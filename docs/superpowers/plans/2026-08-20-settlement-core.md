# Settlement Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать детерминированное ядро сеттлмента DWELL — часы эпох, расчёт весов, дрип из резерва, распределение с сохранением пыли, кумулятивные начисления и построение Merkle-дерева, совместимого с `RewardVault.claim`.

**Architecture:** Всё ядро — чистые функции без I/O: на вход журнал хартбитов и состояние вольта, на выход распределение и корень. Ни сети, ни базы, ни времени — только аргументы. Это даёт полное покрытие тестами и детерминированное восстановление после сбоя воркера.

**Tech Stack:** Node 24 (нативное исполнение TypeScript без сборки), `node:test` + `node:assert` (встроенные), `@openzeppelin/merkle-tree` — единственная рантайм-зависимость, Foundry для кросс-проверки с контрактом.

**Spec:** `docs/superpowers/specs/2026-08-20-stock-mining-protocol-design.md`

**Предшествующий план:** `docs/superpowers/plans/2026-08-20-rewardvault-contract.md` (выполнен; `RewardVault` в `main`)

## Global Constraints

- Вся арифметика на `bigint`. `number` допустим только для номеров эпох и бакетов
- Округление всегда вниз. Остаток от деления **не теряется**: он не аллоцируется и остаётся в резерве
- Ни одна функция ядра не выполняет I/O: без `fetch`, без обращений к БД, без `Date.now()`. Время приходит аргументом
- Своей криптографии нет: дерево строится только через `@openzeppelin/merkle-tree`
- `EPOCH_SECONDS = 300`, `BUCKET_SECONDS = 10`, `BUCKETS_PER_EPOCH = 30`
- `RATE_WAD = 801_931_961_758_373` — полураспад 3 дня (864 эпохи)
- Формула листа обязана совпадать с контрактом: `keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))))`
- Комментарии в коде на английском, сообщения коммитов на русском
- Сборки нет: код исполняется как `.ts` напрямую. `typescript` нужен только для `tsc --noEmit`

## Проверено до написания плана

Эти факты установлены запуском, а не предположением — на них опирается весь план:

1. `node --test` находит и исполняет `*.test.ts` без транспиляции (Node 24.19)
2. `@openzeppelin/merkle-tree@1.0.8` с кодировкой `["address","uint256"]` даёт хеши листьев, **побайтово совпадающие** с формулой контракта
3. `RATE_WAD = 801_931_961_758_373` на целочисленной математике оставляет ровно 50.0000% резерва через 864 эпохи

---

## File Structure

Foundry уже владеет `src/`, `test/`, `script/`, поэтому офчейн-код живёт отдельно.

| Файл | Ответственность |
|---|---|
| `offchain/package.json` | манифест, скрипты, единственная зависимость |
| `offchain/tsconfig.json` | конфиг только для `tsc --noEmit`; сборки нет |
| `offchain/src/types.ts` | общие типы: `Address`, `HeartbeatRecord`, `VaultState`, вход и выход сеттлмента |
| `offchain/src/epoch.ts` | часы: эпохи, бакеты, границы |
| `offchain/src/weights.ts` | вес аккаунта из журнала хартбитов |
| `offchain/src/drip.ts` | свободный резерв и релиз эпохи |
| `offchain/src/allocate.ts` | деление релиза по весам, учёт пыли |
| `offchain/src/entitlements.ts` | накопление кумулятивов |
| `offchain/src/tree.ts` | обёртка над `@openzeppelin/merkle-tree` |
| `offchain/src/settle.ts` | сборка всего в одну чистую функцию |
| `offchain/test/*.test.ts` | по файлу на модуль плюс инвариантные тесты |
| `offchain/scripts/generate-merkle-fixture.ts` | генерация фикстуры для кросс-проверки |
| `test/MerkleCrossCheck.t.sol` | Foundry-тест: контракт принимает пруф, построенный в TS |
| `test/fixtures/merkle.json` | сама фикстура (коммитится) |

Один модуль — одна ответственность. Каждый тестируется в одиночку, `settle.ts` только соединяет их и не содержит собственной арифметики.

---

## Task 1: Каркас пакета и часы эпох

**Files:**
- Create: `offchain/package.json`, `offchain/tsconfig.json`, `offchain/.gitignore`
- Create: `offchain/src/epoch.ts`
- Test: `offchain/test/epoch.test.ts`

**Interfaces:**
- Consumes: ничего
- Produces: константы `EPOCH_SECONDS = 300`, `BUCKET_SECONDS = 10`, `BUCKETS_PER_EPOCH = 30`; функции `epochOf(unixSeconds: number): number`, `bucketOf(unixSeconds: number): number`, `epochOfBucket(bucketId: number): number`, `epochBucketRange(epoch: number): { first: number; last: number }`, `epochStart(epoch: number): number`, `epochEnd(epoch: number): number`

- [ ] **Step 1: Создать манифест пакета**

Файл `offchain/package.json`:

```json
{
  "name": "dwell-offchain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "test": "node --test",
    "typecheck": "tsc --noEmit",
    "fixture": "node scripts/generate-merkle-fixture.ts"
  },
  "dependencies": {
    "@openzeppelin/merkle-tree": "^1.0.8"
  },
  "devDependencies": {
    "@types/node": "^26.2.0",
    "typescript": "^5.7.0"
  }
}
```

`@types/node` обязателен: `tsconfig` объявляет `"types": ["node"]`, и без пакета `tsc` падает с `TS2688`, хотя тесты при этом проходят — Node исполняет TypeScript, не проверяя типы.

- [ ] **Step 2: Создать конфиг TypeScript и локальный .gitignore**

Файл `offchain/tsconfig.json`. `noEmit` не случайность: Node исполняет `.ts` напрямую, компилятор нужен только для проверки типов.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"]
}
```

Файл `offchain/.gitignore`:

```
node_modules/
```

- [ ] **Step 3: Установить зависимости**

```bash
cd offchain
npm install
```

- [ ] **Step 4: Написать падающий тест часов**

Файл `offchain/test/epoch.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EPOCH_SECONDS,
  BUCKET_SECONDS,
  BUCKETS_PER_EPOCH,
  epochOf,
  bucketOf,
  epochOfBucket,
  epochBucketRange,
  epochStart,
  epochEnd
} from "../src/epoch.ts";

