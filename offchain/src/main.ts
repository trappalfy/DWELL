import { ADDRESSES, loadWorkerConfig } from "./config.ts";
import { openDatabase } from "./db/open.ts";
import { HeartbeatStore } from "./db/heartbeats.ts";
import { EntitlementStore } from "./db/entitlements.ts";
import { EpochStore } from "./db/epochs.ts";
import { RootStore } from "./db/roots.ts";
import { ChainReader } from "./chain/reader.ts";
import { ChainWriter } from "./chain/writer.ts";
import { closeBuckets } from "./ingest/bucketClose.ts";
import { settleEpoch } from "./worker/settleJob.ts";
import { publishIfDue } from "./worker/publisher.ts";
import { checkPublishedRoot } from "./worker/watchdog.ts";
import { createFeeWatch } from "./worker/feeWatch.ts";
import { startWorker } from "./worker/loop.ts";
import { startServer } from "./server.ts";
import { findBackdrop } from "./backdrop.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const config = loadWorkerConfig(process.env);

const db = openDatabase(config.databasePath);
const heartbeats = new HeartbeatStore(db);
const entitlements = new EntitlementStore(db);
const epochs = new EpochStore(db);
const roots = new RootStore(db);

const reader = new ChainReader(config.rpcUrl, config.projectToken);
const writer = new ChainWriter(config.rpcUrl, config.keeperKey);

// Alerts go to stderr so the process manager can route them without the
// worker taking on a notification dependency of its own.
const alert = (message: string): void => {
  console.error(`[ALERT ${new Date().toISOString()}] ${message}`);
};

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const backdrop = findBackdrop(webRoot);

/*
 * Built once, not per tick: the watch remembers whether it has already
 * spoken, which is the only thing keeping a ten-second loop from turning an
 * alert into a log nobody reads.
 */
const checkFeeEscrow = createFeeWatch({
  recipient: config.feeRecipient,
  rewardToken: ADDRESSES.tsla,
  threshold: config.feeAlertThreshold,
  escrow: {
    creditedToken: (recipient, token) => reader.escrowCredit(recipient, token),
    creditedNative: (recipient) => reader.escrowCreditNative(recipient)
  },
  alert
});

const server = startServer(
  {
    heartbeats,
    entitlements,
    reader,
    roots,
    epochs,
    backdrop,
    minBalance: config.minBalance,
    vaultAddress: config.rewardVault,
    projectToken: config.projectToken,
    dryRun: config.dryRun,
    now: () => Date.now()
  },
  config.port,
  { staticRoot: webRoot, trustedProxyHops: config.trustedProxyHops }
);

const worker = startWorker(
  {
    closeBuckets: async (currentBucket) => {
      const report = await closeBuckets({ heartbeats, reader, currentBucket });
      // Worth waking someone for: buckets are dropped only when the worker
      // fell far enough behind that their balances stopped being knowable,
      // and the miners in them went unpaid for that time.
      if (report.discarded > 0) {
        alert(`dropped ${report.discarded} stale bucket(s): balances no longer knowable`);
      }
      return report;
    },
    settleEpoch: (epoch) =>
      settleEpoch(
        {
          heartbeats,
          entitlements,
          epochs,
          reader,
          vaultAddress: config.rewardVault,
          minBalance: config.minBalance
        },
        epoch
      ),
    publishIfDue: () =>
      publishIfDue({
        entitlements,
        epochs,
        roots,
        writer,
        vaultAddress: config.rewardVault,
        dryRun: config.dryRun
      }),
    checkPublishedRoot: () =>
      checkPublishedRoot({
        roots,
        vaultAddress: config.rewardVault,
        reader,
        writer,
        alert
      }),
    checkFeeEscrow,
    lastSettledEpoch: () => epochs.lastSettled(),
    alert
  },
  10_000
);

// The key is never printed; the derived address is public and is what an
// operator actually needs to check.
console.log(
  `DWELL up on :${config.port} — vault ${config.rewardVault}, keeper ${writer.address}` +
    (config.dryRun ? " — DRY RUN, nothing will be published" : "")
);

const shutdown = (): void => {
  worker.stop();
  server.close();
  db.close();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
