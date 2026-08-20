interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitOptions {
  readonly capacity: number;
  readonly refillPerMs: number;
}

/**
 * Token bucket, in memory.
 *
 * Deliberately modest: the weight formula is linear in balance, so a bot
 * earns exactly the share its balance entitles it to and steals nothing.
 * Rate limiting here protects the server from noise, not the reward pool
 * from abuse.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refillPerMs: number;

  constructor(options: RateLimitOptions) {
    this.#capacity = options.capacity;
    this.#refillPerMs = options.refillPerMs;
  }

  check(key: string, now: number): boolean {
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };

    const refilled = bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs;
    bucket.tokens = Math.min(this.#capacity, refilled);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      this.#buckets.set(key, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return true;
  }
}
