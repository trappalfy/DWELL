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

interface BootOptions {
  readonly alreadyClaimed?: bigint;
  readonly lastPublished?: number | null;
  readonly settledAfter?: number;
  /** Throws to stand in for an unreachable RPC. */
  readonly vaultState?: () => Promise<{
    balance: bigint;
    totalAllocated: bigint;
    totalClaimed: bigint;
  }>;
  /** Router settings, so a test can stand the server behind a proxy. */
  readonly router?: { readonly trustedProxyHops?: number };
}

// Port 0 asks the OS for a free port, but the assignment is only readable
// after the "listening" event — reading address() synchronously races.
async function boot(balance: bigint, options: BootOptions = {}) {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  const entitlements = new EntitlementStore(db);
  let vaultReads = 0;

  const server = startServer(
    {
      heartbeats,
      entitlements,
      reader: {
        currentBlock: async () => 42_000_000n,
        balancesAt: async (accounts: readonly Address[]) =>
          new Map(accounts.map((a) => [a, balance])),
        claimed: async () => options.alreadyClaimed ?? 0n,
        vaultState: async () => {
          vaultReads++;
          if (options.vaultState) return options.vaultState();
          return { balance: 7n, totalAllocated: 5n, totalClaimed: 3n };
        }
      },
      backdrop: { sources: [], poster: null },
      roots: { lastPublished: () => options.lastPublished ?? null },
      epochs: { countSettledAfter: () => options.settledAfter ?? 0 },
      minBalance: MIN,
      vaultAddress: VAULT,
      projectToken: PROJECT_TOKEN,
      now: () => Date.now()
    },
    0,
    options.router ?? {}
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    entitlements,
    vaultReads: () => vaultReads
  };
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
  const { server, base, entitlements } = await boot(MIN, { alreadyClaimed: 40n });
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
  const { server, base, entitlements } = await boot(MIN, { alreadyClaimed: 500n });
  t.after(() => server.close());

  entitlements.save(new Map([[ACCOUNT, 100n]]));
  const body = (await (await fetch(`${base}/v1/me?account=${ACCOUNT}`)).json()) as JsonBody;

  assert.equal(body.claimable, "0");
});

test("stats отдаёт живые числа фонда", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  const body = (await (await fetch(`${base}/v1/stats`)).json()) as JsonBody;

  assert.equal(body.vaultBalance, "7");
  assert.equal(body.totalReleased, "5");
  assert.equal(body.totalClaimed, "3");
  assert.equal(typeof body.serverTime, "number");
});

test("состояние вольта читается с цепочки один раз на всех", async (t) => {
  // Каждая открытая вкладка опрашивает stats, а продукт как раз и просит
  // держать вкладки открытыми. Без кэша посетители стали бы генератором
  // нагрузки на собственный RPC.
  const { server, base, vaultReads } = await boot(MIN);
  t.after(() => server.close());

  await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/v1/stats`)));
  await fetch(`${base}/v1/stats`);

  assert.equal(vaultReads(), 1, "девять запросов обязаны стоить одного чтения цепочки");
});

test("недоступный RPC не роняет stats", async (t) => {
  const { server, base } = await boot(MIN, {
    vaultState: async () => {
      throw new Error("rpc unreachable");
    }
  });
  t.after(() => server.close());

  const response = await fetch(`${base}/v1/stats`);
  assert.equal(response.status, 200, "числа украшают секцию, а не открывают доступ");

  const body = (await response.json()) as JsonBody;
  assert.equal(body.vaultBalance, null);
  assert.equal(typeof body.activeMiners, "number", "остальное считается локально и обязано работать");
});

test("обратный отсчёт ведётся до настоящей публикации", async (t) => {
  const { server, base } = await boot(MIN, { lastPublished: 5_900_000, settledAfter: 4 });
  t.after(() => server.close());

  const body = (await (await fetch(`${base}/v1/stats`)).json()) as JsonBody;

  assert.equal(body.lastPublishedEpoch, 5_900_000);
  assert.equal(body.epochsUntilPublish, 2, "паблишеру нужно шесть эпох, четыре уже есть");
});

test("просроченная публикация не уходит в минус", async (t) => {
  const { server, base } = await boot(MIN, { settledAfter: 9 });
  t.after(() => server.close());

  const body = (await (await fetch(`${base}/v1/stats`)).json()) as JsonBody;
  assert.equal(body.epochsUntilPublish, 0, "отсчёт останавливается на нуле, а не идёт назад");
});

test("config сообщает странице, есть ли фоновое видео", async (t) => {
  // Страница не должна угадывать наличие файла по 404: сервер знает точно,
  // а фронт по этому ответу выбирает, что рисует фон — видео или канвас.
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  const body = (await (await fetch(`${base}/v1/config`)).json()) as JsonBody;
  assert.deepEqual(body.backdrop, { sources: [], poster: null });
});

/** Челлендж с подставленным заголовком прокси. */
async function challengeAs(
  base: string,
  forwardedFor: string,
  account: Address
): Promise<number> {
  const response = await fetch(`${base}/v1/session/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify({ account })
  });
  return response.status;
}

test("за прокси лимит челленджа считается по клиенту, а не по прокси", async (t) => {
  const { server, base } = await boot(MIN, { router: { trustedProxyHops: 1 } });
  t.after(() => server.close());

  // Ёмкость ведра — пять. Шесть РАЗНЫХ клиентов обязаны пройти все:
  // за прокси у них один и тот же адрес сокета, и без разбора заголовка
  // шестой получил бы отказ.
  const statuses: number[] = [];
  for (let i = 1; i <= 6; i++) {
    statuses.push(await challengeAs(base, `198.51.100.${i}`, ACCOUNT));
  }

  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200]);
});

test("за прокси лимит всё ещё держит одного клиента", async (t) => {
  const { server, base } = await boot(MIN, { router: { trustedProxyHops: 1 } });
  t.after(() => server.close());

  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    statuses.push(await challengeAs(base, "198.51.100.7", ACCOUNT));
  }

  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(statuses[5], 429, "шестой запрос одного клиента обязан быть отбит");
});

test("без доверенных прокси заголовок не даёт обойти лимит", async (t) => {
  const { server, base } = await boot(MIN);
  t.after(() => server.close());

  // Прокси нет, значит заголовок пришёл от клиента и верить ему нельзя.
  const statuses: number[] = [];
  for (let i = 1; i <= 6; i++) {
    statuses.push(await challengeAs(base, `198.51.100.${i}`, ACCOUNT));
  }

  assert.equal(statuses[5], 429, "подделка заголовка не обязана открывать шестой запрос");
});
