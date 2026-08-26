import { parseAbi, parseAbiItem, type PublicClient } from "viem";
import { createReadClient } from "./client.ts";
import { ADDRESSES } from "../config.ts";
import type { Address, VaultState } from "../types.ts";

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const VAULT_ABI = parseAbi([
  "function totalAllocated() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function claimed(address) view returns (uint256)"
]);

const ROOT_PUBLISHED_EVENT = parseAbiItem(
  "event RootPublished(uint64 indexed throughEpoch, bytes32 root, uint256 totalAllocated)"
);

/**
 * How far back to scan for published roots. Events, unlike state, survive
 * far beyond the node's pruning window — measured at 100k blocks against
 * 6-8k for state — so the watchdog works after a restart and can audit
 * history after the fact.
 */
const LOG_LOOKBACK_BLOCKS = 100_000n;

export class ChainReader {
  readonly #client: PublicClient;
  readonly #projectToken: Address;

  /**
   * @param projectToken the token miners must hold; weight is measured
   *        against this balance. Rewards are a different asset entirely
   *        (ADDRESSES.tsla), which is why this is not defaulted.
   */
  constructor(rpcUrl: string, projectToken: Address) {
    this.#client = createReadClient(rpcUrl);
    this.#projectToken = projectToken;
  }

  currentBlock(): Promise<bigint> {
    return this.#client.getBlockNumber();
  }

  /**
   * Reads every balance in a single Multicall3 round trip at one block, so
   * the whole bucket shares a consistent snapshot instead of drifting across
   * per-account requests.
   */
  async balancesAt(
    accounts: readonly Address[],
    blockNumber?: bigint
  ): Promise<Map<Address, bigint>> {
    const result = new Map<Address, bigint>();
    if (accounts.length === 0) return result;

    const values = await this.#client.multicall({
      contracts: accounts.map((account) => ({
        address: this.#projectToken,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account]
      })),
      allowFailure: false,
      ...(blockNumber === undefined ? {} : { blockNumber })
    });

    accounts.forEach((account, index) => result.set(account, values[index] as bigint));
    return result;
  }

  async vaultState(vault: Address): Promise<VaultState> {
    const [balance, totalAllocated, totalClaimed] = await this.#client.multicall({
      contracts: [
        { address: ADDRESSES.tsla, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] },
        { address: vault, abi: VAULT_ABI, functionName: "totalAllocated" },
        { address: vault, abi: VAULT_ABI, functionName: "totalClaimed" }
      ],
      allowFailure: false
    });

    return {
      balance: balance as bigint,
      totalAllocated: totalAllocated as bigint,
      totalClaimed: totalClaimed as bigint
    };
  }

  async lastPublishedRoot(
    vault: Address
  ): Promise<{ root: string; throughEpoch: number } | null> {
    const head = await this.currentBlock();
    const from = head > LOG_LOOKBACK_BLOCKS ? head - LOG_LOOKBACK_BLOCKS : 0n;

    const logs = await this.#client.getLogs({
      address: vault,
      event: ROOT_PUBLISHED_EVENT,
      fromBlock: from,
      toBlock: head
    });

    const latest = logs.at(-1);
    if (!latest) return null;

    return {
      root: latest.args.root as string,
      throughEpoch: Number(latest.args.throughEpoch)
    };
  }

  /** How much this account has already withdrawn; claimable is cumulative minus this. */
  claimed(vault: Address, account: Address): Promise<bigint> {
    return this.#client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "claimed",
      args: [account]
    }) as Promise<bigint>;
  }

  /**
   * Reads any ERC20 balance, not just the project token.
   *
   * Creator fees arrive as WETH, which is neither what miners are weighed by
   * nor what they are paid in, so the token has to be named at the call site
   * rather than baked into the reader.
   */
  tokenBalance(token: Address, account: Address): Promise<bigint> {
    return this.#client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account]
    }) as Promise<bigint>;
  }

  ethBalance(account: Address): Promise<bigint> {
    return this.#client.getBalance({ address: account });
  }
}
