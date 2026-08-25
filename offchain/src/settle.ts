import { computeWeights, sumWeights } from "./weights.ts";
import { computeRelease } from "./drip.ts";
import { allocate } from "./allocate.ts";
import { accumulate } from "./entitlements.ts";
import type { SettlementInput, SettlementResult } from "./types.ts";

/**
 * Settles one epoch.
 *
 * Pure: the same evidence and vault state always produce the same result.
 * That is what makes worker crash recovery safe — after a restart the same
 * root is recomputed rather than a different one being published.
 *
 * This function only wires the pieces together; every arithmetic decision
 * lives in the module that owns it.
 */
export function settle(input: SettlementInput): SettlementResult {
  const weights = computeWeights(input.heartbeats, input.minBalance);
  const totalWeight = sumWeights(weights);

  const release = computeRelease(input.vault, totalWeight, input.releasedEpochs);
  const { allocations, dust } = allocate(release, weights);
  const cumulative = accumulate(input.priorCumulative, allocations);

  // Dust was never handed to anyone, so it stays in the reserve and funds
  // later epochs. Allocation therefore grows by what was distributed.
  const distributed = release - dust;

  return {
    epoch: input.epoch,
    totalWeight,
    release,
    allocations,
    dust,
    cumulative,
    totalAllocated: input.vault.totalAllocated + distributed
  };
}
