import type { PurchaseStore } from "../db/purchases.ts";
import type { Address } from "../types.ts";
import type { Hex } from "viem";

/**
 * Held back so the keeper can always afford to publish and, more
 * importantly, to PAUSE. A wallet that swapped its last wei could not stop
 * the protocol in an emergency, which would quietly disarm the watchdog.
 *
 * At ~0.0203 gwei and ~105k gas a publish costs ~2.1e12 wei, so this covers
 * roughly five thousand transactions.
 */
export const GAS_RESERVE_WEI = 10n ** 16n;

export interface ConvertDeps {
  readonly purchases: PurchaseStore;
  readonly vaultAddress: Address;
  readonly threshold: bigint;
  readonly reader: { ethBalance(account: Address): Promise<bigint> };
  readonly writer: {
    readonly address: Address;
    swapEthForReward(
      recipient: Address,
      amountIn: bigint
    ): Promise<{ txHash: Hex; amountOut: bigint }>;
  };
  readonly dryRun: boolean;
}

export type ConvertOutcome =
  | { readonly converted: false; readonly reason: string }
  | {
      readonly converted: true;
      readonly ethIn: bigint;
      readonly tslaOut: bigint;
      readonly txHash: string;
    };

/**
 * Turns accumulated creator fees into the reward asset.
 *
 * One transaction: the router wraps the ETH itself and delivers the output
 * straight to the vault, so the hot wallet never holds the reward asset and
 * no approve is left standing anywhere.
 */
export async function convertFeesIfDue(deps: ConvertDeps): Promise<ConvertOutcome> {
  const balance = await deps.reader.ethBalance(deps.writer.address);
  if (balance <= GAS_RESERVE_WEI) {
    return { converted: false, reason: "balance is entirely gas reserve" };
  }

  const spendable = balance - GAS_RESERVE_WEI;
  if (spendable < deps.threshold) {
    return { converted: false, reason: `${spendable} wei is below threshold` };
  }

  if (deps.dryRun) {
    return { converted: false, reason: `dry-run: would swap ${spendable} wei` };
  }

  const { txHash, amountOut } = await deps.writer.swapEthForReward(deps.vaultAddress, spendable);
  deps.purchases.record(spendable, amountOut, txHash);

  return { converted: true, ethIn: spendable, tslaOut: amountOut, txHash };
}
