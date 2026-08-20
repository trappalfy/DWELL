import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http } from "viem";
import type { Address } from "../../src/types.ts";

const LIVE_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Anvil's first default account. Public knowledge, worthless outside a fork. */
export const KEEPER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const KEEPER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

export interface ForkHandle {
  readonly rpcUrl: string;
  readonly stop: () => void;
}

/**
 * Boots anvil forking the live chain.
 *
 * Readiness is confirmed by polling rather than by parsing stdout: anvil's
 * banner format is not a stable interface, and a test suite that breaks on
 * a tool's cosmetic change is worse than one that waits.
 */
export async function startFork(): Promise<ForkHandle> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpcUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(
    "anvil",
    ["--fork-url", LIVE_RPC, "--port", String(port), "--silent", "--no-rate-limit"],
    { stdio: "ignore" }
  );

  const client = createPublicClient({ transport: http(rpcUrl) });
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await client.getBlockNumber();
      return { rpcUrl, stop: () => child.kill() };
    } catch {
      await delay(500);
    }
  }

  child.kill();
  throw new Error("anvil did not become ready in 60s");
}
