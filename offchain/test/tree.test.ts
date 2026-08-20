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
  for (const [account, value] of CUMULATIVE) {
    const proof = tree.proofFor(account);
    assert.ok(
      StandardMerkleTree.verify(tree.root, ["address", "uint256"], [account, value.toString()], proof),
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
