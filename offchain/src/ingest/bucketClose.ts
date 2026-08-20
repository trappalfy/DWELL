import type { HeartbeatStore } from "../db/heartbeats.ts";
import type { Address } from "../types.ts";

export interface BucketCloseDeps {
  readonly heartbeats: HeartbeatStore;
  readonly reader: {
    currentBlock(): Promise<bigint>;
    balancesAt(accounts: readonly Address[], blockNumber?: bigint): Promise<Map<Address, bigint>>;
  };
  /** Bucket currently accepting heartbeats; everything before it is final. */
  readonly currentBucket: number;
}

/**
 * Phase two of heartbeat ingestion.
 *
 * Reads every balance for a finished bucket in one multicall at one block.
 * Doing it per heartbeat would mean one RPC call per miner per ten seconds
 * and a snapshot that drifts across accounts within the same bucket.
 *
 * Returns how many buckets were closed.
 */
export async function closeBuckets(deps: BucketCloseDeps): Promise<number> {
  const pending = deps.heartbeats.pendingBuckets(deps.currentBucket);
  if (pending.length === 0) return 0;

  const blockNumber = await deps.reader.currentBlock();

  let closed = 0;
  for (const bucketId of pending) {
    const accounts = deps.heartbeats.accountsInBucket(bucketId);
    if (accounts.length === 0) continue;

    const balances = await deps.reader.balancesAt(accounts, blockNumber);
    deps.heartbeats.fillBucket(bucketId, Number(blockNumber), balances);
    closed += 1;
  }

  return closed;
}
