/**
 * The storage layer's recoverable-failure policy (spec §9.2, §9.7; issue #98).
 *
 * Before this, `DbError.isRetryable` had no caller at all: a `SQLITE_BUSY` reached the
 * repository as a plain rejection and the write was simply lost, which is the "turns a
 * recoverable failure into a fatal one" half of that issue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from './errors';
import { isNotFoundError, isRecoverableStorageError, withStorageRetry } from './retry';

describe('classifying a storage failure (spec §9.2)', () => {
  it('treats SQLite lock contention as recoverable', () => {
    expect(isRecoverableStorageError(new DbError('SQLITE_BUSY', 'busy'))).toBe(true);
    expect(isRecoverableStorageError(new DbError('SQLITE_LOCKED', 'locked'))).toBe(true);
  });

  it('treats a full disk, a read-only database and a constraint as permanent', () => {
    expect(isRecoverableStorageError(new DbError('SQLITE_FULL', 'full'))).toBe(false);
    expect(isRecoverableStorageError(new DbError('SQLITE_READONLY', 'ro'))).toBe(false);
    expect(isRecoverableStorageError(new DbError('SQLITE_CONSTRAINT', 'dup'))).toBe(false);
  });

  it('treats an OPFS handle already in use as recoverable', () => {
    const busy = new DOMException('in use', 'NoModificationAllowedError');
    expect(isRecoverableStorageError(busy)).toBe(true);
  });

  it('does not treat a missing entry as a failure to retry', () => {
    const absent = new DOMException('gone', 'NotFoundError');
    expect(isNotFoundError(absent)).toBe(true);
    expect(isRecoverableStorageError(absent)).toBe(false);
  });

  it('treats an unknown throw as permanent rather than retrying blindly', () => {
    expect(isRecoverableStorageError(new Error('who knows'))).toBe(false);
    expect(isRecoverableStorageError('a string')).toBe(false);
  });
});

describe('withStorageRetry (spec §9.2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the first attempt when it succeeds, without waiting', async () => {
    const operation = vi.fn(async () => 'ok');
    await expect(withStorageRetry(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a recoverable failure and returns the attempt that lands', async () => {
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new DbError('SQLITE_BUSY', 'database is locked');
      return 'landed';
    });

    const settled = withStorageRetry(operation);
    await vi.runAllTimersAsync();
    await expect(settled).resolves.toBe('landed');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt budget, rethrowing the ORIGINAL typed error', async () => {
    const busy = new DbError('SQLITE_BUSY', 'database is locked');
    const operation = vi.fn(async () => {
      throw busy;
    });

    // Attach the handler before the timers run, or the rejection is unhandled in between.
    const settled = withStorageRetry(operation);
    void settled.catch(() => undefined);
    await vi.runAllTimersAsync();
    // The caller must still see a DbError it can branch on, not a "gave up" wrapper.
    await expect(settled).rejects.toBe(busy);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent failure', async () => {
    const full = new DbError('SQLITE_FULL', 'database or disk is full');
    const operation = vi.fn(async () => {
      throw full;
    });

    const settled = withStorageRetry(operation);
    void settled.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(settled).rejects.toBe(full);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('backs off between attempts rather than spinning', async () => {
    const operation = vi.fn(async () => {
      throw new DbError('SQLITE_BUSY', 'busy');
    });

    const settled = withStorageRetry(operation, { attempts: 3, baseDelayMs: 10 });
    void settled.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(operation).toHaveBeenCalledTimes(2);
    // The step doubles, so nothing fires at 10 ms again.
    await vi.advanceTimersByTimeAsync(10);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(operation).toHaveBeenCalledTimes(3);
    await expect(settled).rejects.toBeInstanceOf(DbError);
  });
});
