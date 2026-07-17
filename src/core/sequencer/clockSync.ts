/**
 * Worker clock model — spec §7.1.2. The worker cannot read `audioContext.currentTime`, so
 * the main thread sends `{ contextTime, performanceTime }` pairs from
 * `audioContext.getOutputTimestamp()` every `CLOCK_SYNC_INTERVAL_MS`. The model keeps
 * `offset = contextTime − performanceTime/1000` smoothed over the last 8 samples to reject
 * jitter, and estimates context time as `performance.now()/1000 + offset`. Drift beyond
 * 2 ms snaps (and signals the caller to log). Pure and dependency-free (spec §7.1.5).
 */

/** Sync samples kept for the smoothing average (spec §7.1.2). */
const MAX_SAMPLES = 8;
/** Drift threshold beyond which the model snaps rather than smooths (spec §7.1.2). */
export const DRIFT_SNAP_SECONDS = 0.002;

export class ClockModel {
  private readonly samples: number[] = [];
  private smoothed = 0;
  private synced = false;

  /**
   * Fold a sync pair into the model (spec §7.1.2). `contextTime` is in seconds,
   * `performanceTime` in milliseconds (the `getOutputTimestamp()` domains). Returns
   * whether the offset snapped, so the worker can log the drift event.
   */
  applySync(contextTime: number, performanceTime: number): { snapped: boolean } {
    const instantaneous = contextTime - performanceTime / 1000;
    if (this.synced && Math.abs(instantaneous - this.smoothed) > DRIFT_SNAP_SECONDS) {
      this.samples.length = 0;
      this.samples.push(instantaneous);
      this.smoothed = instantaneous;
      this.synced = true;
      return { snapped: true };
    }
    this.samples.push(instantaneous);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.smoothed = this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
    this.synced = true;
    return { snapped: false };
  }

  /** Estimated context time (seconds) for a `performance.now()` reading in ms (spec §7.1.2). */
  estimateContextTime(performanceNowMs: number): number {
    return performanceNowMs / 1000 + this.smoothed;
  }

  /** The current smoothed offset in seconds. */
  get offsetSeconds(): number {
    return this.smoothed;
  }

  /** Whether at least one sync pair has been received. */
  get hasSync(): boolean {
    return this.synced;
  }
}
