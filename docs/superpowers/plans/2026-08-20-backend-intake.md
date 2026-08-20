# Backend Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить приёмную половину бэкенда DWELL: конфиг с закреплёнными адресами, хранилище на встроенном SQLite, чтение цепочки через multicall, аутентификацию по подписи кошелька, двухфазный приём хартбитов и HTTP API.

**Architecture:** Один процесс, нулевые внешние сервисы. Хранилище — `node:sqlite`, сервер — `node:http`, тесты — `node:test`. Единственные зависимости на весь бэкенд: `viem` для цепочки и `@openzeppelin/merkle-tree` из предыдущего плана. Сессии живут в памяти: перезапуск требует повторной подписи, что совпадает с механикой «майнинг не возобновляется сам».

**Tech Stack:** Node 24 (нативный TypeScript без сборки), `node:sqlite`, `node:http`, `node:test`, `viem`.

**Spec:** `docs/superpowers/specs/2026-08-20-stock-mining-protocol-design.md`

**Предшествующие планы:** `2026-08-20-rewardvault-contract.md` и `2026-08-20-settlement-core.md` — оба выполнены и влиты в `main`.

**Следующий план:** воркер и выпуск (сеттлмент по расписанию, publisher, watchdog, конвертация комиссий) — отдельный документ.

## Global Constraints

- Вся арифметика на `bigint`. В SQLite денежные величины хранятся как `TEXT`: движок оперирует 64-битными целыми, а wei их переполняют
- Адреса контрактов — константы в коде. **Никогда** не резолвятся по символу и не берутся из API эксплорера: в сети есть токены-двойники с идентичными именем и символом
- Фабрика Uniswap v3 в этой сети развёрнута не по каноническому адресу — брать только из конфига
- Ядро сеттлмента остаётся чистым: модули из `offchain/src/*.ts` предыдущего плана не получают I/O
- Секреты только из окружения. Приватные ключи не логируются и не попадают в ответы API
- Комментарии в коде на английском, сообщения коммитов на русском

## Проверено до написания плана

Установлено запуском в этой сети, а не предположением:

1. `node:sqlite` есть в Node 24: `DatabaseSync`, prepared statements, `INSERT OR IGNORE` даёт идемпотентность, `TEXT` возвращает wei без потерь, транзакции откатываются
2. `viem` соединяется с chainId 4663 и собирает три `balanceOf` в один multicall-запрос
3. `verifyMessage` принимает верную подпись и отвергает подменённый адрес
4. Multicall3 развёрнут по каноническому адресу `0xcA11bde05977b3631167028862bE2a173976CA11`
5. Своп идёт через Uniswap **v3** `SwapRouter02`, пул WETH/TSLA существует только в тире **0.3%**, глубина 0.55 WETH / 43.5 TSLA

---

## File Structure

| Файл | Ответственность |
|---|---|
| `offchain/src/config.ts` | закреплённые адреса, параметры протокола, чтение окружения |
| `offchain/src/chain/client.ts` | определение сети и public-клиент viem |
| `offchain/src/chain/reader.ts` | балансы пачкой через multicall, состояние вольта |
| `offchain/src/db/open.ts` | открытие базы, схема, WAL |
| `offchain/src/db/heartbeats.ts` | приём и заполнение хартбитов |
| `offchain/src/db/entitlements.ts` | кумулятивы |
| `offchain/src/db/epochs.ts` | состояние эпох |
| `offchain/src/auth/challenge.ts` | выдача и проверка челленджа |
| `offchain/src/auth/sessions.ts` | сессии в памяти, одна на кошелёк |
| `offchain/src/api/ratelimit.ts` | ведро токенов на аккаунт и IP |
| `offchain/src/api/router.ts` | минимальный роутер поверх `node:http` |
| `offchain/src/api/handlers.ts` | обработчики четырёх эндпоинтов |
| `offchain/src/ingest/bucketClose.ts` | вторая фаза: дозаполнение балансов |

Слои разделены так, чтобы каждый тестировался без соседей: база не знает про HTTP, HTTP не знает про цепочку, цепочка не знает про базу.

---

## Task 1: Конфигурация и клиент цепочки

**Files:**
- Create: `offchain/src/config.ts`
- Create: `offchain/src/chain/client.ts`
- Test: `offchain/test/config.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: `CHAIN_ID = 4663`, объект `ADDRESSES` с полями `tsla`, `weth`, `swapRouter`, `v3Factory`, `wethTslaPool`, `multicall3`; `POOL_FEE = 3000`, `SLIPPAGE_BPS = 200`, `PURCHASE_THRESHOLD_USD_WAD`; функция `loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig` с полями `rpcUrl`, `rewardVault`, `minBalance`, `databasePath`, `port`; `robinhoodChain` и `publicClient`

- [ ] **Step 1: Установить viem**

```bash
cd offchain
npm install viem
```

- [ ] **Step 2: Написать падающий тест конфига**

Файл `offchain/test/config.test.ts`:

```typescript
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
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `cd offchain && node --test test/config.test.ts`
Expected: FAIL — модуль `../src/config.ts` не существует.

- [ ] **Step 4: Написать конфиг**

Файл `offchain/src/config.ts`:

