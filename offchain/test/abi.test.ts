import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { encodeClaim, CLAIM_SELECTOR } from "../../web/lib/abi.js";

// The browser file is imported directly rather than reimplemented here, so
// what viem is checked against is exactly what ships to the page.
const VAULT_ABI = parseAbi(["function claim(uint256 cumulativeAmount, bytes32[] proof)"]);

const reference = (cumulative: bigint, proof: string[]) =>
  encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "claim",
    args: [cumulative, proof as `0x${string}`[]]
  });

const node = (n: number) => "0x" + String(n).padStart(2, "0").repeat(32).slice(0, 64);

test("селектор совпадает с сигнатурой контракта", () => {
  assert.equal(CLAIM_SELECTOR, "0x2f52ebb7");
});

test("кодирование совпадает с viem на пруфе обычной длины", () => {
  const proof = [node(1), node(2), node(3)];
  assert.equal(encodeClaim(123_456_789n, proof), reference(123_456_789n, proof));
});

test("пустой пруф кодируется как у viem", () => {
  // Дерево из одного листа даёт пустой пруф — это рабочий случай.
  assert.equal(encodeClaim(1n, []), reference(1n, []));
});

test("сумма в wei не теряет точности", () => {
  const huge = 2n ** 200n + 12_345n;
  const proof = [node(7)];
  assert.equal(encodeClaim(huge, proof), reference(huge, proof));
});

test("нулевая сумма кодируется как у viem", () => {
  assert.equal(encodeClaim(0n, [node(9)]), reference(0n, [node(9)]));
});

test("длинный пруф кодируется как у viem", () => {
  const proof = Array.from({ length: 17 }, (_, i) => node(i + 1));
  assert.equal(encodeClaim(999n, proof), reference(999n, proof));
});

test("отрицательная сумма отвергается", () => {
  assert.throws(() => encodeClaim(-1n, []), /negative/i);
});

test("элемент пруфа не 32 байта отвергается", () => {
  assert.throws(() => encodeClaim(1n, ["0xabcd"]), /32 bytes/i);
});
