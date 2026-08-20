# Worker and Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Достроить выпускающую половину DWELL: периодический сеттлмент эпох, публикацию корня в `RewardVault`, watchdog с правом паузы, конвертацию комиссий одной транзакцией и режим dry-run с рабочей последовательностью запуска.

**Architecture:** Воркер живёт в том же процессе, что и API, но отдельным путём кода. Он ничего не считает сам — вся денежная арифметика уже лежит в чистых функциях из плана ядра, и воркер только подаёт им данные из базы и относит результат в цепочку. Всё, что пишет в цепочку, собрано в один модуль `ChainWriter`, чтобы ключ кипера имел ровно одну точку входа. Тесты идут против форка настоящей сети: настоящие TSLA, WETH и роутер, ненастоящие деньги.

**Tech Stack:** Node 24 (нативный TypeScript), `node:sqlite`, `node:test`, `viem`, Foundry (`anvil` для форка, `forge` для контракта).

**Spec:** `docs/superpowers/specs/2026-08-20-stock-mining-protocol-design.md`

**Предшествующие планы:** `2026-08-20-rewardvault-contract.md`, `2026-08-20-settlement-core.md`, `2026-08-20-backend-intake.md` — все выполнены и влиты в `main`.

## Global Constraints

- Вся арифметика на `bigint`. В SQLite денежные величины хранятся как `TEXT`
- Адреса контрактов — константы в `src/config.ts`. **Никогда** не резолвятся по символу: в сети есть токены-двойники с идентичными именем и символом
- Ядро сеттлмента остаётся чистым: модули `settle.ts`, `drip.ts`, `weights.ts`, `allocate.ts`, `entitlements.ts`, `tree.ts` не получают I/O
- Приватный ключ читается только из окружения, никогда не логируется и не попадает в ответы API
- Комментарии в коде на английском, сообщения коммитов на русском
- Каждая транзакция отправляется через `ChainWriter`. Никакой другой модуль не держит `WalletClient`

## Проверено до написания плана

Установлено запуском против живой сети, а не предположением. Каждый пункт менял бы код, если бы его не проверили:

1. **Своп — одна транзакция, а не три.** `SwapRouter02.exactInputSingle` объявлен `payable`, а его внутренний `pay()` при `tokenIn == WETH9` сам вызывает `IWETH9.deposit{value}`. `recipient` кладёт TSLA сразу в вольт. Симуляция на живом состоянии: 0.01 ETH → 0.0665 TSLA на адрес вольта одним вызовом. Отдельные `WETH.deposit()`, `approve` и перевод **не нужны**
2. **Структура `ExactInputSingleParams` содержит 7 полей и не содержит `deadline`.** `SwapRouter02` отличается от канонического `SwapRouter`, где полей 8. Сигнатура по памяти дала бы неверный селектор
3. **Сеть — Arbitrum Nitro, ArbOS 116**, не OP-Stack: есть `ArbSys` и `ArbGasInfo`, нет `GasPriceOracle`. `perL1CalldataByte = 0`, поэтому калldata бесплатна и `eth_estimateGas` покрывает полную стоимость
4. **`publishRoot` стоит до 105 000 газа** при цене ~0.0203 gwei. Публикация каждую эпоху обходится ~$50/мес, раз в 30 минут — ~$8/мес
5. **`eth_getLogs` отдаёт события минимум на 100 000 блоков назад**, тогда как состояние живёт 6000–8000. Watchdog переживает рестарт и проверяет историю задним числом
6. **`pause()` в текущем контракте доступен только админу**, а watchdog держит ключ кипера. Это чинится в Task 1

---

## File Structure

| Файл | Ответственность |
|---|---|
| `src/RewardVault.sol` | правка: `pause()` принимает кипера |
| `offchain/src/chain/writer.ts` | единственный держатель ключа: `publishRoot`, `pause`, своп |
| `offchain/src/worker/settleJob.ts` | сеттлмент одной эпохи: база → чистое ядро → база |
| `offchain/src/worker/publisher.ts` | публикация корня по интервалу, таблица `roots` |
| `offchain/src/worker/watchdog.ts` | сверка корня из события с журналом, пауза при расхождении |
| `offchain/src/worker/feeConverter.ts` | конвертация ETH в TSLA по порогу |
| `offchain/src/worker/loop.ts` | планировщик: что и когда запускается |
| `offchain/src/db/roots.ts` | хранилище опубликованных корней |
| `offchain/src/db/purchases.ts` | хранилище конвертаций |
| `offchain/src/main.ts` | точка входа: API и воркер вместе |
| `offchain/test/helpers/fork.ts` | подъём `anvil` на форке живой сети |
| `docs/RUNBOOK.md` | последовательность запуска и действия при инцидентах |

Воркер разбит по глаголам, а не по слоям: каждый файл делает ровно одно действие и тестируется без остальных. `loop.ts` — единственное место, где появляется расписание.

---

## Task 1: Право паузы для кипера

Watchdog живёт в процессе воркера с горячим ключом кипера. Холодный админ-ключ по определению не онлайн в три часа ночи, а окно активации корня — 300 секунд. Без этой правки watchdog может только написать в лог.

`unpause()` остаётся за админом: скомпрометированный кипер в худшем случае устраивает DoS, который админ снимает, и не может вернуть протокол в рабочий режим ради собственной выгоды.

**Files:**
- Modify: `src/RewardVault.sol`
- Test: `test/RewardVault.admin.t.sol`

**Interfaces:**
- Consumes: ничего
- Produces: `pause()` вызывается держателем `KEEPER_ROLE` или `DEFAULT_ADMIN_ROLE`; `unpause()` по-прежнему только `DEFAULT_ADMIN_ROLE`; новая ошибка `NotPauser()`

- [ ] **Step 1: Написать падающие тесты паузы**

Добавить в `test/RewardVault.admin.t.sol`, перед закрывающей скобкой контракта:

```solidity
function test_pause_keeperMayPause() public {
    vm.prank(keeper);
    vault.pause();
    assertTrue(vault.paused(), "keeper must be able to stop the protocol");
}

function test_pause_keeperMayNotUnpause() public {
    vm.prank(keeper);
    vault.pause();

    vm.prank(keeper);
    vm.expectRevert();
    vault.unpause();
}

function test_pause_adminMayPauseAndUnpause() public {
    vm.prank(admin);
    vault.pause();
    assertTrue(vault.paused());

    vm.prank(admin);
    vault.unpause();
    assertFalse(vault.paused());
}

function test_pause_strangerMayNotPause() public {
    address stranger = makeAddr("stranger");
    vm.prank(stranger);
    vm.expectRevert(RewardVault.NotPauser.selector);
    vault.pause();
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `forge test --match-path test/RewardVault.admin.t.sol`
Expected: FAIL — `test_pause_keeperMayPause` откатывается, `NotPauser` не существует.

- [ ] **Step 3: Внести правку в контракт**

В `src/RewardVault.sol` добавить ошибку рядом с остальными:

```solidity
    error NotPauser();
