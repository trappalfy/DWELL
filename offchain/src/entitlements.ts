import type { Address } from "./types.ts";

/**
 * Folds one epoch's allocations into the running cumulative entitlements.
 *
 * The contract pays `cumulative - alreadyClaimed`, so these numbers may only
 * ever grow: a decrease would revoke an entitlement someone can already prove.
 * Returns a new map; the input is never mutated.
 */
export function accumulate(
  prior: ReadonlyMap<Address, bigint>,
  allocations: ReadonlyMap<Address, bigint>
): Map<Address, bigint> {
  const next = new Map(prior);

  for (const [account, amount] of allocations) {
    if (amount < 0n) {
      throw new RangeError(`allocation for ${account} must not be negative, got ${amount}`);
    }
    next.set(account, (next.get(account) ?? 0n) + amount);
  }

  return next;
}

export function sumEntitlements(entitlements: ReadonlyMap<Address, bigint>): bigint {
  let total = 0n;
  for (const value of entitlements.values()) total += value;
  return total;
}
