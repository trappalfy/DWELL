import type { DatabaseSync } from "node:sqlite";
import { BUCKETS_PER_EPOCH } from "../epoch.ts";
import type { Address, HeartbeatRecord } from "../types.ts";

/**
 * Heartbeats are written in two phases.
 *
 * Phase one runs on request and only records that the account was alive in a
 * bucket. Phase two runs once per bucket and fills in every balance from a
 * single multicall at a pinned block — one RPC round trip per bucket instead
 * of one per miner, and a consistent snapshot.
 */
export class HeartbeatStore {
  readonly #accept;
  readonly #fill;
  readonly #forEpoch;
  readonly #pending;
  readonly #inBucket;

  constructor(db: DatabaseSync) {
    this.#accept = db.prepare(
      "INSERT OR IGNORE INTO heartbeats (account, bucket_id) VALUES (?, ?)"
    );
    this.#fill = db.prepare(
      "UPDATE heartbeats SET block_number = ?, balance = ? WHERE account = ? AND bucket_id = ?"
    );
    this.#forEpoch = db.prepare(
      `SELECT account, bucket_id, balance FROM heartbeats
       WHERE bucket_id >= ? AND bucket_id <= ? AND balance IS NOT NULL`
    );
    this.#pending = db.prepare(
      "SELECT DISTINCT bucket_id FROM heartbeats WHERE balance IS NULL AND bucket_id < ? ORDER BY bucket_id"
    );
    this.#inBucket = db.prepare(
      "SELECT account FROM heartbeats WHERE bucket_id = ? AND balance IS NULL"
    );
  }

  /** Accounts still awaiting a balance read in this bucket. */
  accountsInBucket(bucketId: number): Address[] {
    return this.#inBucket
      .all(bucketId)
      .map((row) => String((row as Record<string, unknown>).account) as Address);
  }

  /** Returns false when this bucket was already recorded for the account. */
  accept(account: Address, bucketId: number): boolean {
    return this.#accept.run(account, bucketId).changes > 0;
  }

  fillBucket(bucketId: number, blockNumber: number, balances: ReadonlyMap<Address, bigint>): void {
    for (const [account, balance] of balances) {
      this.#fill.run(blockNumber, balance.toString(), account, bucketId);
    }
  }

  /** Only rows whose balance has been sampled; unfilled buckets are not evidence. */
  listForEpoch(epoch: number): HeartbeatRecord[] {
    const first = epoch * BUCKETS_PER_EPOCH;
    const last = first + BUCKETS_PER_EPOCH - 1;
    return this.#forEpoch.all(first, last).map((row) => ({
      account: String((row as Record<string, unknown>).account) as Address,
      bucketId: Number((row as Record<string, unknown>).bucket_id),
      balance: BigInt(String((row as Record<string, unknown>).balance))
    }));
  }

  pendingBuckets(beforeBucket: number): number[] {
    return this.#pending
      .all(beforeBucket)
      .map((row) => Number((row as Record<string, unknown>).bucket_id));
  }
}