```

Заменить существующий `pause()` на:

```solidity
    /**
     * @notice Halts publishing and claiming.
     * @dev Callable by the keeper as well as the admin. The watchdog runs in
     *      the worker process holding the keeper key, and the admin key is
     *      cold by design — if only the admin could pause, the watchdog could
     *      do nothing but write a log line while a bad root matured.
     *
     *      Pausing is the fail-safe direction: it stops harm rather than
     *      causing it. Unpausing is not, so it stays with the cold key. A
     *      compromised keeper can therefore halt the protocol but never
     *      restart it on its own terms.
     */
    function pause() external {
        if (!hasRole(KEEPER_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotPauser();
        }
        _pause();
    }
```

`unpause()` не трогать.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `forge test --match-path test/RewardVault.admin.t.sol`
Expected: PASS.

- [ ] **Step 5: Прогнать весь набор контракта**

Run: `forge test && forge fmt --check`
Expected: PASS — правка не ломает инварианты и форк-тесты.

- [ ] **Step 6: Коммит**

```bash
git add src/RewardVault.sol test/RewardVault.admin.t.sol
git commit -F - <<'MSG'
Дать киперу право ставить паузу

Watchdog живёт с горячим ключом кипера, а админ-ключ холодный. Без этой
правки watchdog успевал бы только написать в лог, пока злой корень
дозревает 300 секунд. Снятие паузы осталось за админом: пауза ведёт в
сторону безопасности, возврат в рабочий режим — нет.
MSG
```

---

## Task 2: Форк-стенд и запись в цепочку

Тесты записи идут против `anvil`, поднятого форком живой сети. Там настоящие TSLA, WETH и роутер, но деньги ненастоящие — это ровно то, что требует спека §8.

**Files:**
- Create: `offchain/test/helpers/fork.ts`
- Create: `offchain/src/chain/writer.ts`
- Test: `offchain/test/writer.test.ts`

**Interfaces:**
- Consumes: `ADDRESSES`, `POOL_FEE`, `SLIPPAGE_BPS` из `config.ts`; `robinhoodChain` из `chain/client.ts`
- Produces: `startFork(): Promise<ForkHandle>` где `ForkHandle = { rpcUrl, stop() }`; константы `KEEPER_KEY`, `KEEPER_ADDRESS`; класс `ChainWriter` с `publishRoot(vault, epoch, root, totalAllocated)`, `pause(vault)`, `swapEthForReward(recipient, amountIn, options?)`, геттер `address`

- [ ] **Step 1: Написать форк-стенд**

Файл `offchain/test/helpers/fork.ts`. Это тестовая инфраструктура; отдельных тестов у неё нет — её работоспособность доказывают тесты, которые ею пользуются.

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http } from "viem";
import type { Address } from "../../src/types.ts";

const LIVE_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Anvil's first default account. Public knowledge, worthless outside a fork. */
export const KEEPER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const KEEPER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

export interface ForkHandle {
  readonly rpcUrl: string;
  readonly stop: () => void;
}

/**
 * Boots anvil forking the live chain.
 *
 * Readiness is confirmed by polling rather than by parsing stdout: anvil's
 * banner format is not a stable interface, and a test suite that breaks on
 * a tool's cosmetic change is worse than one that waits.
 */
export async function startFork(): Promise<ForkHandle> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpcUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(
    "anvil",
    ["--fork-url", LIVE_RPC, "--port", String(port), "--silent", "--no-rate-limit"],
    { stdio: "ignore" }
  );

  const client = createPublicClient({ transport: http(rpcUrl) });
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await client.getBlockNumber();
      return { rpcUrl, stop: () => child.kill() };
    } catch {
      await delay(500);
    }
  }

  child.kill();
  throw new Error("anvil did not become ready in 60s");
}
```

- [ ] **Step 2: Написать падающий тест записи**

Файл `offchain/test/writer.test.ts`:

```typescript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, createPublicClient, http } from "viem";
import { startFork, KEEPER_KEY, KEEPER_ADDRESS, type ForkHandle } from "./helpers/fork.ts";
import { ChainWriter } from "../src/chain/writer.ts";
import { ADDRESSES } from "../src/config.ts";
import type { Address } from "../src/types.ts";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const SINK = "0x000000000000000000000000000000000000dEaD" as Address;

let fork: ForkHandle | null = null;
let writer: ChainWriter;

before(async () => {
  try {
    fork = await startFork();
  } catch {
    fork = null;
    return;
  }
  writer = new ChainWriter(fork.rpcUrl, KEEPER_KEY);
});

after(() => fork?.stop());

test("кошелёк знает свой адрес", (t) => {
  if (!fork) return t.skip("anvil недоступен");
  assert.equal(writer.address.toLowerCase(), KEEPER_ADDRESS.toLowerCase());
});

test("своп кладёт TSLA прямо на адрес получателя одной транзакцией", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  const client = createPublicClient({ transport: http(fork.rpcUrl) });

  const before = await client.readContract({
    address: ADDRESSES.tsla,
    abi: ERC20,
    functionName: "balanceOf",
    args: [SINK]
  });

  const result = await writer.swapEthForReward(SINK, 10n ** 16n);

  const after = await client.readContract({
    address: ADDRESSES.tsla,
    abi: ERC20,
    functionName: "balanceOf",
    args: [SINK]
  });

  assert.ok(after > before, "получатель должен получить TSLA");
  assert.equal(after - before, result.amountOut, "отчёт должен совпасть с фактом");
  assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
});

test("своп уважает лимит проскальзывания", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  // Минимум выше того, что пул способен отдать, обязан развернуть транзакцию.
  await assert.rejects(
    () => writer.swapEthForReward(SINK, 10n ** 16n, { minOutOverride: 10n ** 24n }),
    /Too little received|reverted|revert/i
  );
});

test("своп нулевой суммы отвергается до обращения к сети", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  await assert.rejects(() => writer.swapEthForReward(SINK, 0n), /amountIn must be positive/);
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `cd offchain && node --test test/writer.test.ts`
Expected: FAIL — модуль `../src/chain/writer.ts` не существует.

- [ ] **Step 4: Реализовать запись в цепочку**

Файл `offchain/src/chain/writer.ts`:

```typescript
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "./client.ts";
import { ADDRESSES, POOL_FEE, SLIPPAGE_BPS } from "../config.ts";
import type { Address } from "../types.ts";

/**
 * SwapRouter02, not the canonical v3 SwapRouter.
 *
 * The params struct has SEVEN fields and no `deadline` — the canonical
 * router has eight. Writing the familiar signature from memory produces a
 * different selector and every swap reverts. Taken from the verified source
 * on the explorer, not from documentation.
 */
const ROUTER_ABI = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)"
]);

const VAULT_ABI = parseAbi([
  "function publishRoot(uint64 newEpoch, bytes32 newRoot, uint256 newTotalAllocated)",
  "function pause()"
]);

const BPS = 10_000n;

export interface SwapResult {
  readonly txHash: Hex;
  readonly amountOut: bigint;
}

export interface SwapOptions {
  /** Test hook: forces a minimum the pool cannot satisfy. */
  readonly minOutOverride?: bigint;
}

/**
 * The single holder of the keeper key.
 *
 * Every state-changing call the protocol makes goes through here, so there
 * is exactly one file to audit for what the hot key is able to do.
 */
export class ChainWriter {
  readonly #public: PublicClient;
  readonly #wallet: WalletClient;
  readonly #account;

  constructor(rpcUrl: string, privateKey: string) {
    this.#account = privateKeyToAccount(privateKey as Hex);
    const transport = http(rpcUrl);
    this.#public = createPublicClient({ chain: robinhoodChain, transport });
    this.#wallet = createWalletClient({
      account: this.#account,
      chain: robinhoodChain,
      transport
    });
  }

  get address(): Address {
    return this.#account.address;
  }

  async publishRoot(
    vault: Address,
    epoch: number,
    root: Hex,
    totalAllocated: bigint
  ): Promise<Hex> {
    const { request } = await this.#public.simulateContract({
      account: this.#account,
      address: vault,
      abi: VAULT_ABI,
      functionName: "publishRoot",
      args: [BigInt(epoch), root, totalAllocated]
    });
    const hash = await this.#wallet.writeContract(request);
    await this.#public.waitForTransactionReceipt({ hash });
    return hash;
  }

  async pause(vault: Address): Promise<Hex> {
    const { request } = await this.#public.simulateContract({
      account: this.#account,
      address: vault,
      abi: VAULT_ABI,
      functionName: "pause"
    });
    const hash = await this.#wallet.writeContract(request);
    await this.#public.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Converts native ETH into the reward asset in ONE transaction.
   *
   * The router is payable and its internal pay() wraps ETH itself when
   * tokenIn is WETH9, and `recipient` delivers straight to the vault. A
   * separate WETH.deposit(), an approve and a transfer are all unnecessary —
   * each removed transaction is a removed failure mode and one less moment
   * where the hot wallet holds value.
   *
   * The expected output comes from simulating the very same call, so no
   * Quoter contract has to be pinned or kept in sync.
   */
  async swapEthForReward(
    recipient: Address,
    amountIn: bigint,
    options: SwapOptions = {}
  ): Promise<SwapResult> {
    if (amountIn <= 0n) throw new RangeError("amountIn must be positive");

    const params = {
      tokenIn: ADDRESSES.weth,
      tokenOut: ADDRESSES.tsla,
      fee: POOL_FEE,
      recipient,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n
    } as const;

    const quoted = await this.#public.simulateContract({
      account: this.#account,
      address: ADDRESSES.swapRouter,
      abi: ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [params],
      value: amountIn
    });
    const expected = quoted.result as bigint;

    const minimum = options.minOutOverride ?? (expected * (BPS - BigInt(SLIPPAGE_BPS))) / BPS;

    const { request } = await this.#public.simulateContract({
      account: this.#account,
      address: ADDRESSES.swapRouter,
      abi: ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{ ...params, amountOutMinimum: minimum }],
      value: amountIn
    });

    const txHash = await this.#wallet.writeContract(request);
    await this.#public.waitForTransactionReceipt({ hash: txHash });

    return { txHash, amountOut: expected };
  }
}
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/writer.test.ts`
Expected: PASS — 4 теста, либо пропуски если `anvil` не установлен.

- [ ] **Step 6: Коммит**

```bash
git add offchain/src/chain/writer.ts offchain/test/writer.test.ts offchain/test/helpers/fork.ts
git commit -F - <<'MSG'
Добавить запись в цепочку и форк-стенд

