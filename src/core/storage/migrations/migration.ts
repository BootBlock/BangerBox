/**
 * Migration model types (spec §9.2 — `PRAGMA user_version`-driven sequential
 * migrations, each wrapped in a transaction with rollback-on-failure).
 */
import type { SqlStatement } from '../driver';

/**
 * A single, immutable schema migration that upgrades the database to `version`.
 * Statements run together inside one atomic transaction, followed by a
 * `PRAGMA user_version = <version>` bump. Migrations are never edited once
 * shipped — corrections ship as a new, higher-versioned migration; destructive
 * table changes use the safe recreation pattern (create-new → copy → drop-old →
 * rename) inside that new migration (spec §9.2).
 */
export interface Migration {
  /** Target schema version this migration produces (contiguous, starting at 1). */
  readonly version: number;
  /** Human-readable label for diagnostics and handover docs. */
  readonly name: string;
  /** Ordered DDL/seed statements that bring the schema up to `version`. */
  readonly statements: readonly SqlStatement[];
}

export interface MigrationReport {
  /** Schema version before migration. */
  readonly from: number;
  /** Schema version after migration (the target). */
  readonly to: number;
  /** Versions actually applied during this run, in order. */
  readonly applied: readonly number[];
}
