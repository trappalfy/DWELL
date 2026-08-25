import type { RootStore } from "../db/roots.ts";
import type { Address } from "../types.ts";
import type { Hex } from "viem";

export interface WatchdogDeps {
  readonly roots: Pick<RootStore, "rootFor">;
  readonly vaultAddress: Address;
  readonly reader: {
    lastPublishedRoot(vault: Address): Promise<{ root: string; throughEpoch: number } | null>;
  };
  readonly writer: { pause(vault: Address): Promise<Hex> };
  readonly alert: (message: string) => void;
}

export type WatchdogVerdict =
  | { readonly ok: true; readonly checked: number }
  | {
      readonly ok: false;
      readonly expected: string;
      readonly actual: string;
      readonly paused: boolean;
    };

/**
 * Compares the root the chain actually carries against the root we recorded
 * sending for that same epoch.
 *
 * The value is in where the other side comes from: the chain's own event log,
 * read back independently of anything this process remembers. A disagreement
 * is one of two things, both serious:
 *
 *   1. the chain carries a root for an epoch we never published — somebody
 *      else used the keeper key;
 *   2. the chain carries a different root for an epoch we did publish — the
 *      worker sent something other than what it recorded.
 *
 * Comparison is per EPOCH, and that is the whole correction here. This used
 * to rebuild a tree from the current journal and compare that. But the
 * journal keeps growing between publishes — a root covers six epochs, and
 * the five epochs after it legitimately allocate to more people — so the
 * live journal disagrees with the last published root almost all of the
 * time. The check fired within five minutes of the first root and paused the
 * vault, which only the cold admin key can undo. A watchdog that cries every
 * half hour is worse than none: it trains the operator to unpause without
 * looking.
 *
 * What is given up is detecting a journal that diverged after the fact.
 * Catching that needs entitlement history the database does not keep, and
 * the previous code did not catch it either — it only looked as though it
 * did, while reporting normal operation as an emergency.
 */
export async function checkPublishedRoot(deps: WatchdogDeps): Promise<WatchdogVerdict> {
  const published = await deps.reader.lastPublishedRoot(deps.vaultAddress);
  if (published === null) return { ok: true, checked: 0 };

  const ours = deps.roots.rootFor(published.throughEpoch);

  if (ours !== null && ours.root.toLowerCase() === published.root.toLowerCase()) {
    return { ok: true, checked: published.throughEpoch };
  }

  const expected = ours?.root ?? "none recorded";
  deps.alert(
    `root mismatch through epoch ${published.throughEpoch}: ` +
      `chain has ${published.root}, we recorded ${expected}`
  );

  // The pause is attempted immediately and its failure is surfaced rather
  // than swallowed: a watchdog that silently failed to stop the protocol is
  // worse than no watchdog at all, because it would still be trusted.
  let paused = false;
  try {
    await deps.writer.pause(deps.vaultAddress);
    paused = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.alert(`WATCHDOG COULD NOT PAUSE: ${message}`);
  }

  return { ok: false, expected, actual: published.root, paused };
}
