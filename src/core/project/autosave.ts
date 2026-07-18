/**
 * Write-behind autosave queue (spec §4.4). Every committed mutation marks its owning
 * entity dirty; the queue coalesces per entity and flushes via repositories after
 * `AUTOSAVE_DEBOUNCE_MS` of quiet — and immediately on demand (`flushNow`), which the
 * app calls on `visibilitychange → hidden` and before a project switch/export.
 *
 * The queue is pure timing + coalescing so it is unit-testable with fake timers
 * (spec §12 Phase 2 exit). It never persists directly: a caller-supplied `flush`
 * turns a batch of dirty keys into the actual repository writes (which are already
 * off the main thread, so autosave never janks playback — spec §4.4).
 *
 * A flush is never allowed to reject: a failed write re-marks its keys dirty and is
 * reported through `onError`, so a transient failure retries on the next tick and an
 * auto-flush can never surface an unhandled rejection.
 *
 * Resolving is the flush's assertion that the batch reached storage — it is what clears
 * the unsaved dot — so a key the flush cannot write must never resolve. Keys no flush
 * handles reject with {@link UnflushableKeyError}, which the queue treats as permanent:
 * retrying could not write them either, so they are dropped without `onIdle` (leaving the
 * project marked modified, which is the truth) rather than re-queued into a retry spin.
 */
import { AUTOSAVE_DEBOUNCE_MS } from '@/core/constants';

/**
 * A dirty key that no flush path can write — an unknown kind, or one whose owning state
 * is gone. Permanent by construction: unlike a quota or worker failure, the same batch
 * would fail identically forever, so the queue must not retry it (spec §4.4).
 */
export class UnflushableKeyError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[], detail: string) {
    super(`${detail} (${keys.join(', ')})`);
    this.name = 'UnflushableKeyError';
    this.keys = keys;
  }
}

/**
 * What a flush actually achieved, so an explicit save can report the truth (spec §4.4).
 * `'idle'` means there was nothing queued — not a save, and not a failure either.
 */
export type SaveOutcome = 'saved' | 'failed' | 'idle';

export interface AutosaveQueueOptions {
  /**
   * Persist the given dirty keys. Resolves only once they are written; rejects to trigger
   * a retry, or with {@link UnflushableKeyError} for keys that can never be written.
   */
  readonly flush: (keys: readonly string[]) => Promise<void>;
  /** Debounce window; defaults to `AUTOSAVE_DEBOUNCE_MS` (spec §2.6). */
  readonly debounceMs?: number;
  /** Notified when a flush fails (the keys are re-queued automatically). */
  readonly onError?: (error: unknown, keys: readonly string[]) => void;
  /** Notified when the queue fully drains after a successful flush (clears the unsaved dot). */
  readonly onIdle?: () => void;
}

export class AutosaveQueue {
  private readonly flushImpl: (keys: readonly string[]) => Promise<void>;
  private readonly debounceMs: number;
  private readonly onError: ((error: unknown, keys: readonly string[]) => void) | undefined;
  private readonly onIdle: (() => void) | undefined;

  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<SaveOutcome> | null = null;
  private disposed = false;

  constructor(options: AutosaveQueueOptions) {
    this.flushImpl = options.flush;
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
    this.onError = options.onError;
    this.onIdle = options.onIdle;
  }

  /** Mark one entity dirty (coalesced by key) and (re)arm the debounce timer. */
  markDirty(key: string): void {
    if (this.disposed) return;
    this.dirty.add(key);
    this.arm();
  }

  /** True while any entity is queued or a flush is in flight. Drives the unsaved dot (spec §4.4). */
  get hasPending(): boolean {
    return this.dirty.size > 0 || this.flushing !== null;
  }

  /** The currently queued keys (test/diagnostic view). */
  get pendingKeys(): readonly string[] {
    return [...this.dirty];
  }

  /**
   * Flush now, awaited (spec §4.4 `saveNow`, and the visibility/pre-switch hooks).
   * Coalesces with any in-flight flush and re-flushes if new dirt accrued meanwhile.
   *
   * Resolves with what the flush achieved rather than merely that it finished: never
   * rejecting is what keeps auto-flushes quiet, but an explicit save must be able to
   * tell a write that landed from one that failed and was re-queued.
   */
  async flushNow(): Promise<SaveOutcome> {
    this.disarm();
    // A coalesced flush's outcome is this call's outcome too — it wrote our dirt.
    const coalesced = this.flushing ? await this.flushing : null;
    if (this.dirty.size === 0) return coalesced ?? 'idle';

    const batch = [...this.dirty];
    this.dirty.clear();
    this.flushing = this.runFlush(batch).then((ok) => (ok ? 'saved' : 'failed'));
    const outcome = await this.flushing;
    this.flushing = null;

    if (outcome === 'failed') {
      // The batch was re-queued; schedule a debounced retry rather than spinning.
      if (!this.disposed) this.arm();
      return 'failed';
    }

    // Mutations that landed during the flush are persisted on the next pass;
    // otherwise the queue is fully drained.
    if (this.dirty.size > 0) return await this.flushNow();
    this.onIdle?.();
    return 'saved';
  }

  /** Cancel timers and drop the in-memory queue (project close — spec §4.4). */
  dispose(): void {
    this.disposed = true;
    this.disarm();
    this.dirty.clear();
  }

  /** Persist one batch; on failure re-queue its keys and report. Returns success. */
  private async runFlush(batch: readonly string[]): Promise<boolean> {
    try {
      await this.flushImpl(batch);
      return true;
    } catch (error) {
      if (error instanceof UnflushableKeyError) {
        // Permanent: re-queueing would rebuild the same doomed batch every debounce, forever.
        // Drop the keys but report and return failure, so `onIdle` never runs and the project
        // stays marked modified — the work really is unsaved.
        this.onError?.(error, error.keys);
        return false;
      }
      // Re-queue so nothing is lost; a re-armed debounce (or saveNow) retries.
      for (const key of batch) this.dirty.add(key);
      this.onError?.(error, batch);
      return false;
    }
  }

  private arm(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.debounceMs);
  }

  private disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
