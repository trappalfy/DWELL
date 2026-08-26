import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeeWatch } from "../src/worker/feeWatch.ts";
import { ADDRESSES } from "../src/config.ts";
import type { Address } from "../src/types.ts";

const RECIPIENT = "0xef048611d7F3077b35Fab260565886186fDa32bA" as Address;
const THRESHOLD = 10n ** 16n; // 0.01 TSLA

/**
 * The escrow is driven by a mutable pair of numbers so a test can move the
 * balance between ticks — which is the only way to check that the watch
 * stays quiet while nothing changes and speaks again after a claim.
 */
function fixture(initial: { token?: bigint; native?: bigint } = {}) {
  const state = { token: initial.token ?? 0n, native: initial.native ?? 0n };
  const alerts: string[] = [];

  const check = createFeeWatch({
    recipient: RECIPIENT,
    rewardToken: ADDRESSES.tsla,
    threshold: THRESHOLD,
    escrow: {
      creditedToken: async () => state.token,
      creditedNative: async () => state.native
    },
    alert: (message: string) => alerts.push(message)
  });

  return { state, alerts, check };
}

test("ниже порога наблюдение молчит", async () => {
  const { alerts, check } = fixture({ token: THRESHOLD - 1n });

  const outcome = await check();

  assert.equal(outcome.claimable, THRESHOLD - 1n);
  assert.equal(alerts.length, 0);
});

test("на пороге тревога срабатывает один раз", async () => {
  const { alerts, check } = fixture({ token: THRESHOLD });

  await check();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /claim/i, "тревога должна говорить, что делать");
});

test("пока не забрали, наблюдение больше не повторяется", async () => {
  const { alerts, check, state } = fixture({ token: THRESHOLD });

  await check();
  state.token = THRESHOLD * 3n;
  await check();
  await check();

  assert.equal(alerts.length, 1, "одна поездка — одна тревога, иначе их перестанут читать");
});

test("после того как забрали, наблюдение снова готово сказать", async () => {
  const { alerts, check, state } = fixture({ token: THRESHOLD });

  await check();
  state.token = 0n; // забрали
  await check();
  state.token = THRESHOLD;
  await check();

  assert.equal(alerts.length, 2);
});

test("нативный ETH в хранилище тоже замечается", async () => {
  const { alerts, check } = fixture({ token: 0n, native: THRESHOLD });

  const outcome = await check();

  assert.equal(outcome.claimableNative, THRESHOLD);
  assert.equal(alerts.length, 1, "ETH тут не ждали — тем более стоит сказать");
});

test("сумма названа в тревоге", async () => {
  const { alerts, check } = fixture({ token: 5n * THRESHOLD });

  await check();

  assert.match(alerts[0]!, /50000000000000000/, "без суммы непонятно, стоит ли идти");
});
