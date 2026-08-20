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
