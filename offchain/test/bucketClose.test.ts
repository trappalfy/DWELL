import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { closeBuckets } from "../src/ingest/bucketClose.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

function stubReader(balances: Record<string, bigint>) {
  const calls: Array<readonly Address[]> = [];
  return {
    calls,
    currentBlock: async () => 42_000_000n,
    balancesAt: async (accounts: readonly Address[]) => {
      calls.push(accounts);
      return new Map(accounts.map((a) => [a, balances[a] ?? 0n]));
    }
  };
}

test("закрывает только бакеты, которые уже позади", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  heartbeats.accept(A, 10);
  heartbeats.accept(A, 11);

  const reader = stubReader({ [A]: 5n });
  const closed = await closeBuckets({ heartbeats, reader, currentBucket: 11 });

  assert.equal(closed, 1, "текущий бакет ещё принимает хартбиты");
  assert.deepEqual(heartbeats.pendingBuckets(12), [11]);
});

test("один multicall на бакет, а не на аккаунт", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  heartbeats.accept(A, 10);
  heartbeats.accept(B, 10);

  const reader = stubReader({ [A]: 7n, [B]: 9n });
  await closeBuckets({ heartbeats, reader, currentBucket: 11 });

  assert.equal(reader.calls.length, 1, "должен быть ровно один запрос балансов");
  assert.equal(reader.calls[0]!.length, 2, "оба аккаунта в одном запросе");
});

test("прочитанные балансы попадают в журнал", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  heartbeats.accept(A, 90);
  heartbeats.accept(B, 90);

  const reader = stubReader({ [A]: 7n, [B]: 9n });
  await closeBuckets({ heartbeats, reader, currentBucket: 91 });

  const rows = heartbeats.listForEpoch(3);
  const byAccount = new Map(rows.map((r) => [r.account, r.balance]));
  assert.equal(byAccount.get(A), 7n);
  assert.equal(byAccount.get(B), 9n);
});

test("без незакрытых бакетов сеть не трогается", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  const reader = stubReader({});

  assert.equal(await closeBuckets({ heartbeats, reader, currentBucket: 5 }), 0);
  assert.equal(reader.calls.length, 0);
});
