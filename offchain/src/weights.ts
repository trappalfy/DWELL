import type { Address, HeartbeatRecord } from "./types.ts";

/**
 * Weight is the sum of the balance sampled in every active bucket:
 *
 *   weight(a) = SUM over active buckets b of balance(a, b)
 *
 * Summing per bucket rather than multiplying a single balance by a bucket
 * count is what makes a mid-epoch balance change settle correctly.
 *
 * The relation is linear in balance, so splitting a balance across wallets
 * yields exactly the same total weight — sybil gains nothing.
 */
export function computeWeights(
  heartbeats: readonly HeartbeatRecord[],
  minBalance: bigint
): Map<Address, bigint> {
  const weights = new Map<Address, bigint>();
  const seen = new Set<string>();

  for (const record of heartbeats) {
    const key = `${record.account}:${record.bucketId}`;
    if (seen.has(key)) {
      throw new Error(`duplicate bucket ${record.bucketId} for account ${record.account}`);
    }
    seen.add(key);

    if (record.balance < minBalance) continue;

    weights.set(record.account, (weights.get(record.account) ?? 0n) + record.balance);
  }

  return weights;
}

export function sumWeights(weights: ReadonlyMap<Address, bigint>): bigint {
  let total = 0n;
  for (const weight of weights.values()) total += weight;
  return total;
}