```typescript
import type { Address } from "./types.ts";

export const CHAIN_ID = 4663;

/**
 * Pinned protocol addresses on Robinhood Chain.
 *
 * Established by decoding real on-chain transactions, not by assumption.
 * Two hazards make dynamic resolution unacceptable here:
 *
 *  1. The chain hosts impostor tokens with the identical name
 *     "Tesla • Robinhood Token" and symbol TSLA. Resolving by symbol would
 *     eventually buy a worthless copy.
 *  2. The Uniswap v3 factory is NOT at its canonical cross-chain address, so
 *     the well-known constant from documentation is wrong here.
 */
export const ADDRESSES = {
  tsla: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  wethTslaPool: "0xA953CA88ff430e9487c60cA34d757414f4efdA07",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11"
} as const satisfies Record<string, Address>;

/** The WETH/TSLA pool exists only in the 0.3% tier on this chain. */
export const POOL_FEE = 3000;

/**
 * Slippage budget in basis points. Must exceed the pool fee: at 0.3% the fee
 * alone would consume a third of a 1% budget and every swap would revert.
 */
export const SLIPPAGE_BPS = 200;

export interface RuntimeConfig {
  readonly rpcUrl: string;
  readonly rewardVault: Address;
  readonly minBalance: bigint;
  readonly databasePath: string;
  readonly port: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requireAddress(env: NodeJS.ProcessEnv, key: string): Address {
  const value = required(env, key);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${key} must be a 20-byte hex address, got ${value}`);
  }
  return value as Address;
}

/** Reads deployment-specific values. Secrets are never returned from here. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return {
    rpcUrl: required(env, "RPC_URL"),
    rewardVault: requireAddress(env, "REWARD_VAULT"),
    minBalance: BigInt(required(env, "MIN_BALANCE")) * 10n ** 18n,
    databasePath: required(env, "DATABASE_PATH"),
    port: Number(env.PORT ?? 8787)
  };
}
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/config.test.ts`
Expected: PASS — 6 тестов.

- [ ] **Step 6: Написать клиент цепочки**

Файл `offchain/src/chain/client.ts`. Тестами не покрывается: это склейка конфига с библиотекой, проверяется в Task 3 живым запросом.

```typescript
import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { ADDRESSES, CHAIN_ID } from "../config.ts";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: ADDRESSES.multicall3 } }
});

export function createReadClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
}
```

- [ ] **Step 7: Коммит**

```bash
git add offchain/src/config.ts offchain/src/chain/client.ts offchain/test/config.test.ts \
        offchain/package.json offchain/package-lock.json
git commit -m "Добавить конфиг с закреплёнными адресами и клиент цепочки"
```

---

## Task 2: Хранилище на встроенном SQLite

**Files:**
- Create: `offchain/src/db/open.ts`
- Create: `offchain/src/db/heartbeats.ts`
- Create: `offchain/src/db/entitlements.ts`
- Create: `offchain/src/db/epochs.ts`
- Test: `offchain/test/db.test.ts`

**Interfaces:**
- Consumes: `Address`, `HeartbeatRecord` из `types.ts`
- Produces: `openDatabase(path: string): DatabaseSync`; `HeartbeatStore` с методами `accept(account, bucketId)`, `fillBucket(bucketId, blockNumber, balances)`, `listForEpoch(epoch)`, `pendingBuckets(beforeBucket)`; `EntitlementStore` с `load()`, `save(cumulative)`; `EpochStore` с `markSettled(epoch, totalWeight, release)`, `lastSettled()`

- [ ] **Step 1: Написать падающий тест хранилища**

Файл `offchain/test/db.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { EpochStore } from "../src/db/epochs.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

function fresh() {
  const db = openDatabase(":memory:");
  return {
    db,
    heartbeats: new HeartbeatStore(db),
    entitlements: new EntitlementStore(db),
    epochs: new EpochStore(db)
  };
}

test("приём хартбита идемпотентен по бакету", () => {
  const { heartbeats } = fresh();
  assert.equal(heartbeats.accept(A, 100), true);
  assert.equal(heartbeats.accept(A, 100), false, "повтор не должен создавать строку");
  assert.equal(heartbeats.accept(A, 101), true);
});

test("вторая фаза дозаполняет баланс и блок", () => {
  const { heartbeats } = fresh();
  heartbeats.accept(A, 100);
  heartbeats.accept(B, 100);

  heartbeats.fillBucket(100, 42_000_000, new Map([[A, 150n * 10n ** 18n], [B, 1n]]));

  const rows = heartbeats.listForEpoch(3);
  assert.equal(rows.length, 2);
  const byAccount = new Map(rows.map((r) => [r.account, r]));
  assert.equal(byAccount.get(A)!.balance, 150n * 10n ** 18n);
  assert.equal(byAccount.get(A)!.bucketId, 100);
  assert.equal(byAccount.get(B)!.balance, 1n);
});

test("wei переживает round-trip без потери точности", () => {
  const { heartbeats } = fresh();
  const huge = 123_456_789_012_345_678_901_234_567_890n;
  heartbeats.accept(A, 100);
  heartbeats.fillBucket(100, 1, new Map([[A, huge]]));
  assert.equal(heartbeats.listForEpoch(3)[0]!.balance, huge);
});

test("listForEpoch отдаёт только бакеты своей эпохи", () => {
  const { heartbeats } = fresh();
  // Эпоха 3 владеет бакетами 90..119
  heartbeats.accept(A, 89);
  heartbeats.accept(A, 90);
  heartbeats.accept(A, 119);
  heartbeats.accept(A, 120);
  for (const b of [89, 90, 119, 120]) heartbeats.fillBucket(b, 1, new Map([[A, 5n]]));

  const buckets = heartbeats.listForEpoch(3).map((r) => r.bucketId).sort((x, y) => x - y);
  assert.deepEqual(buckets, [90, 119]);
});

test("незаполненные бакеты видны, заполненные — нет", () => {
  const { heartbeats } = fresh();
  heartbeats.accept(A, 10);
  heartbeats.accept(A, 11);
  assert.deepEqual(heartbeats.pendingBuckets(12), [10, 11]);

  heartbeats.fillBucket(10, 1, new Map([[A, 5n]]));
  assert.deepEqual(heartbeats.pendingBuckets(12), [11]);
});

test("незаполненные хартбиты не попадают в выборку эпохи", () => {
  const { heartbeats } = fresh();
  heartbeats.accept(A, 90);
  assert.equal(heartbeats.listForEpoch(3).length, 0, "баланс ещё не прочитан");
});

test("кумулятивы сохраняются и читаются", () => {
  const { entitlements } = fresh();
  assert.equal(entitlements.load().size, 0);

  entitlements.save(new Map([[A, 10n ** 20n], [B, 7n]]));
  const loaded = entitlements.load();
  assert.equal(loaded.get(A), 10n ** 20n);
  assert.equal(loaded.get(B), 7n);

  entitlements.save(new Map([[A, 2n * 10n ** 20n], [B, 7n]]));
  assert.equal(entitlements.load().get(A), 2n * 10n ** 20n);
});

test("эпоха отмечается сеттленной и не задваивается", () => {
  const { epochs } = fresh();
  assert.equal(epochs.lastSettled(), null);

  epochs.markSettled(5_955_209, 1_000n, 42n);
  assert.equal(epochs.lastSettled(), 5_955_209);

  assert.throws(() => epochs.markSettled(5_955_209, 1n, 1n), /already settled/);
});

test("схема применяется повторно без ошибки", () => {
  const db = openDatabase(":memory:");
  assert.doesNotThrow(() => new HeartbeatStore(db));
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/db.test.ts`
Expected: FAIL — модули в `../src/db/` не существуют.

- [ ] **Step 3: Написать открытие базы и схему**

Файл `offchain/src/db/open.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";

/**
 * Money is stored as TEXT throughout. SQLite integers are 64-bit and wei
 * amounts overflow them silently, so every balance, weight and entitlement
 * round-trips as a decimal string.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS heartbeats (
  account      TEXT    NOT NULL,
  bucket_id    INTEGER NOT NULL,
  block_number INTEGER,
  balance      TEXT,
  PRIMARY KEY (account, bucket_id)
);

CREATE INDEX IF NOT EXISTS heartbeats_bucket ON heartbeats (bucket_id);

CREATE TABLE IF NOT EXISTS entitlements (
  account    TEXT PRIMARY KEY,
  cumulative TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epochs (
  epoch        INTEGER PRIMARY KEY,
  total_weight TEXT    NOT NULL,
  release      TEXT    NOT NULL,
  settled_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roots (
  through_epoch INTEGER PRIMARY KEY,
  root          TEXT    NOT NULL,
  tx_hash       TEXT,
  published_at  INTEGER
);

CREATE TABLE IF NOT EXISTS purchases (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  eth_in    TEXT    NOT NULL,
  tsla_out  TEXT    NOT NULL,
  tx_hash   TEXT    NOT NULL,
  bought_at INTEGER NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL lets the worker write while the API reads without blocking.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Написать хранилище хартбитов**

Файл `offchain/src/db/heartbeats.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import { BUCKETS_PER_EPOCH } from "../epoch.ts";
import type { Address, HeartbeatRecord } from "../types.ts";

/**
 * Heartbeats are written in two phases.
 *
 * Phase one runs on request and only records that the account was alive in a
 * bucket. Phase two runs once per bucket and fills in every balance from a
 * single multicall at a pinned block — one RPC round trip per bucket instead
 * of one per miner, and a consistent snapshot.
 */
