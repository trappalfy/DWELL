import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulate, sumEntitlements } from "../src/entitlements.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

test("новый аккаунт получает свою аллокацию", () => {
  const next = accumulate(new Map(), new Map([[A, 10n]]));
  assert.equal(next.get(A), 10n);
});

test("аллокация прибавляется к прежнему кумулятиву", () => {
  const next = accumulate(new Map([[A, 10n]]), new Map([[A, 5n]]));
  assert.equal(next.get(A), 15n);
});

test("аккаунт без аллокации сохраняет кумулятив", () => {
  const next = accumulate(new Map([[A, 10n], [B, 7n]]), new Map([[A, 5n]]));
  assert.equal(next.get(A), 15n);
  assert.equal(next.get(B), 7n);
});

test("кумулятив монотонно не убывает", () => {
  let state = new Map<Address, bigint>();
  let previous = 0n;
  for (const amount of [3n, 0n, 11n, 0n, 1n]) {
    state = accumulate(state, amount > 0n ? new Map([[A, amount]]) : new Map());
    const current = state.get(A) ?? 0n;
    assert.ok(current >= previous);
    previous = current;
  }
  assert.equal(previous, 15n);
});

test("исходная карта не мутируется", () => {
  const prior = new Map([[A, 10n]]);
  accumulate(prior, new Map([[A, 5n]]));
  assert.equal(prior.get(A), 10n);
});

test("сумма кумулятивов равна сумме всех аллокаций", () => {
  let state = new Map<Address, bigint>();
  let expected = 0n;
  for (const [a, b] of [[3n, 4n], [5n, 0n], [0n, 9n]] as Array<[bigint, bigint]>) {
    const allocations = new Map<Address, bigint>();
    if (a > 0n) allocations.set(A, a);
    if (b > 0n) allocations.set(B, b);
    state = accumulate(state, allocations);
    expected += a + b;
  }
  assert.equal(sumEntitlements(state), expected);
});

test("отрицательная аллокация отвергается", () => {
  assert.throws(() => accumulate(new Map(), new Map([[A, -1n]])), /negative/);
});
