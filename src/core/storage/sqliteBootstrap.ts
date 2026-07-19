/**
 * SQLite WASM bootstrap (spec §9.2; locked decision §1.3 #6).
 *
 * Instantiates the official @sqlite.org/sqlite-wasm module, opens the database on
 * the **OPFS VFS** (never IndexedDB/:memory: in production) and enables
 * foreign-key enforcement. Any missing prerequisite throws a typed DbError so the
 * worker can report it cleanly rather than silently degrading.
 *
 * Runs exclusively inside `db.worker.ts` — the main thread never imports the WASM
 * (spec §9.2).
 */
import sqlite3InitModule, { type OpfsDatabase, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { DbError } from './errors';
import type { DbDiagnostics } from './rpc';

/** The single database file within the OPFS hierarchy (spec §9.1). */
const DB_FILENAME = '/bangerbox.sqlite3';

/** The OPFS VFS name as registered by sqlite-wasm. */
const OPFS_VFS = 'opfs';

export interface BootstrapResult {
  readonly sqlite3: Sqlite3Static;
  readonly db: OpfsDatabase;
  readonly sqliteVersion: string;
  readonly vfs: string;
  readonly filename: string;
}

export async function bootstrapDatabase(): Promise<BootstrapResult> {
  const sqlite3 = await sqlite3InitModule();

  // The OPFS VFS only materialises in a Worker under cross-origin isolation
  // (COOP/COEP → SharedArrayBuffer). Its absence means the environment is
  // mis-configured; we must not fall back to any other storage (spec §1.3 #6).
  if (typeof sqlite3.oo1.OpfsDb !== 'function') {
    throw new DbError(
      'OPFS_UNAVAILABLE',
      'The OPFS VFS is unavailable. BangerBox requires a cross-origin-isolated context (COOP/COEP headers enabling SharedArrayBuffer) running inside a Web Worker.',
    );
  }

  let db: OpfsDatabase;
  try {
    // Flags 'c': open read-write, creating the database file if it does not exist.
    db = new sqlite3.oo1.OpfsDb(DB_FILENAME, 'c');
  } catch (err) {
    throw DbError.fromUnknown(err, 'OPFS_UNAVAILABLE');
  }

  try {
    // Enforce referential integrity for every connection (the §9.3 cascades rely on it).
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (err) {
    db.close();
    throw DbError.fromUnknown(err, 'INIT_FAILED');
  }

  return {
    sqlite3,
    db,
    sqliteVersion: sqlite3.version.libVersion,
    vfs: OPFS_VFS,
    filename: DB_FILENAME,
  };
}

/** Read a live diagnostics snapshot, including the current schema version. */
export function readDiagnostics(boot: BootstrapResult): DbDiagnostics {
  const userVersion = Number(boot.db.selectValue('PRAGMA user_version') ?? 0);
  return {
    sqliteVersion: boot.sqliteVersion,
    vfs: boot.vfs,
    opfs: true,
    userVersion,
    filename: boot.filename,
  };
}
