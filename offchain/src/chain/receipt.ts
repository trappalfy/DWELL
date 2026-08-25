import type { Hex } from "viem";

/**
 * Refuses a transaction that made it into a block and then reverted.
 *
 * Waiting for a receipt is not the same as the call having worked: viem
 * resolves for a reverted transaction just as it does for a successful one,
 * and only the status field tells them apart. Reading the hash as proof of
 * success would let the worker record a root the vault never accepted —
 * `lastPublished` would advance past entitlements nobody can claim, and the
 * watchdog would then find the chain carrying an older root than our own
 * table claims.
 *
 * Every call goes through a simulation first, so this is the narrow case
 * where state moved between simulating and mining. Rare is not never, and
 * the failure is silent, which is the combination worth guarding.
 */
export function assertMined(
  receipt: { readonly status: "success" | "reverted" },
  call: string,
  hash: Hex
): void {
  if (receipt.status !== "success") {
    throw new Error(`${call} reverted on chain (tx ${hash})`);
  }
}
