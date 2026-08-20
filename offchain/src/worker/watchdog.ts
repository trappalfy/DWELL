import { buildTree } from "../tree.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { Address } from "../types.ts";
import type { Hex } from "viem";

export interface WatchdogDeps {
  readonly entitlements: EntitlementStore;
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
 * Compares the root the chain actually carries against the root our journal
 * produces.
 *
 * Recomputing the same pure function over the same data would always agree —
 * that comparison proves nothing. The value is in where the other side comes
 * from: the root is read from the chain's own event log. A mismatch means
 * the published root does not follow from our journal, which is exactly
 * three things, all serious:
 *
 *   1. somebody else used the keeper key;
 *   2. the journal diverged from what was settled (corruption, a race, a
 *      publish from stale memory);
 *   3. the worker sent something other than what it computed.
 *
 * None of these is reachable by unit tests, which is why the check has to
 * exist at runtime.
 */
export async function checkPublishedRoot(deps: WatchdogDeps): Promise<WatchdogVerdict> {
  const published = await deps.reader.lastPublishedRoot(deps.vaultAddress);
  if (published === null) return { ok: true, checked: 0 };

  const cumulative = deps.entitlements.load();
  const expected = buildTree(cumulative).root;

  if (expected.toLowerCase() === published.root.toLowerCase()) {
    return { ok: true, checked: published.throughEpoch };
  }

  deps.alert(
    `root mismatch through epoch ${published.throughEpoch}: ` +
      `chain has ${published.root}, journal produces ${expected}`
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
