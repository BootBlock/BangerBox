/// <reference lib="webworker" />
/**
 * The database Web Worker (spec §9.2; locked decision §1.3 #6).
 *
 * All SQLite execution lives here, isolated from the main thread. The main thread
 * communicates exclusively through the typed RPC envelopes in ./rpc — parameterised
 * statements only; string-concatenated SQL is forbidden (spec §9.2).
 *
 * Write queue: every inbound request is appended to a single FIFO promise chain,
 * so writes are strictly serialised and rapid successive actions cannot interleave
 * or race the asynchronous boot — OPFS holds an exclusive lock and rapid
 * successive writes must never surface SQLITE_BUSY (spec §9.2). Because the OPFS
 * VFS runs synchronously within this worker, each handler completes atomically
 * before the next begins.
 */
import { bootstrapDatabase, readDiagnostics, type BootstrapResult } from './sqliteBootstrap';
import { DbError } from './errors';
import { parseRequestEnvelope, type DbRequest, type RpcResponseEnvelope } from './rpc';
import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import type { SqlExecuteResult, SqlParams, SqlRow, SqlStatement } from './driver';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

let boot: BootstrapResult | null = null;
let bootPromise: Promise<BootstrapResult> | null = null;

/** Strictly ordered processing chain — the serialised write queue (spec §9.2). */
let queue: Promise<void> = Promise.resolve();

scope.addEventListener('message', (event: MessageEvent) => {
  const envelope = parseRequestEnvelope(event.data);
  if (!envelope) return; // Zod guard (locked decision §1.3 #11): drop malformed traffic.
  queue = queue.then(() => handle(envelope.id, envelope.request));
});

async function handle(id: string, request: DbRequest): Promise<void> {
  try {
    const result = await dispatch(request);
    post({ id, ok: true, result });
  } catch (err) {
    const dbError = DbError.fromUnknown(err, 'UNKNOWN', sqlOf(request));
    post({ id, ok: false, error: dbError.toSerialised() });
  }
}

async function dispatch(request: DbRequest): Promise<unknown> {
  if (request.kind === 'close') {
    if (boot) {
      boot.db.close();
      boot = null;
      bootPromise = null;
    }
    return null;
  }

  const active = await ensureBoot();

  switch (request.kind) {
    case 'init':
    case 'diagnostics':
      return readDiagnostics(active);
    case 'query':
      return runQuery(active, request.sql, request.params);
    case 'execute':
      return runExecute(active, request.sql, request.params);
    case 'transaction':
      return runTransaction(active, request.statements);
    case 'exportBinary':
      return exportBinary(active);
    default:
      return assertNever(request);
  }
}

function ensureBoot(): Promise<BootstrapResult> {
  if (boot) return Promise.resolve(boot);
  bootPromise ??= bootstrapDatabase().then((result) => {
    boot = result;
    return result;
  });
  return bootPromise;
}

function runQuery(active: BootstrapResult, sql: string, params?: SqlParams): SqlRow[] {
  return active.db.selectObjects(sql, bindOf(params)) as SqlRow[];
}

function runExecute(active: BootstrapResult, sql: string, params?: SqlParams): SqlExecuteResult {
  active.db.exec(sql, { bind: bindOf(params) });
  const rowsModified = active.db.changes(false, false);
  const pointer = active.db.pointer;
  const lastInsertRowId = pointer ? active.sqlite3.capi.sqlite3_last_insert_rowid(pointer) : 0n;
  return {
    rowsModified,
    lastInsertRowId: lastInsertRowId === 0n ? null : Number(lastInsertRowId),
  };
}

/** Execute a batch atomically: BEGIN, run all, COMMIT; ROLLBACK on any error. */
function runTransaction(active: BootstrapResult, statements: readonly SqlStatement[]): null {
  const { db } = active;
  db.exec('BEGIN;');
  try {
    for (const statement of statements) {
      db.exec(statement.sql, { bind: bindOf(statement.params) });
    }
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw err;
  }
  return null;
}

/**
 * Serialise the live database to a raw .sqlite binary for the Safe Mode rescue
 * download (spec §8.1) — recoverable in an external tool; never the interchange
 * format (spec §9.6).
 */
function exportBinary(active: BootstrapResult): Uint8Array {
  const pointer = active.db.pointer;
  if (!pointer) {
    throw new DbError('UNKNOWN', 'Cannot export database: the connection pointer is unavailable.');
  }
  return active.sqlite3.capi.sqlite3_js_db_export(pointer);
}

function bindOf(params?: SqlParams): BindingSpec | undefined {
  return params;
}

function sqlOf(request: DbRequest): string | undefined {
  if (request.kind === 'query' || request.kind === 'execute') return request.sql;
  return undefined;
}

function post(response: RpcResponseEnvelope): void {
  scope.postMessage(response);
}

function assertNever(value: never): never {
  throw new DbError('UNKNOWN', `Unhandled database request: ${JSON.stringify(value)}`);
}
