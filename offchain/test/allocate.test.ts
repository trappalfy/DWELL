import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;
const C = "0xcccc000000000000000000000000000000000003" as Address;

function sum(m: ReadonlyMap<Address, bigint>): bigint {
  let total = 0n;
  for (const v of m.values()) total += v;
  return total;
}

test("равные веса делят релиз поровну", () => {
  const { allocations, dust } = allocate(100n, new Map([[A, 1n], [B, 1n]]));
  assert.equal(allocations.get(A), 50n);
  assert.equal(allocations.get(B), 50n);
  assert.equal(dust, 0n);
});

test("доли пропорциональны весам", () => {
  const { allocations } = allocate(900n, new Map([[A, 1n], [B, 2n]]));
  assert.equal(allocations.get(A), 300n);
  assert.equal(allocations.get(B), 600n);
});

test("остаток от деления сохраняется в пыли, а не исчезает", () => {
  const { allocations, dust } = allocate(10n, new Map([[A, 1n], [B, 1n], [C, 1n]]));
  assert.equal(sum(allocations) + dust, 10n);
  assert.equal(dust, 1n);
});

test("сумма долей плюс пыль всегда равна релизу", () => {
  const cases: Array<[bigint, Array<[Address, bigint]>]> = [
    [7n, [[A, 3n], [B, 5n], [C, 11n]]],
    [1n, [[A, 1n], [B, 1n]]],
    [10n ** 24n, [[A, 7n], [B, 13n], [C, 999n]]],
    [0n, [[A, 1n]]]
  ];
  for (const [release, entries] of cases) {
    const { allocations, dust } = allocate(release, new Map(entries));
    assert.equal(sum(allocations) + dust, release);
  }
});

test("нулевой суммарный вес отправляет весь релиз в пыль", () => {
  const { allocations, dust } = allocate(500n, new Map());
  assert.equal(allocations.size, 0);
  assert.equal(dust, 500n);
});

test("нулевые доли не попадают в результат", () => {
  // Вес A ничтожен против B: floor(100 * 1 / 1000001) = 0, поэтому A выпадает,
  // а B получает floor(100 * 1000000 / 1000001) = 99. Единица уходит в пыль.
  const { allocations, dust } = allocate(100n, new Map([[A, 1n], [B, 1_000_000n]]));
  assert.equal(allocations.has(A), false);
  assert.equal(allocations.get(B), 99n);
  assert.equal(dust, 1n);
});

test("релиз меньше числа претендентов целиком уходит в пыль", () => {
  // Ни одна доля не дотягивает до единицы — раздавать нечего, резерв цел
  const { allocations, dust } = allocate(1n, new Map([[A, 1n], [B, 1_000_000n]]));
  assert.equal(allocations.size, 0);
  assert.equal(dust, 1n);
});

test("округление всегда вниз, переаллокация невозможна", () => {
  const { allocations } = allocate(10n, new Map([[A, 1n], [B, 2n]]));
  assert.equal(allocations.get(A), 3n);
  assert.equal(allocations.get(B), 6n);
  assert.ok(sum(allocations) <= 10n);
});

test("отрицательный релиз отвергается", () => {
  assert.throws(() => allocate(-1n, new Map([[A, 1n]])), /negative/);
});