test("константы соответствуют спецификации", () => {
  assert.equal(EPOCH_SECONDS, 300);
  assert.equal(BUCKET_SECONDS, 10);
  assert.equal(BUCKETS_PER_EPOCH, 30);
});

test("epochOf делит время на пятиминутки", () => {
  assert.equal(epochOf(0), 0);
  assert.equal(epochOf(299), 0);
  assert.equal(epochOf(300), 1);
  // Эпоха старта майнинга прототипа: 5955209 * 300 = 1786562700
  assert.equal(epochOf(1786562700), 5955209);
});

test("bucketOf делит время на десятисекундки", () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(9), 0);
  assert.equal(bucketOf(10), 1);
  assert.equal(bucketOf(1786562700), 178656270);
});

test("epochOfBucket согласован с epochOf", () => {
  for (const ts of [0, 7, 299, 300, 1786562700, 1787232900]) {
    assert.equal(epochOfBucket(bucketOf(ts)), epochOf(ts));
  }
});

test("epochBucketRange покрывает ровно 30 бакетов", () => {
  const { first, last } = epochBucketRange(5955209);
  assert.equal(last - first + 1, BUCKETS_PER_EPOCH);
  assert.equal(epochOfBucket(first), 5955209);
  assert.equal(epochOfBucket(last), 5955209);
  assert.equal(epochOfBucket(first - 1), 5955208);
  assert.equal(epochOfBucket(last + 1), 5955210);
});

test("границы эпохи полуоткрыты", () => {
  assert.equal(epochStart(1), 300);
  assert.equal(epochEnd(1), 600);
  assert.equal(epochOf(epochStart(1)), 1);
  assert.equal(epochOf(epochEnd(1) - 1), 1);
  assert.equal(epochOf(epochEnd(1)), 2);
});

test("отрицательное и дробное время отвергается", () => {
  assert.throws(() => epochOf(-1), /non-negative integer/);
  assert.throws(() => bucketOf(1.5), /non-negative integer/);
});
```

- [ ] **Step 5: Убедиться, что тест падает**

Run: `cd offchain && node --test test/epoch.test.ts`
Expected: FAIL — модуль `../src/epoch.ts` не существует.

- [ ] **Step 6: Реализовать часы**

Файл `offchain/src/epoch.ts`:

```typescript
/**
 * Epoch clock. Pure arithmetic over unix seconds — no ambient time source,
 * so every caller must pass the timestamp it wants interpreted.
 */

export const EPOCH_SECONDS = 300;
export const BUCKET_SECONDS = 10;
export const BUCKETS_PER_EPOCH = EPOCH_SECONDS / BUCKET_SECONDS;

