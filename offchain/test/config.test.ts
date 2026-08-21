import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADDRESSES,
  CHAIN_ID,
  POOL_FEE,
  SLIPPAGE_BPS,
  loadRuntimeConfig,
  loadWorkerConfig
} from "../src/config.ts";

const VALID_ENV = {
  RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  REWARD_VAULT: "0xEeed234B30e9331ca8F540f42860a944F411b3DC",
  MIN_BALANCE: "100000",
  PROJECT_TOKEN: "0xdddd000000000000000000000000000000000004",
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

const WORKER_ENV = {
  ...VALID_ENV,
  KEEPER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
};

test("dry-run включён по умолчанию", () => {
  // Забытая переменная обязана давать безопасное состояние: публикация
  // двигает реальные деньги, поэтому включаться она должна намеренно.
  assert.equal(loadWorkerConfig(WORKER_ENV).dryRun, true);
  const { DRY_RUN, ...withoutFlag } = { ...WORKER_ENV, DRY_RUN: "false" };
  assert.equal(loadWorkerConfig(withoutFlag).dryRun, true);
});

test("dry-run снимается только точной строкой false", () => {
  assert.equal(loadWorkerConfig({ ...WORKER_ENV, DRY_RUN: "false" }).dryRun, false);
  for (const sloppy of ["true", "0", "no", "FALSE", ""]) {
    assert.equal(
      loadWorkerConfig({ ...WORKER_ENV, DRY_RUN: sloppy }).dryRun,
      true,
      `значение ${JSON.stringify(sloppy)} не должно снимать защиту`
    );
  }
});

test("кривой приватный ключ отвергается без утечки значения", () => {
  const bad = { ...WORKER_ENV, KEEPER_PRIVATE_KEY: "0xdeadbeef" };
  assert.throws(
    () => loadWorkerConfig(bad),
    (error: Error) => {
      assert.match(error.message, /KEEPER_PRIVATE_KEY/);
      assert.ok(!error.message.includes("0xdeadbeef"), "ключ не должен попадать в текст ошибки");
      return true;
    }
  );
});

test("отсутствующий ключ кипера отвергается", () => {
  const { KEEPER_PRIVATE_KEY, ...without } = WORKER_ENV;
  assert.throws(() => loadWorkerConfig(without), /KEEPER_PRIVATE_KEY/);
});

test("порог конвертации по умолчанию около двух долларов", () => {
  // Фонд маленький, и при пороге в $10 первые комиссии зависли бы на кипере,
  // не дойдя до конвертации. Глубина пула это позволяет: покупка на $10
  // съедала 0.79% WETH-стороны, на $2 — около 0.16%.
  assert.equal(loadWorkerConfig(WORKER_ENV).conversionThreshold, 1_000_000_000_000_000n);
  assert.equal(
    loadWorkerConfig({ ...WORKER_ENV, CONVERSION_THRESHOLD_WEI: "5" }).conversionThreshold,
    5n
  );
});

test("адрес токена проекта обязателен", () => {
  // Пока его нет, вес считался бы по TSLA: майнили бы держатели Tesla,
  // а держатели токена проекта не получали бы ничего. Лучше не подняться.
  const { PROJECT_TOKEN, ...without } = VALID_ENV;
  assert.throws(() => loadRuntimeConfig(without), /PROJECT_TOKEN/);
});

test("токен проекта и актив награды — разные поля", () => {
  const config = loadRuntimeConfig(VALID_ENV);
  assert.equal(config.projectToken, "0xdddd000000000000000000000000000000000004");
  assert.notEqual(config.projectToken, ADDRESSES.tsla, "вес считается по своему токену, награда — в TSLA");
});
