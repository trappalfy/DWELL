import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, createPublicClient, http } from "viem";
import { startFork, KEEPER_KEY, KEEPER_ADDRESS, type ForkHandle } from "./helpers/fork.ts";
import { ChainWriter } from "../src/chain/writer.ts";
import { ADDRESSES } from "../src/config.ts";
import type { Address } from "../src/types.ts";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const SINK = "0x000000000000000000000000000000000000dEaD" as Address;

let fork: ForkHandle | null = null;
let writer: ChainWriter;

before(async () => {
  try {
    fork = await startFork();
  } catch {
    fork = null;
    return;
  }
  writer = new ChainWriter(fork.rpcUrl, KEEPER_KEY);
});

after(() => fork?.stop());

test("кошелёк знает свой адрес", (t) => {
  if (!fork) return t.skip("anvil недоступен");
  assert.equal(writer.address.toLowerCase(), KEEPER_ADDRESS.toLowerCase());
});

test("своп кладёт TSLA прямо на адрес получателя одной транзакцией", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  const client = createPublicClient({ transport: http(fork.rpcUrl) });

  const before = await client.readContract({
    address: ADDRESSES.tsla,
    abi: ERC20,
    functionName: "balanceOf",
    args: [SINK]
  });

  const result = await writer.swapEthForReward(SINK, 10n ** 16n);

  const after = await client.readContract({
    address: ADDRESSES.tsla,
    abi: ERC20,
    functionName: "balanceOf",
    args: [SINK]
  });

  assert.ok(after > before, "получатель должен получить TSLA");
  assert.equal(after - before, result.amountOut, "отчёт должен совпасть с фактом");
  assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
});

test("своп уважает лимит проскальзывания", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  // Минимум выше того, что пул способен отдать, обязан развернуть транзакцию.
  await assert.rejects(
    () => writer.swapEthForReward(SINK, 10n ** 16n, { minOutOverride: 10n ** 24n }),
    /Too little received|reverted|revert/i
  );
});

test("своп нулевой суммы отвергается до обращения к сети", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  await assert.rejects(() => writer.swapEthForReward(SINK, 0n), /amountIn must be positive/);
});
