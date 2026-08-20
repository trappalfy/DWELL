import { parseAbi, type PublicClient } from "viem";
import { createReadClient } from "./client.ts";
import { ADDRESSES } from "../config.ts";
import type { Address, VaultState } from "../types.ts";

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const VAULT_ABI = parseAbi([
  "function totalAllocated() view returns (uint256)",
  "function totalClaimed() view returns (uint256)"
]);

export class ChainReader {
  readonly #client: PublicClient;

  constructor(rpcUrl: string) {
    this.#client = createReadClient(rpcUrl);
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
        address: ADDRESSES.tsla,
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
}
