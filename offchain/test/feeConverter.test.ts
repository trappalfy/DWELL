import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { PurchaseStore } from "../src/db/purchases.ts";
import { convertFeesIfDue, GAS_RESERVE_WEI } from "../src/worker/feeConverter.ts";
import type { Address } from "../src/types.ts";

const VAULT = "0xeeee000000000000000000000000000000000003" as Address;
const KEEPER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const THRESHOLD = 3n * 10n ** 15n; // около $10 при ETH порядка $3000

function fixture(keeperBalance: bigint) {
  const db = openDatabase(":memory:");
  const purchases = new PurchaseStore(db);
  const swaps: Array<{ recipient: Address; amountIn: bigint }> = [];

  return {
    purchases,
    swaps,
    deps: {
      purchases,
      vaultAddress: VAULT,
      threshold: THRESHOLD,
      reader: { ethBalance: async () => keeperBalance },
      writer: {
        address: KEEPER,
        swapEthForReward: async (recipient: Address, amountIn: bigint) => {
          swaps.push({ recipient, amountIn });
          return { txHash: ("0x" + "ef".repeat(32)) as `0x${string}`, amountOut: amountIn * 6n };
        }
      },
      dryRun: false
    }
  };
}

test("ниже порога ничего не конвертируется", async () => {
  const { deps, swaps } = fixture(THRESHOLD + GAS_RESERVE_WEI - 1n);
  const outcome = await convertFeesIfDue(deps);
  assert.equal(outcome.converted, false);
  assert.equal(swaps.length, 0);
});

test("выше порога свопается всё сверх газового резерва", async () => {
  const balance = 10n ** 17n;
  const { deps, swaps } = fixture(balance);

  const outcome = await convertFeesIfDue(deps);

  assert.equal(outcome.converted, true);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0]!.amountIn, balance - GAS_RESERVE_WEI, "резерв на газ обязан остаться");
  assert.equal(swaps[0]!.recipient, VAULT, "TSLA идёт прямо в вольт");
});

test("покупка записывается в журнал", async () => {
  const balance = 10n ** 17n;
  const { deps, purchases } = fixture(balance);

  await convertFeesIfDue(deps);

  assert.equal(purchases.total().ethIn, balance - GAS_RESERVE_WEI);
  assert.ok(purchases.total().tslaOut > 0n);
});

test("газовый резерв никогда не уходит в своп", async () => {
  const { deps, swaps } = fixture(GAS_RESERVE_WEI);
  const outcome = await convertFeesIfDue(deps);
  assert.equal(outcome.converted, false, "весь баланс — это резерв, свопать нечего");
  assert.equal(swaps.length, 0);
});

test("dry-run считает сумму, но не свопает", async () => {
  const { deps, swaps, purchases } = fixture(10n ** 17n);
  const outcome = await convertFeesIfDue({ ...deps, dryRun: true });

  // assert.ok narrows the union; outcome.reason exists only on this branch.
  assert.ok(!outcome.converted);
  assert.match(outcome.reason, /dry-run/);
  assert.equal(swaps.length, 0);
  assert.equal(purchases.total().ethIn, 0n);
});
