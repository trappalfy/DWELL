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
import { ADDRESSES } from "../config.ts";
import type { Address } from "../types.ts";

const VAULT_ABI = parseAbi([
  "function publishRoot(uint64 newEpoch, bytes32 newRoot, uint256 newTotalAllocated)",
  "function pause()"
]);

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


}
