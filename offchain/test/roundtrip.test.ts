import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startFork, KEEPER_KEY, KEEPER_ADDRESS, type ForkHandle } from "./helpers/fork.ts";
import { ChainWriter } from "../src/chain/writer.ts";
import { ChainReader } from "../src/chain/reader.ts";
import { openDatabase } from "../src/db/open.ts";
import { RootStore } from "../src/db/roots.ts";
import { buildTree } from "../src/tree.ts";
import { checkPublishedRoot } from "../src/worker/watchdog.ts";
import { robinhoodChain } from "../src/chain/client.ts";
import { ADDRESSES } from "../src/config.ts";
import type { Address } from "../src/types.ts";

const A = "0xaaaa000000000000000000000000000000000001" as Address;
const B = "0xbbbb000000000000000000000000000000000002" as Address;

const artifact = JSON.parse(
  readFileSync(new URL("../../out/RewardVault.sol/RewardVault.json", import.meta.url), "utf8")
);

let fork: ForkHandle | null = null;
let vault: Address;
let writer: ChainWriter;
let reader: ChainReader;

/**
 * Deploys our real contract onto a fork of the live chain, pointing at the
 * real TSLA token. This is the only test that exercises the seam the
 * watchdog depends on: what ChainWriter sends must be exactly what
 * ChainReader reads back out of the event log.
 */
before(async () => {
  try {
    fork = await startFork();
  } catch {
    fork = null;
    return;
  }

  const account = privateKeyToAccount(KEEPER_KEY as Hex);
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(fork.rpcUrl) });
  const client = createPublicClient({ chain: robinhoodChain, transport: http(fork.rpcUrl) });

  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    // Keeper is also admin here so one key can drive the whole scenario.
    args: [ADDRESSES.tsla, KEEPER_ADDRESS, KEEPER_ADDRESS, 10n ** 30n]
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  vault = receipt.contractAddress as Address;

  writer = new ChainWriter(fork.rpcUrl, KEEPER_KEY);
  reader = new ChainReader(fork.rpcUrl, ADDRESSES.tsla);

  // Fund the vault with real TSLA so the solvency check inside publishRoot
  // can pass. Taken straight from a holder rather than bought through the
  // router: this is test setup, and setup should not depend on pool depth,
  // slippage or a swap path that production no longer uses.
  await fundVaultWithTsla(fork.rpcUrl, vault, 10n ** 16n);
});

after(() => fork?.stop());

/**
 * Moves real TSLA onto the fork by impersonating an address that holds it.
 *
 * The WETH/TSLA pool is used as the source because it is guaranteed to be
 * solvent in that asset for as long as the pool exists — a whale address
 * could be drained or could move on, and the test would start failing for a
 * reason that has nothing to do with the code under test.
 */
async function fundVaultWithTsla(
  rpcUrl: string,
  recipient: Address,
  amount: bigint
): Promise<void> {
  const rpc = async (method: string, params: unknown[]): Promise<void> => {
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
  };

  const source = ADDRESSES.wethTslaPool;
  await rpc("anvil_impersonateAccount", [source]);
  await rpc("anvil_setBalance", [source, "0xde0b6b3a7640000"]);

  // transfer(address,uint256)
  const data =
    "0xa9059cbb" +
    recipient.slice(2).toLowerCase().padStart(64, "0") +
    amount.toString(16).padStart(64, "0");
  await rpc("eth_sendTransaction", [{ from: source, to: ADDRESSES.tsla, data }]);
  await rpc("anvil_stopImpersonatingAccount", [source]);
}

test("опубликованный корень читается обратно из события", async (t) => {
  if (!fork) return t.skip("anvil недоступен");

  const cumulative = new Map<Address, bigint>([[A, 3n], [B, 5n]]);
  const tree = buildTree(cumulative);

  await writer.publishRoot(vault, 42, tree.root as Hex, 8n);

  const seen = await reader.lastPublishedRoot(vault);
  assert.ok(seen, "событие обязано быть найдено");
  assert.equal(seen.root, tree.root, "корень из события обязан совпасть с отправленным");
  assert.equal(seen.throughEpoch, 42);
});

test("watchdog молчит, когда цепочка согласна с записанным", async (t) => {
  if (!fork) return t.skip("anvil недоступен");

  const db = openDatabase(":memory:");
  const roots = new RootStore(db);
  // То же, что было отправлено выше: корень через эпоху 42.
  const published = await reader.lastPublishedRoot(vault);
  assert.ok(published, "корень обязан читаться из события");
  roots.record(published.throughEpoch, published.root, "0x" + "11".repeat(32));

  const alerts: string[] = [];
  const verdict = await checkPublishedRoot({
    roots,
    vaultAddress: vault,
    reader,
    writer,
    alert: (m) => alerts.push(m)
  });

  assert.equal(verdict.ok, true, "цепочка несёт ровно то, что мы записали");
  assert.equal(alerts.length, 0);
});

test("watchdog ставит настоящую паузу на чужой корень", async (t) => {
  if (!fork) return t.skip("anvil недоступен");

  const db = openDatabase(":memory:");
  const roots = new RootStore(db);
  // В нашей таблице этой эпохи нет вовсе: так выглядит публикация,
  // сделанная чужими руками с нашим ключом.

  const alerts: string[] = [];
  const verdict = await checkPublishedRoot({
    roots,
    vaultAddress: vault,
    reader,
    writer,
    alert: (m) => alerts.push(m)
  });

  assert.ok(!verdict.ok);
  assert.equal(verdict.paused, true, "кипер обязан суметь остановить настоящий контракт");

  const client = createPublicClient({ chain: robinhoodChain, transport: http(fork.rpcUrl) });
  const paused = await client.readContract({
    address: vault,
    abi: parseAbi(["function paused() view returns (bool)"]),
    functionName: "paused"
  });
  assert.equal(paused, true, "контракт обязан быть на паузе в цепочке, а не только в отчёте");
});
