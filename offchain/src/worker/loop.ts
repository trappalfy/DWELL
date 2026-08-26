import { createStageAlerter } from "./stageAlerter.ts";
import { bucketOf, epochOf } from "../epoch.ts";

export interface TickDeps {
  closeBuckets(currentBucket: number): Promise<unknown>;
  settleEpoch(epoch: number): Promise<unknown>;
  publishIfDue(): Promise<unknown>;
  checkPublishedRoot(): Promise<unknown>;
  checkFeeEscrow(): Promise<unknown>;
  lastSettledEpoch(): number | null;
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
 *  5. look at what pons owes us last — nothing here moves money, it only
 *     decides whether to say the fees are worth a trip.
 *
 * Each stage is isolated. One failing stage must not cancel the others, or a
 * flaky RPC during publishing would also stop the watchdog. Failures are
 * collected and returned, never swallowed — deciding which of them is worth
 * waking someone for belongs to the caller, which can see across ticks.
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
  await run("fees", () => deps.checkFeeEscrow());

  return { settled, failures };
}

export interface WorkerHandle {
  stop(): void;
}

/**
 * Runs a tick every interval, never overlapping: a slow tick delays the next
 * one rather than running two settlements concurrently over one journal.
 */
export function startWorker(
  deps: TickDeps,
  intervalMs: number,
  alert: (message: string) => void
): WorkerHandle {
  const reportStages = createStageAlerter(alert);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const report = await runWorkerTick(deps, Math.floor(Date.now() / 1_000));
      reportStages(report.failures);
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