Своп идёт одной транзакцией: роутер payable и сам оборачивает ETH, а
recipient кладёт TSLA прямо в вольт. Структура параметров SwapRouter02
содержит семь полей без deadline — канонический роутер тут не подходит.
MSG
```

---

## Task 3: Сеттлмент эпохи

Воркер не считает деньги. Он достаёт из базы то, что уже записано, отдаёт чистой функции `settle` из плана ядра и кладёт результат обратно. Вся арифметика уже покрыта тестами там.

**Files:**
- Create: `offchain/src/worker/settleJob.ts`
- Test: `offchain/test/settleJob.test.ts`

**Interfaces:**
- Consumes: `HeartbeatStore`, `EntitlementStore`, `EpochStore` из плана приёма; `settle` из `settle.ts`
- Produces: `settleEpoch(deps: SettleDeps, epoch: number): Promise<SettlementResult>` где `SettleDeps = { heartbeats, entitlements, epochs, reader, vaultAddress, minBalance }`

- [ ] **Step 1: Написать падающий тест сеттлмента**

Файл `offchain/test/settleJob.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { HeartbeatStore } from "../src/db/heartbeats.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { EpochStore } from "../src/db/epochs.ts";
import { settleEpoch } from "../src/worker/settleJob.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;
const VAULT = "0xeeee000000000000000000000000000000000003" as Address;
const MIN = 100n;

function fixture(balance: bigint) {
  const db = openDatabase(":memory:");
  const heartbeats = new HeartbeatStore(db);
  const entitlements = new EntitlementStore(db);
  const epochs = new EpochStore(db);

  const reader = {
    vaultState: async () => ({ balance, totalAllocated: 0n, totalClaimed: 0n })
  };

  return {
    heartbeats,
    entitlements,
    epochs,
    deps: { heartbeats, entitlements, epochs, reader, vaultAddress: VAULT, minBalance: MIN }
  };
}

test("эпоха без хартбитов ничего не начисляет, но закрывается", async () => {
  const { deps, epochs } = fixture(10n ** 21n);
  const result = await settleEpoch(deps, 3);

  assert.equal(result.totalWeight, 0n);
  assert.equal(result.release, 0n);
  assert.equal(epochs.lastSettled(), 3, "пустая эпоха всё равно закрывается");
});

test("начисления попадают в кумулятивы", async () => {
  const { deps, heartbeats, entitlements } = fixture(10n ** 21n);
  heartbeats.accept(A, 90);
  heartbeats.accept(B, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n], [B, 100n]]));

  const result = await settleEpoch(deps, 3);

  assert.ok(result.release > 0n, "резерв должен выпустить награду");
  const stored = entitlements.load();
  assert.equal(stored.get(A), result.allocations.get(A));
  assert.ok(stored.get(A)! > stored.get(B)!, "больший баланс получает больше");
});

test("аккаунты ниже минимального баланса не участвуют", async () => {
  const { deps, heartbeats, entitlements } = fixture(10n ** 21n);
  heartbeats.accept(A, 90);
  heartbeats.accept(B, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n], [B, 99n]]));

  await settleEpoch(deps, 3);
  assert.equal(entitlements.load().has(B), false, "баланс 99 ниже порога 100");
});

test("кумулятивы накапливаются между эпохами", async () => {
  const { deps, heartbeats, entitlements } = fixture(10n ** 21n);
  heartbeats.accept(A, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n]]));
  await settleEpoch(deps, 3);
  const first = entitlements.load().get(A)!;

  heartbeats.accept(A, 120);
  heartbeats.fillBucket(120, 1, new Map([[A, 300n]]));
  await settleEpoch(deps, 4);
  const second = entitlements.load().get(A)!;

  assert.ok(second > first, "кумулятив обязан расти, а не заменяться");
});

test("повторный сеттлмент эпохи отвергается", async () => {
  const { deps, heartbeats } = fixture(10n ** 21n);
  heartbeats.accept(A, 90);
  heartbeats.fillBucket(90, 1, new Map([[A, 300n]]));

  await settleEpoch(deps, 3);
  await assert.rejects(() => settleEpoch(deps, 3), /already settled/);
});

