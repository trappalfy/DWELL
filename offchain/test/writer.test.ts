import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

/* ------------------------------------------------- creator fees from pons */

/**
 * A real pons launch, picked because its locked position is live and its fee
 * recipient is visible on chain. The fork lets us take that recipient's place
 * without touching anything on the live chain.
 */
const PONS_TOKEN = "0x7FE995a80075dF3Dc8Ae11A9b82c7FE4202CD87f" as Address;
const PONS_DEPLOYER = "0x934e92E1C82020fc4e1Ee55712C6d9fb19C6782a" as Address;

const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)"
]);

/** Puts the fork's default keeper in the seat of the token's fee recipient. */
async function redirectFeesToKeeper(rpcUrl: string): Promise<void> {
  const call = async (method: string, params: unknown[]) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    return response.json();
  };

  await call("anvil_impersonateAccount", [PONS_DEPLOYER]);
  await call("anvil_setBalance", [PONS_DEPLOYER, "0xde0b6b3a7640000"]);
  // setFeeRedirect(address,address) — only the deployer may call it.
  const selector = "0x4d133a6d"; // setFeeRedirect(address,address)
  const data =
    selector + PONS_TOKEN.slice(2).padStart(64, "0") + KEEPER_ADDRESS.slice(2).padStart(64, "0");
  await call("eth_sendTransaction", [
    { from: PONS_DEPLOYER, to: ADDRESSES.ponsLocker, data }
  ]);
  await call("anvil_stopImpersonatingAccount", [PONS_DEPLOYER]);
}

test("разворот WETH забирает ETH из обёртки", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  const client = createPublicClient({ transport: http(fork.rpcUrl) });
  const amount = 10n ** 16n;

  // Wrapping is setup, so it happens through a throwaway client rather than
  // becoming a method on the production writer.
  const wallet = createWalletClient({
    account: privateKeyToAccount(KEEPER_KEY),
    transport: http(fork.rpcUrl),
    chain: undefined
  });
  await wallet.writeContract({
    address: ADDRESSES.weth,
    abi: WETH_ABI,
    functionName: "deposit",
    value: amount,
    chain: undefined
  });

  const wrapperBefore = await client.getBalance({ address: ADDRESSES.weth });
  await writer.unwrapWeth(amount);

  const wethAfter = await client.readContract({
    address: ADDRESSES.weth,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [KEEPER_ADDRESS]
  });
  const wrapperAfter = await client.getBalance({ address: ADDRESSES.weth });

  assert.equal(wethAfter, 0n, "весь WETH обязан быть сожжён");
  assert.equal(
    wrapperBefore - wrapperAfter,
    amount,
    "ровно столько ETH обязано покинуть обёртку в нашу сторону"
  );
});

/*
 * The keeper's own native balance is deliberately NOT asserted here. anvil
 * settles the sender's balance as (before - value - gas) and drops ETH the
 * sender receives during its own transaction, so on a fork the credit is
 * invisible however correct the contract is. Measured, not assumed: the same
 * withdrawal aimed at a THIRD address credits it the full amount on this very
 * fork, and aeWETH.withdrawTo require()s the transfer to succeed. What the
 * assertions above check — the burn, and the ETH leaving the wrapper — is the
 * part a fork reports honestly.
 */

test("сбор комиссий с чужого токена падает громко, а не молча", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  // Кипер здесь никто: ни владелец, ни деплойер, ни получатель. Глотать это
  // как «нечего собирать» значило бы прятать неверную настройку.
  await assert.rejects(() => writer.collectCreatorFees(PONS_TOKEN), /NotAuthorized|reverted/i);
});

test("пустой сбор комиссий возвращает null", async (t) => {
  if (!fork) return t.skip("anvil недоступен");
  await redirectFeesToKeeper(fork.rpcUrl);

  // Первый сбор может что-то принести, а может и нет — на этом блоке как
  // повезёт. Второй гарантированно пуст, и именно он проверяет контракт.
  await writer.collectCreatorFees(PONS_TOKEN).catch(() => null);
  const second = await writer.collectCreatorFees(PONS_TOKEN);

  assert.equal(second, null, "пустой сбор — обычный исход, а не сбой");
});
