import { test } from "node:test";
import assert from "node:assert/strict";
import { WAD, RATE_WAD, HALF_LIFE_EPOCHS, unallocated, computeRelease } from "../src/drip.ts";
import type { VaultState } from "../src/types.ts";

function vault(balance: bigint, allocated: bigint, claimed: bigint): VaultState {
  return { balance, totalAllocated: allocated, totalClaimed: claimed };
}

const SOME_WEIGHT = 1_000n;

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
  assert.equal(computeRelease(vault(reserve, 0n, 0n), SOME_WEIGHT), RATE_WAD);
});

test("без активного веса релиз не происходит", () => {
  assert.equal(computeRelease(vault(10n ** 24n, 0n, 0n), 0n), 0n);
});

test("релиз никогда не превышает свободный резерв", () => {
  for (const reserve of [1n, 7n, 10n ** 6n, 10n ** 24n]) {
    const v = vault(reserve, 0n, 0n);
    assert.ok(computeRelease(v, SOME_WEIGHT) <= unallocated(v));
  }
});

test("пустой резерв даёт нулевой релиз", () => {
  assert.equal(computeRelease(vault(0n, 0n, 0n), SOME_WEIGHT), 0n);
});

test("ставка воспроизводит полураспад в три дня", () => {
  const start = 10n ** 24n;
  let reserve = start;
  for (let i = 0; i < HALF_LIFE_EPOCHS; i++) {
    reserve -= computeRelease(vault(reserve, 0n, 0n), SOME_WEIGHT);
  }
  // Целочисленная математика: допуск в одну сотую процента
  const permille = (reserve * 10_000n) / start;
  assert.ok(permille >= 4_999n && permille <= 5_001n, `осталось ${permille} из 10000`);
});

test("ставка меньше единицы, резерв не обнуляется за один шаг", () => {
  assert.ok(RATE_WAD < WAD);
  assert.equal(HALF_LIFE_EPOCHS, 864);
});
