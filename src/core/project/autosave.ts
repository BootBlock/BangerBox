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
 */
import { AUTOSAVE_DEBOUNCE_MS } from '@/core/constants';

export interface AutosaveQueueOptions {
  /** Persist the given dirty keys. Resolves on success; rejects to trigger a retry. */
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
  private flushing: Promise<void> | null = null;
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
   */
  async flushNow(): Promise<void> {
    this.disarm();
    if (this.flushing) await this.flushing;
    if (this.dirty.size === 0) return;

    const batch = [...this.dirty];
    this.dirty.clear();
    let succeeded = true;
    this.flushing = this.runFlush(batch).then((ok) => {
      succeeded = ok;
    });
    await this.flushing;
    this.flushing = null;

    if (!succeeded) {
      // The batch was re-queued; schedule a debounced retry rather than spinning.
      if (!this.disposed) this.arm();
      return;
    }

    // Mutations that landed during the flush are persisted on the next pass;
    // otherwise the queue is fully drained.
    if (this.dirty.size > 0) await this.flushNow();
    else this.onIdle?.();
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
