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
      claimFeesIfDue: async () => {
        calls.push("claim");
        return { claimed: false, reason: "x" };
      },
      convertFeesIfDue: async () => {
        calls.push("convert");
        return { converted: false, reason: "x" };
      },
      lastSettledEpoch: () => CURRENT_EPOCH - 2,
      alert: () => {},
      ...overrides
    } satisfies TickDeps
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

  const report = await runWorkerTick(
    { ...deps, alert: (m: string) => alerts.push(m) },
    NOW_SECONDS
  );

  assert.ok(calls.includes("convert"), "конвертация обязана идти даже после провала публикации");
  assert.equal(report.failures.length, 1);
  assert.match(alerts[0]!, /rpc down/);
});

test("нечего догонять — эпохи не считаются", async () => {
  const { deps, calls } = fixture({ lastSettledEpoch: () => CURRENT_EPOCH - 1 });
  await runWorkerTick(deps, NOW_SECONDS);
  assert.equal(calls.filter((c) => c.startsWith("settle:")).length, 0);
});

test("комиссии сначала забираются, и только потом конвертируются", async () => {
  const { deps, calls } = fixture();

  await runWorkerTick(deps, NOW_SECONDS);

  const claim = calls.indexOf("claim");
  const convert = calls.indexOf("convert");
  assert.ok(claim >= 0, "сбор комиссий обязан происходить каждый тик");
  assert.ok(
    claim < convert,
    "иначе развёрнутый ETH пролежал бы до следующего тика вместо того, чтобы уехать в вольт"
  );
});

test("провал сбора комиссий не отменяет конвертацию", async () => {
  const { deps, calls } = fixture({
    claimFeesIfDue: async () => {
      throw new Error("локер недоступен");
    }
  });

  const report = await runWorkerTick(deps, NOW_SECONDS);

  assert.ok(report.failures.some((f) => f.includes("claim")), "провал обязан попасть в отчёт");
  assert.ok(calls.includes("convert"), "остаток на кипере всё ещё можно обменять");
});
