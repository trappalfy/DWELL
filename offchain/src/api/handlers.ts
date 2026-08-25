import { verifyMessage } from "viem";
import { ChallengeStore } from "../auth/challenge.ts";
import { SessionStore } from "../auth/sessions.ts";
import { RateLimiter } from "./ratelimit.ts";
import { bucketOf, epochOf, EPOCH_SECONDS, BUCKET_SECONDS } from "../epoch.ts";
import { PUBLISH_EVERY_EPOCHS } from "../worker/publisher.ts";
import { ADDRESSES } from "../config.ts";
import { buildTree } from "../tree.ts";
import type { Routes } from "./router.ts";
import type { HeartbeatStore } from "../db/heartbeats.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { Address, VaultState } from "../types.ts";
import type { Backdrop } from "../backdrop.ts";

export interface HandlerDeps {
  readonly heartbeats: HeartbeatStore;
  readonly entitlements: EntitlementStore;
  readonly reader: {
    currentBlock(): Promise<bigint>;
    balancesAt(accounts: readonly Address[], blockNumber?: bigint): Promise<Map<Address, bigint>>;
    claimed(vault: Address, account: Address): Promise<bigint>;
    vaultState(vault: Address): Promise<VaultState>;
  };
  readonly roots: { lastPublished(): number | null };
  readonly epochs: { countSettledAfter(epoch: number | null): number };
  /** Empty sources mean no video is installed; the page keeps its own sky. */
  readonly backdrop: Backdrop;
  readonly minBalance: bigint;
  readonly vaultAddress: Address;
  /**
   * Null until the token is deployed. The page then says so outright rather
   * than printing a stand-in address: this chain carries impostor tokens
   * under the same name, so a plausible-looking wrong address is the one
   * mistake here that costs a reader money. Only echoed to the client —
   * balances are read against RuntimeConfig.projectToken, which the
   * protocol cannot run without.
   */
  readonly projectToken: Address | null;
  /**
   * Rehearsal mode. The token address is withheld while this is on, because
   * a dry run means the protocol is not live and PROJECT_TOKEN is usually a
   * stand-in — the process refuses to start without one, so a rehearsal has
   * to name some existing contract. Printing that under the $DWELL label
   * would point readers at somebody else's token, and this chain carries
   * impostors under our own name. Nothing else in the response changes.
   */
  readonly dryRun: boolean;
  readonly now: () => number;
}

/** Mirrors RewardVault.CLAIM_DELAY; the UI needs it to say when a root goes live. */
const CLAIM_DELAY_SECONDS = 300;

/**
 * How long one reading of the vault is reused.
 *
 * /v1/stats is polled by every open tab, and the whole product asks people to
 * keep tabs open — reading the chain per request would turn our own visitors
 * into a load generator against the RPC. Fifteen seconds is well inside the
 * half-hour interval these numbers actually move on.
 */
const VAULT_CACHE_MS = 15_000;

interface VaultNumbers {
  readonly vaultBalance: string;
  readonly totalReleased: string;
  readonly totalClaimed: string;
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

  let cachedVault: { at: number; value: VaultNumbers | null } | null = null;
  let vaultInFlight: Promise<VaultNumbers | null> | null = null;

  /** Cached and de-duplicated: a burst of pollers costs one chain read, not one each. */
  const readVault = (): Promise<VaultNumbers | null> => {
    if (cachedVault && deps.now() - cachedVault.at < VAULT_CACHE_MS) {
      return Promise.resolve(cachedVault.value);
    }
    if (vaultInFlight) return vaultInFlight;

    vaultInFlight = deps.reader
      .vaultState(deps.vaultAddress)
      .then((state) => ({
        vaultBalance: state.balance.toString(),
        totalReleased: state.totalAllocated.toString(),
        totalClaimed: state.totalClaimed.toString()
      }))
      // An unreachable chain must not take /v1/stats down with it: these
      // numbers decorate a section, they gate nothing. Caching the failure
      // too keeps a flapping RPC from being hammered.
      .catch((): VaultNumbers | null => null)
      .then((value) => {
        cachedVault = { at: deps.now(), value };
        vaultInFlight = null;
        return value;
      });

    return vaultInFlight;
  };

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

    "GET /v1/me": async ({ bearer, url }) => {
      const queried = url.searchParams.get("account");
      const account = bearer
        ? sessions.resolve(bearer, deps.now())
        : isAddress(queried)
          ? (queried.toLowerCase() as Address)
          : null;
      if (!account) return { status: 400, body: { error: "account or session required" } };

      const balances = await deps.reader.balancesAt([account]);
      const balance = balances.get(account) ?? 0n;

      const cumulative = deps.entitlements.load();
      const mine = cumulative.get(account) ?? 0n;
      const withdrawn = await deps.reader.claimed(deps.vaultAddress, account);

      // The published root can lag the journal, so on-chain withdrawals may
      // briefly exceed what the journal has recorded. Clamp rather than
      // report a negative amount the UI would have to special-case.
      const claimable = mine > withdrawn ? mine - withdrawn : 0n;

      const base = {
        account,
        balance: balance.toString(),
        eligible: balance >= deps.minBalance,
        cumulative: mine.toString(),
        claimed: withdrawn.toString(),
        claimable: claimable.toString()
      };

      if (mine === 0n) return { status: 200, body: { ...base, root: null, proof: null } };

      const tree = buildTree(cumulative);
      return {
        status: 200,
        body: { ...base, root: tree.root, proof: tree.proofFor(account) }
      };
    },

    "GET /v1/config": () => ({
      status: 200,
      body: {
        vault: deps.vaultAddress,
        projectToken: deps.dryRun ? null : deps.projectToken,
        rewardToken: ADDRESSES.tsla,
        minBalance: deps.minBalance.toString(),
        epochSeconds: EPOCH_SECONDS,
        bucketSeconds: BUCKET_SECONDS,
        claimDelaySeconds: CLAIM_DELAY_SECONDS,
        publishEveryEpochs: PUBLISH_EVERY_EPOCHS,
        backdrop: deps.backdrop
      }
    }),

    "GET /v1/stats": async () => {
      const now = Math.floor(deps.now() / 1_000);
      const cumulative = deps.entitlements.load();

      let totalAllocated = 0n;
      for (const amount of cumulative.values()) totalAllocated += amount;

      // What the publisher itself waits for, so the page counts down to the
      // real event rather than to a number it invented. Settled epochs are
      // counted, not subtracted: epoch ids come from unix time and run in
      // the millions, so their difference measures elapsed time, not work.
      const lastPublishedEpoch = deps.roots.lastPublished();
      const settled = deps.epochs.countSettledAfter(lastPublishedEpoch);
      const epochsUntilPublish = Math.max(0, PUBLISH_EVERY_EPOCHS - settled);

      const vault = await readVault();

      return {
        status: 200,
        body: {
          // Sent so the page can correct for a skewed local clock instead of
          // showing a countdown that disagrees with the protocol.
          serverTime: now,
          currentEpoch: epochOf(now),
          activeMiners: deps.heartbeats.accountsInBucket(bucketOf(now)).length,
          entitlementAccounts: cumulative.size,
          totalAllocated: totalAllocated.toString(),
          lastPublishedEpoch,
          epochsUntilPublish,
          // Null when the chain could not be reached; the page shows a dash.
          vaultBalance: vault?.vaultBalance ?? null,
          totalReleased: vault?.totalReleased ?? null,
          totalClaimed: vault?.totalClaimed ?? null
        }
      };
    }
  };
}
