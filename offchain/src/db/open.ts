import { DatabaseSync } from "node:sqlite";

/**
 * Money is stored as TEXT throughout. SQLite integers are 64-bit and wei
 * amounts overflow them silently, so every balance, weight and entitlement
 * round-trips as a decimal string.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS heartbeats (
  account      TEXT    NOT NULL,
  bucket_id    INTEGER NOT NULL,
  block_number INTEGER,
  balance      TEXT,
  PRIMARY KEY (account, bucket_id)
);

CREATE INDEX IF NOT EXISTS heartbeats_bucket ON heartbeats (bucket_id);

CREATE TABLE IF NOT EXISTS entitlements (
  account    TEXT PRIMARY KEY,
  cumulative TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epochs (
  epoch        INTEGER PRIMARY KEY,
  total_weight TEXT    NOT NULL,
  release      TEXT    NOT NULL,
  settled_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roots (
  through_epoch INTEGER PRIMARY KEY,
  root          TEXT    NOT NULL,
  tx_hash       TEXT,
  published_at  INTEGER
);

CREATE TABLE IF NOT EXISTS purchases (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  eth_in    TEXT    NOT NULL,
  tsla_out  TEXT    NOT NULL,
  tx_hash   TEXT    NOT NULL,
  bought_at INTEGER NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL lets the worker write while the API reads without blocking.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
