import type { Address } from "../types.ts";

/**
 * Watches what pons owes us and says when it is worth a trip.
 *
 * It cannot collect. V2FeeEscrow pays only the address it credited, and the
 * creator fee recipient is the cold admin key by choice — the keeper has no
 * standing to claim on its behalf and no way to acquire it. So the worker's
 * whole job here is to notice and to tell someone.
 *
 * Both balances are read because both are possible. Fees arrive in whatever
 * the launch is priced in, and ours is priced in the reward asset itself, so
 * the token side is the expected one. Native ETH turning up would mean
 * something about the launch is not what we think it is — which is worth
 * hearing about immediately, not worth silently ignoring.
 */
export interface FeeWatchDeps {
  /** The address pons credits — the cold wallet, not the keeper. */
  readonly recipient: Address;
  readonly rewardToken: Address;
  /** Below this, a trip with a cold key is not worth the gas or the risk. */
  readonly threshold: bigint;
  readonly escrow: {
    creditedToken(recipient: Address, token: Address): Promise<bigint>;
    creditedNative(recipient: Address): Promise<bigint>;
  };
  readonly alert: (message: string) => void;
}

export interface FeeWatchReading {
  readonly claimable: bigint;
  readonly claimableNative: bigint;
  readonly alerted: boolean;
}

/**
 * Returns the per-tick check, holding the one piece of state that keeps the
 * alert readable: whether it has already been raised.
 *
 * The worker ticks every ten seconds. An alert repeated at that rate is not
 * an alert, it is a log line nobody reads, and the one time it matters it
 * will be scrolled past. So it speaks once on the way up and stays quiet
 * until the balance falls back — which happens only when someone has
 * actually gone and claimed.
 */
export function createFeeWatch(deps: FeeWatchDeps): () => Promise<FeeWatchReading> {
  let announced = false;

  return async function checkFeeEscrow(): Promise<FeeWatchReading> {
    const claimable = await deps.escrow.creditedToken(deps.recipient, deps.rewardToken);
    const claimableNative = await deps.escrow.creditedNative(deps.recipient);

    const due = claimable >= deps.threshold || claimableNative >= deps.threshold;

    if (!due) {
      announced = false;
      return { claimable, claimableNative, alerted: false };
    }

    if (announced) return { claimable, claimableNative, alerted: false };

    announced = true;
    deps.alert(
      `creator fees ready to claim: ${claimable} reward token, ${claimableNative} wei ` +
        `credited to ${deps.recipient} in the pons escrow`
    );
    return { claimable, claimableNative, alerted: true };
  };
}