test("сеттлмент детерминирован на тех же данных", async () => {
  const build = () => {
    const f = fixture(10n ** 21n);
    f.heartbeats.accept(A, 90);
    f.heartbeats.accept(B, 91);
    f.heartbeats.fillBucket(90, 1, new Map([[A, 500n]]));
    f.heartbeats.fillBucket(91, 1, new Map([[B, 700n]]));
    return f.deps;
  };

  const left = await settleEpoch(build(), 3);
  const right = await settleEpoch(build(), 3);

  assert.equal(left.totalAllocated, right.totalAllocated);
  assert.deepEqual([...left.cumulative], [...right.cumulative]);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/settleJob.test.ts`
Expected: FAIL — модуль `../src/worker/settleJob.ts` не существует.

- [ ] **Step 3: Реализовать сеттлмент**

Файл `offchain/src/worker/settleJob.ts`:

```typescript
import { settle } from "../settle.ts";
import type { HeartbeatStore } from "../db/heartbeats.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { EpochStore } from "../db/epochs.ts";
import type { Address, SettlementResult, VaultState } from "../types.ts";

export interface SettleDeps {
  readonly heartbeats: HeartbeatStore;
  readonly entitlements: EntitlementStore;
  readonly epochs: EpochStore;
  readonly reader: { vaultState(vault: Address): Promise<VaultState> };
  readonly vaultAddress: Address;
  readonly minBalance: bigint;
}

/**
 * Settles one epoch: read the journal, call the pure core, write the result.
 *
 * No arithmetic happens here on purpose. Everything about money lives in
 * settle() and the modules beneath it, which are pure and fully tested —
 * this function only moves data across the I/O boundary.
 *
 * The epoch is marked settled BEFORE entitlements are written, so that the
 * primary key rejects a second settlement even if the process dies midway.
 * A crash then leaves an epoch closed with no payout rather than an epoch
 * paid twice; the first is a rounding loss, the second is insolvency.
 */
export async function settleEpoch(
  deps: SettleDeps,
  epoch: number
): Promise<SettlementResult> {
  const heartbeats = deps.heartbeats.listForEpoch(epoch);
  const vault = await deps.reader.vaultState(deps.vaultAddress);
  const priorCumulative = deps.entitlements.load();

  const result = settle({
    epoch,
    heartbeats,
    vault,
    minBalance: deps.minBalance,
    priorCumulative
  });

  deps.epochs.markSettled(epoch, result.totalWeight, result.release);

  if (result.allocations.size > 0) {
    deps.entitlements.save(result.cumulative);
  }

  return result;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/settleJob.test.ts`
Expected: PASS — 6 тестов.

- [ ] **Step 5: Коммит**

```bash
git add offchain/src/worker/settleJob.ts offchain/test/settleJob.test.ts
git commit -F - <<'MSG'
Добавить сеттлмент эпохи

Воркер не считает деньги: достаёт журнал, отдаёт чистой функции settle и
кладёт результат обратно. Эпоха отмечается закрытой до записи начислений,
поэтому смерть процесса посередине оставляет эпоху без выплаты, а не
выплаченной дважды.
MSG
```

---

## Task 4: Публикация корня

Публикация отделена от сеттлмента: считаем каждые 5 минут бесплатно, публикуем раз в 30 минут за газ. Дерево кумулятивное, поэтому один корень покрывает все посчитанные эпохи и ни одно начисление не теряется.

**Files:**
- Create: `offchain/src/db/roots.ts`
- Create: `offchain/src/worker/publisher.ts`
- Test: `offchain/test/publisher.test.ts`

**Interfaces:**
- Consumes: `EntitlementStore`, `EpochStore`, `buildTree`, `sumEntitlements`
- Produces: `RootStore` с `record(throughEpoch, root, txHash)`, `lastPublished()`, `rootFor(throughEpoch)`; `PUBLISH_EVERY_EPOCHS = 6`; `publishIfDue(deps: PublishDeps): Promise<PublishOutcome>`

- [ ] **Step 1: Написать падающий тест публикации**

Файл `offchain/test/publisher.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { EpochStore } from "../src/db/epochs.ts";
import { RootStore } from "../src/db/roots.ts";
import { publishIfDue, PUBLISH_EVERY_EPOCHS } from "../src/worker/publisher.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;
const VAULT = "0xeeee000000000000000000000000000000000003" as Address;

function fixture() {
  const db = openDatabase(":memory:");
  const entitlements = new EntitlementStore(db);
  const epochs = new EpochStore(db);
  const roots = new RootStore(db);

  const sent: Array<{ epoch: number; root: string; totalAllocated: bigint }> = [];
  const writer = {
    publishRoot: async (
      _vault: Address,
      epoch: number,
      root: `0x${string}`,
      totalAllocated: bigint
    ) => {
      sent.push({ epoch, root, totalAllocated });
      return ("0x" + "ab".repeat(32)) as `0x${string}`;
    }
  };

  return {
    entitlements,
    epochs,
    roots,
    sent,
    deps: { entitlements, epochs, roots, writer, vaultAddress: VAULT, dryRun: false }
  };
}

test("без посчитанных эпох публиковать нечего", async () => {
  const { deps, sent } = fixture();
  const outcome = await publishIfDue(deps);
  assert.equal(outcome.published, false);
  assert.equal(sent.length, 0);
});

test("публикация ждёт, пока накопится интервал", async () => {
  const { deps, epochs, entitlements, sent } = fixture();
  entitlements.save(new Map([[A, 500n]]));
  epochs.markSettled(100, 10n, 5n);

  assert.equal((await publishIfDue(deps)).published, false, "одна эпоха — рано");
  assert.equal(sent.length, 0);

  for (let e = 101; e < 100 + PUBLISH_EVERY_EPOCHS; e++) epochs.markSettled(e, 10n, 5n);
  const outcome = await publishIfDue(deps);

  assert.equal(outcome.published, true);
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0]!.epoch,
    100 + PUBLISH_EVERY_EPOCHS - 1,
    "корень покрывает всё до последней посчитанной эпохи"
  );
});

test("опубликованный корень записывается и не публикуется дважды", async () => {
  const { deps, epochs, entitlements, roots, sent } = fixture();
  entitlements.save(new Map([[A, 500n]]));
  for (let e = 100; e < 100 + PUBLISH_EVERY_EPOCHS; e++) epochs.markSettled(e, 10n, 5n);

  const first = await publishIfDue(deps);
  assert.equal(first.published, true);
  assert.equal(roots.lastPublished(), 100 + PUBLISH_EVERY_EPOCHS - 1);

  const second = await publishIfDue(deps);
  assert.equal(second.published, false, "та же эпоха не публикуется повторно");
  assert.equal(sent.length, 1);
});

test("сумма начислений уходит в цепочку как totalAllocated", async () => {
  const { deps, epochs, entitlements, sent } = fixture();
  entitlements.save(new Map([[A, 500n], [B, 700n]]));
  for (let e = 100; e < 100 + PUBLISH_EVERY_EPOCHS; e++) epochs.markSettled(e, 10n, 5n);

  await publishIfDue(deps);
  assert.equal(sent[0]!.totalAllocated, 1_200n);
});

test("dry-run считает корень, но ничего не отправляет", async () => {
  const { deps, epochs, entitlements, roots, sent } = fixture();
  entitlements.save(new Map([[A, 500n]]));
  for (let e = 100; e < 100 + PUBLISH_EVERY_EPOCHS; e++) epochs.markSettled(e, 10n, 5n);

  const outcome = await publishIfDue({ ...deps, dryRun: true });

  // assert.ok narrows the union for TypeScript; assert.equal does not, and
  // outcome.reason only exists on the not-published branch.
  assert.ok(!outcome.published);
  assert.match(outcome.reason, /dry-run/);
  assert.equal(sent.length, 0, "в dry-run сеть не трогается");
  assert.equal(roots.lastPublished(), null, "в dry-run ничего не записывается");
});

test("пустые кумулятивы не публикуются", async () => {
  const { deps, epochs, sent } = fixture();
  for (let e = 100; e < 100 + PUBLISH_EVERY_EPOCHS; e++) epochs.markSettled(e, 0n, 0n);

  const outcome = await publishIfDue(deps);
  assert.equal(outcome.published, false, "дерево без листьев построить нельзя");
  assert.equal(sent.length, 0);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/publisher.test.ts`
Expected: FAIL — модули `../src/db/roots.ts` и `../src/worker/publisher.ts` не существуют.

- [ ] **Step 3: Написать хранилище корней**

Файл `offchain/src/db/roots.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";

export interface PublishedRoot {
  readonly throughEpoch: number;
  readonly root: string;
  readonly txHash: string | null;
}

export class RootStore {
  readonly #insert;
  readonly #last;
  readonly #byEpoch;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      "INSERT INTO roots (through_epoch, root, tx_hash, published_at) VALUES (?, ?, ?, ?)"
    );
    this.#last = db.prepare("SELECT max(through_epoch) AS epoch FROM roots");
    this.#byEpoch = db.prepare(
      "SELECT through_epoch, root, tx_hash FROM roots WHERE through_epoch = ?"
    );
  }

  /** The primary key on through_epoch makes a double publish impossible. */
  record(throughEpoch: number, root: string, txHash: string): void {
    this.#insert.run(throughEpoch, root, txHash, Date.now());
  }

  lastPublished(): number | null {
    const row = this.#last.get() as Record<string, unknown> | undefined;
    const value = row?.epoch;
    return value === null || value === undefined ? null : Number(value);
  }

  rootFor(throughEpoch: number): PublishedRoot | null {
    const row = this.#byEpoch.get(throughEpoch) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      throughEpoch: Number(row.through_epoch),
      root: String(row.root),
      txHash: row.tx_hash === null ? null : String(row.tx_hash)
    };
  }
}
```

- [ ] **Step 4: Написать публикацию**

Файл `offchain/src/worker/publisher.ts`:

```typescript
import { buildTree } from "../tree.ts";
import { sumEntitlements } from "../entitlements.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { EpochStore } from "../db/epochs.ts";
import type { RootStore } from "../db/roots.ts";
import type { Address } from "../types.ts";
import type { Hex } from "viem";

/**
 * Six epochs, thirty minutes.
 *
 * Settlement runs every epoch and costs nothing; publishing costs gas. At
 * 105k gas a root and ~0.0203 gwei, publishing every epoch runs about
 * $50/month against $8 at this interval. Because the tree is cumulative,
 * one root covers every epoch settled since the last one — no entitlement
 * is lost, it only becomes claimable later.
 *
 * This is deliberately NOT tied to the epoch length: they answer different
 * questions.
 */
export const PUBLISH_EVERY_EPOCHS = 6;

