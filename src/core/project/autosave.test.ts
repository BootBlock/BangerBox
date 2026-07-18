/**
 * Autosave queue tests (spec §4.4) — debounce and per-entity coalescing with fake
 * timers, a Phase 2 exit criterion (spec §12).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS } from '@/core/constants';
import { AutosaveQueue, UnflushableKeyError } from './autosave';

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

  it('does not re-queue a failed batch onto a queue disposed mid-flush (issue #77)', async () => {
    let rejectFirst!: (error: Error) => void;
    const flush = vi.fn(() => new Promise<void>((_resolve, reject) => (rejectFirst = reject)));
    const queue = new AutosaveQueue({ flush, onError: vi.fn() });

    queue.markDirty('project:1');
    const flushing = queue.flushNow();
    // The project closes while the write is still in flight, and only then does it fail.
    queue.dispose();
    rejectFirst(new Error('quota'));
    await flushing;

    // Nothing re-arms for a disposed queue, so a re-queued key would stay dirty forever and
    // pin the unsaved dot on a project that is already gone.
    expect(queue.pendingKeys).toEqual([]);
    expect(queue.hasPending).toBe(false);
  });

  it('never signals idle for a batch the flush could not write (issue #72)', async () => {
    const onIdle = vi.fn();
    const onError = vi.fn();
    const flush = vi.fn(async (keys: readonly string[]) => {
      throw new UnflushableKeyError(keys, 'no path');
    });
    const queue = new AutosaveQueue({ flush, onIdle, onError });

    queue.markDirty('settings:theme');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(onIdle).not.toHaveBeenCalled(); // the unsaved dot must stay up
    expect(onError).toHaveBeenCalledWith(expect.any(UnflushableKeyError), ['settings:theme']);
  });

  it('does not retry an unflushable key forever', async () => {
    const flush = vi.fn(async (keys: readonly string[]) => {
      throw new UnflushableKeyError(keys, 'no path');
    });
    const queue = new AutosaveQueue({ flush, onError: vi.fn() });

    queue.markDirty('settings:theme');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 10);

    // A transient failure re-queues and retries; a permanent one is attempted exactly once.
    expect(flush).toHaveBeenCalledTimes(1);
    expect(queue.hasPending).toBe(false);
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
