import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '@/test/drivers/memoryDriver';
import { DbError } from '../errors';
import type { Migration } from './migration';
import { getUserVersion, runMigrations } from './engine';
import { migrations } from './index';

describe('migration engine', () => {
  it('applies outstanding migrations in order and bumps user_version', async () => {
    const driver = createMemoryDriver();
    const steps: Migration[] = [
      { version: 1, name: 'one', statements: [{ sql: 'CREATE TABLE a (x TEXT);' }] },
      { version: 2, name: 'two', statements: [{ sql: 'CREATE TABLE b (y TEXT);' }] },
    ];

    const report = await runMigrations(driver, steps);
    expect(report).toEqual({ from: 0, to: 2, applied: [1, 2] });
    expect(await getUserVersion(driver)).toBe(2);

    // Idempotent: nothing further to apply.
    const again = await runMigrations(driver, steps);
    expect(again).toEqual({ from: 2, to: 2, applied: [] });
    await driver.close();
  });

  it('rolls a failing migration back atomically and reports INIT_FAILED', async () => {
    const driver = createMemoryDriver();
    const steps: Migration[] = [
      {
        version: 1,
        name: 'broken',
        statements: [{ sql: 'CREATE TABLE a (x TEXT);' }, { sql: 'THIS IS NOT SQL;' }],
      },
    ];

    await expect(runMigrations(driver, steps)).rejects.toMatchObject({
      name: 'DbError',
      code: 'INIT_FAILED',
    });
    // The whole step rolled back: no table, version untouched.
    expect(await getUserVersion(driver)).toBe(0);
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a';",
    );
    expect(tables).toHaveLength(0);
    await driver.close();
  });

  it('refuses to run against a database from a newer build (SCHEMA_TOO_NEW)', async () => {
    const driver = createMemoryDriver();
    await driver.execute('PRAGMA user_version = 99;');
    await expect(runMigrations(driver, [{ version: 1, name: 'one', statements: [] }])).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
    });
    await driver.close();
  });

  it('rejects non-contiguous version sequences as an authoring error', async () => {
    const driver = createMemoryDriver();
    const steps: Migration[] = [
      { version: 1, name: 'one', statements: [] },
      { version: 3, name: 'skipped-two', statements: [] },
    ];
    await expect(runMigrations(driver, steps)).rejects.toBeInstanceOf(DbError);
    await driver.close();
  });
});

describe('v1 DDL (spec §9.3)', () => {
  it('creates every binding table and index', async () => {
    const driver = createMemoryDriver();
    await runMigrations(driver, migrations);

    const names = (
      await driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name;",
      )
    ).map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'projects',
        'sequences',
        'programs',
        'tracks',
        'midi_events',
        'automation_points',
        'samples',
        'sample_tags',
        'song_entries',
        'app_settings',
        'idx_sequences_project',
        'idx_tracks_sequence',
        'idx_midi_events_lookup',
        'idx_automation_lookup',
        'idx_sample_tags_tag',
        'idx_song_entries',
      ]),
    );
    expect(await getUserVersion(driver)).toBe(1);
    await driver.close();
  });

  it('enforces referential integrity and cascade deletes', async () => {
    const driver = createMemoryDriver();
    await runMigrations(driver, migrations);

    const now = Date.now();
    await driver.execute('INSERT INTO projects (id, name, created_at, modified_at) VALUES (?, ?, ?, ?);', [
      'p1',
      'Test',
      now,
      now,
    ]);
    await driver.execute('INSERT INTO sequences (id, project_id, position, name) VALUES (?, ?, ?, ?);', [
      's1',
      'p1',
      0,
      'Sequence 1',
    ]);
    await driver.execute(
      "INSERT INTO tracks (id, sequence_id, position, name, type) VALUES ('t1', 's1', 0, 'Kick', 'drum');",
    );

    // A track referencing a missing sequence must be rejected.
    await expect(
      driver.execute(
        "INSERT INTO tracks (id, sequence_id, position, name, type) VALUES ('t2', 'nope', 0, 'X', 'drum');",
      ),
    ).rejects.toMatchObject({ name: 'DbError' });

    // Deleting the project cascades to sequences and tracks.
    await driver.execute('DELETE FROM projects WHERE id = ?;', ['p1']);
    expect(await driver.query('SELECT id FROM sequences;')).toHaveLength(0);
    expect(await driver.query('SELECT id FROM tracks;')).toHaveLength(0);
    await driver.close();
  });

  it('enforces the binding CHECK constraints', async () => {
    const driver = createMemoryDriver();
    await runMigrations(driver, migrations);

    const now = Date.now();
    await expect(
      driver.execute(
        'INSERT INTO projects (id, name, created_at, modified_at, bit_depth) VALUES (?, ?, ?, ?, ?);',
        ['p1', 'Bad depth', now, now, '48'],
      ),
    ).rejects.toMatchObject({ name: 'DbError' });

    await expect(
      driver.execute(
        "INSERT INTO programs (id, project_id, name, type, payload) VALUES ('pr1', 'missing', 'X', 'granular', '{}');",
      ),
    ).rejects.toMatchObject({ name: 'DbError' });
    await driver.close();
  });
});