export interface PublishDeps {
  readonly entitlements: EntitlementStore;
  readonly epochs: EpochStore;
  readonly roots: RootStore;
  readonly writer: {
    publishRoot(vault: Address, epoch: number, root: Hex, totalAllocated: bigint): Promise<Hex>;
  };
  readonly vaultAddress: Address;
  /** When true the root is computed and reported but never sent. */
  readonly dryRun: boolean;
}

export type PublishOutcome =
  | { readonly published: false; readonly reason: string; readonly root?: string }
  | {
      readonly published: true;
      readonly throughEpoch: number;
      readonly root: string;
      readonly txHash: string;
    };

export async function publishIfDue(deps: PublishDeps): Promise<PublishOutcome> {
  const lastSettled = deps.epochs.lastSettled();
  if (lastSettled === null) return { published: false, reason: "no epoch settled yet" };

  const lastPublished = deps.roots.lastPublished();
  if (lastPublished !== null && lastSettled <= lastPublished) {
    return { published: false, reason: "no new epochs since last root" };
  }

  const sinceLast = lastPublished === null ? lastSettled + 1 : lastSettled - lastPublished;
  if (sinceLast < PUBLISH_EVERY_EPOCHS) {
    return { published: false, reason: `only ${sinceLast} epochs since last root` };
  }

  const cumulative = deps.entitlements.load();
  const anyAllocated = [...cumulative.values()].some((amount) => amount > 0n);
  if (!anyAllocated) return { published: false, reason: "nothing allocated yet" };

  const tree = buildTree(cumulative);
  const totalAllocated = sumEntitlements(cumulative);

  if (deps.dryRun) {
    return { published: false, reason: `dry-run: would publish ${tree.root}`, root: tree.root };
  }

  const txHash = await deps.writer.publishRoot(
    deps.vaultAddress,
    lastSettled,
    tree.root as Hex,
    totalAllocated
  );

  deps.roots.record(lastSettled, tree.root, txHash);

  return { published: true, throughEpoch: lastSettled, root: tree.root, txHash };
}
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/publisher.test.ts`
Expected: PASS — 6 тестов.

- [ ] **Step 6: Коммит**

```bash
git add offchain/src/db/roots.ts offchain/src/worker/publisher.ts offchain/test/publisher.test.ts
git commit -F - <<'MSG'
Добавить публикацию корня по интервалу

Считаем каждую эпоху бесплатно, публикуем раз в шесть за газ. Дерево
кумулятивное, поэтому один корень покрывает все посчитанные эпохи и
начисления не теряются, а лишь позже становятся клеймабельными.
MSG
```

---

## Task 5: Watchdog

Пересчёт той же функции на тех же данных всегда совпадает — сравнивать их бессмысленно. Watchdog берёт корень **из события в цепочке** и сверяет с пересчитанным из журнала. Расхождение означает, что опубликованное не следует из нашего журнала.

**Files:**
- Create: `offchain/src/worker/watchdog.ts`
- Modify: `offchain/src/chain/reader.ts`
- Test: `offchain/test/watchdog.test.ts`

**Interfaces:**
- Consumes: `EntitlementStore`, `buildTree`
- Produces: `checkPublishedRoot(deps: WatchdogDeps): Promise<WatchdogVerdict>`; новый метод `ChainReader.lastPublishedRoot(vault)`

- [ ] **Step 1: Написать падающий тест watchdog**

Файл `offchain/test/watchdog.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
import { buildTree } from "../src/tree.ts";
import { checkPublishedRoot } from "../src/worker/watchdog.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const VAULT = "0xeeee000000000000000000000000000000000003" as Address;
const FAKE_ROOT = "0x" + "cd".repeat(32);

function fixture(onChainRoot: string | null) {
  const db = openDatabase(":memory:");
  const entitlements = new EntitlementStore(db);
  entitlements.save(new Map([[A, 500n]]));

  const paused: Address[] = [];
  const alerts: string[] = [];

  return {
    entitlements,
    paused,
    alerts,
    deps: {
      entitlements,
      vaultAddress: VAULT,
      reader: {
        lastPublishedRoot: async () =>
          onChainRoot === null ? null : { root: onChainRoot, throughEpoch: 105 }
      },
      writer: {
        pause: async (vault: Address) => {
          paused.push(vault);
          return ("0x" + "de".repeat(32)) as `0x${string}`;
        }
      },
      alert: (message: string) => alerts.push(message)
    }
  };
}

test("совпадающий корень не вызывает тревоги", async () => {
  const expected = buildTree(new Map([[A, 500n]])).root;
  const { deps, paused, alerts } = fixture(expected);

  const verdict = await checkPublishedRoot(deps);

  assert.equal(verdict.ok, true);
  assert.equal(paused.length, 0);
  assert.equal(alerts.length, 0);
});

test("расхождение немедленно ставит паузу", async () => {
  const { deps, paused, alerts } = fixture(FAKE_ROOT);

  const verdict = await checkPublishedRoot(deps);

  // assert.ok narrows the union; the mismatch branch owns `paused`.
  assert.ok(!verdict.ok, "расхождение обязано быть замечено");
  assert.equal(verdict.paused, true);
  assert.deepEqual(paused, [VAULT], "вольт обязан быть остановлен");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /mismatch/i);
});

test("отчёт называет оба корня", async () => {
  const expected = buildTree(new Map([[A, 500n]])).root;
  const { deps } = fixture(FAKE_ROOT);

  const verdict = await checkPublishedRoot(deps);

  assert.ok(!verdict.ok);
  assert.equal(verdict.actual, FAKE_ROOT);
  assert.equal(verdict.expected, expected);
});

test("без опубликованных корней проверять нечего", async () => {
  const { deps, paused } = fixture(null);

  const verdict = await checkPublishedRoot(deps);

  assert.equal(verdict.ok, true);
  assert.equal(paused.length, 0);
});

