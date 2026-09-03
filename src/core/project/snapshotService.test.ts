/**
 * `.mpcweb` restore is transactional (spec §9.6: "Import is transactional — a failure mid-way
 * leaves no partial project").
 *
 * Run against the real in-memory SQLite driver (spec §11.3) rather than mocks, because the
 * guarantee under test is the DATABASE's: a rolled-back BEGIN…COMMIT. A mocked driver would
 * only prove that one call was made, not that nothing survived it.
 *
 * The failure is injected as a foreign-key violation on the LAST statements in the batch — a
 * song entry naming a sequence the archive never carried. That is the case the old row-at-a-time
 * restore lost work to: by the time it threw, the project, its programs, sequences, tracks and
 * events were all committed, leaving a project that appears in Main mode's recent list and opens
 * in a state the archive never described.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memoryDriver';
import { createRepositories, type Repositories } from '@/core/storage/repositories';
import { migrations, runMigrations } from '@/core/storage/migrations';
import { dumpSnapshot, restoreSnapshot } from './snapshotService';
import type { ProjectSnapshot } from './mpcweb';

let driver: MemoryDriver;
let repos: Repositories;

beforeEach(async () => {
  driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  repos = createRepositories(driver);
});

const PROJECT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SEQUENCE_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const TRACK_ID = 'cccccccc-0000-4000-8000-000000000003';
const PROGRAM_ID = 'dddddddd-0000-4000-8000-000000000004';
const SAMPLE_ID = 'eeeeeeee-0000-4000-8000-000000000005';

/** A snapshot with one row in every table — enough that a partial restore would be visible. */
function snapshot(): ProjectSnapshot {
  return {
    version: 1,
    project: {
      id: PROJECT_ID,
      name: 'Imported',
      created_at: 1,
      modified_at: 1,
      sample_rate: 48_000,
      bit_depth: '24',
      bpm_default: 92,
      insert_limit: 4,
      payload: '{}',
    },
    programs: [{ id: PROGRAM_ID, project_id: PROJECT_ID, name: 'Program 1', type: 'drum', payload: '{}' }],
    sequences: [
      {
        id: SEQUENCE_ID,
        project_id: PROJECT_ID,
        position: 0,
        name: 'Sequence 1',
        length_bars: 2,
        time_sig_numerator: 4,
        time_sig_denominator: 4,
        tempo: null,
        swing_amount: 50,
        swing_division: 16,
      },
    ],
    tracks: [
      {
        id: TRACK_ID,
        sequence_id: SEQUENCE_ID,
        program_id: PROGRAM_ID,
        position: 0,
        name: 'Track 1',
        type: 'drum',
        mixer: '{}',
      },
    ],
    midiEvents: [
      {
        id: 'ffffffff-0000-4000-8000-000000000006',
        track_id: TRACK_ID,
        tick_start: 0,
        duration_ticks: 96,
        note: 36,
        velocity: 100,
        extra: null,
      },
    ],
    automation: [
      {
        id: 'ffffffff-0000-4000-8000-000000000007',
        scope: 'track',
        owner_id: TRACK_ID,
        target_path: 'mixer.volume',
        tick: 0,
        value: 0.8,
        curve: 'linear',
      },
    ],
    samples: [
      {
        id: SAMPLE_ID,
        project_id: PROJECT_ID,
        name: 'Kick',
        opfs_path: `/projects/${PROJECT_ID}/samples/${SAMPLE_ID}.wav`,
        frames: 1000,
        sample_rate: 48_000,
        channels: 1,
        root_note: 60,
        created_at: 1,
      },
    ],
    songEntries: [
      {
        id: 'ffffffff-0000-4000-8000-000000000008',
        project_id: PROJECT_ID,
        position: 0,
        sequence_id: SEQUENCE_ID,
        repeats: 1,
      },
    ],
  };
}

