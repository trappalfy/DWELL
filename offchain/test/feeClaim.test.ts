import { test } from "node:test";
import assert from "node:assert/strict";
import { claimFeesIfDue } from "../src/worker/feeClaim.ts";
import { ADDRESSES } from "../src/config.ts";
import type { Address } from "../src/types.ts";

const KEEPER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const PROJECT = "0xdddd000000000000000000000000000000000001" as Address;
const TX = ("0x" + "ab".repeat(32)) as `0x${string}`;

/**
 * balances is keyed by token so a test can hand the keeper a WETH balance and
 * a project-token balance at once — the point of several of these cases is
 * that only one of the two is ever touched.
 */
function fixture(options: {
  balances: Partial<Record<Address, bigint>>;
  collectReturns?: `0x${string}` | null;
  dryRun?: boolean;
}) {
  const collected: Address[] = [];
  const unwrapped: bigint[] = [];

  return {
    collected,
    unwrapped,
    deps: {
      projectToken: PROJECT,
      reader: {
        tokenBalance: async (token: Address) => options.balances[token] ?? 0n
      },
      writer: {
        address: KEEPER,
        collectCreatorFees: async (token: Address) => {
          collected.push(token);
          return options.collectReturns === undefined ? TX : options.collectReturns;
        },
        unwrapWeth: async (amount: bigint) => {
          unwrapped.push(amount);
          return TX;
        }
      },
      dryRun: options.dryRun ?? false
    }
  };
}

test("сухой прогон не забирает и не разворачивает ничего", async () => {
  const { deps, collected, unwrapped } = fixture({
    balances: { [ADDRESSES.weth]: 10n ** 16n },
    dryRun: true
  });

  const outcome = await claimFeesIfDue(deps);

  assert.equal(outcome.claimed, false);
  assert.equal(collected.length, 0, "сухой прогон не шлёт транзакций");
  assert.equal(unwrapped.length, 0);
});

test("комиссии забираются по адресу проектного токена", async () => {
  const { deps, collected } = fixture({ balances: { [ADDRESSES.weth]: 10n ** 16n } });

  await claimFeesIfDue(deps);

  assert.deepEqual(collected, [PROJECT], "собирать надо по нашему токену, а не по наградному");
});

test("разворачивается весь баланс WETH", async () => {
  const balance = 7n * 10n ** 15n;
  const { deps, unwrapped } = fixture({ balances: { [ADDRESSES.weth]: balance } });

  const outcome = await claimFeesIfDue(deps);

  assert.equal(outcome.claimed, true);
  assert.deepEqual(unwrapped, [balance]);
});

test("пустой сбор не мешает развернуть остаток с прошлого раза", async () => {
  const balance = 3n * 10n ** 15n;
  const { deps, unwrapped } = fixture({
    balances: { [ADDRESSES.weth]: balance },
    collectReturns: null
  });

  const outcome = await claimFeesIfDue(deps);

  assert.equal(outcome.claimed, true, "остаток WETH обязан доехать даже без нового сбора");
  assert.deepEqual(unwrapped, [balance]);
});

test("когда WETH нет, ничего не разворачивается", async () => {
  const { deps, unwrapped } = fixture({ balances: {}, collectReturns: null });

  const outcome = await claimFeesIfDue(deps);

  assert.equal(outcome.claimed, false);
  assert.equal(unwrapped.length, 0, "разворот нуля — это транзакция впустую");
});

test("проектный токен не трогается — он копится", async () => {
  const weth = 2n * 10n ** 15n;
  const { deps, unwrapped } = fixture({
    balances: { [ADDRESSES.weth]: weth, [PROJECT]: 500n * 10n ** 18n }
  });

  await claimFeesIfDue(deps);

  assert.deepEqual(unwrapped, [weth], "разворачивается только WETH, накопленный $DWELL остаётся лежать");
});
