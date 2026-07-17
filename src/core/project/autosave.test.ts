/**
 * Autosave queue tests (spec §4.4) — debounce and per-entity coalescing with fake
 * timers, a Phase 2 exit criterion (spec §12).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS } from '@/core/constants';
import { AutosaveQueue } from './autosave';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AutosaveQueue', () => {
  it('debounces: flushes once after AUTOSAVE_DEBOUNCE_MS of quiet', async () => {
    const flush = vi.fn(async () => {});
    const queue = new AutosaveQueue({ flush });

    queue.markDirty('project:1');
    // Keep marking within the window — the timer keeps resetting.
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    queue.markDirty('project:1');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(flush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple dirty entities into one batched flush', async () => {
    const flush = vi.fn(async () => {});
    const queue = new AutosaveQueue({ flush });

    queue.markDirty('project:1');
    queue.markDirty('sequence:a');
    queue.markDirty('project:1'); // duplicate collapses
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(flush).toHaveBeenCalledTimes(1);
    const batch = [...(flush.mock.calls[0]![0] as readonly string[])].sort();
    expect(batch).toEqual(['project:1', 'sequence:a']);
    expect(queue.hasPending).toBe(false);
  });

  it('flushNow flushes immediately and cancels the pending debounce', async () => {
    const flush = vi.fn(async () => {});
    const queue = new AutosaveQueue({ flush });

    queue.markDirty('program:x');
    await queue.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);

    // The armed timer was cancelled — advancing produces no second flush.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('re-queues keys and reports when a flush fails, retrying on the next pass', async () => {
    const onError = vi.fn();
    let attempt = 0;
    const flush = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('write failed');
    });
    const queue = new AutosaveQueue({ flush, onError });

    queue.markDirty('project:1');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(queue.hasPending).toBe(true); // re-queued

    await queue.flushNow();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(queue.hasPending).toBe(false);
  });

  it('re-flushes entities dirtied during an in-flight flush', async () => {
    let resolveFirst!: () => void;
    const flush = vi.fn((keys: readonly string[]) => {
      if (keys.includes('a')) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    const queue = new AutosaveQueue({ flush });

    queue.markDirty('a');
    const flushing = queue.flushNow();
    // Dirty a new entity while the first flush is still pending.
    queue.markDirty('b');
    resolveFirst();
    await flushing;

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1]![0]).toEqual(['b']);
  });

  it('stops accepting work after dispose', async () => {
    const flush = vi.fn(async () => {});
    const queue = new AutosaveQueue({ flush });
    queue.dispose();
    queue.markDirty('project:1');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(flush).not.toHaveBeenCalled();
  });
});