export class HeartbeatStore {
  readonly #accept;
  readonly #fill;
  readonly #forEpoch;
  readonly #pending;
  readonly #inBucket;

  constructor(db: DatabaseSync) {
    this.#accept = db.prepare(
      "INSERT OR IGNORE INTO heartbeats (account, bucket_id) VALUES (?, ?)"
    );
    this.#fill = db.prepare(
      "UPDATE heartbeats SET block_number = ?, balance = ? WHERE account = ? AND bucket_id = ?"
    );
    this.#forEpoch = db.prepare(
      `SELECT account, bucket_id, balance FROM heartbeats
       WHERE bucket_id >= ? AND bucket_id <= ? AND balance IS NOT NULL`
    );
    this.#pending = db.prepare(
      "SELECT DISTINCT bucket_id FROM heartbeats WHERE balance IS NULL AND bucket_id < ? ORDER BY bucket_id"
    );
    this.#inBucket = db.prepare(
      "SELECT account FROM heartbeats WHERE bucket_id = ? AND balance IS NULL"
    );
  }

  /** Accounts still awaiting a balance read in this bucket. */
  accountsInBucket(bucketId: number): Address[] {
    return this.#inBucket
      .all(bucketId)
      .map((row) => String((row as Record<string, unknown>).account) as Address);
  }

  /** Returns false when this bucket was already recorded for the account. */
  accept(account: Address, bucketId: number): boolean {
    return this.#accept.run(account, bucketId).changes > 0;
  }

  fillBucket(bucketId: number, blockNumber: number, balances: ReadonlyMap<Address, bigint>): void {
    for (const [account, balance] of balances) {
      this.#fill.run(blockNumber, balance.toString(), account, bucketId);
    }
  }

  /** Only rows whose balance has been sampled; unfilled buckets are not evidence. */
  listForEpoch(epoch: number): HeartbeatRecord[] {
    const first = epoch * BUCKETS_PER_EPOCH;
    const last = first + BUCKETS_PER_EPOCH - 1;
    return this.#forEpoch.all(first, last).map((row) => ({
      account: String((row as Record<string, unknown>).account) as Address,
      bucketId: Number((row as Record<string, unknown>).bucket_id),
      balance: BigInt(String((row as Record<string, unknown>).balance))
    }));
  }

  pendingBuckets(beforeBucket: number): number[] {
    return this.#pending
      .all(beforeBucket)
      .map((row) => Number((row as Record<string, unknown>).bucket_id));
  }
}
```

- [ ] **Step 5: Написать хранилища кумулятивов и эпох**

Файл `offchain/src/db/entitlements.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import type { Address } from "../types.ts";