/** Row counts across every table the restore writes. */
async function counts(): Promise<Record<string, number>> {
  const tables = [
    'projects',
    'programs',
    'sequences',
    'tracks',
    'midi_events',
    'automation_points',
    'samples',
    'song_entries',
  ];
  const result: Record<string, number> = {};
  for (const table of tables) {
    const row = await driver.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`);
    result[table] = row!.n;
  }
  return result;
}

describe('restoreSnapshot (spec §9.6)', () => {
  it('writes every table of a snapshot', async () => {
    await restoreSnapshot(repos, snapshot());

    expect(await counts()).toEqual({
      projects: 1,
      programs: 1,
      sequences: 1,
      tracks: 1,
      midi_events: 1,
      automation_points: 1,
      samples: 1,
      song_entries: 1,
    });
  });

  it('leaves no partial project when a late row fails', async () => {
    const broken = snapshot();
    // The song entry points at a sequence the archive never carried: everything before it
    // inserts cleanly, so only atomicity can keep this out of the database.
    broken.songEntries = [
      {
        id: 'ffffffff-0000-4000-8000-000000000009',
        project_id: PROJECT_ID,
        position: 0,
        sequence_id: 'no-such-sequence',
        repeats: 1,
      },
    ];

    await expect(restoreSnapshot(repos, broken)).rejects.toThrow();

    // Not "the project is unopened" — the rows must not exist at all, or the failed import
    // still shows up in the recent-projects list and opens in a state nothing described.
    expect(await counts()).toEqual({
      projects: 0,
      programs: 0,
      sequences: 0,
      tracks: 0,
      midi_events: 0,
      automation_points: 0,
      samples: 0,
      song_entries: 0,
    });
    expect(await repos.projects.getById(PROJECT_ID)).toBeUndefined();
    expect((await repos.projects.listRecent()).rows).toHaveLength(0);
  });

  it('does not disturb projects already in the database when a restore fails', async () => {
    const existing = await repos.projects.create({ name: 'My Work' });
    const broken = snapshot();
    broken.tracks[0]!.sequence_id = 'no-such-sequence';

    await expect(restoreSnapshot(repos, broken)).rejects.toThrow();

    expect((await repos.projects.listRecent()).rows.map((row) => row.id)).toEqual([existing.id]);
  });

  it('commits the extra global sample rows a shared install rides along (spec §9.8)', async () => {
    const shared = snapshot();
    shared.samples = [];
    const globalPath = '/global_library/content/abc.wav';

    await restoreSnapshot(repos, shared, [
      repos.samples.insertStatement({
        id: SAMPLE_ID,
        project_id: null,
        name: 'Shared Kick',
        opfs_path: globalPath,
        frames: 1000,
        sample_rate: 48_000,
        channels: 1,
      }),
    ]);

    expect(await repos.samples.getGlobalByPath(globalPath)).toBeDefined();
  });

  it('rolls the extra global sample rows back with the rest (spec §9.8)', async () => {
    const broken = snapshot();
    broken.samples = [];
    broken.tracks[0]!.sequence_id = 'no-such-sequence';
    const globalPath = '/global_library/content/def.wav';

    await expect(
      restoreSnapshot(repos, broken, [
        repos.samples.insertStatement({
          id: SAMPLE_ID,
          project_id: null,
          name: 'Shared Kick',
          opfs_path: globalPath,
          frames: 1000,
          sample_rate: 48_000,
          channels: 1,
        }),
      ]),
    ).rejects.toThrow();

    // Committed separately, these rows would outlive the failure and point at files the
    // installer is about to delete.
    expect(await repos.samples.getGlobalByPath(globalPath)).toBeUndefined();
  });
});

/**
 * §9.6: "Every sample referenced by the project ... global-library refs are copied in."
 *
 * `dumpSnapshot` listed `samples WHERE project_id = ?` only, so a project playing §9.8 factory
 * audio — which de-duplicates into `/global_library/` with `project_id = NULL` (§9.1, §9.3) —
 * exported with no sample rows for it and no audio behind them. That archive imported without
 * complaint and played nothing, which is the same silent outcome issue #99 is about, reached
 * from the export side instead of the import side.
 */
describe('dumpSnapshot — global-library audio is copied in (spec §9.6)', () => {
  const GLOBAL_SAMPLE_ID = '11111111-0000-4000-8000-00000000000a';
  const UNUSED_GLOBAL_ID = '22222222-0000-4000-8000-00000000000b';

  async function seedProject(programPayload: string): Promise<void> {
    await repos.projects.create({ id: PROJECT_ID, name: 'Exported' });
    await repos.programs.create({
      id: PROGRAM_ID,
      project_id: PROJECT_ID,
      name: 'Kit',
      type: 'drum',
      payload: programPayload,
    });
  }

  async function seedGlobalSample(id: string): Promise<void> {
    await repos.samples.create({
      id,
      project_id: null,
      name: `global-${id.slice(0, 4)}`,
      opfs_path: `/global_library/${id}.wav`,
      frames: 100,
      sample_rate: 48_000,
      channels: 1,
      root_note: 60,
    });
  }

  it('includes a global sample the programs of the project reference', async () => {
    await seedProject(JSON.stringify({ pads: [{ layers: [{ sampleId: GLOBAL_SAMPLE_ID }] }] }));
    await seedGlobalSample(GLOBAL_SAMPLE_ID);

    const dumped = await dumpSnapshot(repos, PROJECT_ID);
    expect(dumped.samples.map((row) => row.id)).toEqual([GLOBAL_SAMPLE_ID]);
  });

  it('leaves out a global sample nothing in the project plays', async () => {
    await seedProject(JSON.stringify({ pads: [{ layers: [{ sampleId: GLOBAL_SAMPLE_ID }] }] }));
    await seedGlobalSample(GLOBAL_SAMPLE_ID);
    await seedGlobalSample(UNUSED_GLOBAL_ID);

    const dumped = await dumpSnapshot(repos, PROJECT_ID);
    expect(dumped.samples.map((row) => row.id)).toEqual([GLOBAL_SAMPLE_ID]);
  });

  it('lists a project-scoped sample once, never twice', async () => {
    await seedProject(JSON.stringify({ pads: [{ layers: [{ sampleId: SAMPLE_ID }] }] }));
    await repos.samples.create({
      id: SAMPLE_ID,
      project_id: PROJECT_ID,
      name: 'kick',
      opfs_path: `/projects/${PROJECT_ID}/samples/${SAMPLE_ID}.wav`,
      frames: 100,
      sample_rate: 48_000,
      channels: 1,
      root_note: 60,
    });

    const dumped = await dumpSnapshot(repos, PROJECT_ID);
    expect(dumped.samples.map((row) => row.id)).toEqual([SAMPLE_ID]);
  });
});
