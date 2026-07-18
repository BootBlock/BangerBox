/**
 * The strictly typed promise-based `postMessage` RPC bridge (spec §9.2; locked
 * decision §1.3 #7 — hand-rolled, no Comlink).
 *
 * Every call from the main thread is wrapped in an envelope carrying a correlation
 * `id`; the worker replies with the matching `id` and either a result or a
 * serialised error. Envelopes are Zod-validated at both ends (locked decision
 * §1.3 #11 — RPC payload guards). Messages are structured-clone-safe.
 */
import { z } from 'zod';
import { DbError, isSerialisedDbError, type SerialisedDbError } from './errors';
import type { IDatabaseDriver, SqlExecuteResult, SqlParams, SqlRow, SqlStatement } from './driver';

/** Snapshot of the live database/VFS state, returned by `init` and `diagnostics`. */
export interface DbDiagnostics {
  readonly sqliteVersion: string;
  /** The active Virtual File System name (expected: 'opfs'). */
  readonly vfs: string;
  /** Whether the connection is actually backed by OPFS (never :memory: in production). */
  readonly opfs: boolean;
  /** Current schema version from `PRAGMA user_version` (spec §9.2). */
  readonly userVersion: number;
  /** The database filename/path in the VFS (spec §9.1: /bangerbox.sqlite3). */
  readonly filename: string;
}

/** The request union — every supported worker operation. */
export type DbRequest =
  | { readonly kind: 'init' }
  | { readonly kind: 'diagnostics' }
  | { readonly kind: 'exportBinary' }
  | { readonly kind: 'query'; readonly sql: string; readonly params?: SqlParams }
  | { readonly kind: 'execute'; readonly sql: string; readonly params?: SqlParams }
  | { readonly kind: 'transaction'; readonly statements: readonly SqlStatement[] }
  | { readonly kind: 'close' };

/** Main thread → worker. */
export interface RpcRequestEnvelope {
  readonly id: string;
  readonly request: DbRequest;
}

/** Worker → main thread. */
export type RpcResponseEnvelope =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly id: string; readonly ok: false; readonly error: SerialisedDbError };

// --- Zod envelope guards (locked decision §1.3 #11) ------------------------------

const sqlValueSchema = z.union([
  z.string(),
  z.number(),
  z.bigint(),
  z.boolean(),
  z.null(),
  z.instanceof(Uint8Array),
]);

const sqlParamsSchema = z.union([z.array(sqlValueSchema), z.record(z.string(), sqlValueSchema)]);

const sqlStatementSchema = z.object({
  sql: z.string().min(1),
  params: sqlParamsSchema.optional(),
});

const dbRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('init') }),
  z.object({ kind: z.literal('diagnostics') }),
  z.object({ kind: z.literal('exportBinary') }),
  z.object({ kind: z.literal('query'), sql: z.string().min(1), params: sqlParamsSchema.optional() }),
  z.object({ kind: z.literal('execute'), sql: z.string().min(1), params: sqlParamsSchema.optional() }),
  z.object({ kind: z.literal('transaction'), statements: z.array(sqlStatementSchema) }),
  z.object({ kind: z.literal('close') }),
]);

const rpcRequestEnvelopeSchema = z.object({
  id: z.string().min(1),
  request: dbRequestSchema,
});

const serialisedDbErrorSchema = z.object({
  name: z.literal('DbError'),
  code: z.string(),
  message: z.string(),
  resultCode: z.number().optional(),
  sql: z.string().optional(),
});

const rpcResponseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string().min(1), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().min(1), ok: z.literal(false), error: serialisedDbErrorSchema }),
]);

/** Validate an inbound request envelope inside the worker. */
export function parseRequestEnvelope(value: unknown): RpcRequestEnvelope | null {
  const parsed = rpcRequestEnvelopeSchema.safeParse(value);
  return parsed.success ? (parsed.data as RpcRequestEnvelope) : null;
}

/** Validate an inbound response envelope on the main thread. */
export function parseResponseEnvelope(value: unknown): RpcResponseEnvelope | null {
  const parsed = rpcResponseEnvelopeSchema.safeParse(value);
  if (!parsed.success) return null;
  const envelope = parsed.data;
  if (!envelope.ok && !isSerialisedDbError(envelope.error)) return null;
  return envelope as RpcResponseEnvelope;
}