export class EntitlementStore {
  readonly #db;
  readonly #all;
  readonly #upsert;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#all = db.prepare("SELECT account, cumulative FROM entitlements");
    this.#upsert = db.prepare(
      `INSERT INTO entitlements (account, cumulative) VALUES (?, ?)
       ON CONFLICT (account) DO UPDATE SET cumulative = excluded.cumulative`
    );
  }

  load(): Map<Address, bigint> {
    const result = new Map<Address, bigint>();
    for (const row of this.#all.all()) {
      const record = row as Record<string, unknown>;
      result.set(String(record.account) as Address, BigInt(String(record.cumulative)));
    }
    return result;
  }

  /** Written in one transaction so a crash cannot leave a partial epoch. */
  save(cumulative: ReadonlyMap<Address, bigint>): void {
    this.#db.exec("BEGIN");
    try {
      for (const [account, amount] of cumulative) {
        this.#upsert.run(account, amount.toString());
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
```

Файл `offchain/src/db/epochs.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";

export class EpochStore {
  readonly #insert;
  readonly #last;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      "INSERT INTO epochs (epoch, total_weight, release, settled_at) VALUES (?, ?, ?, ?)"
    );
    this.#last = db.prepare("SELECT max(epoch) AS epoch FROM epochs");
  }

  /** The primary key makes double settlement impossible at the storage layer. */
  markSettled(epoch: number, totalWeight: bigint, release: bigint): void {
    try {
      this.#insert.run(epoch, totalWeight.toString(), release.toString(), Date.now());
    } catch (error) {
      throw new Error(`epoch ${epoch} already settled`, { cause: error });
    }
  }

  lastSettled(): number | null {
    const row = this.#last.get() as Record<string, unknown> | undefined;
    const value = row?.epoch;
    return value === null || value === undefined ? null : Number(value);
  }
}
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/db.test.ts`
Expected: PASS — 9 тестов.

- [ ] **Step 7: Коммит**

```bash
git add offchain/src/db offchain/test/db.test.ts
git commit -m "Добавить хранилище на встроенном SQLite"
```

---

## Task 3: Чтение цепочки

**Files:**
- Create: `offchain/src/chain/reader.ts`
- Test: `offchain/test/reader.test.ts`

**Interfaces:**
- Consumes: `createReadClient` из Task 1, `ADDRESSES`
- Produces: `ChainReader` с методами `balancesAt(accounts: readonly Address[], blockNumber?: bigint): Promise<Map<Address, bigint>>`, `currentBlock(): Promise<bigint>`, `vaultState(vault: Address): Promise<VaultState>`

Тесты ходят в живую сеть: это интеграционный слой, и мок доказал бы только то, что мок работает. При недоступном RPC тесты пропускаются явным флагом.

- [ ] **Step 1: Написать падающий тест чтения**

Файл `offchain/test/reader.test.ts`:

```typescript
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

let reader: ChainReader;
let online = false;

before(async () => {
  reader = new ChainReader(RPC);
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

test("баланс на прошлом блоке отличается от текущего срезом", async (t) => {
  if (!online) return t.skip("RPC недоступен");
  const head = await reader.currentBlock();
  const past = await reader.balancesAt([POOL], head - 1_000_000n);
  assert.equal(typeof past.get(POOL), "bigint");
});

test("состояние вольта читается тремя полями", async (t) => {
  if (!online) return t.skip("RPC недоступен");
  const state = await reader.vaultState(LIVE_VAULT);
  assert.equal(typeof state.balance, "bigint");
  assert.equal(typeof state.totalAllocated, "bigint");
  assert.equal(typeof state.totalClaimed, "bigint");
  assert.ok(state.totalAllocated >= state.totalClaimed, "начислено не меньше заклеймленного");
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/reader.test.ts`
Expected: FAIL — модуль `../src/chain/reader.ts` не существует.

- [ ] **Step 3: Реализовать чтение**

Файл `offchain/src/chain/reader.ts`:

```typescript
import { parseAbi, type PublicClient } from "viem";
import { createReadClient } from "./client.ts";
import { ADDRESSES } from "../config.ts";
import type { Address, VaultState } from "../types.ts";

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const VAULT_ABI = parseAbi([
  "function totalAllocated() view returns (uint256)",
  "function totalClaimed() view returns (uint256)"
]);

export class ChainReader {
  readonly #client: PublicClient;

  constructor(rpcUrl: string) {
    this.#client = createReadClient(rpcUrl);
  }

  currentBlock(): Promise<bigint> {
    return this.#client.getBlockNumber();
  }

  /**
   * Reads every balance in a single Multicall3 round trip at one block, so
   * the whole bucket shares a consistent snapshot instead of drifting across
   * per-account requests.
   */
  async balancesAt(
    accounts: readonly Address[],
    blockNumber?: bigint
  ): Promise<Map<Address, bigint>> {
    const result = new Map<Address, bigint>();
    if (accounts.length === 0) return result;

    const values = await this.#client.multicall({
      contracts: accounts.map((account) => ({
        address: ADDRESSES.tsla,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account]
      })),
      allowFailure: false,
      ...(blockNumber === undefined ? {} : { blockNumber })
    });

    accounts.forEach((account, index) => result.set(account, values[index] as bigint));
    return result;
  }

  async vaultState(vault: Address): Promise<VaultState> {
    const [balance, totalAllocated, totalClaimed] = await this.#client.multicall({
      contracts: [
        { address: ADDRESSES.tsla, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] },
        { address: vault, abi: VAULT_ABI, functionName: "totalAllocated" },
        { address: vault, abi: VAULT_ABI, functionName: "totalClaimed" }
      ],
      allowFailure: false
    });

    return {
      balance: balance as bigint,
      totalAllocated: totalAllocated as bigint,
      totalClaimed: totalClaimed as bigint
    };
  }
}
```

Важно: в `balancesAt` читается баланс **токена проекта**, а не TSLA. На момент написания плана токен ещё не запущен, поэтому здесь стоит `ADDRESSES.tsla` как заглушка для интеграционного теста. При запуске токена заменить на его адрес и добавить в `ADDRESSES` поле `projectToken`, а тест переписать на него.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/reader.test.ts`
Expected: PASS — 4 теста (или пропуски при недоступном RPC).

