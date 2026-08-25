import type { PurchaseStore } from "../db/purchases.ts";
import type { Address } from "../types.ts";
import type { Hex } from "viem";

/**
 * Held back so the keeper can always afford to publish and, more
 * importantly, to PAUSE. A wallet that swapped its last wei could not stop
 * the protocol in an emergency, which would quietly disarm the watchdog.
 *
 * It doubles as the unattended runway. The converter never spends below this
 * line, so it is what the keeper lives on while no fees are arriving. A
 * publish costs ~114k gas and happens 48 times a day; at ~0.025 gwei that is
 * ~1.4e14 wei a day, so this holds about a week of publishing, or two days
 * once a busy day of fee swaps is counted against it.
 *
 * Raise it in step with the keeper's funding: it is the operator's promise
 * about how long the protocol can run between check-ins, and setting it
 * above what the keeper actually holds stops conversion altogether.
 */
export const GAS_RESERVE_WEI = 10n ** 15n;

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