// --- Main-thread driver over the bridge ------------------------------------------

/** Structural subset of `Worker` the driver needs — injectable for unit tests. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Production database driver — the main-thread client of `db.worker.ts`.
 * Implements IDatabaseDriver by marshalling each call across the postMessage
 * bridge with a correlation id and awaiting the matching reply. The main thread
 * never imports the SQLite WASM binary (spec §9.2).
 */
export class WorkerDatabaseDriver implements IDatabaseDriver {
  readonly #worker: WorkerLike;
  readonly #pending = new Map<string, PendingCall>();
  #disposed = false;
  /**
   * Set when the worker itself dies (`error`/`messageerror`). Rejecting the calls
   * that were in flight is not enough: the worker is gone, so every *later* call
   * must be refused too, or it would be posted into the void and never settle.
   */
  #failure: DbError | null = null;

  constructor(worker?: WorkerLike) {
    // This exact `new Worker(new URL(...), { type: 'module' })` form is what Vite
    // statically detects to bundle the worker (and its SQLite WASM import).
    this.#worker =
      worker ??
      new Worker(new URL('./db.worker.ts', import.meta.url), {
        type: 'module',
        name: 'bangerbox-db',
      });
    this.#worker.addEventListener('message', this.#handleMessage);
    this.#worker.addEventListener('error', this.#handleWorkerFailure);
    this.#worker.addEventListener('messageerror', this.#handleWorkerFailure);
  }

  /** Open the OPFS database and return a diagnostics snapshot. */
  init(): Promise<DbDiagnostics> {
    return this.#send<DbDiagnostics>({ kind: 'init' });
  }

  diagnostics(): Promise<DbDiagnostics> {
    return this.#send<DbDiagnostics>({ kind: 'diagnostics' });
  }

  /** Raw .sqlite bytes for the Safe Mode rescue download (spec §8.1). */
  exportBinary(): Promise<Uint8Array> {
    return this.#send<Uint8Array>({ kind: 'exportBinary' });
  }

  query<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow[]> {
    return this.#send<TRow[]>({ kind: 'query', sql, params });
  }

  async queryOne<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow | undefined> {
    const rows = await this.#send<TRow[]>({ kind: 'query', sql, params });
    return rows[0];
  }

  execute(sql: string, params?: SqlParams): Promise<SqlExecuteResult> {
    return this.#send<SqlExecuteResult>({ kind: 'execute', sql, params });
  }

  async transaction(statements: readonly SqlStatement[]): Promise<void> {
    await this.#send<null>({ kind: 'transaction', statements });
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    // A dead worker will never answer a close request; just tear down locally.
    if (this.#failure) {
      this.dispose();
      return;
    }
    try {
      await this.#send<null>({ kind: 'close' });
    } finally {
      this.dispose();
    }
  }

  /** Forcibly tear down the worker and reject any in-flight calls. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.removeEventListener('message', this.#handleMessage);
    this.#worker.removeEventListener('error', this.#handleWorkerFailure);
    this.#worker.removeEventListener('messageerror', this.#handleWorkerFailure);
    this.#worker.terminate();
    this.#rejectAll(new DbError('UNKNOWN', 'The database driver was disposed.'));
  }

  #send<T>(request: DbRequest): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new DbError('UNKNOWN', 'The database driver has been disposed.'));
    }
    if (this.#failure) return Promise.reject(this.#failure);
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      const envelope: RpcRequestEnvelope = { id, request };
      this.#worker.postMessage(envelope);
    });
  }

  #handleMessage = (event: MessageEvent): void => {
    const response = parseResponseEnvelope(event.data);
    if (!response) return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(DbError.fromSerialised(response.error));
    }
  };

  #handleWorkerFailure = (event: Event): void => {
    if (this.#failure || this.#disposed) return;
    const detail = event instanceof ErrorEvent && event.message ? event.message : 'unknown worker failure';
    this.#failure = new DbError('INIT_FAILED', `Database worker error: ${detail}`);
    // The worker cannot serve anything after this; stop it rather than leaving a
    // half-dead thread holding the exclusive OPFS write lock (spec §9.2).
    this.#worker.terminate();
    this.#rejectAll(this.#failure);
  };

  #rejectAll(error: DbError): void {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}