- [ ] **Step 5: Коммит**

```bash
git add offchain/src/chain/reader.ts offchain/test/reader.test.ts
git commit -m "Добавить чтение балансов пачкой и состояния вольта"
```

---

## Task 4: Аутентификация по подписи

**Files:**
- Create: `offchain/src/auth/challenge.ts`
- Create: `offchain/src/auth/sessions.ts`
- Test: `offchain/test/auth.test.ts`

**Interfaces:**
- Consumes: ничего из предыдущих задач
- Produces: `ChallengeStore` с `issue(account, now): Challenge`, `consume(challengeId, now): Challenge | null`; тип `Challenge { id, account, message, expiresAt }`; `SessionStore` с `open(account, now): string`, `resolve(token, now): Address | null`, `touch(token, now)`, `close(token)`; константы `CHALLENGE_TTL_MS`, `SESSION_TTL_MS`

- [ ] **Step 1: Написать падающий тест аутентификации**

Файл `offchain/test/auth.test.ts`:

```typescript
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/auth.test.ts`
Expected: FAIL — модули в `../src/auth/` не существуют.

- [ ] **Step 3: Реализовать челлендж**

Файл `offchain/src/auth/challenge.ts`:

```typescript
import { randomBytes } from "node:crypto";
import type { Address } from "../types.ts";

export const CHALLENGE_TTL_MS = 120_000;

export interface Challenge {
  readonly id: string;
  readonly account: Address;
  readonly message: string;
  readonly expiresAt: number;
}

/**
 * Issues one-time messages for wallets to sign.
 *
 * The account and the nonce are both inside the signed text, so a signature
 * captured from one wallet cannot be replayed for another account or reused
 * for a second session.
 */
export class ChallengeStore {
  readonly #open = new Map<string, Challenge>();

  issue(account: Address, now: number): Challenge {
    const id = randomBytes(16).toString("hex");
    const challenge: Challenge = {
      id,
      account,
      message: `DWELL mining session\n\naccount: ${account}\nnonce: ${id}`,
      expiresAt: now + CHALLENGE_TTL_MS
    };
    this.#open.set(id, challenge);
    this.#sweep(now);
    return challenge;
  }

  /** Removes the challenge whether or not it was still valid: single use. */
  consume(challengeId: string, now: number): Challenge | null {
    const challenge = this.#open.get(challengeId);
    if (!challenge) return null;
    this.#open.delete(challengeId);
    return challenge.expiresAt > now ? challenge : null;
  }

  #sweep(now: number): void {
    for (const [id, challenge] of this.#open) {
      if (challenge.expiresAt <= now) this.#open.delete(id);
    }
  }
}
```

- [ ] **Step 4: Реализовать сессии**

Файл `offchain/src/auth/sessions.ts`:

```typescript
import { randomBytes } from "node:crypto";
import type { Address } from "../types.ts";

export const SESSION_TTL_MS = 60_000;

interface Session {
  readonly account: Address;
  expiresAt: number;
}

/**
 * Sessions live in memory only.
 *
 * A restart therefore forces every miner to sign again, which matches the
 * product rule that mining never resumes on its own — and removes a class of
 * bugs around persisting bearer tokens.
 *
 * One session per wallet: opening a new one closes the old, so a single
 * balance cannot be mined from two places at once.
 */
export class SessionStore {
  readonly #byToken = new Map<string, Session>();
  readonly #byAccount = new Map<Address, string>();

  open(account: Address, now: number): string {
    const previous = this.#byAccount.get(account);
    if (previous) this.#byToken.delete(previous);

    const token = randomBytes(32).toString("hex");
    this.#byToken.set(token, { account, expiresAt: now + SESSION_TTL_MS });
    this.#byAccount.set(account, token);
    return token;
  }

  resolve(token: string, now: number): Address | null {
    const session = this.#byToken.get(token);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.close(token);
      return null;
    }
    return session.account;
  }

  /** Extends the session; called on every accepted heartbeat. */
  touch(token: string, now: number): void {
    const session = this.#byToken.get(token);
    if (session) session.expiresAt = now + SESSION_TTL_MS;
  }

  close(token: string): void {
    const session = this.#byToken.get(token);
    if (!session) return;
    this.#byToken.delete(token);
    if (this.#byAccount.get(session.account) === token) {
      this.#byAccount.delete(session.account);
    }
  }
}
```

