import { settle } from "../settle.ts";
import type { HeartbeatStore } from "../db/heartbeats.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { EpochStore } from "../db/epochs.ts";
import type { Address, SettlementResult, VaultState } from "../types.ts";

export interface SettleDeps {
  readonly heartbeats: HeartbeatStore;
  readonly entitlements: EntitlementStore;
  readonly epochs: EpochStore;
  readonly reader: { vaultState(vault: Address): Promise<VaultState> };
  readonly vaultAddress: Address;
  readonly minBalance: bigint;
}

/**
 * Settles one epoch: read the journal, call the pure core, write the result.
 *
 * No arithmetic happens here on purpose. Everything about money lives in
 * settle() and the modules beneath it, which are pure and fully tested —
 * this function only moves data across the I/O boundary.
 *
 * The epoch is marked settled BEFORE entitlements are written, so that the
 * primary key rejects a second settlement even if the process dies midway.
 * A crash then leaves an epoch closed with no payout rather than an epoch
 * paid twice; the first is a rounding loss, the second is insolvency.
 */
export async function settleEpoch(
  deps: SettleDeps,
  epoch: number
): Promise<SettlementResult> {
  const heartbeats = deps.heartbeats.listForEpoch(epoch);
  const vault = await deps.reader.vaultState(deps.vaultAddress);
  const priorCumulative = deps.entitlements.load();

  const result = settle({
    epoch,
    heartbeats,
    vault,
    minBalance: deps.minBalance,
    priorCumulative,
    // Read before this epoch is marked settled, so the count is of epochs
    // that came before rather than including the one being settled now.
    releasedEpochs: deps.epochs.countReleasing()
  });

  deps.epochs.markSettled(epoch, result.totalWeight, result.release);

  if (result.allocations.size > 0) {
    deps.entitlements.save(result.cumulative);
  }

  return result;
}
