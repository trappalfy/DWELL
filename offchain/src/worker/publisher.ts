import { buildTree } from "../tree.ts";
import { sumEntitlements } from "../entitlements.ts";
import type { EntitlementStore } from "../db/entitlements.ts";
import type { EpochStore } from "../db/epochs.ts";
import type { RootStore } from "../db/roots.ts";
import type { Address } from "../types.ts";
import type { Hex } from "viem";

/**
 * Six epochs, thirty minutes.
 *
 * Settlement runs every epoch and costs nothing; publishing costs gas. At
 * 105k gas a root and ~0.0203 gwei, publishing every epoch runs about
 * $50/month against $8 at this interval. Because the tree is cumulative,
 * one root covers every epoch settled since the last one — no entitlement
 * is lost, it only becomes claimable later.
 *
 * This is deliberately NOT tied to the epoch length: they answer different
 * questions.
 */
export const PUBLISH_EVERY_EPOCHS = 6;

export interface PublishDeps {
  readonly entitlements: EntitlementStore;
  readonly epochs: EpochStore;
  readonly roots: RootStore;
  readonly writer: {
    publishRoot(vault: Address, epoch: number, root: Hex, totalAllocated: bigint): Promise<Hex>;
  };
  readonly vaultAddress: Address;
  /** When true the root is computed and reported but never sent. */
  readonly dryRun: boolean;
}

export type PublishOutcome =
  | { readonly published: false; readonly reason: string; readonly root?: string }
  | {
      readonly published: true;
      readonly throughEpoch: number;
      readonly root: string;
      readonly txHash: string;
    };

export async function publishIfDue(deps: PublishDeps): Promise<PublishOutcome> {
  const lastSettled = deps.epochs.lastSettled();
  if (lastSettled === null) return { published: false, reason: "no epoch settled yet" };

  const lastPublished = deps.roots.lastPublished();
  if (lastPublished !== null && lastSettled <= lastPublished) {
    return { published: false, reason: "no new epochs since last root" };
  }

  // Counted, not subtracted: epoch ids come from unix time and run in the
  // millions, so a difference between them measures elapsed time rather than
  // settled work.
  const sinceLast = deps.epochs.countSettledAfter(lastPublished);
  if (sinceLast < PUBLISH_EVERY_EPOCHS) {
    return { published: false, reason: `only ${sinceLast} epochs since last root` };
  }

  const cumulative = deps.entitlements.load();
  const anyAllocated = [...cumulative.values()].some((amount) => amount > 0n);
  if (!anyAllocated) return { published: false, reason: "nothing allocated yet" };

  const tree = buildTree(cumulative);
  const totalAllocated = sumEntitlements(cumulative);

  // Epochs keep closing even when nobody mines, so without this check a dead
  // period would republish an identical root every interval and pay gas for
  // a transaction that changes nothing.
  if (lastPublished !== null) {
    const previous = deps.roots.rootFor(lastPublished);
    if (previous && previous.root.toLowerCase() === tree.root.toLowerCase()) {
      return { published: false, reason: "root unchanged since last publish", root: tree.root };
    }
  }

  if (deps.dryRun) {
    return { published: false, reason: `dry-run: would publish ${tree.root}`, root: tree.root };
  }

  const txHash = await deps.writer.publishRoot(
    deps.vaultAddress,
    lastSettled,
    tree.root as Hex,
    totalAllocated
  );

  deps.roots.record(lastSettled, tree.root, txHash);

  return { published: true, throughEpoch: lastSettled, root: tree.root, txHash };
}
