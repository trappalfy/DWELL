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
  const result = await closeBuckets({ heartbeats, reader, currentBucket: 11 });

  assert.equal(result.closed, 1, "текущий бакет ещё принимает хартбиты");
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

  assert.deepEqual(await closeBuckets({ heartbeats, reader, currentBucket: 5 }), {
    closed: 0,
    discarded: 0
  });
  assert.equal(reader.calls.length, 0);
});

test("отставший бакет не заполняется сегодняшним балансом", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  // Бакет 900 отстал на 100 тактов — больше двух эпох.
  heartbeats.accept(A, 900);

  const reader = stubReader({ [A]: 5n });
  const result = await closeBuckets({ heartbeats, reader, currentBucket: 1000 });

  assert.equal(result.closed, 0, "заполнять его текущим балансом нельзя");
  assert.equal(result.discarded, 1);
  assert.equal(reader.calls.length, 0, "и спрашивать балансы незачем");
});

test("отставший бакет не остаётся в очереди навсегда", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  heartbeats.accept(A, 900);

  const reader = stubReader({ [A]: 5n });
  await closeBuckets({ heartbeats, reader, currentBucket: 1000 });

  assert.deepEqual(heartbeats.pendingBuckets(1000), [], "иначе он всплывал бы каждый тик");
  assert.deepEqual(heartbeats.listForEpoch(30), [], "и не даёт веса ни на грамм");
});

test("бакет, отставший в пределах допуска, всё ещё закрывается", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  // 50 тактов позади — меньше двух эпох, короткая заминка воркера.
  heartbeats.accept(A, 950);

  const reader = stubReader({ [A]: 5n });
  const result = await closeBuckets({ heartbeats, reader, currentBucket: 1000 });

  assert.equal(result.closed, 1, "короткая задержка не обязана стоить майнеру бакета");
  assert.equal(result.discarded, 0);
});
