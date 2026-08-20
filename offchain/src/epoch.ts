/**
 * Epoch clock. Pure arithmetic over unix seconds — no ambient time source,
 * so every caller must pass the timestamp it wants interpreted.
 */

export const EPOCH_SECONDS = 300;
export const BUCKET_SECONDS = 10;
export const BUCKETS_PER_EPOCH = EPOCH_SECONDS / BUCKET_SECONDS;

function assertTimeIndex(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/** Epoch containing the given unix timestamp. */
export function epochOf(unixSeconds: number): number {
  assertTimeIndex(unixSeconds, "unixSeconds");
  return Math.floor(unixSeconds / EPOCH_SECONDS);
}

/** Heartbeat bucket containing the given unix timestamp. */
export function bucketOf(unixSeconds: number): number {
  assertTimeIndex(unixSeconds, "unixSeconds");
  return Math.floor(unixSeconds / BUCKET_SECONDS);
}

/** Epoch a bucket belongs to. */
export function epochOfBucket(bucketId: number): number {
  assertTimeIndex(bucketId, "bucketId");
  return Math.floor(bucketId / BUCKETS_PER_EPOCH);
}

/** Inclusive range of buckets belonging to an epoch. */
export function epochBucketRange(epoch: number): { first: number; last: number } {
  assertTimeIndex(epoch, "epoch");
  const first = epoch * BUCKETS_PER_EPOCH;
  return { first, last: first + BUCKETS_PER_EPOCH - 1 };
}

/** First second of an epoch (inclusive). */
export function epochStart(epoch: number): number {
  assertTimeIndex(epoch, "epoch");
  return epoch * EPOCH_SECONDS;
}

/** First second of the next epoch (exclusive end). */
export function epochEnd(epoch: number): number {
  assertTimeIndex(epoch, "epoch");
  return (epoch + 1) * EPOCH_SECONDS;
}
