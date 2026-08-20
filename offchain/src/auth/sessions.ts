import { randomBytes } from "node:crypto";
import type { Address } from "../types.ts";

export const SESSION_TTL_MS = 60_000;

interface Session {
  readonly account: Address;
  expiresAt: number;
}

/**
 * Sessions live in memory only.
 *
 * A restart therefore forces every miner to sign again, which matches the
 * product rule that mining never resumes on its own — and removes a class of
 * bugs around persisting bearer tokens.
 *
 * One session per wallet: opening a new one closes the old, so a single
 * balance cannot be mined from two places at once.
 */
export class SessionStore {
  readonly #byToken = new Map<string, Session>();
  readonly #byAccount = new Map<Address, string>();

  open(account: Address, now: number): string {
    const previous = this.#byAccount.get(account);
    if (previous) this.#byToken.delete(previous);

    const token = randomBytes(32).toString("hex");
    this.#byToken.set(token, { account, expiresAt: now + SESSION_TTL_MS });
    this.#byAccount.set(account, token);
    return token;
  }

  resolve(token: string, now: number): Address | null {
    const session = this.#byToken.get(token);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.close(token);
      return null;
    }
    return session.account;
  }

  /** Extends the session; called on every accepted heartbeat. */
  touch(token: string, now: number): void {
    const session = this.#byToken.get(token);
    if (session) session.expiresAt = now + SESSION_TTL_MS;
  }

  close(token: string): void {
    const session = this.#byToken.get(token);
    if (!session) return;
    this.#byToken.delete(token);
    if (this.#byAccount.get(session.account) === token) {
      this.#byAccount.delete(session.account);
    }
  }
}
