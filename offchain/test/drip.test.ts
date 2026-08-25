import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WAD,
  RATE_WAD,
  HALF_LIFE_EPOCHS,
  LAUNCH_WINDOW_EPOCHS,
  unallocated,
  computeRelease
} from "../src/drip.ts";
import type { VaultState } from "../src/types.ts";

function vault(balance: bigint, allocated: bigint, claimed: bigint): VaultState {
  return { balance, totalAllocated: allocated, totalClaimed: claimed };
}

const SOME_WEIGHT = 1_000n;

// Окно запуска позади: действует установившийся режим полураспада.
const AFTER_WINDOW = LAUNCH_WINDOW_EPOCHS;

test("свободный резерв есть баланс минус непогашенные обязательства", () => {
  assert.equal(unallocated(vault(100n, 0n, 0n)), 100n);
  assert.equal(unallocated(vault(100n, 40n, 0n)), 60n);
  // 40 начислено, 25 уже забрано: баланс упал на 25, долг остался 15
  assert.equal(unallocated(vault(75n, 40n, 25n)), 60n);
});

test("нарушенная платёжеспособность отвергается", () => {
  assert.throws(() => unallocated(vault(10n, 100n, 0n)), /insolvent/);
});

test("релиз есть доля свободного резерва", () => {
  const reserve = 10n ** 18n;
  assert.equal(computeRelease(vault(reserve, 0n, 0n), SOME_WEIGHT, AFTER_WINDOW), RATE_WAD);
});

test("без активного веса релиз не происходит", () => {
  assert.equal(computeRelease(vault(10n ** 24n, 0n, 0n), 0n, AFTER_WINDOW), 0n);
});

test("релиз никогда не превышает свободный резерв", () => {
  for (const reserve of [1n, 7n, 10n ** 6n, 10n ** 24n]) {
    const v = vault(reserve, 0n, 0n);
    // Обязано держаться в обоих режимах: и внутри окна запуска, и после него.
    for (const mined of [0, 1, LAUNCH_WINDOW_EPOCHS - 1, AFTER_WINDOW]) {
      assert.ok(computeRelease(v, SOME_WEIGHT, mined) <= unallocated(v), `mined=${mined}`);
    }
  }
});

test("пустой резерв даёт нулевой релиз", () => {
  assert.equal(computeRelease(vault(0n, 0n, 0n), SOME_WEIGHT, AFTER_WINDOW), 0n);
});

test("ставка воспроизводит полураспад в одни сутки", () => {
  const start = 10n ** 24n;
  let reserve = start;
  for (let i = 0; i < HALF_LIFE_EPOCHS; i++) {
    reserve -= computeRelease(vault(reserve, 0n, 0n), SOME_WEIGHT, AFTER_WINDOW);
  }
  // Целочисленная математика: допуск в одну сотую процента
  const permille = (reserve * 10_000n) / start;
  assert.ok(permille >= 4_999n && permille <= 5_001n, `осталось ${permille} из 10000`);
});

test("ставка меньше единицы, резерв не обнуляется за один шаг", () => {
  assert.ok(RATE_WAD < WAD);
  assert.equal(HALF_LIFE_EPOCHS, 72, "шесть часов при эпохе в пять минут");
});

// --- окно запуска ---

const BANK = 86_400_000_000_000_000n; // 0.0864 TSLA — предзарядка вольта

test("в окне запуска эпоха отдаёт равную долю банка", () => {
  const release = computeRelease(vault(BANK, 0n, 0n), SOME_WEIGHT, 0);
  assert.equal(release, BANK / BigInt(LAUNCH_WINDOW_EPOCHS));
});

test("окно запуска раздаёт банк целиком, без хвоста", () => {
  let free = BANK;
  let released = 0n;
  for (let mined = 0; mined < LAUNCH_WINDOW_EPOCHS; mined++) {
    const release = computeRelease(vault(free, 0n, 0n), SOME_WEIGHT, mined);
    free -= release;
    released += release;
  }
  assert.equal(released, BANK, "за окно раздаётся весь банк");
  assert.equal(free, 0n, "остатка не остаётся");
});

test("последняя эпоха окна отдаёт весь остаток", () => {
  const remainder = 12_345n;
  const release = computeRelease(vault(remainder, 0n, 0n), SOME_WEIGHT, LAUNCH_WINDOW_EPOCHS - 1);
  assert.equal(release, remainder);
});

test("после окна запуска действует прежний полураспад", () => {
  const reserve = 10n ** 18n;
  const release = computeRelease(vault(reserve, 0n, 0n), SOME_WEIGHT, LAUNCH_WINDOW_EPOCHS);
  assert.equal(release, RATE_WAD, "доля от остатка, а не доля банка");
});

test("пустая эпоха окно не расходует", () => {
  assert.equal(computeRelease(vault(BANK, 0n, 0n), 0n, 0), 0n);
});

test("долив комиссий внутри окна расходится по оставшимся эпохам", () => {
  // На середине окна в вольт приходит столько же, сколько было изначально.
  const half = LAUNCH_WINDOW_EPOCHS / 2;
  const free = BANK + BANK;
  const release = computeRelease(vault(free, 0n, 0n), SOME_WEIGHT, half);
  assert.equal(release, free / BigInt(LAUNCH_WINDOW_EPOCHS - half));
});
