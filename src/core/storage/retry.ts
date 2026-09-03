/**
 * The storage layer's single policy for a recoverable failure (spec §9.2, §9.7; issue #98).
 *
 * A storage failure is one of three things, and the layer previously had no way to say which:
 *
 * 1. **Transient contention** — SQLite reports `SQLITE_BUSY`/`SQLITE_LOCKED`, or OPFS reports
 *    `NoModificationAllowedError` because another handle holds the file. The same call a
 *    moment later succeeds. §9.2 says rapid successive writes "must never surface
 *    SQLITE_BUSY", and the worker's FIFO queue only guarantees that *within* one tab — the
 *    VFS itself can still report contention, and that is what this retries.
 * 2. **Permanent, but recoverable by the user** — quota exhausted, a constraint violated.
 *    Retrying cannot help; the caller reports it.
 * 3. **Absent** — the entry is not there. Not a failure at all for a delete or an existence
 *    check, and handled at the call site rather than here (see `isNotFoundError`).
 *
 * Only (1) is retried, and only a bounded number of times: an unbounded retry turns a stuck
 * lock into a hung UI, which is worse than the error. Everything else propagates unchanged,
 * so a caller still sees the original typed error rather than a wrapper.
 */
import { STORAGE_RETRY_ATTEMPTS, STORAGE_RETRY_BASE_DELAY_MS } from '@/core/constants';
import { DbError } from './errors';

/**
 * True for the OPFS "someone else holds this file" error. Chromium raises
 * `NoModificationAllowedError` when a sync access handle is already open on the file, which
 * clears as soon as that handle closes.
 */
function isOpfsContention(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NoModificationAllowedError';
}

/**
 * True for the OPFS "it is not there" error, which callers treat as an answer rather than a
 * failure. Everything else — permissions, I/O, quota — must propagate, or a delete that could
 * not happen reports success (issue #98).
 */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

/** True for a failure the same call would plausibly survive if repeated (spec §9.2). */
export function isRecoverableStorageError(error: unknown): boolean {
  if (error instanceof DbError) return error.isRetryable;
  return isOpfsContention(error);
}

export interface RetryOptions {
  /** Total attempts including the first. Defaults to `STORAGE_RETRY_ATTEMPTS` (spec §2.6). */
  readonly attempts?: number;
  /** First backoff step in milliseconds; each retry doubles it. */
  readonly baseDelayMs?: number;
  /** Which failures to retry; defaults to {@link isRecoverableStorageError}. */
  readonly isRetryable?: (error: unknown) => boolean;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a storage operation, retrying it while it fails recoverably (spec §9.2).
 *
 * The operation must be idempotent under a failure, which every caller here is: a SQLite
 * statement that reported BUSY never ran, a transaction that failed rolled back, and
 * `writeFileAtomic` removes its temp file before rejecting. Backoff doubles from
 * `baseDelayMs` so a briefly-held lock costs one short wait rather than a spin.
 */
export async function withStorageRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? STORAGE_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? STORAGE_RETRY_BASE_DELAY_MS;
  const retryable = options.isRetryable ?? isRecoverableStorageError;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      // The last attempt's failure is the caller's failure, unchanged: a retry budget must
      // never turn a typed DbError into a generic "gave up" the UI cannot act on.
      if (attempt >= attempts || !retryable(error)) throw error;
      await wait(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
