import type { Address } from "../types.ts";
import type { Hex } from "viem";
import { ADDRESSES } from "../config.ts";

/**
 * Pulls the creator fees pons owes us and turns them into spendable ETH.
 *
 * The fees do not arrive on their own. They accrue inside the locked
 * liquidity position of our own pool, and PonsLaunchLocker.collectFees pays
 * them out only when somebody asks — pons runs an automation that "may"
 * claim on our behalf, which is not a promise the hearth can be built on.
 * The keeper is the fee recipient, and collectFees authorises the recipient
 * by name, so it can always claim for itself without anyone's permission.
 *
 * What comes back is a pair, because the pool is a pair: WETH and our own
 * token. Only the WETH half is money here. It arrives WRAPPED — the locker
 * pays with IERC20.safeTransfer — while feeConverter reads the NATIVE
 * balance, so without the unwrap below the fees would sit on the keeper
 * forever and the vault would never refill.
 *
 * The project token half is deliberately left alone: selling our own supply
 * back into our own pool is a decision about the token, not about plumbing.
 */
export interface ClaimDeps {
  /** The token whose pool pays us — NOT the reward asset. */
  readonly projectToken: Address;
  readonly reader: {
    tokenBalance(token: Address, account: Address): Promise<bigint>;
  };
  readonly writer: {
    readonly address: Address;
    /** Resolves to null when the locker had nothing to pay out. */
    collectCreatorFees(token: Address): Promise<Hex | null>;
    unwrapWeth(amount: bigint): Promise<Hex>;
  };
  readonly dryRun: boolean;
}

export type ClaimOutcome =
  | { readonly claimed: false; readonly reason: string }
  | {
      readonly claimed: true;
      readonly unwrapped: bigint;
      readonly collectTx: Hex | null;
      readonly unwrapTx: Hex;
    };

export async function claimFeesIfDue(deps: ClaimDeps): Promise<ClaimOutcome> {
  if (deps.dryRun) {
    return { claimed: false, reason: "dry-run: would collect creator fees" };
  }

  const collectTx = await deps.writer.collectCreatorFees(deps.projectToken);

  /*
   * Read after collecting, and read the balance rather than trusting the
   * amount the call reports. A claim that succeeded but whose unwrap failed
   * leaves WETH stranded on the keeper; starting from the balance means the
   * next tick picks that up instead of waiting for fresh fees to arrive.
   */
  const weth = await deps.reader.tokenBalance(ADDRESSES.weth, deps.writer.address);
  if (weth <= 0n) {
    return { claimed: false, reason: "no WETH on the keeper" };
  }

  const unwrapTx = await deps.writer.unwrapWeth(weth);
  return { claimed: true, unwrapped: weth, collectTx, unwrapTx };
}
