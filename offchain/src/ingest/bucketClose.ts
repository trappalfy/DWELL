import { BUCKETS_PER_EPOCH } from "../epoch.ts";
import type { HeartbeatStore } from "../db/heartbeats.ts";
import type { Address } from "../types.ts";

/**
 * How far behind a bucket may fall and still be sampled.
 *
 * Balances are read at the CURRENT block, which is right when the bucket
 * closed moments ago and wrong once it did not. A miner who sold during an
 * outage would otherwise be paid for the balance they have now, and one who
 * bought would be paid for buckets they sat out — in both cases for a
 * balance they did not hold at the time.
 *
 * Two epochs, not one: settlement waits for an epoch to end, so the last
 * epoch's buckets must still be fillable after a short hiccup or the whole
 * epoch would settle empty. Beyond that the sample is no longer evidence
 * about the bucket, and the honest reading is that we have none.
 */
export const STALE_AFTER_BUCKETS = 2 * BUCKETS_PER_EPOCH;

export interface BucketCloseDeps {
  readonly heartbeats: HeartbeatStore;
  readonly reader: {
    currentBlock(): Promise<bigint>;
    balancesAt(accounts: readonly Address[], blockNumber?: bigint): Promise<Map<Address, bigint>>;
  };
  /** Bucket currently accepting heartbeats; everything before it is final. */
  readonly currentBucket: number;
}

export interface BucketCloseReport {
  /** Buckets whose balances were sampled and written. */
  readonly closed: number;
  /** Buckets dropped because their balances could no longer be read honestly. */
  readonly discarded: number;
}

/**
 * Phase two of heartbeat ingestion.
 *
 * Reads every balance for a finished bucket in one multicall at one block.
 * Doing it per heartbeat would mean one RPC call per miner per ten seconds
 * and a snapshot that drifts across accounts within the same bucket.
 */
export async function closeBuckets(deps: BucketCloseDeps): Promise<BucketCloseReport> {
  const pending = deps.heartbeats.pendingBuckets(deps.currentBucket);
  if (pending.length === 0) return { closed: 0, discarded: 0 };

  const stale: number[] = [];
  const fresh: number[] = [];
  for (const bucketId of pending) {
    (deps.currentBucket - bucketId > STALE_AFTER_BUCKETS ? stale : fresh).push(bucketId);
  }

  let discarded = 0;
  for (const bucketId of stale) {
    if (deps.heartbeats.discardBucket(bucketId) > 0) discarded += 1;
  }

  if (fresh.length === 0) return { closed: 0, discarded };

  // One block for the whole pass: buckets this recent are all describable by
  // the same snapshot, and a block per bucket would multiply the round trips.
  const blockNumber = await deps.reader.currentBlock();

  let closed = 0;
  for (const bucketId of fresh) {
    const accounts = deps.heartbeats.accountsInBucket(bucketId);
    if (accounts.length === 0) continue;

    const balances = await deps.reader.balancesAt(accounts, blockNumber);
    deps.heartbeats.fillBucket(bucketId, Number(blockNumber), balances);
    closed += 1;
  }

  return { closed, discarded };
}
