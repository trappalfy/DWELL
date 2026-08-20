import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startFork, KEEPER_KEY, KEEPER_ADDRESS, type ForkHandle } from "./helpers/fork.ts";
import { ChainWriter } from "../src/chain/writer.ts";
import { ChainReader } from "../src/chain/reader.ts";
import { openDatabase } from "../src/db/open.ts";
import { EntitlementStore } from "../src/db/entitlements.ts";
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
  reader = new ChainReader(fork.rpcUrl);

  // Fund the vault with real TSLA so the solvency check inside publishRoot
  // can pass; the swap is the same one the fee converter will use.
  await writer.swapEthForReward(vault, 10n ** 16n);
});

after(() => fork?.stop());

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

test("watchdog молчит, когда цепочка согласна с журналом", async (t) => {
  if (!fork) return t.skip("anvil недоступен");

  const db = openDatabase(":memory:");
  const entitlements = new EntitlementStore(db);
  entitlements.save(new Map([[A, 3n], [B, 5n]]));

  const alerts: string[] = [];
  const verdict = await checkPublishedRoot({
    entitlements,
    vaultAddress: vault,
    reader,
    writer,
    alert: (m) => alerts.push(m)
  });

  assert.equal(verdict.ok, true, "журнал и цепочка совпадают");
  assert.equal(alerts.length, 0);
});

test("watchdog ставит настоящую паузу, когда журнал разошёлся", async (t) => {
  if (!fork) return t.skip("anvil недоступен");

  const db = openDatabase(":memory:");
  const entitlements = new EntitlementStore(db);
  // Не тот кумулятив, что опубликован — цепочка и журнал разойдутся.
  entitlements.save(new Map([[A, 999n]]));

  const alerts: string[] = [];
  const verdict = await checkPublishedRoot({
    entitlements,
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
