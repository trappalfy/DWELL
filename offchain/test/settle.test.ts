import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/settle.ts";
import { RATE_WAD, WAD } from "../src/drip.ts";
import type { Address, HeartbeatRecord, SettlementInput } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

const MIN = 100_000n * 10n ** 18n;
const RESERVE = 1_000n * 10n ** 18n;

function hb(account: Address, bucketId: number, balance: bigint): HeartbeatRecord {
  return { account, bucketId, balance };
}

function input(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    epoch: 5_955_209,
    heartbeats: [hb(A, 0, MIN), hb(B, 0, MIN)],
    vault: { balance: RESERVE, totalAllocated: 0n, totalClaimed: 0n },
    minBalance: MIN,
    priorCumulative: new Map<Address, bigint>(),
    ...overrides
  };
}

test("релиз делится по весам и попадает в кумулятивы", () => {
  const result = settle(input());
  const expectedRelease = (RESERVE * RATE_WAD) / WAD;

  assert.equal(result.release, expectedRelease);
  assert.equal(result.totalWeight, MIN * 2n);
  assert.equal(result.cumulative.get(A), expectedRelease / 2n);
  assert.equal(result.cumulative.get(B), expectedRelease / 2n);
  assert.equal(result.totalAllocated, expectedRelease - result.dust);
});

test("кумулятивы прошлых эпох переносятся", () => {
  const prior = new Map<Address, bigint>([[A, 1_000n], [B, 2_000n]]);
  const result = settle(input({ priorCumulative: prior }));

  assert.ok(result.cumulative.get(A)! > 1_000n);
  assert.ok(result.cumulative.get(B)! > 2_000n);
});

test("без активных майнеров резерв не трогается", () => {
  const result = settle(input({ heartbeats: [] }));

  assert.equal(result.release, 0n);
  assert.equal(result.totalWeight, 0n);
  assert.equal(result.allocations.size, 0);
  assert.equal(result.dust, 0n);
  assert.equal(result.totalAllocated, 0n);
});

test("майнеры ниже порога не получают ничего", () => {
  const result = settle(input({ heartbeats: [hb(A, 0, MIN - 1n)] }));
  assert.equal(result.totalWeight, 0n);
  assert.equal(result.release, 0n);
});

test("totalAllocated растёт на распределённое, а не на релиз", () => {
  const vault = { balance: RESERVE, totalAllocated: 500n, totalClaimed: 200n };
  const result = settle(input({ vault, priorCumulative: new Map<Address, bigint>([[A, 500n]]) }));
  const distributed = result.release - result.dust;
  assert.equal(result.totalAllocated, 500n + distributed);
});

test("номер эпохи прокидывается в результат", () => {
  assert.equal(settle(input({ epoch: 42 })).epoch, 42);
});
