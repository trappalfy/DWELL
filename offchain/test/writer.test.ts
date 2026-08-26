import { test } from "node:test";
import assert from "node:assert/strict";
import { ChainWriter } from "../src/chain/writer.ts";
import { KEEPER_KEY, KEEPER_ADDRESS } from "./helpers/fork.ts";

/*
 * No fork here on purpose. Everything the writer does beyond deriving its own
 * address is a transaction, and those are exercised end to end against a real
 * chain in roundtrip.test.ts — publishing a root and reading it back proves
 * far more than a mock ever could. Booting anvil to assert one derived
 * address would only add another suite competing for the live node.
 */
test("кошелёк знает свой адрес, не выходя в сеть", () => {
  const writer = new ChainWriter("http://127.0.0.1:1", KEEPER_KEY);
  assert.equal(writer.address.toLowerCase(), KEEPER_ADDRESS.toLowerCase());
});
