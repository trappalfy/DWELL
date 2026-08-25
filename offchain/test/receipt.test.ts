import { test } from "node:test";
import assert from "node:assert/strict";
import { assertMined } from "../src/chain/receipt.ts";

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

test("успешная квитанция проходит молча", () => {
  assert.doesNotThrow(() => assertMined({ status: "success" }, "publishRoot", HASH));
});

test("откатившаяся квитанция отвергается", () => {
  assert.throws(
    () => assertMined({ status: "reverted" }, "publishRoot", HASH),
    /publishRoot/,
    "в сообщении обязано быть видно, какой вызов откатился"
  );
});

test("сообщение называет хэш, чтобы транзакцию можно было найти", () => {
  assert.throws(() => assertMined({ status: "reverted" }, "swap", HASH), new RegExp(HASH));
});
