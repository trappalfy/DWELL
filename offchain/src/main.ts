import { loadWorkerConfig } from "./config.ts";
import { openDatabase } from "./db/open.ts";
import { HeartbeatStore } from "./db/heartbeats.ts";
import { EntitlementStore } from "./db/entitlements.ts";
import { EpochStore } from "./db/epochs.ts";
import { RootStore } from "./db/roots.ts";
import { PurchaseStore } from "./db/purchases.ts";
import { ChainReader } from "./chain/reader.ts";
import { ChainWriter } from "./chain/writer.ts";
import { closeBuckets } from "./ingest/bucketClose.ts";
import { settleEpoch } from "./worker/settleJob.ts";
import { publishIfDue } from "./worker/publisher.ts";
import { checkPublishedRoot } from "./worker/watchdog.ts";
import { convertFeesIfDue } from "./worker/feeConverter.ts";
import { startWorker } from "./worker/loop.ts";
import { startServer } from "./server.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const config = loadWorkerConfig(process.env);

const db = openDatabase(config.databasePath);
const heartbeats = new HeartbeatStore(db);
const entitlements = new EntitlementStore(db);
const epochs = new EpochStore(db);
const roots = new RootStore(db);
const purchases = new PurchaseStore(db);

const reader = new ChainReader(config.rpcUrl, config.projectToken);
const writer = new ChainWriter(config.rpcUrl, config.keeperKey);

// Alerts go to stderr so the process manager can route them without the
// worker taking on a notification dependency of its own.
const alert = (message: string): void => {
  console.error(`[ALERT ${new Date().toISOString()}] ${message}`);
};

const server = startServer(
  {
    heartbeats,
    entitlements,
    reader,
    roots,
    epochs,
    minBalance: config.minBalance,
    vaultAddress: config.rewardVault,
    projectToken: config.projectToken,
    now: () => Date.now()
  },
  config.port,
  { staticRoot: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web") }
);

const worker = startWorker(
  {
    closeBuckets: (currentBucket) => closeBuckets({ heartbeats, reader, currentBucket }),
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
        entitlements,
        vaultAddress: config.rewardVault,
        reader,
        writer,
        alert
      }),
    convertFeesIfDue: () =>
      convertFeesIfDue({
        purchases,
        vaultAddress: config.rewardVault,
        threshold: config.conversionThreshold,
        reader,
        writer,
        dryRun: config.dryRun
      }),
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