test("провал паузы не глотается молча", async () => {
  const { deps, alerts } = fixture(FAKE_ROOT);
  const failing = {
    ...deps,
    writer: {
      pause: async () => {
        throw new Error("rpc down");
      }
    }
  };

  const verdict = await checkPublishedRoot(failing);

  assert.ok(!verdict.ok);
  assert.equal(verdict.paused, false, "пауза не прошла, и это обязано быть видно");
  assert.equal(alerts.length, 2, "тревога о расхождении и тревога о провале паузы");
  assert.match(alerts[1]!, /rpc down/);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/watchdog.test.ts`
Expected: FAIL — модуль `../src/worker/watchdog.ts` не существует.

- [ ] **Step 3: Реализовать watchdog**

Файл `offchain/src/worker/watchdog.ts`:

```typescript
import { buildTree } from "../tree.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { Address } from "../types.ts";
import type { Hex } from "viem";

export interface WatchdogDeps {
  readonly entitlements: EntitlementStore;
  readonly vaultAddress: Address;
  readonly reader: {
    lastPublishedRoot(vault: Address): Promise<{ root: string; throughEpoch: number } | null>;
  };
  readonly writer: { pause(vault: Address): Promise<Hex> };
  readonly alert: (message: string) => void;
}

export type WatchdogVerdict =
  | { readonly ok: true; readonly checked: number }
  | {
      readonly ok: false;
      readonly expected: string;
      readonly actual: string;
      readonly paused: boolean;
    };

/**
 * Compares the root the chain actually carries against the root our journal
 * produces.
 *
 * Recomputing the same pure function over the same data would always agree —
 * that comparison proves nothing. The value is in where the other side comes
 * from: the root is read from the chain's own event log. A mismatch means
 * the published root does not follow from our journal, which is exactly
 * three things, all serious:
 *
 *   1. somebody else used the keeper key;
 *   2. the journal diverged from what was settled (corruption, a race, a
 *      publish from stale memory);
 *   3. the worker sent something other than what it computed.
 *
 * None of these is reachable by unit tests, which is why the check has to
 * exist at runtime.
 */
export async function checkPublishedRoot(deps: WatchdogDeps): Promise<WatchdogVerdict> {
  const published = await deps.reader.lastPublishedRoot(deps.vaultAddress);
  if (published === null) return { ok: true, checked: 0 };

  const cumulative = deps.entitlements.load();
  const expected = buildTree(cumulative).root;

  if (expected.toLowerCase() === published.root.toLowerCase()) {
    return { ok: true, checked: published.throughEpoch };
  }

  deps.alert(
    `root mismatch through epoch ${published.throughEpoch}: ` +
      `chain has ${published.root}, journal produces ${expected}`
  );

  // The pause is attempted immediately and its failure is surfaced rather
  // than swallowed: a watchdog that silently failed to stop the protocol is
  // worse than no watchdog at all, because it would still be trusted.
  let paused = false;
  try {
    await deps.writer.pause(deps.vaultAddress);
    paused = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.alert(`WATCHDOG COULD NOT PAUSE: ${message}`);
  }

  return { ok: false, expected, actual: published.root, paused };
}
```

- [ ] **Step 4: Добавить чтение опубликованного корня**

В `offchain/src/chain/reader.ts` поправить импорт viem:

```typescript
import { parseAbi, parseAbiItem, type PublicClient } from "viem";
```

Добавить рядом с другими ABI:

```typescript
const ROOT_PUBLISHED_EVENT = parseAbiItem(
  "event RootPublished(uint64 indexed throughEpoch, bytes32 root, uint256 totalAllocated)"
);

/**
 * How far back to scan for published roots. Events, unlike state, survive
 * far beyond the node's pruning window — measured at 100k blocks against
 * 6-8k for state — so the watchdog works after a restart and can audit
 * history after the fact.
 */
const LOG_LOOKBACK_BLOCKS = 100_000n;
```

Добавить метод в класс `ChainReader`, после `vaultState`:

```typescript
  async lastPublishedRoot(
    vault: Address
  ): Promise<{ root: string; throughEpoch: number } | null> {
    const head = await this.currentBlock();
    const from = head > LOG_LOOKBACK_BLOCKS ? head - LOG_LOOKBACK_BLOCKS : 0n;

    const logs = await this.#client.getLogs({
      address: vault,
      event: ROOT_PUBLISHED_EVENT,
      fromBlock: from,
      toBlock: head
    });

    const latest = logs.at(-1);
    if (!latest) return null;

    return {
      root: latest.args.root as string,
      throughEpoch: Number(latest.args.throughEpoch)
    };
  }
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/watchdog.test.ts && npm run typecheck`
Expected: PASS — 5 тестов, типы без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add offchain/src/worker/watchdog.ts offchain/src/chain/reader.ts offchain/test/watchdog.test.ts
git commit -F - <<'MSG'
Добавить watchdog со сверкой корня из события

Пересчёт той же функции на тех же данных всегда совпадает и ничего не
доказывает. Watchdog берёт корень из события в цепочке: расхождение
означает, что опубликованное не следует из нашего журнала. Провал паузы
не глотается — watchdog, молча не остановивший протокол, хуже, чем его
отсутствие, потому что ему верят.
MSG
```

---

## Task 6: Конвертация комиссий

**Files:**
- Create: `offchain/src/db/purchases.ts`
- Create: `offchain/src/worker/feeConverter.ts`
- Modify: `offchain/src/chain/reader.ts`
- Test: `offchain/test/feeConverter.test.ts`

**Interfaces:**
- Consumes: `ChainWriter.swapEthForReward` из Task 2
- Produces: `PurchaseStore` с `record(ethIn, tslaOut, txHash)`, `total()`; `GAS_RESERVE_WEI`; `convertFeesIfDue(deps: ConvertDeps): Promise<ConvertOutcome>`; новый метод `ChainReader.ethBalance(account)`

- [ ] **Step 1: Написать падающий тест конвертации**

Файл `offchain/test/feeConverter.test.ts`:

```typescript
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/feeConverter.test.ts`
Expected: FAIL — модули `../src/db/purchases.ts` и `../src/worker/feeConverter.ts` не существуют.

- [ ] **Step 3: Написать хранилище покупок**

Файл `offchain/src/db/purchases.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";

export class PurchaseStore {
  readonly #insert;
  readonly #all;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      "INSERT INTO purchases (eth_in, tsla_out, tx_hash, bought_at) VALUES (?, ?, ?, ?)"
    );
    this.#all = db.prepare("SELECT eth_in, tsla_out FROM purchases");
  }

  record(ethIn: bigint, tslaOut: bigint, txHash: string): void {
    this.#insert.run(ethIn.toString(), tslaOut.toString(), txHash, Date.now());
  }

  /** Summed in JS, not in SQL: these are wei and SQLite would overflow them. */
  total(): { ethIn: bigint; tslaOut: bigint } {
    let ethIn = 0n;
    let tslaOut = 0n;
    for (const row of this.#all.all()) {
      const record = row as Record<string, unknown>;
      ethIn += BigInt(String(record.eth_in));
      tslaOut += BigInt(String(record.tsla_out));
    }
    return { ethIn, tslaOut };
  }
}
```

- [ ] **Step 4: Написать конвертацию**

Файл `offchain/src/worker/feeConverter.ts`:

```typescript
import type { PurchaseStore } from "../db/purchases.ts";
import type { Address } from "../types.ts";
import type { Hex } from "viem";

/**
 * Held back so the keeper can always afford to publish and, more
 * importantly, to PAUSE. A wallet that swapped its last wei could not stop
 * the protocol in an emergency, which would quietly disarm the watchdog.
 *
 * At ~0.0203 gwei and ~105k gas a publish costs ~2.1e12 wei, so this covers
 * roughly five thousand transactions.
 */
export const GAS_RESERVE_WEI = 10n ** 16n;

export interface ConvertDeps {
  readonly purchases: PurchaseStore;
  readonly vaultAddress: Address;
  readonly threshold: bigint;
  readonly reader: { ethBalance(account: Address): Promise<bigint> };
  readonly writer: {
    readonly address: Address;
    swapEthForReward(
      recipient: Address,
      amountIn: bigint
    ): Promise<{ txHash: Hex; amountOut: bigint }>;
  };
  readonly dryRun: boolean;
}

export type ConvertOutcome =
  | { readonly converted: false; readonly reason: string }
  | {
      readonly converted: true;
      readonly ethIn: bigint;
      readonly tslaOut: bigint;
      readonly txHash: string;
    };

/**
 * Turns accumulated creator fees into the reward asset.
 *
 * One transaction: the router wraps the ETH itself and delivers the output
 * straight to the vault, so the hot wallet never holds the reward asset and
 * no approve is left standing anywhere.
 */
export async function convertFeesIfDue(deps: ConvertDeps): Promise<ConvertOutcome> {
  const balance = await deps.reader.ethBalance(deps.writer.address);
  if (balance <= GAS_RESERVE_WEI) {
    return { converted: false, reason: "balance is entirely gas reserve" };
  }

  const spendable = balance - GAS_RESERVE_WEI;
  if (spendable < deps.threshold) {
    return { converted: false, reason: `${spendable} wei is below threshold` };
  }

  if (deps.dryRun) {
    return { converted: false, reason: `dry-run: would swap ${spendable} wei` };
  }

  const { txHash, amountOut } = await deps.writer.swapEthForReward(deps.vaultAddress, spendable);
  deps.purchases.record(spendable, amountOut, txHash);

  return { converted: true, ethIn: spendable, tslaOut: amountOut, txHash };
}
```

- [ ] **Step 5: Добавить чтение баланса ETH**

Добавить метод в класс `ChainReader` в `offchain/src/chain/reader.ts`:

```typescript
  ethBalance(account: Address): Promise<bigint> {
    return this.#client.getBalance({ address: account });
  }
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/feeConverter.test.ts && npm run typecheck`
Expected: PASS — 5 тестов.

- [ ] **Step 7: Коммит**

```bash
git add offchain/src/db/purchases.ts offchain/src/worker/feeConverter.ts \
        offchain/src/chain/reader.ts offchain/test/feeConverter.test.ts
git commit -F - <<'MSG'
Добавить конвертацию комиссий в награду

Одна транзакция: роутер сам оборачивает ETH и кладёт TSLA прямо в вольт,
поэтому горячий кошелёк никогда не держит награду и не оставляет висящих
approve. Газовый резерв не свопается — кошелёк, потративший последний
wei, не смог бы поставить паузу.
MSG
```

