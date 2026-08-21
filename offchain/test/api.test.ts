import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { startServer } from "../src/server.ts";
import type { Address } from "../src/types.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const signer = privateKeyToAccount(KEY);
const ACCOUNT = signer.address.toLowerCase() as Address;
const MIN = 100_000n * 10n ** 18n;
const VAULT = "0xeeee000000000000000000000000000000000003" as Address;
const PROJECT_TOKEN = "0xdddd000000000000000000000000000000000004" as Address;

// Port 0 asks the OS for a free port, but the assignment is only readable
// after the "listening" event — reading address() synchronously races.
async function boot(balance: bigint, alreadyClaimed = 0n) {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  const entitlements = new EntitlementStore(db);
  const server = startServer(
    {
      heartbeats,
      entitlements,
      reader: {
        currentBlock: async () => 42_000_000n,
        balancesAt: async (accounts: readonly Address[]) =>
          new Map(accounts.map((a) => [a, balance])),
        claimed: async () => alreadyClaimed
      },
      minBalance: MIN,
      vaultAddress: VAULT,
      projectToken: PROJECT_TOKEN,
      now: () => Date.now()
    },
    0
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, base: `http://127.0.0.1:${port}`, entitlements };
}

// Responses are checked field by field below; a permissive shape keeps the
// assertions readable without re-declaring every payload.
type JsonBody = Record<string, any>;

async function post(
  base: string,
  path: string,
  body: unknown,
  token?: string
): Promise<{ status: number; json: JsonBody }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as JsonBody };
}

test("полный путь: челлендж, подпись, сессия, хартбит", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  const challenge = await post(base, "/v1/session/challenge", { account: ACCOUNT });
  assert.equal(challenge.status, 200);
  assert.ok(challenge.json.message.includes(ACCOUNT));

  const signature = await signer.signMessage({ message: challenge.json.message });
  const session = await post(base, "/v1/session/verify", {
    challengeId: challenge.json.challengeId,
    signature
  });
  assert.equal(session.status, 200);
  assert.match(session.json.sessionToken, /^[0-9a-f]{64}$/);

  const beat = await post(base, "/v1/heartbeat", {}, session.json.sessionToken);
  assert.equal(beat.status, 200);
  assert.equal(beat.json.accepted, true);
  assert.equal(typeof beat.json.bucketId, "number");
});

test("чужая подпись не даёт сессию", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  const challenge = await post(base, "/v1/session/challenge", { account: ACCOUNT });
  const other = privateKeyToAccount(
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
  );
  const signature = await other.signMessage({ message: challenge.json.message });

  const session = await post(base, "/v1/session/verify", {
    challengeId: challenge.json.challengeId,
    signature
  });
  assert.equal(session.status, 401);
});

test("хартбит без токена отвергается", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());
  assert.equal((await post(base, "/v1/heartbeat", {})).status, 401);
});

test("челлендж нельзя использовать дважды", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  const challenge = await post(base, "/v1/session/challenge", { account: ACCOUNT });
  const signature = await signer.signMessage({ message: challenge.json.message });
  const body = { challengeId: challenge.json.challengeId, signature };

  assert.equal((await post(base, "/v1/session/verify", body)).status, 200);
  assert.equal((await post(base, "/v1/session/verify", body)).status, 401);
});

test("stats отдаётся без авторизации", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  const response = await fetch(`${base}/v1/stats`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as JsonBody;
  assert.equal(typeof body.activeMiners, "number");
  assert.equal(typeof body.currentEpoch, "number");
});

test("неизвестный маршрут даёт 404", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/v1/nope`)).status, 404);
});

test("CORS-преflight отвечает", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());
  const response = await fetch(`${base}/v1/stats`, { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("config отдаёт адреса и пороги, которые фронт сам знать не может", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  const body = (await (await fetch(`${base}/v1/config`)).json()) as JsonBody;

  assert.equal(body.vault, VAULT);
  assert.equal(body.projectToken, PROJECT_TOKEN, "вес считается по токену проекта");
  assert.notEqual(body.rewardToken, body.projectToken, "награда — другой актив");
  assert.equal(body.minBalance, MIN.toString());
  assert.equal(body.epochSeconds, 300);
  assert.equal(body.bucketSeconds, 10);
  assert.equal(body.claimDelaySeconds, 300);
  assert.equal(body.publishEveryEpochs, 6);
});

test("me показывает баланс и право майнить", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  const body = (await (await fetch(`${base}/v1/me?account=${ACCOUNT}`)).json()) as JsonBody;

  assert.equal(body.balance, MIN.toString());
  assert.equal(body.eligible, true, "ровно порог уже допускает");
});

test("баланс ниже порога не даёт права майнить", async (t) => {
  const { server, base } = await boot(MIN - 1n);
  t.after(() => server.close());

  const body = (await (await fetch(`${base}/v1/me?account=${ACCOUNT}`)).json()) as JsonBody;

  assert.equal(body.eligible, false, "не хватает одного wei — уже нельзя");
  assert.equal(body.balance, (MIN - 1n).toString());
});

test("claimable есть кумулятив минус уже забранное", async (t) => {
  const { server, base, entitlements } = await boot(MIN, 40n);
  t.after(() => server.close());

  entitlements.save(new Map([[ACCOUNT, 100n]]));
  const body = (await (await fetch(`${base}/v1/me?account=${ACCOUNT}`)).json()) as JsonBody;

  assert.equal(body.cumulative, "100");
  assert.equal(body.claimed, "40");
  assert.equal(body.claimable, "60");
  assert.ok(Array.isArray(body.proof), "пруф нужен, чтобы забрать");
});

test("забранное сверх кумулятива не уводит claimable в минус", async (t) => {
  // Корень мог быть опубликован раньше, чем журнал догнал цепочку.
  const { server, base, entitlements } = await boot(MIN, 500n);
  t.after(() => server.close());

  entitlements.save(new Map([[ACCOUNT, 100n]]));
  const body = (await (await fetch(`${base}/v1/me?account=${ACCOUNT}`)).json()) as JsonBody;

  assert.equal(body.claimable, "0");
});
