import { test } from "node:test";
import assert from "node:assert/strict";
import { createStageAlerter } from "../src/worker/stageAlerter.ts";

function fixture() {
  const alerts: string[] = [];
  const report = createStageAlerter((m) => alerts.push(m));
  return { alerts, report };
}

test("одиночный сбой не поднимает тревогу", () => {
  const { alerts, report } = fixture();

  report(["watchdog: RPC Request failed"]);

  assert.equal(alerts.length, 0, "мигнувший узел чинится сам на следующем тике");
});

test("тревога поднимается на третьем подряд сбое", () => {
  const { alerts, report } = fixture();

  report(["watchdog: boom"]);
  report(["watchdog: boom"]);
  assert.equal(alerts.length, 0);

  report(["watchdog: boom"]);

  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /watchdog/);
  assert.match(alerts[0]!, /3/, "сколько раз подряд — часть диагноза");
});

test("удачный тик сбрасывает счёт", () => {
  const { alerts, report } = fixture();

  report(["watchdog: boom"]);
  report(["watchdog: boom"]);
  report([]); // получилось
  report(["watchdog: boom"]);
  report(["watchdog: boom"]);

  assert.equal(alerts.length, 0, "два сбоя, удача, снова два — это не поломка");
});

test("о восстановлении сообщается отдельно", () => {
  const { alerts, report } = fixture();

  for (let i = 0; i < 3; i++) report(["watchdog: boom"]);
  assert.equal(alerts.length, 1);

  report([]);

  assert.equal(alerts.length, 2);
  assert.match(alerts[1]!, /watchdog/);
  assert.match(alerts[1]!, /recover/i, "молчание после тревоги нельзя оставлять двусмысленным");
});

test("пока держится, тревога не повторяется каждый тик", () => {
  const { alerts, report } = fixture();

  for (let i = 0; i < 10; i++) report(["watchdog: boom"]);

  assert.equal(alerts.length, 1, "повторение каждые десять секунд — это снова шум");
});

test("стадии считаются по отдельности", () => {
  const { alerts, report } = fixture();

  report(["watchdog: a", "fees: b"]);
  report(["watchdog: a"]);
  report(["watchdog: a"]);

  assert.equal(alerts.length, 1, "у fees был один сбой, тревоги он не заслужил");
  assert.match(alerts[0]!, /watchdog/);
});
