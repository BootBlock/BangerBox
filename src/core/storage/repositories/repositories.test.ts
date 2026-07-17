/**
 * Repository round-trip tests over the in-memory driver (Phase 1 exit criterion,
 * spec §12; driver seam per §11.3). The real OPFS/worker path is proven by the
 * browser smoke (§11.4) — never here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memoryDriver';
import { migrations, runMigrations } from '../migrations';
import { MAX_PAGE_SIZE } from './base';
import { createRepositories, type Repositories } from './index';

let driver: MemoryDriver;
let repos: Repositories;

beforeEach(async () => {
  driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  repos = createRepositories(driver);
});

async function seedProject(name = 'Test Project') {
  return repos.projects.create({ name });
}

describe('ProjectRepository', () => {
  it('round-trips create → read → update → delete', async () => {
    const created = await repos.projects.create({ name: 'Beat Tape', bpm_default: 92 });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.sample_rate).toBe(48000); // spec §1.3 #18 defaults
    expect(created.bit_depth).toBe('24');
    expect(created.insert_limit).toBe(4);
    expect(created.bpm_default).toBe(92);
    expect(created.payload).toBe('{}');

    const updated = await repos.projects.update(created.id, { name: 'Renamed', bit_depth: '32f' });
    expect(updated.name).toBe('Renamed');
    expect(updated.bit_depth).toBe('32f');
    expect(updated.modified_at).toBeGreaterThanOrEqual(created.modified_at);

    await repos.projects.remove(created.id);
    expect(await repos.projects.getById(created.id)).toBeUndefined();
  });

  it('lists recent projects by modified_at descending with paging', async () => {
    const a = await repos.projects.create({ name: 'A' });
    const b = await repos.projects.create({ name: 'B' });
    await repos.projects.touch(a.id, Date.now() + 1000);

    const page = await repos.projects.listRecent({ limit: 1 });
    expect(page.rows[0]!.name).toBe('A');
    expect(page.hasMore).toBe(true);

    const rest = await repos.projects.listRecent({ limit: 1, offset: 1 });
    expect(rest.rows[0]!.id).toBe(b.id);
  });

  it('clamps requested page sizes to the 200-row ceiling (spec §9.2)', async () => {
    const page = await repos.projects.listRecent({ limit: 10_000 });
    expect(page.limit).toBe(MAX_PAGE_SIZE);
  });
});

describe('SequenceRepository', () => {
  it('round-trips with §9.3 defaults and honours tempo = null semantics', async () => {
    const project = await seedProject();
    const sequence = await repos.sequences.create({
      project_id: project.id,
      position: 0,
      name: 'Sequence 1',
    });
    expect(sequence.length_bars).toBe(2);
    expect(sequence.time_sig_numerator).toBe(4);
    expect(sequence.swing_amount).toBe(50);
    expect(sequence.tempo).toBeNull();

    const withTempo = await repos.sequences.update(sequence.id, { tempo: 174 });
    expect(withTempo.tempo).toBe(174);
    // Explicit null = follow the project default again (spec §7.2).
    const followsProject = await repos.sequences.update(sequence.id, { tempo: null });
    expect(followsProject.tempo).toBeNull();
  });

  it('lists a project in position order', async () => {
    const project = await seedProject();
    await repos.sequences.create({ project_id: project.id, position: 1, name: 'Verse' });
    await repos.sequences.create({ project_id: project.id, position: 0, name: 'Intro' });

    const page = await repos.sequences.listByProject(project.id);
    expect(page.rows.map((row) => row.name)).toEqual(['Intro', 'Verse']);
  });
});

describe('TrackRepository', () => {
  it('round-trips and nulls program_id when the program is deleted (§9.3 SET NULL)', async () => {
    const project = await seedProject();
    const sequence = await repos.sequences.create({
      project_id: project.id,
      position: 0,
      name: 'S1',
    });
    const program = await repos.programs.create({
      project_id: project.id,
      name: 'Drums',
      type: 'drum',
      payload: '{"pads":[]}',
    });
    const track = await repos.tracks.create({
      sequence_id: sequence.id,
      program_id: program.id,
      position: 0,
      name: 'Drum track',
      type: 'drum',
    });
    expect(track.program_id).toBe(program.id);
    expect(track.mixer).toBe('{}');

    await repos.programs.remove(program.id);
    const orphaned = await repos.tracks.getById(track.id);
    expect(orphaned?.program_id).toBeNull();
  });
});

describe('MidiEventRepository', () => {
  it('bulk-inserts, lists in tick order, replaces, and clears', async () => {
    const project = await seedProject();
    const sequence = await repos.sequences.create({
      project_id: project.id,
      position: 0,
      name: 'S1',
    });
    const track = await repos.tracks.create({
      sequence_id: sequence.id,
      position: 0,
      name: 'T1',
      type: 'drum',
    });

    await repos.midiEvents.insertMany([
      { track_id: track.id, tick_start: 960, duration_ticks: 120, note: 36, velocity: 100 },
      { track_id: track.id, tick_start: 0, duration_ticks: 120, note: 38, velocity: 90 },
    ]);

    const page = await repos.midiEvents.listByTrack(track.id);
    expect(page.rows.map((row) => row.tick_start)).toEqual([0, 960]);

    await repos.midiEvents.replaceTrack(track.id, [
      { track_id: track.id, tick_start: 480, duration_ticks: 60, note: 42, velocity: 64 },
    ]);
    const replaced = await repos.midiEvents.listByTrack(track.id);
    expect(replaced.rows).toHaveLength(1);
    expect(replaced.rows[0]!.note).toBe(42);

    await repos.midiEvents.deleteMany([replaced.rows[0]!.id]);
    expect((await repos.midiEvents.listByTrack(track.id)).rows).toHaveLength(0);
  });

  it('cascades away with its track (§9.3 ON DELETE CASCADE)', async () => {
    const project = await seedProject();
    const sequence = await repos.sequences.create({
      project_id: project.id,
      position: 0,
      name: 'S1',
    });
    const track = await repos.tracks.create({
      sequence_id: sequence.id,
      position: 0,
      name: 'T1',
      type: 'drum',
    });
    await repos.midiEvents.insertMany([
      { track_id: track.id, tick_start: 0, duration_ticks: 1, note: 36, velocity: 1 },
    ]);

    await repos.tracks.remove(track.id);
    expect(await driver.query('SELECT id FROM midi_events;')).toHaveLength(0);
  });
});

describe('AutomationRepository', () => {
  it('round-trips lanes per owner/target and replaces atomically', async () => {
    const ownerId = crypto.randomUUID();
    await repos.automation.insertMany([
      { scope: 'sequence', owner_id: ownerId, target_path: 'mixer.master.level', tick: 0, value: 1 },
      {
        scope: 'sequence',
        owner_id: ownerId,
        target_path: 'mixer.master.level',
        tick: 960,
        value: 0.5,
        curve: 'exp',
      },
    ]);

    const lane = await repos.automation.listByOwner('sequence', ownerId);
    expect(lane.rows.map((row) => row.tick)).toEqual([0, 960]);
    expect(lane.rows[1]!.curve).toBe('exp');

    await repos.automation.replaceTarget('sequence', ownerId, 'mixer.master.level', [
      { scope: 'sequence', owner_id: ownerId, target_path: 'mixer.master.level', tick: 240, value: 0.7 },
    ]);
    const replaced = await repos.automation.listByOwner('sequence', ownerId);
    expect(replaced.rows).toHaveLength(1);

    await repos.automation.clearOwner('sequence', ownerId);
    expect((await repos.automation.listByOwner('sequence', ownerId)).rows).toHaveLength(0);
  });
});

describe('ProgramRepository', () => {
  it('round-trips and cascades away with its project', async () => {
    const project = await seedProject();
    const program = await repos.programs.create({
      project_id: project.id,
      name: 'Keys',
      type: 'keygroup',
      payload: '{"zones":[]}',
    });

    const updated = await repos.programs.update(program.id, { payload: '{"zones":[1]}' });
    expect(updated.payload).toBe('{"zones":[1]}');

    const listed = await repos.programs.listByProject(project.id);
    expect(listed.rows).toHaveLength(1);

    await repos.projects.remove(project.id);
    expect(await repos.programs.getById(program.id)).toBeUndefined();
  });
});

describe('SampleRepository', () => {
  it('round-trips metadata, tags, and the global library split', async () => {
    const project = await seedProject();
    const projectSample = await repos.samples.create({
      project_id: project.id,
      name: 'kick.wav',
      opfs_path: `/projects/${project.id}/samples/kick.wav`,
      frames: 48000,
      sample_rate: 48000,
      channels: 1,
    });
    const globalSample = await repos.samples.create({
      name: 'hat.wav',
      opfs_path: '/global_library/hat.wav',
      frames: 24000,
      sample_rate: 48000,
      channels: 2,
      root_note: 72,
    });
    expect(projectSample.root_note).toBe(60);
    expect(globalSample.project_id).toBeNull();

    expect((await repos.samples.listByProject(project.id)).rows.map((r) => r.id)).toEqual([
      projectSample.id,
    ]);
    expect((await repos.samples.listGlobal()).rows.map((r) => r.id)).toEqual([globalSample.id]);

    await repos.samples.setTags(projectSample.id, ['drums', 'imported']);
    expect(await repos.samples.tagsFor(projectSample.id)).toEqual(['drums', 'imported']);
    expect((await repos.samples.listByTag('drums')).rows.map((r) => r.id)).toEqual([
      projectSample.id,
    ]);

    await repos.samples.setTags(projectSample.id, ['one-shot']);
    expect(await repos.samples.tagsFor(projectSample.id)).toEqual(['one-shot']);

    await repos.samples.remove(projectSample.id);
    expect(await driver.query('SELECT * FROM sample_tags;')).toHaveLength(0);
  });

  it('rejects duplicate opfs_path rows (§9.3 UNIQUE)', async () => {
    await repos.samples.create({
      name: 'a.wav',
      opfs_path: '/global_library/a.wav',
      frames: 1,
      sample_rate: 48000,
      channels: 1,
    });
    await expect(
      repos.samples.create({
        name: 'b.wav',
        opfs_path: '/global_library/a.wav',
        frames: 1,
        sample_rate: 48000,
        channels: 1,
      }),
    ).rejects.toMatchObject({ name: 'DbError' });
  });
});

describe('SongRepository', () => {
  it('replaces the playlist atomically, restamping positions from array order', async () => {
    const project = await seedProject();
    const s1 = await repos.sequences.create({ project_id: project.id, position: 0, name: 'A' });
    const s2 = await repos.sequences.create({ project_id: project.id, position: 1, name: 'B' });

    await repos.songs.replaceForProject(project.id, [
      { sequence_id: s1.id, repeats: 2 },
      { sequence_id: s2.id },
    ]);
    let playlist = await repos.songs.listByProject(project.id);
    expect(playlist.map((e) => [e.sequence_id, e.position, e.repeats])).toEqual([
      [s1.id, 0, 2],
      [s2.id, 1, 1],
    ]);

    // Reorder = replace with the new order.
    await repos.songs.replaceForProject(project.id, [
      { sequence_id: s2.id },
      { sequence_id: s1.id },
    ]);
    playlist = await repos.songs.listByProject(project.id);
    expect(playlist.map((e) => e.sequence_id)).toEqual([s2.id, s1.id]);

    // Deleting a referenced sequence cascades its entries away (§9.3).
    await repos.sequences.remove(s2.id);
    playlist = await repos.songs.listByProject(project.id);
    expect(playlist.map((e) => e.sequence_id)).toEqual([s1.id]);
  });
});

describe('SettingsRepository', () => {
  it('gets, upserts, and removes keys', async () => {
    expect(await repos.settings.get('qlink.bindings.pad')).toBeUndefined();
    await repos.settings.set('qlink.bindings.pad', '[1]');
    await repos.settings.set('qlink.bindings.pad', '[2]');
    expect(await repos.settings.get('qlink.bindings.pad')).toBe('[2]');
    await repos.settings.remove('qlink.bindings.pad');
    expect(await repos.settings.get('qlink.bindings.pad')).toBeUndefined();
  });
});