Срок жизни сессии — 60 секунд, шесть пропущенных хартбитов подряд. Это и есть определение «вкладку закрыли»: сервер не может наблюдать видимость напрямую, но может заметить, что перестали приходить сигналы.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/auth.test.ts`
Expected: PASS — 10 тестов.

- [ ] **Step 6: Коммит**

```bash
git add offchain/src/auth offchain/test/auth.test.ts
git commit -m "Добавить одноразовые челленджи и сессии в памяти"
```

---

## Task 5: Рейт-лимит и вторая фаза хартбитов

**Files:**
- Create: `offchain/src/api/ratelimit.ts`
- Create: `offchain/src/ingest/bucketClose.ts`
- Test: `offchain/test/ratelimit.test.ts`
- Test: `offchain/test/bucketClose.test.ts`

**Interfaces:**
- Consumes: `HeartbeatStore` из Task 2, `ChainReader` из Task 3
- Produces: `RateLimiter` с `check(key: string, now: number): boolean`; `closeBuckets(deps, now): Promise<number>` где `deps = { heartbeats, reader, currentBucket }`

- [ ] **Step 1: Написать падающий тест рейт-лимита**

Файл `offchain/test/ratelimit.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/api/ratelimit.ts";

const T0 = 1_787_000_000_000;

test("пропускает в пределах ёмкости", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerMs: 1 / 1_000 });
  assert.equal(limiter.check("a", T0), true);
  assert.equal(limiter.check("a", T0), true);
  assert.equal(limiter.check("a", T0), true);
});

test("отсекает при исчерпании", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerMs: 1 / 1_000 });
  limiter.check("a", T0);
  limiter.check("a", T0);
  assert.equal(limiter.check("a", T0), false);
});

test("ведро наполняется со временем", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerMs: 1 / 1_000 });
  limiter.check("a", T0);
  limiter.check("a", T0);
  assert.equal(limiter.check("a", T0 + 999), false);
  assert.equal(limiter.check("a", T0 + 1_000), true);
});

test("ключи независимы", () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerMs: 1 / 1_000 });
  assert.equal(limiter.check("a", T0), true);
  assert.equal(limiter.check("b", T0), true);
  assert.equal(limiter.check("a", T0), false);
});

test("ведро не переполняется сверх ёмкости", () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerMs: 1 / 1_000 });
  limiter.check("a", T0);
  // Долгая пауза не должна накопить больше, чем вмещает ведро
  assert.equal(limiter.check("a", T0 + 1_000_000), true);
  assert.equal(limiter.check("a", T0 + 1_000_000), true);
  assert.equal(limiter.check("a", T0 + 1_000_000), false);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/ratelimit.test.ts`
Expected: FAIL — модуль `../src/api/ratelimit.ts` не существует.

- [ ] **Step 3: Реализовать рейт-лимит**

Файл `offchain/src/api/ratelimit.ts`:

```typescript
interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitOptions {
  readonly capacity: number;
  readonly refillPerMs: number;
}

/**
 * Token bucket, in memory.
 *
 * Deliberately modest: the weight formula is linear in balance, so a bot
 * earns exactly the share its balance entitles it to and steals nothing.
 * Rate limiting here protects the server from noise, not the reward pool
 * from abuse.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #refillPerMs: number;

  constructor(options: RateLimitOptions) {
    this.#capacity = options.capacity;
    this.#refillPerMs = options.refillPerMs;
  }

  check(key: string, now: number): boolean {
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };

    const refilled = bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs;
    bucket.tokens = Math.min(this.#capacity, refilled);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      this.#buckets.set(key, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return true;
  }
}
```

- [ ] **Step 4: Написать падающий тест закрытия бакетов**

Файл `offchain/test/bucketClose.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { closeBuckets } from "../src/ingest/bucketClose.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

function stubReader(balances: Record<string, bigint>) {
  const calls: Array<readonly Address[]> = [];
  return {
    calls,
    currentBlock: async () => 42_000_000n,
    balancesAt: async (accounts: readonly Address[]) => {
      calls.push(accounts);
      return new Map(accounts.map((a) => [a, balances[a] ?? 0n]));
    }
  };
}

test("закрывает только бакеты, которые уже позади", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  heartbeats.accept(A, 10);
  heartbeats.accept(A, 11);

  const reader = stubReader({ [A]: 5n });
  const closed = await closeBuckets({ heartbeats, reader, currentBucket: 11 });

  assert.equal(closed, 1, "текущий бакет ещё принимает хартбиты");
  assert.deepEqual(heartbeats.pendingBuckets(12), [11]);
});

test("один multicall на бакет, а не на аккаунт", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  heartbeats.accept(A, 10);
  heartbeats.accept(B, 10);

  const reader = stubReader({ [A]: 7n, [B]: 9n });
  await closeBuckets({ heartbeats, reader, currentBucket: 11 });

  assert.equal(reader.calls.length, 1, "должен быть ровно один запрос балансов");
  assert.equal(reader.calls[0]!.length, 2, "оба аккаунта в одном запросе");
});

test("прочитанные балансы попадают в журнал", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  heartbeats.accept(A, 90);
  heartbeats.accept(B, 90);

  const reader = stubReader({ [A]: 7n, [B]: 9n });
  await closeBuckets({ heartbeats, reader, currentBucket: 91 });

  const rows = heartbeats.listForEpoch(3);
  const byAccount = new Map(rows.map((r) => [r.account, r.balance]));
  assert.equal(byAccount.get(A), 7n);
  assert.equal(byAccount.get(B), 9n);
});

test("без незакрытых бакетов сеть не трогается", async () => {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  const reader = stubReader({});

  assert.equal(await closeBuckets({ heartbeats, reader, currentBucket: 5 }), 0);
  assert.equal(reader.calls.length, 0);
});
```

- [ ] **Step 5: Убедиться, что тест падает**

Run: `cd offchain && node --test test/bucketClose.test.ts`
Expected: FAIL — модуль `../src/ingest/bucketClose.ts` не существует.

- [ ] **Step 6: Реализовать закрытие бакетов**

Файл `offchain/src/ingest/bucketClose.ts`:

```typescript
import type { HeartbeatStore } from "../db/heartbeats.ts";
import type { Address } from "../types.ts";

export interface BucketCloseDeps {
  readonly heartbeats: HeartbeatStore;
  readonly reader: {
    currentBlock(): Promise<bigint>;
    balancesAt(accounts: readonly Address[], blockNumber?: bigint): Promise<Map<Address, bigint>>;
  };
  /** Bucket currently accepting heartbeats; everything before it is final. */
  readonly currentBucket: number;
}