---

## Task 7: Планировщик, точка входа и рабочая последовательность

**Files:**
- Create: `offchain/src/worker/loop.ts`
- Create: `offchain/src/main.ts`
- Create: `docs/RUNBOOK.md`
- Modify: `offchain/src/config.ts`
- Test: `offchain/test/loop.test.ts`

**Interfaces:**
- Consumes: всё из Task 2–6
- Produces: `runWorkerTick(deps: TickDeps, nowSeconds: number): Promise<TickReport>`; `startWorker(deps, intervalMs): WorkerHandle`; `loadWorkerConfig(env): WorkerConfig`

- [ ] **Step 1: Написать падающий тест планировщика**

Файл `offchain/test/loop.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkerTick, type TickDeps } from "../src/worker/loop.ts";
import { epochOf } from "../src/epoch.ts";

const NOW_SECONDS = 1_787_000_000;
const CURRENT_EPOCH = epochOf(NOW_SECONDS);

// Partial<TickDeps>, not Record<string, unknown>: spreading an index
// signature would widen the typed fields and lose the contract this file
// is meant to be checking.
function fixture(overrides: Partial<TickDeps> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      closeBuckets: async () => {
        calls.push("closeBuckets");
        return 1;
      },
      settleEpoch: async (epoch: number) => {
        calls.push(`settle:${epoch}`);
        return null;
      },
      publishIfDue: async () => {
        calls.push("publish");
        return { published: false, reason: "x" };
      },
      checkPublishedRoot: async () => {
        calls.push("watchdog");
        return { ok: true, checked: 0 };
      },
      convertFeesIfDue: async () => {
        calls.push("convert");
        return { converted: false, reason: "x" };
      },
      lastSettledEpoch: () => CURRENT_EPOCH - 2,
      alert: () => {},
      ...overrides
    }
  };
}

test("тик закрывает бакеты раньше, чем считает эпохи", async () => {
  const { deps, calls } = fixture();
  await runWorkerTick(deps, NOW_SECONDS);
  assert.equal(calls[0], "closeBuckets", "балансы должны быть прочитаны до расчёта");
});

test("текущая эпоха не считается — она ещё не кончилась", async () => {
  const { deps, calls } = fixture();
  await runWorkerTick(deps, NOW_SECONDS);
  assert.ok(!calls.includes(`settle:${CURRENT_EPOCH}`), "незакрытую эпоху считать нельзя");
  assert.ok(calls.includes(`settle:${CURRENT_EPOCH - 1}`), "прошлая эпоха обязана быть посчитана");
});

test("отставание догоняется по одной эпохе в порядке возрастания", async () => {
  const { deps, calls } = fixture({ lastSettledEpoch: () => CURRENT_EPOCH - 4 });
  await runWorkerTick(deps, NOW_SECONDS);

  const settled = calls.filter((c) => c.startsWith("settle:"));
  assert.deepEqual(settled, [
    `settle:${CURRENT_EPOCH - 3}`,
    `settle:${CURRENT_EPOCH - 2}`,
    `settle:${CURRENT_EPOCH - 1}`
  ]);
});

test("watchdog идёт после публикации", async () => {
  const { deps, calls } = fixture();
  await runWorkerTick(deps, NOW_SECONDS);
  assert.ok(
    calls.indexOf("watchdog") > calls.indexOf("publish"),
    "сверять надо то, что уже отправлено"
  );
});

test("падение одной стадии не отменяет остальные", async () => {
  const alerts: string[] = [];
  const { deps, calls } = fixture({
    publishIfDue: async () => {
      throw new Error("rpc down");
    }
  });

  const report = await runWorkerTick({ ...deps, alert: (m: string) => alerts.push(m) }, NOW_SECONDS);

  assert.ok(calls.includes("convert"), "конвертация обязана идти даже после провала публикации");
  assert.equal(report.failures.length, 1);
  assert.match(alerts[0]!, /rpc down/);
});

test("нечего догонять — эпохи не считаются", async () => {
  const { deps, calls } = fixture({ lastSettledEpoch: () => CURRENT_EPOCH - 1 });
  await runWorkerTick(deps, NOW_SECONDS);
  assert.equal(calls.filter((c) => c.startsWith("settle:")).length, 0);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd offchain && node --test test/loop.test.ts`
Expected: FAIL — модуль `../src/worker/loop.ts` не существует.

- [ ] **Step 3: Реализовать планировщик**

Файл `offchain/src/worker/loop.ts`:

```typescript
import { bucketOf, epochOf } from "../epoch.ts";

export interface TickDeps {
  closeBuckets(currentBucket: number): Promise<number>;
  settleEpoch(epoch: number): Promise<unknown>;
  publishIfDue(): Promise<unknown>;
  checkPublishedRoot(): Promise<unknown>;
  convertFeesIfDue(): Promise<unknown>;
  lastSettledEpoch(): number | null;
  alert(message: string): void;
}

export interface TickReport {
  readonly settled: number[];
  readonly failures: string[];
}

/**
 * One pass of the worker.
 *
 * The order is not arbitrary:
 *
 *  1. close buckets first — settlement can only count balances that have
 *     actually been sampled;
 *  2. settle only epochs that have ENDED. The current epoch is still
 *     collecting heartbeats, and settling it would underpay everyone in it;
 *  3. publish;
 *  4. run the watchdog AFTER publishing, since it checks what was sent;
 *  5. convert fees last — it is the only stage that is never urgent.
 *
 * Each stage is isolated. One failing stage must not cancel the others, or a
 * flaky RPC during publishing would also stop fee conversion and, worse, the
 * watchdog. Failures are collected and alerted, never swallowed.
 */
export async function runWorkerTick(deps: TickDeps, nowSeconds: number): Promise<TickReport> {
  const settled: number[] = [];
  const failures: string[] = [];

  const run = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      deps.alert(`worker stage ${name} failed: ${message}`);
    }
  };

  await run("closeBuckets", () => deps.closeBuckets(bucketOf(nowSeconds)));

  const currentEpoch = epochOf(nowSeconds);
  const lastSettled = deps.lastSettledEpoch();
  const from = lastSettled === null ? currentEpoch - 1 : lastSettled + 1;

  for (let epoch = from; epoch < currentEpoch; epoch++) {
    const target = epoch;
    await run(`settle:${target}`, async () => {
      await deps.settleEpoch(target);
      settled.push(target);
    });
  }

  await run("publish", () => deps.publishIfDue());
  await run("watchdog", () => deps.checkPublishedRoot());
  await run("convert", () => deps.convertFeesIfDue());

  return { settled, failures };
}

export interface WorkerHandle {
  stop(): void;
}

/**
 * Runs a tick every interval, never overlapping: a slow tick delays the next
 * one rather than running two settlements concurrently over one journal.
 */
export function startWorker(deps: TickDeps, intervalMs: number): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runWorkerTick(deps, Math.floor(Date.now() / 1_000));
      schedule();
    }, intervalMs);
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd offchain && node --test test/loop.test.ts`
Expected: PASS — 6 тестов.

- [ ] **Step 5: Расширить конфиг воркера**

Дописать в конец `offchain/src/config.ts`:

```typescript
export interface WorkerConfig extends RuntimeConfig {
  readonly keeperKey: string;
  readonly dryRun: boolean;
  readonly conversionThreshold: bigint;
}

/**
 * Reads the worker's extra settings.
 *
 * dryRun defaults to TRUE. Publishing moves real value, so the safe state
 * has to be the one you get by forgetting to set a variable — turning it
 * off must be a deliberate act, never an accident of deployment.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const base = loadRuntimeConfig(env);
  const key = required(env, "KEEPER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // The value itself is never included in the message.
    throw new Error("KEEPER_PRIVATE_KEY must be a 32-byte hex private key");
  }

  return {
    ...base,
    keeperKey: key,
    dryRun: env.DRY_RUN !== "false",
    conversionThreshold: BigInt(env.CONVERSION_THRESHOLD_WEI ?? "3000000000000000")
  };
}
```

