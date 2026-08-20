import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeights, sumWeights } from "../src/weights.ts";
import type { Address, HeartbeatRecord } from "../src/types.ts";

const ALICE = "0xaaaa000000000000000000000000000000000001" as Address;
const BOB = "0xbbbb000000000000000000000000000000000002" as Address;

const MIN = 100_000n * 10n ** 18n;
const HELD = 150_000n * 10n ** 18n;

function hb(account: Address, bucketId: number, balance: bigint): HeartbeatRecord {
  return { account, bucketId, balance };
}

test("вес есть сумма балансов по активным бакетам", () => {
  const w = computeWeights([hb(ALICE, 1, HELD), hb(ALICE, 2, HELD), hb(ALICE, 3, HELD)], MIN);
  assert.equal(w.get(ALICE), HELD * 3n);
});

test("изменение баланса внутри эпохи учитывается побакетно", () => {
  const later = 200_000n * 10n ** 18n;
  const w = computeWeights([hb(ALICE, 1, HELD), hb(ALICE, 2, later)], MIN);
  assert.equal(w.get(ALICE), HELD + later);
});

test("баланс ниже порога не даёт веса", () => {
  const low = 99_999n * 10n ** 18n;
  const w = computeWeights([hb(ALICE, 1, low), hb(ALICE, 2, HELD)], MIN);
  assert.equal(w.get(ALICE), HELD);
});

test("аккаунт без единого проходного бакета отсутствует в результате", () => {
  const low = 1n;
  const w = computeWeights([hb(ALICE, 1, low)], MIN);
  assert.equal(w.has(ALICE), false);
});

test("ровно пороговый баланс проходит", () => {
  const w = computeWeights([hb(ALICE, 1, MIN)], MIN);
  assert.equal(w.get(ALICE), MIN);
});

test("веса разных аккаунтов не смешиваются", () => {
  const w = computeWeights([hb(ALICE, 1, HELD), hb(BOB, 1, MIN), hb(BOB, 2, MIN)], MIN);
  assert.equal(w.get(ALICE), HELD);
  assert.equal(w.get(BOB), MIN * 2n);
});

test("дробление баланса по кошелькам не даёт преимущества", () => {
  const whole = computeWeights([hb(ALICE, 1, MIN * 2n)], MIN);
  const split = computeWeights([hb(ALICE, 1, MIN), hb(BOB, 1, MIN)], MIN);
  assert.equal(sumWeights(whole), sumWeights(split));
});

test("пустой журнал даёт нулевой суммарный вес", () => {
  assert.equal(sumWeights(computeWeights([], MIN)), 0n);
});

test("повторный бакет одного аккаунта отвергается", () => {
  assert.throws(
    () => computeWeights([hb(ALICE, 1, HELD), hb(ALICE, 1, HELD)], MIN),
    /duplicate bucket/
  );
});
