/**
 * Decides which stage failures are worth waking someone for.
 *
 * Every stage of the tick is isolated and retried ten seconds later, so a
 * single failure costs ten seconds of blindness and nothing else. Measured
 * on the live node: the watchdog's log query fails roughly once in a
 * thousand ticks, which under per-failure alerting produced a couple of
 * frightening lines a day for a condition that had already healed itself.
 *
 * An alert that cries at noise is worse than no alert, because it teaches
 * the operator to scroll past the one that matters. So a stage has to fail
 * REPEATEDLY before it is worth saying anything, and when it comes back the
 * recovery is stated plainly rather than left as silence — silence after an
 * alarm is ambiguous, and ambiguity at three in the morning is expensive.
 */
const CONSECUTIVE_BEFORE_ALERT = 3;

export type StageReporter = (failures: readonly string[]) => void;

/**
 * @param alert where a decided alert goes
 * @param threshold consecutive failures of one stage before speaking
 */
export function createStageAlerter(
  alert: (message: string) => void,
  threshold: number = CONSECUTIVE_BEFORE_ALERT
): StageReporter {
  /** Stage name to how many ticks in a row it has failed. */
  const streaks = new Map<string, number>();
  /** Stages already alerted on, so the alarm is not repeated every tick. */
  const alerted = new Set<string>();

  return function report(failures: readonly string[]): void {
    const failedNow = new Map<string, string>();
    for (const entry of failures) {
      const at = entry.indexOf(":");
      const stage = at < 0 ? entry : entry.slice(0, at);
      failedNow.set(stage, entry);
    }

    // Recovery first: a stage that is not in this tick's failures is working,
    // whatever it was doing before.
    for (const stage of [...streaks.keys()]) {
      if (failedNow.has(stage)) continue;
      streaks.delete(stage);
      if (alerted.delete(stage)) {
        alert(`worker stage ${stage} recovered`);
      }
    }

    for (const [stage, entry] of failedNow) {
      const streak = (streaks.get(stage) ?? 0) + 1;
      streaks.set(stage, streak);
      if (streak < threshold || alerted.has(stage)) continue;
      alerted.add(stage);
      alert(`worker stage ${stage} failed ${streak} ticks in a row: ${entry}`);
    }
  };
}
