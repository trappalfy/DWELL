import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { ChallengeStore, CHALLENGE_TTL_MS } from "../src/auth/challenge.ts";
import { SessionStore, SESSION_TTL_MS } from "../src/auth/sessions.ts";
import type { Address } from "../src/types.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const signer = privateKeyToAccount(KEY);
const ACCOUNT = signer.address.toLowerCase() as Address;
const OTHER = "0xbbbb000000000000000000000000000000000002" as Address;

const T0 = 1_787_000_000_000;

test("челлендж содержит адрес и одноразовый идентификатор", () => {
  const store = new ChallengeStore();
  const first = store.issue(ACCOUNT, T0);
  const second = store.issue(ACCOUNT, T0);

  assert.notEqual(first.id, second.id, "идентификатор обязан быть одноразовым");
  assert.ok(first.message.includes(ACCOUNT), "адрес должен входить в подписываемый текст");
  assert.ok(first.message.includes(first.id), "идентификатор должен входить в текст");
  assert.equal(first.expiresAt, T0 + CHALLENGE_TTL_MS);
});

test("челлендж расходуется ровно один раз", () => {
  const store = new ChallengeStore();
  const challenge = store.issue(ACCOUNT, T0);

  assert.equal(store.consume(challenge.id, T0 + 1_000)?.account, ACCOUNT);
  assert.equal(store.consume(challenge.id, T0 + 1_000), null, "повторное использование запрещено");
});

test("просроченный челлендж отвергается", () => {
  const store = new ChallengeStore();
  const challenge = store.issue(ACCOUNT, T0);
  assert.equal(store.consume(challenge.id, T0 + CHALLENGE_TTL_MS + 1), null);
});

test("подпись челленджа проверяется настоящим кошельком", async () => {
  const store = new ChallengeStore();
  const challenge = store.issue(ACCOUNT, T0);
  const signature = await signer.signMessage({ message: challenge.message });

  assert.equal(
    await verifyMessage({ address: signer.address, message: challenge.message, signature }),
    true
  );
  assert.equal(
    await verifyMessage({ address: OTHER, message: challenge.message, signature }),
    false,
    "чужой адрес не должен проходить"
  );
});

test("сессия выдаётся и разрешается в адрес", () => {
  const store = new SessionStore();
  const token = store.open(ACCOUNT, T0);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(store.resolve(token, T0 + 1_000), ACCOUNT);
});

test("новая сессия вытесняет прежнюю у того же кошелька", () => {
  const store = new SessionStore();
  const first = store.open(ACCOUNT, T0);
  const second = store.open(ACCOUNT, T0 + 1);

  assert.equal(store.resolve(first, T0 + 2), null, "старая сессия обязана закрыться");
  assert.equal(store.resolve(second, T0 + 2), ACCOUNT);
});

test("протухшая сессия не разрешается", () => {
  const store = new SessionStore();
  const token = store.open(ACCOUNT, T0);
  assert.equal(store.resolve(token, T0 + SESSION_TTL_MS + 1), null);
});

test("touch продлевает сессию", () => {
  const store = new SessionStore();
  const token = store.open(ACCOUNT, T0);
  store.touch(token, T0 + SESSION_TTL_MS - 1);
  assert.equal(store.resolve(token, T0 + SESSION_TTL_MS + 1), ACCOUNT);
});

test("закрытая сессия не разрешается", () => {
  const store = new SessionStore();
  const token = store.open(ACCOUNT, T0);
  store.close(token);
  assert.equal(store.resolve(token, T0 + 1), null);
});

test("неизвестный токен не разрешается", () => {
  const store = new SessionStore();
  assert.equal(store.resolve("0".repeat(64), T0), null);
});
