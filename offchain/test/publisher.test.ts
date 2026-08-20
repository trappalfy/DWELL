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