- [ ] **Step 6: Написать точку входа**

Файл `offchain/src/main.ts`:

```typescript
import { loadWorkerConfig } from "./config.ts";
import { openDatabase } from "./db/open.ts";
import { HeartbeatStore } from "./db/heartbeats.ts";
import { EntitlementStore } from "./db/entitlements.ts";
import { EpochStore } from "./db/epochs.ts";
import { RootStore } from "./db/roots.ts";
import { PurchaseStore } from "./db/purchases.ts";
import { ChainReader } from "./chain/reader.ts";
import { ChainWriter } from "./chain/writer.ts";
import { closeBuckets } from "./ingest/bucketClose.ts";
import { settleEpoch } from "./worker/settleJob.ts";
import { publishIfDue } from "./worker/publisher.ts";
import { checkPublishedRoot } from "./worker/watchdog.ts";
import { convertFeesIfDue } from "./worker/feeConverter.ts";
import { startWorker } from "./worker/loop.ts";
import { startServer } from "./server.ts";

const config = loadWorkerConfig(process.env);

const db = openDatabase(config.databasePath);
const heartbeats = new HeartbeatStore(db);
const entitlements = new EntitlementStore(db);
const epochs = new EpochStore(db);
const roots = new RootStore(db);
const purchases = new PurchaseStore(db);

const reader = new ChainReader(config.rpcUrl);
const writer = new ChainWriter(config.rpcUrl, config.keeperKey);

// Alerts go to stderr so the process manager can route them without the
// worker taking on a notification dependency of its own.
const alert = (message: string): void => {
  console.error(`[ALERT ${new Date().toISOString()}] ${message}`);
};

const server = startServer(
  { heartbeats, entitlements, reader, minBalance: config.minBalance, now: () => Date.now() },
  config.port
);

const worker = startWorker(
  {
    closeBuckets: (currentBucket) => closeBuckets({ heartbeats, reader, currentBucket }),
    settleEpoch: (epoch) =>
      settleEpoch(
        {
          heartbeats,
          entitlements,
          epochs,
          reader,
          vaultAddress: config.rewardVault,
          minBalance: config.minBalance
        },
        epoch
      ),
    publishIfDue: () =>
      publishIfDue({
        entitlements,
        epochs,
        roots,
        writer,
        vaultAddress: config.rewardVault,
        dryRun: config.dryRun
      }),
    checkPublishedRoot: () =>
      checkPublishedRoot({
        entitlements,
        vaultAddress: config.rewardVault,
        reader,
        writer,
        alert
      }),
    convertFeesIfDue: () =>
      convertFeesIfDue({
        purchases,
        vaultAddress: config.rewardVault,
        threshold: config.conversionThreshold,
        reader,
        writer,
        dryRun: config.dryRun
      }),
    lastSettledEpoch: () => epochs.lastSettled(),
    alert
  },
  10_000
);

// The key is never printed; the derived address is public and is what an
// operator actually needs to check.
console.log(
  `DWELL up on :${config.port} — vault ${config.rewardVault}, keeper ${writer.address}` +
    (config.dryRun ? " — DRY RUN, nothing will be published" : "")
);

const shutdown = (): void => {
  worker.stop();
  server.close();
  db.close();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 7: Написать рабочую последовательность**

Файл `docs/RUNBOOK.md`:

````markdown
# DWELL — запуск и инциденты

## Переменные окружения

| Переменная | Обязательна | Смысл |
|---|---|---|
| `RPC_URL` | да | узел Robinhood Chain |
| `REWARD_VAULT` | да | адрес развёрнутого `RewardVault` |
| `MIN_BALANCE` | да | порог участия, в целых токенах |
| `DATABASE_PATH` | да | файл SQLite |
| `KEEPER_PRIVATE_KEY` | да | горячий ключ кипера |
| `PORT` | нет | по умолчанию 8787 |
| `DRY_RUN` | нет | **по умолчанию включён**; выключается только строкой `false` |
| `CONVERSION_THRESHOLD_WEI` | нет | по умолчанию 3e15, около $10 |

`DRY_RUN` включён по умолчанию намеренно: забытая переменная обязана давать
безопасное состояние, а не публикацию реальных денег.

## Последовательность запуска

1. Развернуть `RewardVault`, **верифицировать исходник** на Blockscout
2. Предзарядить вольт TSLA
3. Выставить `maxAllocationIncreasePerRoot` низко
4. Запустить токен на лаунчпаде, **указать адрес кипера получателем creator fee**
5. Поднять процесс с включённым `DRY_RUN`: хартбиты принимаются, эпохи считаются, корни логируются, но не публикуются
6. Сверить расчёты на реальных данных
7. Снять `DRY_RUN`. Первый корень покроет **все эпохи с момента открытия майнинга**
8. Поднимать потолок по мере накопления доверия

Пункт 1 предшествует пункту 4 намеренно: контракт должен быть открыт для
проверки до того, как участники понесут деньги.

Пункт 5 стоит после пункта 4, потому что без держателей токена майнеров нет
и проверять нечего. Участники при этом ничего не теряют: сеттлмент
детерминирован и считается из журнала задним числом.

## Инциденты

**Watchdog поставил паузу.** Опубликованный корень не следует из журнала. Не
снимать паузу до выяснения. Сверить таблицу `roots` с событиями
`RootPublished` в цепочке. Причин ровно три: ключом кипера воспользовался
кто-то другой, база разошлась с расчётом, воркер отправил не то, что
посчитал.

**Воркер отстал больше чем на 10 минут.** Состояние на узле живёт 6000–8000
блоков. Балансы отставших бакетов уже не восстановить — их надо пропустить,
а не дозаполнять текущими значениями, иначе продавший в простое майнер
получит награду за баланс, которого у него не было.

**Своп разворачивается с `Too little received`.** Цена ушла сильнее лимита
проскальзывания. Проверить глубину пула, прежде чем поднимать лимит: подъём
лимита без проверки глубины — это согласие на плохую цену.

**Кончился ETH у кипера.** Публикация и, что важнее, пауза станут
невозможны. Резерв `GAS_RESERVE_WEI` не свопается именно поэтому, но
пополнять кошелёк всё равно нужно.

**Нужно остановить всё прямо сейчас.** Пауза доступна и киперу, и админу:

```bash
cast send $REWARD_VAULT "pause()" --private-key $KEY --rpc-url $RPC_URL
```

Снять паузу может только админ.
````

- [ ] **Step 8: Прогнать весь набор и типы**

Run: `cd offchain && node --test && npm run typecheck`
Expected: PASS — 101 прежний + 4 + 6 + 6 + 5 + 5 + 6 = 133 теста, типы без ошибок.

Run: `forge test && forge fmt --check`
Expected: PASS — 35 тестов контракта (31 прежний + 4 из Task 1).

- [ ] **Step 9: Коммит**

```bash
git add offchain/src/worker/loop.ts offchain/src/main.ts offchain/src/config.ts \
        offchain/test/loop.test.ts docs/RUNBOOK.md
git commit -F - <<'MSG'
Добавить планировщик воркера, точку входа и рабочую последовательность

Порядок стадий не произволен: бакеты закрываются до расчёта, текущая
эпоха не считается, watchdog идёт после публикации. Падение одной стадии
не отменяет остальные, иначе моргнувший RPC на публикации заодно
выключил бы и watchdog. DRY_RUN включён по умолчанию.
MSG
```

---

## Что этот план не покрывает

- Фронтенд и лендинг — отложены по решению заказчика до появления идеи и стиля
- **Адрес токена проекта.** Пока токена нет, `ChainReader.balancesAt` читает TSLA как заглушку. При запуске добавить `projectToken` в `ADDRESSES` и переключить чтение на него — это одно место в коде
- Четыре параметра из §10 спеки остаются за заказчиком: предзаряд вольта, `MIN_BALANCE`, эмиссия токена, стартовый `maxAllocationIncreasePerRoot`
- Фактическая ставка creator fee выбранного лаунчпада — выяснить до запуска и подставить в расчёт притока
- Уведомления наружу: алерты идут в stderr, маршрутизация оставлена процесс-менеджеру
