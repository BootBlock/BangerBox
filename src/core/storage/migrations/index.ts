/**
 * The ordered migration registry (spec §9.2). New migrations append here with the
 * next contiguous version number — never edit a shipped migration.
 */
import { initialSchema } from './001-initial-schema';
import type { Migration } from './migration';

export const migrations: readonly Migration[] = [initialSchema];

export { getUserVersion, runMigrations } from './engine';
export type { Migration, MigrationReport } from './migration';
