import type { Address } from "./types.ts";

/**
 * Splits an epoch release across accounts in proportion to weight.
 *
 *   share(a) = floor(release * weight(a) / totalWeight)
 *
 * Every share floors, so the sum of shares is at most the release. The
 * remainder is returned as dust: the caller leaves it unallocated, which
 * hands it to later epochs. Nothing is ever created or lost.
 */
export function allocate(
  release: bigint,
  weights: ReadonlyMap<Address, bigint>
): { allocations: Map<Address, bigint>; dust: bigint } {
  if (release < 0n) throw new RangeError(`release must not be negative, got ${release}`);

  const allocations = new Map<Address, bigint>();

  let totalWeight = 0n;
  for (const weight of weights.values()) totalWeight += weight;
  if (totalWeight <= 0n) return { allocations, dust: release };

  let distributed = 0n;
  for (const [account, weight] of weights) {
    const share = (release * weight) / totalWeight;
    if (share > 0n) {
      allocations.set(account, share);
      distributed += share;
    }
  }

  return { allocations, dust: release - distributed };
}
