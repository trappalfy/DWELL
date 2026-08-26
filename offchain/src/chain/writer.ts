import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "./client.ts";
import { assertMined } from "./receipt.ts";
import { ADDRESSES, POOL_FEE, SLIPPAGE_BPS } from "../config.ts";
import type { Address } from "../types.ts";

/**
 * SwapRouter02, not the canonical v3 SwapRouter.
 *
 * The params struct has SEVEN fields and no `deadline` — the canonical
 * router has eight. Writing the familiar signature from memory produces a
 * different selector and every swap reverts. Taken from the verified source
 * on the explorer, not from documentation.
 */
const ROUTER_ABI = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)"
]);

/*
 * The custom errors are declared alongside the function on purpose: viem can
 * only report a revert BY NAME when its ABI carries that error, and without
 * them collectFees would surface a bare four-byte selector that no caller
 * could tell apart from any other revert.
 */
const LOCKER_ABI = parseAbi([
  "function collectFees(address token) returns (uint256 amount0, uint256 amount1)",
  "error NoFeesToCollect()",
  "error NotAuthorized()",
  "error TokenNotFound()"
]);

const WETH_ABI = parseAbi([
  "function withdraw(uint256 amount)"
]);

const VAULT_ABI = parseAbi([
  "function publishRoot(uint64 newEpoch, bytes32 newRoot, uint256 newTotalAllocated)",
  "function pause()"
]);

const BPS = 10_000n;

export interface SwapResult {
  readonly txHash: Hex;
  readonly amountOut: bigint;
}

export interface SwapOptions {
  /** Test hook: forces a minimum the pool cannot satisfy. */
  readonly minOutOverride?: bigint;
}

/**
 * The single holder of the keeper key.
 *
 * Every state-changing call the protocol makes goes through here, so there
 * is exactly one file to audit for what the hot key is able to do.
 */
export class ChainWriter {
  readonly #public: PublicClient;
  readonly #wallet: WalletClient;
  readonly #account;

  constructor(rpcUrl: string, privateKey: string) {
    this.#account = privateKeyToAccount(privateKey as Hex);
    const transport = http(rpcUrl);
    this.#public = createPublicClient({ chain: robinhoodChain, transport });
    this.#wallet = createWalletClient({
      account: this.#account,
      chain: robinhoodChain,
      transport
    });
  }

  get address(): Address {
    return this.#account.address;
  }

  async publishRoot(
    vault: Address,
    epoch: number,
    root: Hex,
    totalAllocated: bigint
  ): Promise<Hex> {
    const { request } = await this.#public.simulateContract({
      account: this.#account,
      address: vault,
      abi: VAULT_ABI,
      functionName: "publishRoot",
      args: [BigInt(epoch), root, totalAllocated]
    });
    const hash = await this.#wallet.writeContract(request);
    assertMined(await this.#public.waitForTransactionReceipt({ hash }), "publishRoot", hash);
    return hash;
  }

  async pause(vault: Address): Promise<Hex> {
    const { request } = await this.#public.simulateContract({
      account: this.#account,
      address: vault,
      abi: VAULT_ABI,
      functionName: "pause"
    });
    const hash = await this.#wallet.writeContract(request);
    assertMined(await this.#public.waitForTransactionReceipt({ hash }), "pause", hash);
    return hash;
  }

  /**
   * Converts native ETH into the reward asset in ONE transaction.
   *
   * The router is payable and its internal pay() wraps ETH itself when
   * tokenIn is WETH9, and `recipient` delivers straight to the vault. A
   * separate WETH.deposit(), an approve and a transfer are all unnecessary —
   * each removed transaction is a removed failure mode and one less moment
   * where the hot wallet holds value.
   *
   * The expected output comes from simulating the very same call, so no
   * Quoter contract has to be pinned or kept in sync.
   */
  async swapEthForReward(
    recipient: Address,
    amountIn: bigint,
    options: SwapOptions = {}
  ): Promise<SwapResult> {
    if (amountIn <= 0n) throw new RangeError("amountIn must be positive");

    const params = {
      tokenIn: ADDRESSES.weth,
      tokenOut: ADDRESSES.tsla,
      fee: POOL_FEE,
      recipient,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n
    } as const;

    const quoted = await this.#public.simulateContract({
      account: this.#account,
      address: ADDRESSES.swapRouter,
      abi: ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [params],
      value: amountIn
    });
    const expected = quoted.result as bigint;

    const minimum = options.minOutOverride ?? (expected * (BPS - BigInt(SLIPPAGE_BPS))) / BPS;

    const { request } = await this.#public.simulateContract({
      account: this.#account,
      address: ADDRESSES.swapRouter,
      abi: ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{ ...params, amountOutMinimum: minimum }],
      value: amountIn
    });

    const txHash = await this.#wallet.writeContract(request);
    assertMined(
      await this.#public.waitForTransactionReceipt({ hash: txHash }),
      "exactInputSingle",
      txHash
    );

    return { txHash, amountOut: expected };
  }

  /**
   * Claims the creator fees pons owes the keeper.
   *
   * Returns null when the locker had nothing to pay. That case is the normal
   * one — most ticks find an empty position — and it arrives as a revert, so
   * it has to be told apart from a real failure rather than retried or
   * alerted on. Everything else is rethrown untouched: NotAuthorized in
   * particular means the fee wallet is not ours, which is a misconfiguration
   * that must be loud.
   */
  async collectCreatorFees(token: Address): Promise<Hex | null> {
    try {
      const { request } = await this.#public.simulateContract({
        account: this.#account,
        address: ADDRESSES.ponsLocker,
        abi: LOCKER_ABI,
        functionName: "collectFees",
        args: [token]
      });
      const hash = await this.#wallet.writeContract(request);
      assertMined(await this.#public.waitForTransactionReceipt({ hash }), "collectFees", hash);
      return hash;
    } catch (error) {
      if (isNoFeesToCollect(error)) return null;
      throw error;
    }
  }

  /**
   * Unwraps WETH into native ETH.
   *
   * The locker pays with safeTransfer, so fees land WRAPPED, while
   * feeConverter spends the NATIVE balance. Without this step the two never
   * meet and the fees sit on the keeper forever.
   */
  async unwrapWeth(amount: bigint): Promise<Hex> {
    if (amount <= 0n) throw new RangeError("amount must be positive");

    const { request } = await this.#public.simulateContract({
      account: this.#account,
      address: ADDRESSES.weth,
      abi: WETH_ABI,
      functionName: "withdraw",
      args: [amount]
    });
    const hash = await this.#wallet.writeContract(request);
    assertMined(await this.#public.waitForTransactionReceipt({ hash }), "withdraw", hash);
    return hash;
  }
}

/**
 * Recognises the locker's "nothing to pay out" revert.
 *
 * Matched on the error's own name rather than a hand-written four-byte
 * selector: viem surfaces the custom error by name once the ABI is known,
 * and a mistyped constant would silently start swallowing some other revert.
 */
function isNoFeesToCollect(error: unknown): boolean {
  for (let e: unknown = error; e != null; e = (e as { cause?: unknown }).cause) {
    if ((e as { data?: { errorName?: string } }).data?.errorName === "NoFeesToCollect") return true;
    if (String((e as { message?: string }).message ?? "").includes("NoFeesToCollect")) return true;
  }
  return false;
}

