/**
 * The versioned migration engine (spec §9.2).
 *
 * Schema state is dictated absolutely by `PRAGMA user_version` — querying
 * `sqlite_master` to guess schema state is forbidden (spec §9.2). On boot we read
 * the current version and apply, in strict ascending order, every migration newer
 * than it. Each migration runs in a single atomic transaction with its
 * `user_version` bump, so a failure rolls the step back entirely and halts rather
 * than leaving a half-migrated database.
 *
 * Operates against the IDatabaseDriver abstraction, so the entire engine is
 * validated in unit tests against the in-memory driver (spec §11.3). Adapted from
 * the proven Gubbins migration engine (spec §13.6 reference rule).
 */
import { DbError } from '../errors';
import type { IDatabaseDriver, SqlStatement } from '../driver';
import type { Migration, MigrationReport } from './migration';

/** Read the current schema version from `PRAGMA user_version`. */
export async function getUserVersion(driver: IDatabaseDriver): Promise<number> {
  const row = await driver.queryOne<{ user_version: number | bigint }>('PRAGMA user_version;');
  return Number(row?.user_version ?? 0);
}

/**
 * Apply all outstanding migrations. Returns a report describing what ran.
 * Idempotent: a database already at the target version performs no writes.
 */
export async function runMigrations(
  driver: IDatabaseDriver,
  migrations: readonly Migration[],
): Promise<MigrationReport> {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  assertValidSequence(ordered);

  const from = await getUserVersion(driver);
  const to = ordered.length === 0 ? from : ordered[ordered.length - 1]!.version;
  const applied: number[] = [];

  // A database whose version exceeds the highest migration this build knows about
  // was written by a newer build. Refuse to run rather than silently no-op and
  // surface later as cryptic "no such table" failures; Safe Mode offers the rescue
  // paths (spec §8.1).
  if (ordered.length > 0 && from > to) {
    throw new DbError(
      'SCHEMA_TOO_NEW',
      `The on-device database is at schema v${from}, which is newer than this build supports (v${to}). ` +
        'Update BangerBox, or use Safe Mode to export and reset local data.',
    );
  }

  for (const migration of ordered) {
    if (migration.version <= from) continue;

    const statements: SqlStatement[] = [
      ...migration.statements,
      // The version value is an integer we control, not user input; PRAGMA does
      // not accept bound parameters, so it is inlined safely via Number().
      { sql: `PRAGMA user_version = ${Number(migration.version)};` },
    ];

    try {
      await driver.transaction(statements);
    } catch (err) {
      throw new DbError(
        'INIT_FAILED',
        `Migration v${migration.version} ("${migration.name}") failed and was rolled back; halting application start (spec §9.2).`,
        { cause: err },
      );
    }

    applied.push(migration.version);
  }

  return { from, to, applied };
}

/** Guard against authoring mistakes: versions must be contiguous starting at 1. */
function assertValidSequence(ordered: readonly Migration[]): void {
  for (let index = 0; index < ordered.length; index++) {
    const expected = index + 1;
    const migration = ordered[index]!;
    if (migration.version !== expected) {
      throw new DbError(
        'INIT_FAILED',
        `Migration versions must be contiguous from 1. Expected v${expected} at position ${index}, found v${migration.version} ("${migration.name}").`,
      );
    }
  }
}
