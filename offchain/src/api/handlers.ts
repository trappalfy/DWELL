import { verifyMessage } from "viem";
import { ChallengeStore } from "../auth/challenge.ts";
import { SessionStore } from "../auth/sessions.ts";
import { RateLimiter } from "./ratelimit.ts";
import { bucketOf, epochOf } from "../epoch.ts";
import { buildTree } from "../tree.ts";
import type { Routes } from "./router.ts";
import type { HeartbeatStore } from "../db/heartbeats.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { Address } from "../types.ts";

export interface HandlerDeps {
  readonly heartbeats: HeartbeatStore;
  readonly entitlements: EntitlementStore;
  readonly reader: {
    currentBlock(): Promise<bigint>;
    balancesAt(accounts: readonly Address[], blockNumber?: bigint): Promise<Map<Address, bigint>>;
  };
  readonly minBalance: bigint;
  readonly now: () => number;
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function createHandlers(deps: HandlerDeps): Routes {
  const challenges = new ChallengeStore();
  const sessions = new SessionStore();

  // Six heartbeats a minute is the protocol rate; the capacity leaves room
  // for a retry after a dropped response without letting a client flood.
  const heartbeatLimit = new RateLimiter({ capacity: 12, refillPerMs: 6 / 60_000 });
  const challengeLimit = new RateLimiter({ capacity: 5, refillPerMs: 5 / 60_000 });

  return {
    "POST /v1/session/challenge": ({ body, ip }) => {
      const account = (body as { account?: unknown }).account;
      if (!isAddress(account)) return { status: 400, body: { error: "account required" } };
      if (!challengeLimit.check(ip, deps.now())) {
        return { status: 429, body: { error: "too many requests" } };
      }

      const challenge = challenges.issue(account.toLowerCase() as Address, deps.now());
      return {
        status: 200,
        body: {
          challengeId: challenge.id,
          message: challenge.message,
          expiresAt: challenge.expiresAt
        }
      };
    },

    "POST /v1/session/verify": async ({ body }) => {
      const { challengeId, signature } = body as { challengeId?: unknown; signature?: unknown };
      if (typeof challengeId !== "string" || typeof signature !== "string") {
        return { status: 400, body: { error: "challengeId and signature required" } };
      }

      const challenge = challenges.consume(challengeId, deps.now());
      if (!challenge) return { status: 401, body: { error: "challenge expired or unknown" } };

      const valid = await verifyMessage({
        address: challenge.account,
        message: challenge.message,
        signature: signature as `0x${string}`
      });
      if (!valid) return { status: 401, body: { error: "signature does not match account" } };

      const token = sessions.open(challenge.account, deps.now());
      return { status: 200, body: { sessionToken: token, account: challenge.account } };
    },

    "POST /v1/heartbeat": ({ bearer }) => {
      if (!bearer) return { status: 401, body: { error: "session required" } };

      const now = deps.now();
      const account = sessions.resolve(bearer, now);
      if (!account) return { status: 401, body: { error: "session expired" } };
      if (!heartbeatLimit.check(account, now)) {
        return { status: 429, body: { error: "too many requests" } };
      }

      const bucketId = bucketOf(Math.floor(now / 1_000));
      const accepted = deps.heartbeats.accept(account, bucketId);
      sessions.touch(bearer, now);

      // A repeat within the same bucket is not an error: the client may retry
      // after a dropped response, and the primary key already deduplicates.
      return {
        status: 200,
        body: { accepted: true, fresh: accepted, bucketId, epochId: epochOf(Math.floor(now / 1_000)) }
      };
    },

    "GET /v1/me": ({ bearer, url }) => {
      const queried = url.searchParams.get("account");
      const account = bearer
        ? sessions.resolve(bearer, deps.now())
        : isAddress(queried)
          ? (queried.toLowerCase() as Address)
          : null;
      if (!account) return { status: 400, body: { error: "account or session required" } };

      const cumulative = deps.entitlements.load();
      const mine = cumulative.get(account) ?? 0n;
      if (mine === 0n) {
        return { status: 200, body: { account, cumulative: "0", proof: null } };
      }

      const tree = buildTree(cumulative);
      return {
        status: 200,
        body: {
          account,
          cumulative: mine.toString(),
          root: tree.root,
          proof: tree.proofFor(account)
        }
      };
    },

    "GET /v1/stats": () => {
      const now = Math.floor(deps.now() / 1_000);
      const cumulative = deps.entitlements.load();

      let totalAllocated = 0n;
      for (const amount of cumulative.values()) totalAllocated += amount;

      return {
        status: 200,
        body: {
          currentEpoch: epochOf(now),
          activeMiners: deps.heartbeats.accountsInBucket(bucketOf(now)).length,
          entitlementAccounts: cumulative.size,
          totalAllocated: totalAllocated.toString()
        }
      };
    }
  };
}