/**
 * Phase two of heartbeat ingestion.
 *
 * Reads every balance for a finished bucket in one multicall at one block.
 * Doing it per heartbeat would mean one RPC call per miner per ten seconds
 * and a snapshot that drifts across accounts within the same bucket.
 *
 * Returns how many buckets were closed.
 */
export async function closeBuckets(deps: BucketCloseDeps): Promise<number> {
  const pending = deps.heartbeats.pendingBuckets(deps.currentBucket);
  if (pending.length === 0) return 0;

  const blockNumber = await deps.reader.currentBlock();

  let closed = 0;
  for (const bucketId of pending) {
    const accounts = deps.heartbeats.accountsInBucket(bucketId);
    if (accounts.length === 0) continue;

    const balances = await deps.reader.balancesAt(accounts, blockNumber);
    deps.heartbeats.fillBucket(bucketId, Number(blockNumber), balances);
    closed += 1;
  }

  return closed;
}
```

- [ ] **Step 7: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/ratelimit.test.ts test/bucketClose.test.ts test/db.test.ts`
Expected: PASS — 5 + 4 + 9 = 18 тестов.

- [ ] **Step 8: Коммит**

```bash
git add offchain/src/api/ratelimit.ts offchain/src/ingest/bucketClose.ts \
        offchain/src/db/heartbeats.ts offchain/test/ratelimit.test.ts offchain/test/bucketClose.test.ts
git commit -m "Добавить рейт-лимит и вторую фазу приёма хартбитов"
```

---

## Task 6: HTTP API

**Files:**
- Create: `offchain/src/api/router.ts`
- Create: `offchain/src/api/handlers.ts`
- Create: `offchain/src/server.ts`
- Test: `offchain/test/api.test.ts`

**Interfaces:**
- Consumes: всё из Task 1–5, `buildTree` из плана ядра
- Produces: `createRouter(routes): RequestListener`; `createHandlers(deps): Routes` с ключами `POST /v1/session/challenge`, `POST /v1/session/verify`, `POST /v1/heartbeat`, `GET /v1/me`, `GET /v1/stats`; `startServer(deps, port): Server`

- [ ] **Step 1: Написать падающий тест API**

Файл `offchain/test/api.test.ts`:

```typescript
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

// Port 0 asks the OS for a free port, but the assignment is only readable
// after the "listening" event — reading address() synchronously races.
async function boot(balance: bigint) {
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
          new Map(accounts.map((a) => [a, balance]))
      },
      minBalance: MIN,
      now: () => Date.now()
    },
    0
  );
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function post(base: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json().catch(() => null) };
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
  const body = await response.json();
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/api.test.ts`
Expected: FAIL — модуль `../src/server.ts` не существует.

- [ ] **Step 3: Реализовать роутер**

Файл `offchain/src/api/router.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  readonly body: unknown;
  readonly url: URL;
  readonly bearer: string | null;
  readonly ip: string;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export type Handler = (context: RouteContext) => Promise<RouteResult> | RouteResult;
export type Routes = Record<string, Handler>;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // The largest legitimate request is a signature; anything bigger is noise.
    if (size > 8_192) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createRouter(routes: Routes) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS).end();
      return;
    }

    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) {
      response.writeHead(404, { "content-type": "application/json", ...CORS_HEADERS });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const authorization = request.headers.authorization ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;

    let result: RouteResult;
    try {
      const body = request.method === "POST" ? await readBody(request) : {};
      result = await handler({
        body,
        url,
        bearer,
        ip: request.socket.remoteAddress ?? "unknown"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "bad request";
      result = { status: 400, body: { error: message } };
    }

    response.writeHead(result.status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS
    });
    response.end(JSON.stringify(result.body));
  };
}
```

- [ ] **Step 4: Реализовать обработчики**

Файл `offchain/src/api/handlers.ts`:

```typescript
import { verifyMessage } from "viem";
import { ChallengeStore } from "../auth/challenge.ts";
import { SessionStore } from "../auth/sessions.ts";
import { RateLimiter } from "./ratelimit.ts";
import { bucketOf, epochOf } from "../epoch.ts";
import { buildTree } from "../tree.ts";
import type { Routes } from "./router.ts";
import type { HeartbeatStore } from "../db/heartbeats.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { Address } from "../types.ts";

export interface HandlerDeps {
  readonly heartbeats: HeartbeatStore;
  readonly entitlements: EntitlementStore;
  readonly reader: {
    currentBlock(): Promise<bigint>;
    balancesAt(accounts: readonly Address[], blockNumber?: bigint): Promise<Map<Address, bigint>>;
  };
  readonly minBalance: bigint;
  readonly now: () => number;
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function createHandlers(deps: HandlerDeps): Routes {
  const challenges = new ChallengeStore();
  const sessions = new SessionStore();

  // Six heartbeats a minute is the protocol rate; the capacity leaves room
  // for a retry after a dropped response without letting a client flood.
  const heartbeatLimit = new RateLimiter({ capacity: 12, refillPerMs: 6 / 60_000 });
  const challengeLimit = new RateLimiter({ capacity: 5, refillPerMs: 5 / 60_000 });

  return {
    "POST /v1/session/challenge": ({ body, ip }) => {
      const account = (body as { account?: unknown }).account;
      if (!isAddress(account)) return { status: 400, body: { error: "account required" } };
      if (!challengeLimit.check(ip, deps.now())) {
        return { status: 429, body: { error: "too many requests" } };
      }

      const challenge = challenges.issue(account.toLowerCase() as Address, deps.now());
      return {
        status: 200,
        body: {
          challengeId: challenge.id,
          message: challenge.message,
          expiresAt: challenge.expiresAt
        }
      };
    },

    "POST /v1/session/verify": async ({ body }) => {
      const { challengeId, signature } = body as { challengeId?: unknown; signature?: unknown };
      if (typeof challengeId !== "string" || typeof signature !== "string") {
        return { status: 400, body: { error: "challengeId and signature required" } };
      }

      const challenge = challenges.consume(challengeId, deps.now());
      if (!challenge) return { status: 401, body: { error: "challenge expired or unknown" } };

      const valid = await verifyMessage({
        address: challenge.account,
        message: challenge.message,
        signature: signature as `0x${string}`
      });
      if (!valid) return { status: 401, body: { error: "signature does not match account" } };

      const token = sessions.open(challenge.account, deps.now());
      return { status: 200, body: { sessionToken: token, account: challenge.account } };
    },

    "POST /v1/heartbeat": ({ bearer }) => {
      if (!bearer) return { status: 401, body: { error: "session required" } };

      const now = deps.now();
      const account = sessions.resolve(bearer, now);
      if (!account) return { status: 401, body: { error: "session expired" } };
      if (!heartbeatLimit.check(account, now)) {
        return { status: 429, body: { error: "too many requests" } };
      }

      const bucketId = bucketOf(Math.floor(now / 1_000));
      const accepted = deps.heartbeats.accept(account, bucketId);
      sessions.touch(bearer, now);

      // A repeat within the same bucket is not an error: the client may retry
      // after a dropped response, and the primary key already deduplicates.
      return {
        status: 200,
        body: { accepted: true, fresh: accepted, bucketId, epochId: epochOf(Math.floor(now / 1_000)) }
      };
    },

    "GET /v1/me": ({ bearer, url }) => {
      const queried = url.searchParams.get("account");
      const account = bearer
        ? sessions.resolve(bearer, deps.now())
        : isAddress(queried)
          ? (queried.toLowerCase() as Address)
          : null;
      if (!account) return { status: 400, body: { error: "account or session required" } };

      const cumulative = deps.entitlements.load();
      const mine = cumulative.get(account) ?? 0n;
      if (mine === 0n) {
        return { status: 200, body: { account, cumulative: "0", proof: null } };
      }

      const tree = buildTree(cumulative);
      return {
        status: 200,
        body: {
          account,
          cumulative: mine.toString(),
          root: tree.root,
          proof: tree.proofFor(account)
        }
      };
    },

    "GET /v1/stats": () => {
      const now = Math.floor(deps.now() / 1_000);
      const cumulative = deps.entitlements.load();

      let totalAllocated = 0n;
      for (const amount of cumulative.values()) totalAllocated += amount;

      return {
        status: 200,
        body: {
          currentEpoch: epochOf(now),
          activeMiners: deps.heartbeats.accountsInBucket(bucketOf(now)).length,
          entitlementAccounts: cumulative.size,
          totalAllocated: totalAllocated.toString()
        }
      };
    }
  };
}
```

- [ ] **Step 5: Реализовать запуск сервера**

Файл `offchain/src/server.ts`:

```typescript
import { createServer, type Server } from "node:http";
import { createRouter } from "./api/router.ts";
import { createHandlers, type HandlerDeps } from "./api/handlers.ts";

/** Port 0 asks the OS for a free port; tests rely on that. */
export function startServer(deps: HandlerDeps, port: number): Server {
  const server = createServer(createRouter(createHandlers(deps)));
  server.listen(port);
  return server;
}
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/api.test.ts`
Expected: PASS — 7 тестов.


- [ ] **Step 7: Прогнать весь набор и типы**

Run: `cd offchain && node --test && npm run typecheck`
Expected: PASS — 55 прежних + 6 + 9 + 4 + 10 + 9 + 7 = 100 тестов, типы без ошибок.

- [ ] **Step 8: Коммит**

```bash
git add offchain/src/api offchain/src/server.ts offchain/test/api.test.ts
git commit -m "Добавить HTTP API с аутентификацией по подписи"
```

---

## Что этот план не покрывает

Реализуется в следующем плане — воркер и выпуск:

- Периодический сеттлмент эпох и запись в `epochs`/`entitlements`
- Публикация корня в `RewardVault` и таблица `roots`
- Watchdog: независимый пересчёт корня и аварийная пауза
- Конвертация комиссий: `WETH.deposit` и своп через `SwapRouter02`
- Режим dry-run и рабочая последовательность запуска
