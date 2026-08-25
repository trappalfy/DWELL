import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { EpochStore } from "../src/db/epochs.ts";
import { settleEpoch } from "../src/worker/settleJob.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;
const VAULT = "0xeeee000000000000000000000000000000000003" as Address;
const MIN = 100n;

function fixture(balance: bigint) {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  const entitlements = new EntitlementStore(db);
  const epochs = new EpochStore(db);

  const reader = {
    vaultState: async () => ({ balance, totalAllocated: 0n, totalClaimed: 0n })
  };

  return {
    heartbeats,
    entitlements,
    epochs,
    deps: { heartbeats, entitlements, epochs, reader, vaultAddress: VAULT, minBalance: MIN }
  };
}

test("эпоха без хартбитов ничего не начисляет, но закрывается", async () => {
  const { deps, epochs } = fixture(10n ** 21n);
  const result = await settleEpoch(deps, 3);

  assert.equal(result.totalWeight, 0n);
  assert.equal(result.release, 0n);
  assert.equal(epochs.lastSettled(), 3, "пустая эпоха всё равно закрывается");
});

test("начисления попадают в кумулятивы", async () => {
  const { deps, heartbeats, entitlements } = fixture(10n ** 21n);
  heartbeats.accept(A, 90);
  heartbeats.accept(B, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n], [B, 100n]]));

  const result = await settleEpoch(deps, 3);

  assert.ok(result.release > 0n, "резерв должен выпустить награду");
  const stored = entitlements.load();
  assert.equal(stored.get(A), result.allocations.get(A));
  assert.ok(stored.get(A)! > stored.get(B)!, "больший баланс получает больше");
});

test("аккаунты ниже минимального баланса не участвуют", async () => {
  const { deps, heartbeats, entitlements } = fixture(10n ** 21n);
  heartbeats.accept(A, 90);
  heartbeats.accept(B, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n], [B, 99n]]));

  await settleEpoch(deps, 3);
  assert.equal(entitlements.load().has(B), false, "баланс 99 ниже порога 100");
});

test("кумулятивы накапливаются между эпохами", async () => {
  const { deps, heartbeats, entitlements } = fixture(10n ** 21n);
  heartbeats.accept(A, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n]]));
  await settleEpoch(deps, 3);
  const first = entitlements.load().get(A)!;

  heartbeats.accept(A, 120);
  heartbeats.fillBucket(120, 1, new Map([[A, 300n]]));
  await settleEpoch(deps, 4);
  const second = entitlements.load().get(A)!;

  assert.ok(second > first, "кумулятив обязан расти, а не заменяться");
});

test("повторный сеттлмент эпохи отвергается", async () => {
  const { deps, heartbeats } = fixture(10n ** 21n);
  heartbeats.accept(A, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n]]));

  await settleEpoch(deps, 3);
  await assert.rejects(() => settleEpoch(deps, 3), /already settled/);
});

test("сеттлмент детерминирован на тех же данных", async () => {
  const build = () => {
    const f = fixture(10n ** 21n);
    f.heartbeats.accept(A, 90);
    f.heartbeats.accept(B, 91);
    f.heartbeats.fillBucket(90, 1, new Map([[A, 500n]]));
    f.heartbeats.fillBucket(91, 1, new Map([[B, 700n]]));
    return f.deps;
  };

  const left = await settleEpoch(build(), 3);
  const right = await settleEpoch(build(), 3);

  assert.equal(left.totalAllocated, right.totalAllocated);
  assert.deepEqual([...left.cumulative], [...right.cumulative]);
});

test("первая намайненная эпоха отдаёт ровно 1/24 банка", async () => {
  const bank = 86_400_000_000_000_000n; // 0.0864 TSLA
  const { deps, heartbeats } = fixture(bank);
  heartbeats.accept(A, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n]]));

  const result = await settleEpoch(deps, 3);

  assert.equal(result.release, bank / 24n, "окно запуска, а не полураспад");
});

test("пустые эпохи не расходуют окно запуска", async () => {
  const bank = 86_400_000_000_000_000n;
  const { deps, heartbeats } = fixture(bank);

  // Десять эпох подряд никого не было — они закрываются, но окно не трогают.
  for (let epoch = 3; epoch < 13; epoch++) await settleEpoch(deps, epoch);

  heartbeats.accept(A, 390);
  heartbeats.fillBucket(390, 1, new Map([[A, 300n]]));
  const result = await settleEpoch(deps, 13);

  assert.equal(result.release, bank / 24n, "доля та же, что была бы в первой эпохе");
});


test("майнинг при пустом вольте окно запуска не расходует", async () => {
  const bank = 86_400_000_000_000_000n;
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  const entitlements = new EntitlementStore(db);
  const epochs = new EpochStore(db);

  const vault = { balance: 0n, totalAllocated: 0n, totalClaimed: 0n };
  const deps = {
    heartbeats,
    entitlements,
    epochs,
    reader: { vaultState: async () => vault },
    vaultAddress: VAULT,
    minBalance: MIN
  };

  // Пять эпох люди держат вкладку, но вольт ещё не заряжен.
  for (let epoch = 3; epoch < 8; epoch++) {
    heartbeats.accept(A, epoch * 30);
    heartbeats.fillBucket(epoch * 30, 1, new Map([[A, 300n]]));
    const dry = await settleEpoch(deps, epoch);
    assert.equal(dry.release, 0n, "пустой вольт ничего не раздаёт");
  }
  assert.equal(entitlements.load().size, 0, "и ничего никому не начисляет");

  // Вольт заряжают — раздача обязана начаться с первой доли, а не с середины.
  vault.balance = bank;
  heartbeats.accept(A, 8 * 30);
  heartbeats.fillBucket(8 * 30, 1, new Map([[A, 300n]]));
  const first = await settleEpoch(deps, 8);

  assert.equal(first.release, bank / 24n, "окно открывается заливкой вольта");
});
