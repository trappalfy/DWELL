import { randomBytes } from "node:crypto";
import type { Address } from "../types.ts";

export const CHALLENGE_TTL_MS = 120_000;

export interface Challenge {
  readonly id: string;
  readonly account: Address;
  readonly message: string;
  readonly expiresAt: number;
}

/**
 * Issues one-time messages for wallets to sign.
 *
 * The account and the nonce are both inside the signed text, so a signature
 * captured from one wallet cannot be replayed for another account or reused
 * for a second session.
 */
export class ChallengeStore {
  readonly #open = new Map<string, Challenge>();

  issue(account: Address, now: number): Challenge {
    const id = randomBytes(16).toString("hex");
    const challenge: Challenge = {
      id,
      account,
      message: `DWELL mining session\n\naccount: ${account}\nnonce: ${id}`,
      expiresAt: now + CHALLENGE_TTL_MS
    };
    this.#open.set(id, challenge);
    this.#sweep(now);
    return challenge;
  }

  /** Removes the challenge whether or not it was still valid: single use. */
  consume(challengeId: string, now: number): Challenge | null {
    const challenge = this.#open.get(challengeId);
    if (!challenge) return null;
    this.#open.delete(challengeId);
    return challenge.expiresAt > now ? challenge : null;
  }

  #sweep(now: number): void {
    for (const [id, challenge] of this.#open) {
      if (challenge.expiresAt <= now) this.#open.delete(id);
    }
  }
}
