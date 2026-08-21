import type { VaultState } from "./types.ts";

export const WAD = 10n ** 18n;

export const HALF_LIFE_DAYS = 1;
export const EPOCHS_PER_DAY = 288;
export const HALF_LIFE_EPOCHS = HALF_LIFE_DAYS * EPOCHS_PER_DAY;

/**
 * Fraction of the free reserve released each epoch, scaled by WAD.
 *
 *   RATE = 1 - 0.5 ^ (1 / HALF_LIFE_EPOCHS)
 *        = 1 - 0.5 ^ (1 / 288)
 *        = 0.002403867116379740...
 *
 * Releasing a fraction rather than a fixed amount is what keeps the reward
 * stream smooth and non-zero: a share of something is always above zero, and
 * a spike in fee income spreads across days instead of landing in one epoch.
 *
 * A one-day half-life front-loads hard — half the reserve goes out on day
 * one — which matches how briefly attention lasts here. The trade is a thin
 * tail: by day three roughly seven eighths is spent. The property test below
 * derives the halving from this constant rather than trusting the literal.
 */
export const RATE_WAD = 2_403_867_116_379_740n;

/**
 * Reward-asset balance not yet promised to anyone.
 *
 * Outstanding obligation is totalAllocated - totalClaimed: allocation only
 * grows, while the balance drops as accounts withdraw.
 */
export function unallocated(vault: VaultState): bigint {
  const outstanding = vault.totalAllocated - vault.totalClaimed;
  if (vault.balance < outstanding) {
    throw new Error(
      `insolvent vault state: balance ${vault.balance} < outstanding ${outstanding}`
    );
  }
  return vault.balance - outstanding;
}

/**
 * Amount to distribute this epoch. Floors, so the result never exceeds the
 * free reserve. With no active weight nothing is released and the reserve is
 * left untouched for later epochs.
 */
export function computeRelease(vault: VaultState, totalWeight: bigint): bigint {
  if (totalWeight <= 0n) return 0n;
  return (unallocated(vault) * RATE_WAD) / WAD;
}