function assertTimeIndex(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/** Epoch containing the given unix timestamp. */
export function epochOf(unixSeconds: number): number {
  assertTimeIndex(unixSeconds, "unixSeconds");
  return Math.floor(unixSeconds / EPOCH_SECONDS);
}

/** Heartbeat bucket containing the given unix timestamp. */
export function bucketOf(unixSeconds: number): number {
  assertTimeIndex(unixSeconds, "unixSeconds");
  return Math.floor(unixSeconds / BUCKET_SECONDS);
}

/** Epoch a bucket belongs to. */
export function epochOfBucket(bucketId: number): number {
  assertTimeIndex(bucketId, "bucketId");
  return Math.floor(bucketId / BUCKETS_PER_EPOCH);
}

/** Inclusive range of buckets belonging to an epoch. */
export function epochBucketRange(epoch: number): { first: number; last: number } {
  assertTimeIndex(epoch, "epoch");
  const first = epoch * BUCKETS_PER_EPOCH;
  return { first, last: first + BUCKETS_PER_EPOCH - 1 };
}

/** First second of an epoch (inclusive). */
export function epochStart(epoch: number): number {
  assertTimeIndex(epoch, "epoch");
  return epoch * EPOCH_SECONDS;
}

/** First second of the next epoch (exclusive end). */
export function epochEnd(epoch: number): number {
  assertTimeIndex(epoch, "epoch");
  return (epoch + 1) * EPOCH_SECONDS;
}
```

- [ ] **Step 7: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/epoch.test.ts`
Expected: PASS — 7 тестов.

- [ ] **Step 8: Коммит**

```bash
git add offchain/package.json offchain/package-lock.json offchain/tsconfig.json \
        offchain/.gitignore offchain/src/epoch.ts offchain/test/epoch.test.ts
git commit -m "Добавить офчейн-пакет и часы эпох"
```

---

## Task 2: Типы и расчёт весов

**Files:**
- Create: `offchain/src/types.ts`
- Create: `offchain/src/weights.ts`
- Test: `offchain/test/weights.test.ts`

**Interfaces:**
- Consumes: ничего из предыдущих задач
- Produces: типы `Address = \`0x${string}\``, `HeartbeatRecord { account: Address; bucketId: number; balance: bigint }`, `VaultState { balance: bigint; totalAllocated: bigint; totalClaimed: bigint }`; функции `computeWeights(heartbeats: readonly HeartbeatRecord[], minBalance: bigint): Map<Address, bigint>` и `sumWeights(weights: ReadonlyMap<Address, bigint>): bigint`

- [ ] **Step 1: Написать падающий тест весов**

Файл `offchain/test/weights.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeights, sumWeights } from "../src/weights.ts";
import type { Address, HeartbeatRecord } from "../src/types.ts";

const ALICE = "0xaaaa000000000000000000000000000000000001" as Address;
const BOB = "0xbbbb000000000000000000000000000000000002" as Address;

const MIN = 100_000n * 10n ** 18n;
const HELD = 150_000n * 10n ** 18n;

function hb(account: Address, bucketId: number, balance: bigint): HeartbeatRecord {
  return { account, bucketId, balance };
}

test("вес есть сумма балансов по активным бакетам", () => {
  const w = computeWeights([hb(ALICE, 1, HELD), hb(ALICE, 2, HELD), hb(ALICE, 3, HELD)], MIN);
  assert.equal(w.get(ALICE), HELD * 3n);
});

test("изменение баланса внутри эпохи учитывается побакетно", () => {
  const later = 200_000n * 10n ** 18n;
  const w = computeWeights([hb(ALICE, 1, HELD), hb(ALICE, 2, later)], MIN);
  assert.equal(w.get(ALICE), HELD + later);
});

test("баланс ниже порога не даёт веса", () => {
  const low = 99_999n * 10n ** 18n;
  const w = computeWeights([hb(ALICE, 1, low), hb(ALICE, 2, HELD)], MIN);
  assert.equal(w.get(ALICE), HELD);
});

test("аккаунт без единого проходного бакета отсутствует в результате", () => {
  const low = 1n;
  const w = computeWeights([hb(ALICE, 1, low)], MIN);
  assert.equal(w.has(ALICE), false);
});

test("ровно пороговый баланс проходит", () => {
  const w = computeWeights([hb(ALICE, 1, MIN)], MIN);
  assert.equal(w.get(ALICE), MIN);
});

test("веса разных аккаунтов не смешиваются", () => {
  const w = computeWeights([hb(ALICE, 1, HELD), hb(BOB, 1, MIN), hb(BOB, 2, MIN)], MIN);
  assert.equal(w.get(ALICE), HELD);
  assert.equal(w.get(BOB), MIN * 2n);
});

test("дробление баланса по кошелькам не даёт преимущества", () => {
  const whole = computeWeights([hb(ALICE, 1, MIN * 2n)], MIN);
  const split = computeWeights([hb(ALICE, 1, MIN), hb(BOB, 1, MIN)], MIN);
  assert.equal(sumWeights(whole), sumWeights(split));
});

test("пустой журнал даёт нулевой суммарный вес", () => {
  assert.equal(sumWeights(computeWeights([], MIN)), 0n);
});

test("повторный бакет одного аккаунта отвергается", () => {
  assert.throws(
    () => computeWeights([hb(ALICE, 1, HELD), hb(ALICE, 1, HELD)], MIN),
    /duplicate bucket/
  );
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/weights.test.ts`
Expected: FAIL — модули `../src/weights.ts` и `../src/types.ts` не существуют.

- [ ] **Step 3: Написать общие типы**

Файл `offchain/src/types.ts`:

```typescript
/** Lowercase 0x-prefixed EVM address. */
export type Address = `0x${string}`;

/** One accepted heartbeat: an account was active in a bucket holding a balance. */
export interface HeartbeatRecord {
  readonly account: Address;
  readonly bucketId: number;
  readonly balance: bigint;
}

/** On-chain state of the reward vault at settlement time. */
export interface VaultState {
  /** Reward-asset balance held by the vault. */
  readonly balance: bigint;
  readonly totalAllocated: bigint;
  readonly totalClaimed: bigint;
}

export interface SettlementInput {
  readonly epoch: number;
  readonly heartbeats: readonly HeartbeatRecord[];
  readonly vault: VaultState;
  readonly minBalance: bigint;
  readonly priorCumulative: ReadonlyMap<Address, bigint>;
}

export interface SettlementResult {
  readonly epoch: number;
  readonly totalWeight: bigint;
  readonly release: bigint;
  readonly allocations: ReadonlyMap<Address, bigint>;
  /** Remainder of integer division. Stays in the reserve, never lost. */
  readonly dust: bigint;
  readonly cumulative: ReadonlyMap<Address, bigint>;
  readonly totalAllocated: bigint;
}
```

- [ ] **Step 4: Реализовать расчёт весов**

Файл `offchain/src/weights.ts`:

```typescript
import type { Address, HeartbeatRecord } from "./types.ts";

/**
 * Weight is the sum of the balance sampled in every active bucket:
 *
 *   weight(a) = SUM over active buckets b of balance(a, b)
 *
 * Summing per bucket rather than multiplying a single balance by a bucket
 * count is what makes a mid-epoch balance change settle correctly.
 *
 * The relation is linear in balance, so splitting a balance across wallets
 * yields exactly the same total weight — sybil gains nothing.
 */
export function computeWeights(
  heartbeats: readonly HeartbeatRecord[],
  minBalance: bigint
): Map<Address, bigint> {
  const weights = new Map<Address, bigint>();
  const seen = new Set<string>();

  for (const record of heartbeats) {
    const key = `${record.account}:${record.bucketId}`;
    if (seen.has(key)) {
      throw new Error(`duplicate bucket ${record.bucketId} for account ${record.account}`);
    }
    seen.add(key);

    if (record.balance < minBalance) continue;

    weights.set(record.account, (weights.get(record.account) ?? 0n) + record.balance);
  }

  return weights;
}

export function sumWeights(weights: ReadonlyMap<Address, bigint>): bigint {
  let total = 0n;
  for (const weight of weights.values()) total += weight;
  return total;
}
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/weights.test.ts`
Expected: PASS — 9 тестов.

- [ ] **Step 6: Коммит**

```bash
git add offchain/src/types.ts offchain/src/weights.ts offchain/test/weights.test.ts
git commit -m "Добавить типы ядра и расчёт весов по бакетам"
```

---

## Task 3: Дрип из резерва

**Files:**
- Create: `offchain/src/drip.ts`
- Test: `offchain/test/drip.test.ts`

**Interfaces:**
- Consumes: `VaultState` из Task 2
- Produces: константы `WAD = 10n ** 18n`, `HALF_LIFE_DAYS = 3`, `EPOCHS_PER_DAY = 288`, `HALF_LIFE_EPOCHS = 864`, `RATE_WAD = 801_931_961_758_373n`; функции `unallocated(vault: VaultState): bigint` и `computeRelease(vault: VaultState, totalWeight: bigint): bigint`

- [ ] **Step 1: Написать падающий тест дрипа**

Файл `offchain/test/drip.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WAD,
  RATE_WAD,
  HALF_LIFE_EPOCHS,
  unallocated,
  computeRelease
} from "../src/drip.ts";
import type { VaultState } from "../src/types.ts";

function vault(balance: bigint, allocated: bigint, claimed: bigint): VaultState {
  return { balance, totalAllocated: allocated, totalClaimed: claimed };
}

const SOME_WEIGHT = 1_000n;

test("свободный резерв есть баланс минус непогашенные обязательства", () => {
  assert.equal(unallocated(vault(100n, 0n, 0n)), 100n);
  assert.equal(unallocated(vault(100n, 40n, 0n)), 60n);
  // 40 начислено, 25 уже забрано: баланс упал на 25, долг остался 15
  assert.equal(unallocated(vault(75n, 40n, 25n)), 60n);
});

test("нарушенная платёжеспособность отвергается", () => {
  assert.throws(() => unallocated(vault(10n, 100n, 0n)), /insolvent/);
});

test("релиз есть доля свободного резерва", () => {
  const reserve = 10n ** 18n;
  assert.equal(computeRelease(vault(reserve, 0n, 0n), SOME_WEIGHT), RATE_WAD);
});

test("без активного веса релиз не происходит", () => {
  assert.equal(computeRelease(vault(10n ** 24n, 0n, 0n), 0n), 0n);
});

test("релиз никогда не превышает свободный резерв", () => {
  for (const reserve of [1n, 7n, 10n ** 6n, 10n ** 24n]) {
    const v = vault(reserve, 0n, 0n);
    assert.ok(computeRelease(v, SOME_WEIGHT) <= unallocated(v));
  }
});

test("пустой резерв даёт нулевой релиз", () => {
  assert.equal(computeRelease(vault(0n, 0n, 0n), SOME_WEIGHT), 0n);
});

test("ставка воспроизводит полураспад в три дня", () => {
  const start = 10n ** 24n;
  let reserve = start;
  for (let i = 0; i < HALF_LIFE_EPOCHS; i++) {
    reserve -= computeRelease(vault(reserve, 0n, 0n), SOME_WEIGHT);
  }
  // Целочисленная математика: допуск в одну сотую процента
  const permille = (reserve * 10_000n) / start;
  assert.ok(permille >= 4_999n && permille <= 5_001n, `осталось ${permille} из 10000`);
});

test("ставка меньше единицы, резерв не обнуляется за один шаг", () => {
  assert.ok(RATE_WAD < WAD);
  assert.equal(HALF_LIFE_EPOCHS, 864);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/drip.test.ts`
Expected: FAIL — модуль `../src/drip.ts` не существует.

- [ ] **Step 3: Реализовать дрип**

Файл `offchain/src/drip.ts`:

```typescript
import type { VaultState } from "./types.ts";

export const WAD = 10n ** 18n;

export const HALF_LIFE_DAYS = 3;
export const EPOCHS_PER_DAY = 288;
export const HALF_LIFE_EPOCHS = HALF_LIFE_DAYS * EPOCHS_PER_DAY;

/**
 * Fraction of the free reserve released each epoch, scaled by WAD.
 *
 *   RATE = 1 - 0.5 ^ (1 / HALF_LIFE_EPOCHS)
 *        = 1 - 0.5 ^ (1 / 864)
 *        = 0.000801931961758373...
 *
 * Releasing a fraction rather than a fixed amount is what keeps the reward
 * stream smooth and non-zero: a share of something is always above zero, and
 * a spike in fee income spreads across days instead of landing in one epoch.
 */
export const RATE_WAD = 801_931_961_758_373n;

/**
 * Reward-asset balance not yet promised to anyone.
 *
 * Outstanding obligation is totalAllocated - totalClaimed: allocation only
 * grows, while the balance drops as accounts withdraw.
 */
export function unallocated(vault: VaultState): bigint {
  const outstanding = vault.totalAllocated - vault.totalClaimed;
  if (vault.balance < outstanding) {
    throw new Error(
      `insolvent vault state: balance ${vault.balance} < outstanding ${outstanding}`
    );
  }
  return vault.balance - outstanding;
}

/**
 * Amount to distribute this epoch. Floors, so the result never exceeds the
 * free reserve. With no active weight nothing is released and the reserve is
 * left untouched for later epochs.
 */
export function computeRelease(vault: VaultState, totalWeight: bigint): bigint {
  if (totalWeight <= 0n) return 0n;
  return (unallocated(vault) * RATE_WAD) / WAD;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/drip.test.ts`
Expected: PASS — 8 тестов.

- [ ] **Step 5: Коммит**

```bash
git add offchain/src/drip.ts offchain/test/drip.test.ts
git commit -m "Добавить экспоненциальный дрип с полураспадом в три дня"
```

---

## Task 4: Распределение и пыль

**Files:**
- Create: `offchain/src/allocate.ts`
- Test: `offchain/test/allocate.test.ts`

**Interfaces:**
- Consumes: `Address` из Task 2
- Produces: `allocate(release: bigint, weights: ReadonlyMap<Address, bigint>): { allocations: Map<Address, bigint>; dust: bigint }`

- [ ] **Step 1: Написать падающий тест распределения**

Файл `offchain/test/allocate.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;
const C = "0xcccc000000000000000000000000000000000003" as Address;

function sum(m: ReadonlyMap<Address, bigint>): bigint {
  let total = 0n;
  for (const v of m.values()) total += v;
  return total;
}

test("равные веса делят релиз поровну", () => {
  const { allocations, dust } = allocate(100n, new Map([[A, 1n], [B, 1n]]));
  assert.equal(allocations.get(A), 50n);
  assert.equal(allocations.get(B), 50n);
  assert.equal(dust, 0n);
});

test("доли пропорциональны весам", () => {
  const { allocations } = allocate(900n, new Map([[A, 1n], [B, 2n]]));
  assert.equal(allocations.get(A), 300n);
  assert.equal(allocations.get(B), 600n);
});

test("остаток от деления сохраняется в пыли, а не исчезает", () => {
  const { allocations, dust } = allocate(10n, new Map([[A, 1n], [B, 1n], [C, 1n]]));
  assert.equal(sum(allocations) + dust, 10n);
  assert.equal(dust, 1n);
});

test("сумма долей плюс пыль всегда равна релизу", () => {
  const cases: Array<[bigint, Array<[Address, bigint]>]> = [
    [7n, [[A, 3n], [B, 5n], [C, 11n]]],
    [1n, [[A, 1n], [B, 1n]]],
    [10n ** 24n, [[A, 7n], [B, 13n], [C, 999n]]],
    [0n, [[A, 1n]]]
  ];
  for (const [release, entries] of cases) {
    const { allocations, dust } = allocate(release, new Map(entries));
    assert.equal(sum(allocations) + dust, release);
  }
});

test("нулевой суммарный вес отправляет весь релиз в пыль", () => {
  const { allocations, dust } = allocate(500n, new Map());
  assert.equal(allocations.size, 0);
  assert.equal(dust, 500n);
});

test("нулевые доли не попадают в результат", () => {
  // Релиза не хватает даже на одну единицу владельцу крошечного веса
  const { allocations } = allocate(1n, new Map([[A, 1n], [B, 1_000_000n]]));
  assert.equal(allocations.has(A), false);
  assert.equal(allocations.get(B), 1n);
});

test("округление всегда вниз, переаллокация невозможна", () => {
  const { allocations } = allocate(10n, new Map([[A, 1n], [B, 2n]]));
  assert.equal(allocations.get(A), 3n);
  assert.equal(allocations.get(B), 6n);
  assert.ok(sum(allocations) <= 10n);
});

test("отрицательный релиз отвергается", () => {
  assert.throws(() => allocate(-1n, new Map([[A, 1n]])), /negative/);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/allocate.test.ts`
Expected: FAIL — модуль `../src/allocate.ts` не существует.

- [ ] **Step 3: Реализовать распределение**

Файл `offchain/src/allocate.ts`:

```typescript
import type { Address } from "./types.ts";

/**
 * Splits an epoch release across accounts in proportion to weight.
 *
 *   share(a) = floor(release * weight(a) / totalWeight)
 *
 * Every share floors, so the sum of shares is at most the release. The
 * remainder is returned as dust: the caller leaves it unallocated, which
 * hands it to later epochs. Nothing is ever created or lost.
 */
export function allocate(
  release: bigint,
  weights: ReadonlyMap<Address, bigint>
): { allocations: Map<Address, bigint>; dust: bigint } {
  if (release < 0n) throw new RangeError(`release must not be negative, got ${release}`);

  const allocations = new Map<Address, bigint>();

  let totalWeight = 0n;
  for (const weight of weights.values()) totalWeight += weight;
  if (totalWeight <= 0n) return { allocations, dust: release };

  let distributed = 0n;
  for (const [account, weight] of weights) {
    const share = (release * weight) / totalWeight;
    if (share > 0n) {
      allocations.set(account, share);
      distributed += share;
    }
  }

  return { allocations, dust: release - distributed };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/allocate.test.ts`
Expected: PASS — 8 тестов.

- [ ] **Step 5: Коммит**

```bash
git add offchain/src/allocate.ts offchain/test/allocate.test.ts
git commit -m "Добавить пропорциональное распределение с сохранением пыли"
```

---

## Task 5: Кумулятивные начисления

**Files:**
- Create: `offchain/src/entitlements.ts`
- Test: `offchain/test/entitlements.test.ts`

**Interfaces:**
- Consumes: `Address` из Task 2
- Produces: `accumulate(prior: ReadonlyMap<Address, bigint>, allocations: ReadonlyMap<Address, bigint>): Map<Address, bigint>` и `sumEntitlements(m: ReadonlyMap<Address, bigint>): bigint`

- [ ] **Step 1: Написать падающий тест кумулятивов**

Файл `offchain/test/entitlements.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulate, sumEntitlements } from "../src/entitlements.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

test("новый аккаунт получает свою аллокацию", () => {
  const next = accumulate(new Map(), new Map([[A, 10n]]));
  assert.equal(next.get(A), 10n);
});

test("аллокация прибавляется к прежнему кумулятиву", () => {
  const next = accumulate(new Map([[A, 10n]]), new Map([[A, 5n]]));
  assert.equal(next.get(A), 15n);
});

test("аккаунт без аллокации сохраняет кумулятив", () => {
  const next = accumulate(new Map([[A, 10n], [B, 7n]]), new Map([[A, 5n]]));
  assert.equal(next.get(A), 15n);
  assert.equal(next.get(B), 7n);
});

test("кумулятив монотонно не убывает", () => {
  let state = new Map<Address, bigint>();
  let previous = 0n;
  for (const amount of [3n, 0n, 11n, 0n, 1n]) {
    state = accumulate(state, amount > 0n ? new Map([[A, amount]]) : new Map());
    const current = state.get(A) ?? 0n;
    assert.ok(current >= previous);
    previous = current;
  }
  assert.equal(previous, 15n);
});

test("исходная карта не мутируется", () => {
  const prior = new Map([[A, 10n]]);
  accumulate(prior, new Map([[A, 5n]]));
  assert.equal(prior.get(A), 10n);
});

test("сумма кумулятивов равна сумме всех аллокаций", () => {
  let state = new Map<Address, bigint>();
  let expected = 0n;
  for (const [a, b] of [[3n, 4n], [5n, 0n], [0n, 9n]] as Array<[bigint, bigint]>) {
    const allocations = new Map<Address, bigint>();
    if (a > 0n) allocations.set(A, a);
    if (b > 0n) allocations.set(B, b);
    state = accumulate(state, allocations);
    expected += a + b;
  }
  assert.equal(sumEntitlements(state), expected);
});

test("отрицательная аллокация отвергается", () => {
  assert.throws(() => accumulate(new Map(), new Map([[A, -1n]])), /negative/);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/entitlements.test.ts`
Expected: FAIL — модуль `../src/entitlements.ts` не существует.

- [ ] **Step 3: Реализовать накопление**

Файл `offchain/src/entitlements.ts`:

```typescript
import type { Address } from "./types.ts";

/**
 * Folds one epoch's allocations into the running cumulative entitlements.
 *
 * The contract pays `cumulative - alreadyClaimed`, so these numbers may only
 * ever grow: a decrease would revoke an entitlement someone can already prove.
 * Returns a new map; the input is never mutated.
 */
export function accumulate(
  prior: ReadonlyMap<Address, bigint>,
  allocations: ReadonlyMap<Address, bigint>
): Map<Address, bigint> {
  const next = new Map(prior);

  for (const [account, amount] of allocations) {
    if (amount < 0n) {
      throw new RangeError(`allocation for ${account} must not be negative, got ${amount}`);
    }
    next.set(account, (next.get(account) ?? 0n) + amount);
  }

  return next;
}

export function sumEntitlements(entitlements: ReadonlyMap<Address, bigint>): bigint {
  let total = 0n;
  for (const value of entitlements.values()) total += value;
  return total;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/entitlements.test.ts`
Expected: PASS — 7 тестов.

- [ ] **Step 5: Коммит**

```bash
git add offchain/src/entitlements.ts offchain/test/entitlements.test.ts
git commit -m "Добавить накопление кумулятивных начислений"
```

---

## Task 6: Merkle-дерево

**Files:**
- Create: `offchain/src/tree.ts`
- Test: `offchain/test/tree.test.ts`

**Interfaces:**
- Consumes: `Address` из Task 2
- Produces: `buildTree(cumulative: ReadonlyMap<Address, bigint>): BuiltTree`, где `BuiltTree { root: Address; proofFor(account: Address): string[]; leafFor(account: Address): string; dump(): Array<{ account: Address; cumulative: bigint; proof: string[] }> }`

Своё дерево не пишем: `@openzeppelin/merkle-tree` с кодировкой `["address","uint256"]` даёт лист `keccak256(keccak256(abi.encode(...)))` и сортирует пары — ровно то, что проверяет `MerkleProof.verify` в контракте. Совместимость подтверждена сверкой хешей до написания плана и закрепляется тестом в Task 8.

- [ ] **Step 1: Написать падающий тест дерева**

Файл `offchain/test/tree.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { buildTree } from "../src/tree.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;
const C = "0xcccc000000000000000000000000000000000003" as Address;

const CUMULATIVE = new Map<Address, bigint>([
  [A, 100n * 10n ** 18n],
  [B, 50n * 10n ** 18n],
  [C, 7n]
]);

test("корень непустой и детерминированный", () => {
  const first = buildTree(CUMULATIVE);
  const second = buildTree(new Map([...CUMULATIVE].reverse()));
  assert.match(first.root, /^0x[0-9a-f]{64}$/);
  assert.equal(first.root, second.root, "порядок вставки не должен влиять на корень");
});

test("пруф каждого аккаунта проверяется библиотекой", () => {
  const tree = buildTree(CUMULATIVE);
  const oz = StandardMerkleTree.of(
    [...CUMULATIVE].map(([account, value]) => [account, value.toString()]),
    ["address", "uint256"]
  );
  for (const [account, value] of CUMULATIVE) {
    const proof = tree.proofFor(account);
    assert.ok(
      StandardMerkleTree.verify(oz.root, ["address", "uint256"], [account, value.toString()], proof),
      `пруф для ${account} не прошёл проверку`
    );
  }
});

test("dump отдаёт все записи с пруфами", () => {
  const entries = buildTree(CUMULATIVE).dump();
  assert.equal(entries.length, CUMULATIVE.size);
  for (const entry of entries) {
    assert.equal(CUMULATIVE.get(entry.account), entry.cumulative);
    assert.ok(Array.isArray(entry.proof));
  }
});

test("дерево из одного листа даёт пустой пруф", () => {
  const tree = buildTree(new Map([[A, 1n]]));
  assert.deepEqual(tree.proofFor(A), []);
  assert.equal(tree.root, tree.leafFor(A));
});

test("нулевые кумулятивы исключаются", () => {
  const tree = buildTree(new Map([[A, 5n], [B, 0n]]));
  assert.equal(tree.dump().length, 1);
  assert.throws(() => tree.proofFor(B), /not in tree/);
});

test("пустая карта отвергается", () => {
  assert.throws(() => buildTree(new Map()), /at least one/);
});

test("запрос пруфа для чужого аккаунта отвергается", () => {
  const tree = buildTree(CUMULATIVE);
  const stranger = "0xdddd000000000000000000000000000000000004" as Address;
  assert.throws(() => tree.proofFor(stranger), /not in tree/);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/tree.test.ts`
Expected: FAIL — модуль `../src/tree.ts` не существует.

- [ ] **Step 3: Реализовать обёртку дерева**

Файл `offchain/src/tree.ts`:

```typescript
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Address } from "./types.ts";

const LEAF_ENCODING = ["address", "uint256"] as const;

export interface TreeEntry {
  readonly account: Address;
  readonly cumulative: bigint;
  readonly proof: string[];
}

export interface BuiltTree {
  readonly root: string;
  proofFor(account: Address): string[];
  leafFor(account: Address): string;
  dump(): TreeEntry[];
}

/**
 * Builds the cumulative-entitlement tree the contract verifies against.
 *
 * StandardMerkleTree hashes a leaf as keccak256(keccak256(abi.encode(...)))
 * and sorts each pair before hashing — byte-for-byte the encoding used by
 * RewardVault.claim and OpenZeppelin's MerkleProof.verify. No hand-rolled
 * cryptography lives here on purpose; Task 8 pins the compatibility with a
 * test that feeds a proof built here into the real contract.
 *
 * Accounts with a zero cumulative are dropped: they have nothing to claim,
 * and a zero leaf would only enlarge every other account's proof.
 */
export function buildTree(cumulative: ReadonlyMap<Address, bigint>): BuiltTree {
  const values: Array<[Address, string]> = [];
  for (const [account, amount] of cumulative) {
    if (amount < 0n) {
      throw new RangeError(`cumulative for ${account} must not be negative, got ${amount}`);
    }
    if (amount === 0n) continue;
    values.push([account, amount.toString()]);
  }

  if (values.length === 0) {
    throw new Error("tree requires at least one account with a non-zero cumulative");
  }

  // Sort by account so the root depends only on content, never on insertion
  // order — the worker must reproduce an identical root after a restart.
  values.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const tree = StandardMerkleTree.of(values, [...LEAF_ENCODING]);

  const indexOf = new Map<Address, number>();
  for (const [index, value] of tree.entries()) {
    indexOf.set(value[0] as Address, index);
  }

  function requireIndex(account: Address): number {
    const index = indexOf.get(account);
    if (index === undefined) throw new Error(`account ${account} is not in tree`);
    return index;
  }

  return {
    root: tree.root,
    proofFor: (account) => tree.getProof(requireIndex(account)),
    leafFor: (account) => tree.leafHash(tree.at(requireIndex(account))!),
    dump: () =>
      values.map(([account, amount]) => ({
        account,
        cumulative: BigInt(amount),
        proof: tree.getProof(requireIndex(account))
      }))
  };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/tree.test.ts`
Expected: PASS — 7 тестов.

- [ ] **Step 5: Коммит**

```bash
git add offchain/src/tree.ts offchain/test/tree.test.ts
git commit -m "Добавить построение Merkle-дерева кумулятивов"
```

---

## Task 7: Сборка сеттлмента и инварианты

**Files:**
- Create: `offchain/src/settle.ts`
- Test: `offchain/test/settle.test.ts`
- Test: `offchain/test/invariants.test.ts`

**Interfaces:**
- Consumes: `computeWeights`, `sumWeights` (Task 2); `computeRelease` (Task 3); `allocate` (Task 4); `accumulate` (Task 5)
- Produces: `settle(input: SettlementInput): SettlementResult`

- [ ] **Step 1: Написать падающий тест сборки**

Файл `offchain/test/settle.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/settle.ts";
import { RATE_WAD, WAD } from "../src/drip.ts";
import type { Address, HeartbeatRecord, SettlementInput } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

const MIN = 100_000n * 10n ** 18n;
const RESERVE = 1_000n * 10n ** 18n;

function hb(account: Address, bucketId: number, balance: bigint): HeartbeatRecord {
  return { account, bucketId, balance };
}

function input(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    epoch: 5_955_209,
    heartbeats: [hb(A, 0, MIN), hb(B, 0, MIN)],
    vault: { balance: RESERVE, totalAllocated: 0n, totalClaimed: 0n },
    minBalance: MIN,
    priorCumulative: new Map(),
    ...overrides
  };
}

test("релиз делится по весам и попадает в кумулятивы", () => {
  const result = settle(input());
  const expectedRelease = (RESERVE * RATE_WAD) / WAD;

  assert.equal(result.release, expectedRelease);
  assert.equal(result.totalWeight, MIN * 2n);
  assert.equal(result.cumulative.get(A), expectedRelease / 2n);
  assert.equal(result.cumulative.get(B), expectedRelease / 2n);
  assert.equal(result.totalAllocated, expectedRelease - result.dust);
});

test("кумулятивы прошлых эпох переносятся", () => {
  const prior = new Map<Address, bigint>([[A, 1_000n], [B, 2_000n]]);
  const result = settle(input({ priorCumulative: prior }));

  assert.ok(result.cumulative.get(A)! > 1_000n);
  assert.ok(result.cumulative.get(B)! > 2_000n);
});

test("без активных майнеров резерв не трогается", () => {
  const result = settle(input({ heartbeats: [] }));

  assert.equal(result.release, 0n);
  assert.equal(result.totalWeight, 0n);
  assert.equal(result.allocations.size, 0);
  assert.equal(result.dust, 0n);
  assert.equal(result.totalAllocated, 0n);
});

test("майнеры ниже порога не получают ничего", () => {
  const result = settle(input({ heartbeats: [hb(A, 0, MIN - 1n)] }));
  assert.equal(result.totalWeight, 0n);
  assert.equal(result.release, 0n);
});

test("totalAllocated растёт на распределённое, а не на релиз", () => {
  const vault = { balance: RESERVE, totalAllocated: 500n, totalClaimed: 200n };
  const result = settle(input({ vault, priorCumulative: new Map([[A, 500n]]) }));
  const distributed = result.release - result.dust;
  assert.equal(result.totalAllocated, 500n + distributed);
});

test("номер эпохи прокидывается в результат", () => {
  assert.equal(settle(input({ epoch: 42 })).epoch, 42);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/settle.test.ts`
Expected: FAIL — модуль `../src/settle.ts` не существует.

- [ ] **Step 3: Реализовать сборку**

Файл `offchain/src/settle.ts`:

```typescript
import { computeWeights, sumWeights } from "./weights.ts";
import { computeRelease } from "./drip.ts";
import { allocate } from "./allocate.ts";
import { accumulate } from "./entitlements.ts";
import type { SettlementInput, SettlementResult } from "./types.ts";

/**
 * Settles one epoch.
 *
 * Pure: the same evidence and vault state always produce the same result.
 * That is what makes worker crash recovery safe — after a restart the same
 * root is recomputed rather than a different one being published.
 *
 * This function only wires the pieces together; every arithmetic decision
 * lives in the module that owns it.
 */
export function settle(input: SettlementInput): SettlementResult {
  const weights = computeWeights(input.heartbeats, input.minBalance);
  const totalWeight = sumWeights(weights);

  const release = computeRelease(input.vault, totalWeight);
  const { allocations, dust } = allocate(release, weights);
  const cumulative = accumulate(input.priorCumulative, allocations);

  // Dust was never handed to anyone, so it stays in the reserve and funds
  // later epochs. Allocation therefore grows by what was distributed.
  const distributed = release - dust;

  return {
    epoch: input.epoch,
    totalWeight,
    release,
    allocations,
    dust,
    cumulative,
    totalAllocated: input.vault.totalAllocated + distributed
  };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/settle.test.ts`
Expected: PASS — 6 тестов.

- [ ] **Step 5: Написать инвариантные тесты**

Файл `offchain/test/invariants.test.ts`. Это проверка свойств на псевдослучайных последовательностях — замена аудита на той части, где живут деньги.

```typescript
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

    for (let epoch = 1; epoch <= 100; epoch++) {
      const result = settle({
        epoch,
        heartbeats: randomHeartbeats(rand, epoch),
        vault,
        minBalance: MIN,
        priorCumulative: cumulative
      });

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

      // 5. Платёжеспособность: обещано не больше, чем куплено
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
    priorCumulative: new Map<Address, bigint>()
  };

  const first = settle(args);
  const second = settle(args);

  assert.equal(first.release, second.release);
  assert.equal(first.totalAllocated, second.totalAllocated);
  assert.deepEqual([...first.cumulative], [...second.cumulative]);
});
```

- [ ] **Step 6: Прогнать инварианты и весь набор**

Run: `cd offchain && node --test`
Expected: PASS — 54 теста: epoch 7, weights 9, drip 8, allocate 8, entitlements 7, tree 7, settle 6, invariants 2.

- [ ] **Step 7: Проверить типы**

Run: `cd offchain && npm run typecheck`
Expected: без ошибок.

- [ ] **Step 8: Коммит**

```bash
git add offchain/src/settle.ts offchain/test/settle.test.ts offchain/test/invariants.test.ts
git commit -m "Собрать сеттлмент эпохи и покрыть инвариантами"
```

---

## Task 8: Кросс-проверка дерева с контрактом

**Files:**
- Create: `offchain/scripts/generate-merkle-fixture.ts`
- Create: `test/fixtures/merkle.json`
- Create: `test/MerkleCrossCheck.t.sol`

**Interfaces:**
- Consumes: `buildTree` из Task 6; `RewardVault` из предыдущего плана
- Produces: фикстура `test/fixtures/merkle.json` со схемой `{ root, count, entries: [{ account, cumulative, proof }] }`, где `cumulative` записан шестнадцатеричной строкой

Это ключевая задача плана. Все предыдущие тесты проверяют TS сам против себя; здесь пруф, построенный офчейн, скармливается **настоящему контракту**. Если офчейн и ончейн разойдутся в кодировке листа, майнеры не смогут забрать награду — и узнать об этом надо здесь, а не в мейннете.

- [ ] **Step 1: Написать генератор фикстуры**

Файл `offchain/scripts/generate-merkle-fixture.ts`:

```typescript
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildTree } from "../src/tree.ts";
import type { Address } from "../src/types.ts";

/**
 * Writes a fixture consumed by test/MerkleCrossCheck.t.sol.
 *
 * Cumulative amounts are written as hex strings: JSON numbers lose precision
 * above 2^53, and Foundry's parseJsonUint reads hex strings exactly.
 */
const CUMULATIVE = new Map<Address, bigint>([
  ["0x0000000000000000000000000000000000000101" as Address, 4n * 10n ** 18n],
  ["0x0000000000000000000000000000000000000202" as Address, 1n * 10n ** 18n],
  ["0x0000000000000000000000000000000000000303" as Address, 250_000_000_000_000_000n],
  ["0x0000000000000000000000000000000000000404" as Address, 1n],
  ["0x0000000000000000000000000000000000000505" as Address, 123_456_789_987_654_321n]
]);

const tree = buildTree(CUMULATIVE);

const fixture = {
  root: tree.root,
  count: tree.dump().length,
  entries: tree.dump().map((entry) => ({
    account: entry.account,
    cumulative: `0x${entry.cumulative.toString(16)}`,
    proof: entry.proof
  }))
};

const target = resolve(import.meta.dirname, "../../test/fixtures/merkle.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);

const total = [...CUMULATIVE.values()].reduce((sum, value) => sum + value, 0n);
console.log(`wrote ${target}`);
console.log(`root ${fixture.root}`);
console.log(`entries ${fixture.count}, total cumulative ${total}`);
```

- [ ] **Step 2: Сгенерировать фикстуру**

Run: `cd offchain && npm run fixture`
Expected: вывод с путём, корнем и `entries 5`. Файл `test/fixtures/merkle.json` создан.

- [ ] **Step 3: Написать падающий Foundry-тест**

Файл `test/MerkleCrossCheck.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Proves the off-chain tree and the on-chain verifier agree. The fixture
///      is produced by offchain/scripts/generate-merkle-fixture.ts; if the leaf
///      encodings ever diverge, miners could not claim, so this test is the
///      guard that keeps the two halves in sync.
contract MerkleCrossCheckTest is Test {
    RewardVault internal vault;
    MockERC20 internal token;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");

    string internal fixture;

    function setUp() public {
        token = new MockERC20("Tesla Mock", "TSLA");
        vault = new RewardVault(IERC20(address(token)), admin, keeper, 1_000e18);
        fixture = vm.readFile("test/fixtures/merkle.json");
    }

    function _entryPath(uint256 index, string memory field)
        internal
        pure
        returns (string memory)
    {
        return string.concat("$.entries[", vm.toString(index), "].", field);
    }

    function test_contractAcceptsProofsBuiltOffchain() public {
        bytes32 root = vm.parseJsonBytes32(fixture, "$.root");
        uint256 count = vm.parseJsonUint(fixture, "$.count");
        assertGt(count, 0, "fixture is empty");

        uint256 totalCumulative;
        for (uint256 i = 0; i < count; i++) {
            totalCumulative += vm.parseJsonUint(fixture, _entryPath(i, "cumulative"));
        }

        token.mint(address(vault), totalCumulative);

        vm.prank(admin);
        vault.setMaxAllocationIncreasePerRoot(totalCumulative);

        vm.prank(keeper);
        vault.publishRoot(1, root, totalCumulative);
        vm.warp(block.timestamp + 300);

        for (uint256 i = 0; i < count; i++) {
            address account = vm.parseJsonAddress(fixture, _entryPath(i, "account"));
            uint256 cumulative = vm.parseJsonUint(fixture, _entryPath(i, "cumulative"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(fixture, _entryPath(i, "proof"));

            vm.prank(account);
            vault.claim(cumulative, proof);

            assertEq(token.balanceOf(account), cumulative, "claimed amount mismatch");
        }

        assertEq(vault.totalClaimed(), totalCumulative, "not every entitlement was claimed");
        assertEq(vault.outstanding(), 0, "obligations remain after full claim");
    }

    function test_tamperedCumulativeIsRejected() public {
        bytes32 root = vm.parseJsonBytes32(fixture, "$.root");
        address account = vm.parseJsonAddress(fixture, _entryPath(0, "account"));
        uint256 cumulative = vm.parseJsonUint(fixture, _entryPath(0, "cumulative"));
        bytes32[] memory proof = vm.parseJsonBytes32Array(fixture, _entryPath(0, "proof"));

        token.mint(address(vault), 1_000e18);
        vm.prank(keeper);
        vault.publishRoot(1, root, 1_000e18);
        vm.warp(block.timestamp + 300);

        vm.prank(account);
        vm.expectRevert(RewardVault.InvalidProof.selector);
        vault.claim(cumulative + 1, proof);
    }
}
```

- [ ] **Step 4: Убедиться, что тест падает до генерации фикстуры**

Если фикстура уже сгенерирована на шаге 2, временно проверить обратное поведение:

Run: `mv test/fixtures/merkle.json test/fixtures/merkle.json.bak && forge test --match-path test/MerkleCrossCheck.t.sol`
Expected: FAIL — `vm.readFile` не находит файл.

Затем вернуть: `mv test/fixtures/merkle.json.bak test/fixtures/merkle.json`

- [ ] **Step 5: Прогнать кросс-проверку**

Run: `forge test --match-path test/MerkleCrossCheck.t.sol -vv`
Expected: PASS — 2 теста. Это доказывает, что дерево из TypeScript принимается контрактом побайтово.

Если `test_contractAcceptsProofsBuiltOffchain` падает на `InvalidProof` — разошлись кодировки листа. Не «чинить» подгонкой контракта: сверить порядок и типы в `abi.encode` с `LEAF_ENCODING` в `offchain/src/tree.ts`.

- [ ] **Step 6: Прогнать оба набора целиком**

Run: `forge test && cd offchain && node --test`
Expected: Foundry — 31 тест (29 прежних + 2 новых). Node — 47 тестов.

- [ ] **Step 7: Коммит**

```bash
git add offchain/scripts/generate-merkle-fixture.ts test/fixtures/merkle.json \
        test/MerkleCrossCheck.t.sol
git commit -m "Доказать совместимость офчейн-дерева с контрактом"
```

---

## Что этот план не покрывает

Реализуется в плане 3:

- HTTP API, сессии, приём хартбитов
- Схема Postgres и работа с ней
- Воркер, publisher, watchdog
- Конвертация комиссий ETH в TSLA
- Чтение балансов с цепочки через multicall
