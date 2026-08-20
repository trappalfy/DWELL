import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildTree } from "../src/tree.ts";
import type { Address } from "../src/types.ts";

/**
 * Writes a fixture consumed by test/MerkleCrossCheck.t.sol.
 *
 * Cumulative amounts are written as hex strings: JSON numbers lose precision
 * above 2^53, and Foundry's parseJsonUint reads hex strings exactly.
 */
const CUMULATIVE = new Map<Address, bigint>([
  ["0x0000000000000000000000000000000000000101" as Address, 4n * 10n ** 18n],
  ["0x0000000000000000000000000000000000000202" as Address, 1n * 10n ** 18n],
  ["0x0000000000000000000000000000000000000303" as Address, 250_000_000_000_000_000n],
  ["0x0000000000000000000000000000000000000404" as Address, 1n],
  ["0x0000000000000000000000000000000000000505" as Address, 123_456_789_987_654_321n]
]);

const tree = buildTree(CUMULATIVE);
const entries = tree.dump();

const fixture = {
  root: tree.root,
  count: entries.length,
  entries: entries.map((entry) => ({
    account: entry.account,
    cumulative: `0x${entry.cumulative.toString(16)}`,
    proof: entry.proof
  }))
};

const target = resolve(import.meta.dirname, "../../test/fixtures/merkle.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);

const total = [...CUMULATIVE.values()].reduce((sum, value) => sum + value, 0n);
console.log(`wrote ${target}`);
console.log(`root ${fixture.root}`);
console.log(`entries ${fixture.count}, total cumulative ${total}`);
