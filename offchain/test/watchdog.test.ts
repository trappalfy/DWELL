import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/open.ts";
import { RootStore } from "../src/db/roots.ts";
import { checkPublishedRoot } from "../src/worker/watchdog.ts";
import type { Address } from "../src/types.ts";

const VAULT = "0xeeee000000000000000000000000000000000003" as Address;
const OUR_ROOT = "0x" + "ab".repeat(32);
const STRANGER_ROOT = "0x" + "cd".repeat(32);
const EPOCH = 105;

interface OnChain {
  readonly root: string;
  readonly throughEpoch: number;
}

function fixture(onChain: OnChain | null, recorded: { epoch: number; root: string } | null) {
  const db = openDatabase(":memory:");
  const roots = new RootStore(db);
  if (recorded) roots.record(recorded.epoch, recorded.root, "0x" + "11".repeat(32));

  const paused: Address[] = [];
  const alerts: string[] = [];

  return {
    roots,
    paused,
    alerts,
    deps: {
      roots,
      vaultAddress: VAULT,
      reader: { lastPublishedRoot: async () => onChain },
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

test("корень в цепочке совпадает с записанным — тревоги нет", async () => {
  const { deps, paused, alerts } = fixture(
    { root: OUR_ROOT, throughEpoch: EPOCH },
    { epoch: EPOCH, root: OUR_ROOT }
  );

  const verdict = await checkPublishedRoot(deps);

  assert.equal(verdict.ok, true);
  assert.equal(paused.length, 0);
  assert.equal(alerts.length, 0);
});

test("рост журнала между публикациями тревоги не вызывает", async () => {
  // Это ровно тот случай, на котором прежняя проверка останавливала
  // протокол: корень опубликован через эпоху 105, дальше эпохи 106-110
  // начисляют новым людям, и журнал законно расходится с цепочкой.
  // Публикация следующего корня наступит только после шести эпох.
  const { deps, paused, alerts } = fixture(
    { root: OUR_ROOT, throughEpoch: EPOCH },
    { epoch: EPOCH, root: OUR_ROOT }
  );

  for (let i = 0; i < 30; i++) {
    const verdict = await checkPublishedRoot(deps);
    assert.equal(verdict.ok, true, `тик ${i} обязан быть спокойным`);
  }

  assert.equal(paused.length, 0, "полчаса между корнями — не повод для паузы");
  assert.equal(alerts.length, 0);
});

test("чужой корень за эпоху, которой мы не публиковали, ставит паузу", async () => {
  // Ключом кипера воспользовался кто-то другой: в цепочке есть корень,
  // которого нет в нашей таблице.
  const { deps, paused, alerts } = fixture(
    { root: STRANGER_ROOT, throughEpoch: 111 },
    { epoch: EPOCH, root: OUR_ROOT }
  );

  const verdict = await checkPublishedRoot(deps);

  assert.ok(!verdict.ok);
  assert.equal(verdict.paused, true);
  assert.deepEqual(paused, [VAULT]);
  assert.match(alerts[0]!, /111/, "тревога обязана назвать эпоху");
});

test("другой корень за нашу эпоху ставит паузу", async () => {
  // Отправлено не то, что посчитано.
  const { deps, paused } = fixture(
    { root: STRANGER_ROOT, throughEpoch: EPOCH },
    { epoch: EPOCH, root: OUR_ROOT }
  );

  const verdict = await checkPublishedRoot(deps);

  assert.ok(!verdict.ok);
  assert.equal(verdict.expected, OUR_ROOT);
  assert.equal(verdict.actual, STRANGER_ROOT);
  assert.deepEqual(paused, [VAULT]);
});

test("сравнение не зависит от регистра шестнадцатеричной записи", async () => {
  const { deps, paused } = fixture(
    { root: OUR_ROOT.toUpperCase().replace("0X", "0x"), throughEpoch: EPOCH },
    { epoch: EPOCH, root: OUR_ROOT }
  );

  const verdict = await checkPublishedRoot(deps);

  assert.equal(verdict.ok, true);
  assert.equal(paused.length, 0);
});

test("без опубликованных корней проверять нечего", async () => {
  const { deps, paused } = fixture(null, null);

  const verdict = await checkPublishedRoot(deps);

  assert.equal(verdict.ok, true);
  assert.equal(paused.length, 0);
});

test("провал паузы не глотается молча", async () => {
  const { deps, alerts } = fixture(
    { root: STRANGER_ROOT, throughEpoch: EPOCH },
    { epoch: EPOCH, root: OUR_ROOT }
  );
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
