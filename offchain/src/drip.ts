import type { VaultState } from "./types.ts";

export const WAD = 10n ** 18n;

export const EPOCHS_PER_HOUR = 12;
export const EPOCHS_PER_DAY = 288;
export const HALF_LIFE_HOURS = 6;
export const HALF_LIFE_EPOCHS = HALF_LIFE_HOURS * EPOCHS_PER_HOUR;

/**
 * Fraction of the free reserve released each epoch, scaled by WAD.
 *
 *   RATE = 1 - 0.5 ^ (1 / HALF_LIFE_EPOCHS)
 *        = 1 - 0.5 ^ (1 / 72)
 *        = 0.009580852533173743...
 *
 * Releasing a fraction rather than a fixed amount is what keeps the reward
 * stream smooth and non-zero: a share of something is always above zero, and
 * a spike in fee income spreads across epochs instead of landing in one.
 *
 * The half-life is measured in MINED epochs, not wall-clock time: with no
 * active weight computeRelease returns zero and the reserve is untouched.
 * A quiet night therefore costs the pool nothing — six hours means six hours
 * of somebody actually holding a tab open.
 *
 * Six hours empties ~94% within a day of active mining. That is deliberate:
 * the budget here is small and meant to land while attention is on the
 * launch, and later top-ups from fees flow out just as promptly rather than
 * being hoarded for a tail nobody stays for.
 *
 * The property test derives the halving from this constant rather than
 * trusting the literal, so a wrong digit fails the suite.
 */
export const RATE_WAD = 9_580_852_533_173_743n;

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
