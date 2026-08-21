/**
 * Serves the real page against a fake chain, so the front end can be looked
 * at and used without a deployed vault, a launched token, or a keeper key.
 *
 * This is not a second implementation of the protocol: the router, handlers,
 * stores and static serving are the production ones. Only the chain reader is
 * replaced, plus a ticker that credits whoever is present so the page has
 * numbers to show. Nothing here is imported by src/.
 *
 * Run: node scripts/dev-server.ts
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { startServer } from "../src/server.ts";
import { findBackdrop } from "../src/backdrop.ts";
import { bucketOf } from "../src/epoch.ts";
import type { Address } from "../src/types.ts";

const env = process.env;
const port = Number(env.PORT ?? 8787);

/** Whole tokens the fake chain reports for every account that asks. */
const balance = BigInt(env.DEV_BALANCE ?? "250000") * 10n ** 18n;
const minBalance = BigInt(env.MIN_BALANCE ?? "100000") * 10n ** 18n;

/** TSLA credited per tick to everyone present, so the readout visibly moves. */
const CREDIT_PER_TICK = 40_000_000_000_000n;
const TICK_MS = 10_000;

const VAULT = "0xeeee000000000000000000000000000000000003" as Address;
const PROJECT_TOKEN = "0xdddd000000000000000000000000000000000004" as Address;

const db = openDatabase(":memory:");
const heartbeats = new HeartbeatStore(db);
const entitlements = new EntitlementStore(db);

let vaultBalance = 57_600_000_000_000_000n; // ~$20 of TSLA, the real pre-charge
let released = 0n;

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const backdrop = findBackdrop(webRoot);

const server = startServer(
  {
    heartbeats,
    entitlements,
    reader: {
      currentBlock: async () => 1n,
      balancesAt: async (accounts) => new Map(accounts.map((a) => [a, balance])),
      claimed: async () => 0n,
      vaultState: async () => ({
        balance: vaultBalance,
        totalAllocated: released,
        totalClaimed: 0n
      })
    },
    roots: { lastPublished: () => null },
    // Counts up so the settlement clock ticks down instead of standing still.
    epochs: { countSettledAfter: () => Math.floor(Date.now() / 60_000) % 7 },
    backdrop,
    minBalance,
    vaultAddress: VAULT,
    projectToken: PROJECT_TOKEN,
    now: () => Date.now()
  },
  port,
  { staticRoot: webRoot }
);

/**
 * Stands in for settlement. The real worker does this once per five-minute
 * epoch; here it runs every ten seconds so a number moves while you watch.
 */
setInterval(() => {
  const present = heartbeats.accountsInBucket(bucketOf(Math.floor(Date.now() / 1_000)));
  if (present.length === 0) return;

  const cumulative = entitlements.load();
  for (const account of present) {
    cumulative.set(account, (cumulative.get(account) ?? 0n) + CREDIT_PER_TICK);
    released += CREDIT_PER_TICK;
    vaultBalance -= CREDIT_PER_TICK;
  }
  entitlements.save(cumulative);
}, TICK_MS);

server.once("listening", () => {
  console.log(`
  DWELL dev server — http://127.0.0.1:${port}

  The chain is FAKE. Balances, the vault and the settlement clock are all
  made up here; nothing is read from or written to any network, and no
  private key is loaded. Claiming will not work — it needs a real vault.

  Every wallet reads as ${(balance / 10n ** 18n).toLocaleString("en-US")} $DWELL (threshold ${(minBalance / 10n ** 18n).toLocaleString("en-US")}).
  Set DEV_BALANCE=1000 to see the below-threshold state instead.
`);
});

const shutdown = (): void => {
  server.close();
  db.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
