import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDRESSES, CHAIN_ID, POOL_FEE, SLIPPAGE_BPS, loadRuntimeConfig } from "../src/config.ts";

const VALID_ENV = {
  RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  REWARD_VAULT: "0xEeed234B30e9331ca8F540f42860a944F411b3DC",
  MIN_BALANCE: "100000",
  DATABASE_PATH: "./dwell.db",
  PORT: "8787"
};

test("адреса закреплены и имеют корректный вид", () => {
  assert.equal(CHAIN_ID, 4663);
  for (const [name, value] of Object.entries(ADDRESSES)) {
    assert.match(value, /^0x[0-9a-fA-F]{40}$/, `${name} не похож на адрес`);
  }
  assert.equal(ADDRESSES.tsla, "0x322F0929c4625eD5bAd873c95208D54E1c003b2d");
  assert.equal(ADDRESSES.weth, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
  assert.equal(ADDRESSES.multicall3, "0xcA11bde05977b3631167028862bE2a173976CA11");
});

test("параметры свопа учитывают тир пула", () => {
  // Пул WETH/TSLA существует только в тире 0.3%
  assert.equal(POOL_FEE, 3000);
  // Комиссия 0.3% съедает треть однопроцентного бюджета, поэтому лимит выше
  assert.ok(SLIPPAGE_BPS > POOL_FEE / 100, "лимит проскальзывания не покрывает комиссию пула");
  assert.equal(SLIPPAGE_BPS, 200);
});

test("минимальный баланс разворачивается в wei", () => {
  const config = loadRuntimeConfig(VALID_ENV);
  assert.equal(config.minBalance, 100_000n * 10n ** 18n);
});

test("адрес вольта нормализуется и проверяется", () => {
  const config = loadRuntimeConfig(VALID_ENV);
  assert.equal(config.rewardVault, "0xEeed234B30e9331ca8F540f42860a944F411b3DC");
  assert.throws(
    () => loadRuntimeConfig({ ...VALID_ENV, REWARD_VAULT: "не адрес" }),
    /REWARD_VAULT/
  );
});

test("отсутствующая обязательная переменная отвергается", () => {
  const { REWARD_VAULT, ...without } = VALID_ENV;
  assert.throws(() => loadRuntimeConfig(without), /REWARD_VAULT/);
});

test("порт по умолчанию задан, путь к базе обязателен", () => {
  const { PORT, ...withoutPort } = VALID_ENV;
  assert.equal(loadRuntimeConfig(withoutPort).port, 8787);
  const { DATABASE_PATH, ...withoutDb } = VALID_ENV;
  assert.throws(() => loadRuntimeConfig(withoutDb), /DATABASE_PATH/);
});
