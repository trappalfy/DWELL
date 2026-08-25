import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/settle.ts";
import { sumEntitlements } from "../src/entitlements.ts";
import type { Address, HeartbeatRecord, VaultState } from "../src/types.ts";

const MIN = 100_000n * 10n ** 18n;
const ACCOUNTS: Address[] = [
  "0xaaaa000000000000000000000000000000000001",
  "0xbbbb000000000000000000000000000000000002",
  "0xcccc000000000000000000000000000000000003",
  "0xdddd000000000000000000000000000000000004"
] as Address[];

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomHeartbeats(rand: () => number, epoch: number): HeartbeatRecord[] {
  const records: HeartbeatRecord[] = [];
  const firstBucket = epoch * 30;
  for (const account of ACCOUNTS) {
    if (rand() < 0.3) continue;
    const buckets = 1 + Math.floor(rand() * 30);
    const multiple = BigInt(1 + Math.floor(rand() * 5));
    for (let i = 0; i < buckets; i++) {
      const balance = rand() < 0.15 ? MIN - 1n : MIN * multiple;
      records.push({ account, bucketId: firstBucket + i, balance });
    }
  }
  return records;
}

test("свойства сохраняются на 400 случайных эпохах", () => {
  for (let seed = 1; seed <= 4; seed++) {
    const rand = makeRandom(seed);

    let vault: VaultState = {
      balance: 5_000n * 10n ** 18n,
      totalAllocated: 0n,
      totalClaimed: 0n
    };
    let cumulative = new Map<Address, bigint>();
    let purchasedTotal = vault.balance;
    let previousTotalAllocated = 0n;
    let releasedEpochs = 0;

    for (let epoch = 1; epoch <= 100; epoch++) {
      const result = settle({
        epoch,
        heartbeats: randomHeartbeats(rand, epoch),
        vault,
        minBalance: MIN,
        priorCumulative: cumulative,
        // Растёт вместе с прогоном, поэтому сотня эпох проходит и через
        // окно запуска, и через режим полураспада за ним.
        releasedEpochs
      });
      if (result.release > 0n) releasedEpochs++;

      // 1. Ничего не создаётся и не теряется в пределах эпохи
      let distributed = 0n;
      for (const amount of result.allocations.values()) distributed += amount;
      assert.equal(distributed + result.dust, result.release, `эпоха ${epoch}: релиз разошёлся`);

      // 2. Кумулятив монотонно не убывает
      for (const [account, amount] of result.cumulative) {
        assert.ok(
          amount >= (cumulative.get(account) ?? 0n),
          `эпоха ${epoch}: кумулятив ${account} уменьшился`
        );
      }

      // 3. Сумма кумулятивов в точности равна totalAllocated
      assert.equal(
        sumEntitlements(result.cumulative),
        result.totalAllocated,
        `эпоха ${epoch}: кумулятивы разошлись с totalAllocated`
      );

      // 4. totalAllocated не убывает
      assert.ok(result.totalAllocated >= previousTotalAllocated, `эпоха ${epoch}: аллокация убыла`);

      // 5. Платёжеспособность: обещано не больше, чем лежит в вольте
      assert.ok(
        result.totalAllocated - vault.totalClaimed <= vault.balance,
        `эпоха ${epoch}: нарушена платёжеспособность`
      );

      // 6. Никогда не аллоцировано больше, чем всего куплено
      assert.ok(result.totalAllocated <= purchasedTotal, `эпоха ${epoch}: аллокация выше закупки`);

      previousTotalAllocated = result.totalAllocated;
      cumulative = new Map(result.cumulative);

      // Продвигаем состояние: иногда докупаем актив, иногда кто-то клеймит
      const purchase = rand() < 0.4 ? BigInt(Math.floor(rand() * 1e18)) : 0n;
      purchasedTotal += purchase;

      const outstanding = result.totalAllocated - vault.totalClaimed;
      const claim = rand() < 0.3 ? (outstanding * BigInt(Math.floor(rand() * 100))) / 100n : 0n;

      vault = {
        balance: vault.balance + purchase - claim,
        totalAllocated: result.totalAllocated,
        totalClaimed: vault.totalClaimed + claim
      };
    }
  }
});

test("детерминизм: одинаковый вход даёт одинаковый выход", () => {
  const heartbeats = randomHeartbeats(makeRandom(99), 7);
  const args = {
    epoch: 7,
    heartbeats,
    vault: { balance: 1_000n * 10n ** 18n, totalAllocated: 0n, totalClaimed: 0n },
    minBalance: MIN,
    priorCumulative: new Map<Address, bigint>(),
    releasedEpochs: 0
  };

  const first = settle(args);
  const second = settle(args);

  assert.equal(first.release, second.release);
  assert.equal(first.totalAllocated, second.totalAllocated);
  assert.deepEqual([...first.cumulative], [...second.cumulative]);
});
