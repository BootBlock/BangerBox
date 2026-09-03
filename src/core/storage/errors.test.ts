import { describe, expect, it } from 'vitest';
import { DbError, isSerialisedDbError, mapResultCode } from './errors';

describe('DbError', () => {
  it('round-trips through the serialised wire form', () => {
    const original = new DbError('SQLITE_CONSTRAINT', 'UNIQUE constraint failed', {
      resultCode: 19,
      sql: 'INSERT INTO projects …',
    });
    const wire = original.toSerialised();
    expect(isSerialisedDbError(wire)).toBe(true);

    const rebuilt = DbError.fromSerialised(wire);
    expect(rebuilt.code).toBe('SQLITE_CONSTRAINT');
    expect(rebuilt.message).toBe('UNIQUE constraint failed');
    expect(rebuilt.resultCode).toBe(19);
    expect(rebuilt.sql).toBe('INSERT INTO projects …');
  });

  it('omits absent optional fields from the wire form (structured-clone hygiene)', () => {
    const wire = new DbError('UNKNOWN', 'boom').toSerialised();
    expect('resultCode' in wire).toBe(false);
    expect('sql' in wire).toBe(false);
  });

  it('normalises unknown thrown values, mapping sqlite-wasm result codes', () => {
    const sqliteish = Object.assign(new Error('database is locked'), { resultCode: 5 });
    const mapped = DbError.fromUnknown(sqliteish, 'UNKNOWN', 'UPDATE …');
    expect(mapped.code).toBe('SQLITE_BUSY');
    expect(mapped.isRetryable).toBe(true);
    expect(mapped.sql).toBe('UPDATE …');
  });

  it('normalises node:sqlite errors via their errcode property', () => {
    const nodeish = Object.assign(new Error('constraint failed'), { errcode: 787 });
    expect(DbError.fromUnknown(nodeish).code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('passes an existing DbError through unchanged', () => {
    const original = new DbError('SCHEMA_TOO_NEW', 'too new');
    expect(DbError.fromUnknown(original)).toBe(original);
  });

  it('maps extended constraint codes onto SQLITE_CONSTRAINT', () => {
    // SQLITE_CONSTRAINT_NOTNULL = 19 | (5 << 8)
    expect(mapResultCode(19 | (5 << 8))).toBe('SQLITE_CONSTRAINT');
    expect(mapResultCode(999999)).toBe('SQLITE_ERROR');
  });

  // Issue #98: only the CONSTRAINT family was collapsed onto its primary code, so genuine
  // lock contention arrived as SQLITE_ERROR and `isRetryable` said false for exactly the
  // case §9.2's write queue exists to survive.
  it('collapses every extended family onto its primary code, not just CONSTRAINT', () => {
    expect(mapResultCode(261)).toBe('SQLITE_BUSY'); // SQLITE_BUSY_RECOVERY
    expect(mapResultCode(262)).toBe('SQLITE_LOCKED'); // SQLITE_LOCKED_SHAREDCACHE
    expect(mapResultCode(517)).toBe('SQLITE_BUSY'); // SQLITE_BUSY_SNAPSHOT
    expect(mapResultCode(8 | (5 << 8))).toBe('SQLITE_READONLY'); // SQLITE_READONLY_DBMOVED
    expect(mapResultCode(13 | (3 << 8))).toBe('SQLITE_FULL');
  });

  it('keeps the foreign-key constraint distinguishable from its family', () => {
    expect(mapResultCode(787)).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('reports extended lock contention as retryable', () => {
    expect(new DbError(mapResultCode(261), 'busy').isRetryable).toBe(true);
    expect(new DbError(mapResultCode(262), 'locked').isRetryable).toBe(true);
    // Disk full and read-only are permanent: retrying them only delays the report.
    expect(new DbError(mapResultCode(13), 'full').isRetryable).toBe(false);
    expect(new DbError(mapResultCode(8), 'readonly').isRetryable).toBe(false);
  });
});
