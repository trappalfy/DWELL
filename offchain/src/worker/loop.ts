import { bucketOf, epochOf } from "../epoch.ts";

export interface TickDeps {
  closeBuckets(currentBucket: number): Promise<unknown>;
  settleEpoch(epoch: number): Promise<unknown>;
  publishIfDue(): Promise<unknown>;
  checkPublishedRoot(): Promise<unknown>;
  claimFeesIfDue(): Promise<unknown>;
  convertFeesIfDue(): Promise<unknown>;
  lastSettledEpoch(): number | null;
  alert(message: string): void;
}

export interface TickReport {
  readonly settled: number[];
  readonly failures: string[];
}

/**
 * One pass of the worker.
 *
 * The order is not arbitrary:
 *
 *  1. close buckets first — settlement can only count balances that have
 *     actually been sampled;
 *  2. settle only epochs that have ENDED. The current epoch is still
 *     collecting heartbeats, and settling it would underpay everyone in it;
 *  3. publish;
 *  4. run the watchdog AFTER publishing, since it checks what was sent;
 *  5. claim creator fees, then convert them, last and in that order — this
 *     is the only pair of stages that is never urgent, and claiming leaves
 *     the money in a form only converting can move.
 *
 * Each stage is isolated. One failing stage must not cancel the others, or a
 * flaky RPC during publishing would also stop fee conversion and, worse, the
 * watchdog. Failures are collected and alerted, never swallowed.
 */
export async function runWorkerTick(deps: TickDeps, nowSeconds: number): Promise<TickReport> {
  const settled: number[] = [];
  const failures: string[] = [];

  const run = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      deps.alert(`worker stage ${name} failed: ${message}`);
    }
  };

  await run("closeBuckets", () => deps.closeBuckets(bucketOf(nowSeconds)));

  const currentEpoch = epochOf(nowSeconds);
  const lastSettled = deps.lastSettledEpoch();
  const from = lastSettled === null ? currentEpoch - 1 : lastSettled + 1;

  for (let epoch = from; epoch < currentEpoch; epoch++) {
    const target = epoch;
    await run(`settle:${target}`, async () => {
      await deps.settleEpoch(target);
      settled.push(target);
    });
  }

  await run("publish", () => deps.publishIfDue());
  await run("watchdog", () => deps.checkPublishedRoot());
  // Claim before converting, in that order and in the same tick: claiming
  // leaves the fees as native ETH on the keeper, and converting is what moves
  // them into the vault. Reversed, every claim would wait a tick to matter.
  await run("claim", () => deps.claimFeesIfDue());
  await run("convert", () => deps.convertFeesIfDue());

  return { settled, failures };
}

export interface WorkerHandle {
  stop(): void;
}

/**
 * Runs a tick every interval, never overlapping: a slow tick delays the next
 * one rather than running two settlements concurrently over one journal.
 */
export function startWorker(deps: TickDeps, intervalMs: number): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runWorkerTick(deps, Math.floor(Date.now() / 1_000));
      schedule();
    }, intervalMs);
  };

  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
