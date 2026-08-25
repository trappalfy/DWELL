import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { EpochStore } from "../src/db/epochs.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

function fresh() {
  const db = openDatabase(":memory:");
  return {
    db,
    heartbeats: new HeartbeatStore(db),
    entitlements: new EntitlementStore(db),
    epochs: new EpochStore(db)
  };
}

test("приём хартбита идемпотентен по бакету", () => {
  const { heartbeats } = fresh();
  assert.equal(heartbeats.accept(A, 100), true);
  assert.equal(heartbeats.accept(A, 100), false, "повтор не должен создавать строку");
  assert.equal(heartbeats.accept(A, 101), true);
});

test("вторая фаза дозаполняет баланс и блок", () => {
  const { heartbeats } = fresh();
  heartbeats.accept(A, 100);
  heartbeats.accept(B, 100);

  heartbeats.fillBucket(100, 42_000_000, new Map([[A, 150n * 10n ** 18n], [B, 1n]]));

  const rows = heartbeats.listForEpoch(3);
  assert.equal(rows.length, 2);
  const byAccount = new Map(rows.map((r) => [r.account, r]));
  assert.equal(byAccount.get(A)!.balance, 150n * 10n ** 18n);
  assert.equal(byAccount.get(A)!.bucketId, 100);
  assert.equal(byAccount.get(B)!.balance, 1n);
});

test("wei переживает round-trip без потери точности", () => {
  const { heartbeats } = fresh();
  const huge = 123_456_789_012_345_678_901_234_567_890n;
  heartbeats.accept(A, 100);
  heartbeats.fillBucket(100, 1, new Map([[A, huge]]));
  assert.equal(heartbeats.listForEpoch(3)[0]!.balance, huge);
});

test("listForEpoch отдаёт только бакеты своей эпохи", () => {
  const { heartbeats } = fresh();
  // Эпоха 3 владеет бакетами 90..119
  heartbeats.accept(A, 89);
  heartbeats.accept(A, 90);
  heartbeats.accept(A, 119);
  heartbeats.accept(A, 120);
  for (const b of [89, 90, 119, 120]) heartbeats.fillBucket(b, 1, new Map([[A, 5n]]));

  const buckets = heartbeats.listForEpoch(3).map((r) => r.bucketId).sort((x, y) => x - y);
  assert.deepEqual(buckets, [90, 119]);
});

test("незаполненные бакеты видны, заполненные — нет", () => {
  const { heartbeats } = fresh();
  heartbeats.accept(A, 10);
  heartbeats.accept(A, 11);
  assert.deepEqual(heartbeats.pendingBuckets(12), [10, 11]);

  heartbeats.fillBucket(10, 1, new Map([[A, 5n]]));
  assert.deepEqual(heartbeats.pendingBuckets(12), [11]);
});

test("незаполненные хартбиты не попадают в выборку эпохи", () => {
  const { heartbeats } = fresh();
  heartbeats.accept(A, 90);
  assert.equal(heartbeats.listForEpoch(3).length, 0, "баланс ещё не прочитан");
});

test("кумулятивы сохраняются и читаются", () => {
  const { entitlements } = fresh();
  assert.equal(entitlements.load().size, 0);

  entitlements.save(new Map([[A, 10n ** 20n], [B, 7n]]));
  const loaded = entitlements.load();
  assert.equal(loaded.get(A), 10n ** 20n);
  assert.equal(loaded.get(B), 7n);

  entitlements.save(new Map([[A, 2n * 10n ** 20n], [B, 7n]]));
  assert.equal(entitlements.load().get(A), 2n * 10n ** 20n);
});

test("эпоха отмечается сеттленной и не задваивается", () => {
  const { epochs } = fresh();
  assert.equal(epochs.lastSettled(), null);

  epochs.markSettled(5_955_209, 1_000n, 42n);
  assert.equal(epochs.lastSettled(), 5_955_209);

  assert.throws(() => epochs.markSettled(5_955_209, 1n, 1n), /already settled/);
});

test("схема применяется повторно без ошибки", () => {
  const db = openDatabase(":memory:");
  assert.doesNotThrow(() => new HeartbeatStore(db));
});

test("счёт посчитанных эпох ведётся строками, а не вычитанием номеров", () => {
  const { epochs } = fresh();
  // Номера эпох выводятся из unix-времени и идут миллионами: разность двух
  // номеров измеряет время, а не объём посчитанной работы.
  epochs.markSettled(5_955_209, 1n, 1n);
  epochs.markSettled(5_955_210, 1n, 1n);

  assert.equal(epochs.countSettledAfter(null), 2, "с нуля считаются все строки");
  assert.equal(epochs.countSettledAfter(5_955_209), 1);
  assert.equal(epochs.countSettledAfter(5_955_210), 0);
});

test("пропуск эпох не завышает счёт", () => {
  const { epochs } = fresh();
  epochs.markSettled(100, 1n, 1n);
  epochs.markSettled(900, 1n, 1n);
  assert.equal(epochs.countSettledAfter(null), 2, "дыра от простоя не считается работой");
});

test("недоступный путь к базе называет сам путь", () => {
  // SQLite сообщает только «unable to open database file», по которому
  // оператор не поймёт, какой путь оказался неверным.
  assert.throws(
    () => openDatabase("/definitely/not/a/directory/dwell.db"),
    /cannot open database at \/definitely\/not\/a\/directory\/dwell\.db/
  );
});

test("countReleasing считает только эпохи, в которых что-то раздали", () => {
  const { epochs } = fresh();

  epochs.markSettled(5_955_209, 1_000n, 42n); // майнили и раздали
  epochs.markSettled(5_955_210, 0n, 0n); // никого не было
  epochs.markSettled(5_955_211, 700n, 0n); // майнили, но вольт пуст
  epochs.markSettled(5_955_212, 500n, 21n); // майнили и раздали

  assert.equal(epochs.countSettledAfter(null), 4, "закрыты все четыре эпохи");
  assert.equal(epochs.countReleasing(), 2, "окно расходует только настоящая выплата");
});
