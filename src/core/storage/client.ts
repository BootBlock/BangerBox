/**
 * The application-wide database client (main thread).
 *
 * Owns the single WorkerDatabaseDriver instance and the boot orchestration:
 * open the OPFS connection, then apply any outstanding migrations before the UI
 * is allowed to use the database (spec §9.2). Kept as a module singleton so the
 * worker — which holds the exclusive OPFS write lock — is created exactly once
 * per tab.
 */
import { WorkerDatabaseDriver, type DbDiagnostics } from './rpc';
import { migrations, runMigrations, type MigrationReport } from './migrations';

let driver: WorkerDatabaseDriver | null = null;
let bootPromise: Promise<DbBootResult> | null = null;

/** Lazily construct (once) and return the shared database driver. */
export function getDatabaseDriver(): WorkerDatabaseDriver {
  driver ??= new WorkerDatabaseDriver();
  return driver;
}

export interface DbBootResult {
  readonly diagnostics: DbDiagnostics;
  readonly migration: MigrationReport;
}

/**
 * Boot the database: connect on the OPFS VFS, then migrate to the target schema.
 * Idempotent — concurrent and repeat callers share one boot. Throws a typed
 * DbError if the environment is unsupported or a migration fails; callers surface
 * that through Safe Mode rather than a white screen (spec §8.1).
 */
export function bootDatabase(): Promise<DbBootResult> {
  bootPromise ??= (async () => {
    try {
      const db = getDatabaseDriver();
      const initial = await db.init();
      const migration = await runMigrations(db, migrations);
      // After migration the schema version is the migration target; avoid an extra
      // round-trip by deriving the post-boot diagnostics locally.
      const diagnostics: DbDiagnostics = { ...initial, userVersion: migration.to };
      return { diagnostics, migration };
    } catch (err) {
      bootPromise = null; // allow a retry after a failed boot
      throw err;
    }
  })();
  return bootPromise;
}

/** Tear down the database client (used by the Safe Mode hard reset, spec §8.1). */
export async function disposeDatabase(): Promise<void> {
  const current = driver;
  driver = null;
  bootPromise = null;
  if (!current) return;
  try {
    await current.close();
  } catch {
    current.dispose();
  }
}
