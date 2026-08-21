import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ChainReader } from "../src/chain/reader.ts";
import { ADDRESSES } from "../src/config.ts";
import type { Address } from "../src/types.ts";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const POOL = ADDRESSES.wethTslaPool;
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
const EMPTY = "0x0000000000000000000000000000000000000001" as Address;
const LIVE_VAULT = "0xEeed234B30e9331ca8F540f42860a944F411b3DC" as Address;

/**
 * Measured against the live node: historical state survives between 6000 and
 * 8000 blocks, which at ~100ms per block is only 10-13 minutes. This RPC is
 * pruned, not archival. Bucket closing must therefore stay near the head — a
 * worker that falls further behind cannot recover what those balances were.
 */
const RETENTION_BLOCKS = 6_000n;

let reader: ChainReader;
let online = false;

before(async () => {
  // Настоящего токена проекта ещё нет; для интеграционного теста годится
  // любой живой ERC20 с держателями, поэтому берём TSLA.
  reader = new ChainReader(RPC, ADDRESSES.tsla);
  try {
    await reader.currentBlock();
    online = true;
  } catch {
    online = false;
  }
});

test("multicall возвращает балансы в порядке запроса", async (t) => {
  if (!online) return t.skip("RPC недоступен");
  const accounts = [POOL, POOL_MANAGER, EMPTY];
  const balances = await reader.balancesAt(accounts);

  assert.equal(balances.size, 3);
  assert.ok(balances.get(POOL)! > 0n, "в пуле должна быть TSLA");
  assert.ok(balances.get(POOL_MANAGER)! > 0n, "в PoolManager должна быть TSLA");
  assert.equal(balances.get(EMPTY), 0n);
});

test("пустой список аккаунтов не ходит в сеть", async () => {
  const balances = await reader.balancesAt([]);
  assert.equal(balances.size, 0);
});

test("баланс читается на закреплённом блоке", async (t) => {
  if (!online) return t.skip("RPC недоступен");
  const head = await reader.currentBlock();
  const past = await reader.balancesAt([POOL], head - 100n);
  assert.equal(typeof past.get(POOL), "bigint");
});

test("окно хранения состояния покрывает отставание воркера", async (t) => {
  if (!online) return t.skip("RPC недоступен");
  const head = await reader.currentBlock();
  const balances = await reader.balancesAt([POOL], head - RETENTION_BLOCKS);
  assert.equal(typeof balances.get(POOL), "bigint");
});

test("состояние вольта читается тремя полями", async (t) => {
  if (!online) return t.skip("RPC недоступен");
  const state = await reader.vaultState(LIVE_VAULT);
  assert.equal(typeof state.balance, "bigint");
  assert.equal(typeof state.totalAllocated, "bigint");
  assert.equal(typeof state.totalClaimed, "bigint");
  assert.ok(state.totalAllocated >= state.totalClaimed, "начислено не меньше заклеймленного");
});
