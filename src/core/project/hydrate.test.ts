/**
 * Hydration + autosave-persist round-trip over a fixture in-memory DB (spec §12 Phase 2
 * exit — "hydration test from a fixture DB"). Proves DB → store population (spec §4.4)
 * and store → DB write-behind (spec §4.4) both preserve the model.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memoryDriver';
import { migrations, runMigrations } from '@/core/storage/migrations';
import { createRepositories, type Repositories } from '@/core/storage/repositories';
import {
  channelStripSchema,
  createDefaultChannelStrip,
  createDefaultDrumProgram,
  createDefaultPad,
  createDefaultSequence,
} from './schemas';
import { hydrateStores } from './hydrate';
import { flushDirtyKeys } from './persist';
import { dirtyKey } from './dirty';
import { clearUndoHistory } from '@/store';
import { useMixerStore } from '@/store/useMixerStore';
import { useProgramStore } from '@/store/useProgramStore';
import { useProjectStore } from '@/store/useProjectStore';
import { useSequenceStore } from '@/store/useSequenceStore';
import { useTransportStore } from '@/store/useTransportStore';

let driver: MemoryDriver;
let repos: Repositories;
let projectId: string;
let sequenceId: string;
let trackId: string;
let programId: string;

async function seedProject(): Promise<void> {
  const project = await repos.projects.create({ name: 'Fixture', bpm_default: 96 });
  projectId = project.id;

  const program = createDefaultDrumProgram('Kit');
  program.pads.push(createDefaultPad(0, 'Kick'));
  programId = program.id;
  await repos.programs.create({
    id: program.id,
    project_id: projectId,
    name: program.name,
    type: 'drum',
    payload: JSON.stringify(program),
  });

  const sequence = createDefaultSequence(projectId, 0, 'Seq A');
  sequenceId = sequence.id;
  await repos.sequences.create({
    id: sequence.id,
    project_id: projectId,
    position: 0,
    name: sequence.name,
    length_bars: 4,
    time_sig_numerator: 3,
    time_sig_denominator: 4,
    tempo: 128,
    swing_amount: 58,
    swing_division: 16,
  });

  trackId = crypto.randomUUID();
  const strip = { ...createDefaultChannelStrip(`track:${trackId}`), level: 0.6, pan: -0.25 };
  await repos.tracks.create({
    id: trackId,
    sequence_id: sequenceId,
    program_id: programId,
    position: 0,
    name: 'Drums',
    type: 'drum',
    mixer: JSON.stringify(strip),
  });

  await repos.midiEvents.insertMany([
    { id: 'evt-2', track_id: trackId, tick_start: 480, duration_ticks: 24, note: 38, velocity: 100, extra: null },
    { id: 'evt-1', track_id: trackId, tick_start: 0, duration_ticks: 24, note: 36, velocity: 120, extra: null },
  ]);
  await repos.automation.insertMany([
    { id: 'auto-1', scope: 'track', owner_id: trackId, target_path: `mixer.track:${trackId}.level`, tick: 0, value: 0.5, curve: 'linear' },
  ]);
  await repos.songs.replaceForProject(projectId, [{ sequence_id: sequenceId, repeats: 2 }]);
}

beforeEach(async () => {
  driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  repos = createRepositories(driver);
  clearUndoHistory();
  await seedProject();
});

describe('hydrateStores (spec §4.4)', () => {
  beforeEach(async () => {
    await hydrateStores(repos, projectId);
  });

  it('populates project identity + settings', () => {
    const project = useProjectStore.getState();
    expect(project.projectId).toBe(projectId);
    expect(project.projectName).toBe('Fixture');
    expect(project.modifiedSinceLastSave).toBe(false);
  });

  it('validates and loads programs with their pads', () => {
    const program = useProgramStore.getState().programs[programId];
    expect(program?.type).toBe('drum');
    if (program?.type === 'drum') expect(program.pads.map((p) => p.name)).toEqual(['Kick']);
    expect(useProgramStore.getState().activeProgramId).toBe(programId);
  });

  it('maps sequences, tracks, tick-sorted events, automation lanes and the song playlist', () => {
    const seq = useSequenceStore.getState().sequences[sequenceId];
    expect(seq?.lengthBars).toBe(4);
    expect(seq?.timeSig).toEqual({ numerator: 3, denominator: 4 });
    expect(seq?.tempo).toBe(128);

    expect(useSequenceStore.getState().tracks[trackId]?.name).toBe('Drums');
    expect(useSequenceStore.getState().events[trackId]?.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
    expect(useSequenceStore.getState().automation[`track:${trackId}:mixer.track:${trackId}.level`]).toHaveLength(1);
    expect(useSequenceStore.getState().songEntries).toEqual([
      expect.objectContaining({ sequenceId, repeats: 2, position: 0 }),
    ]);
  });

  it('loads the track mixer strip and a master strip', () => {
    expect(useMixerStore.getState().channels[`track:${trackId}`]?.level).toBe(0.6);
    expect(useMixerStore.getState().channels[`track:${trackId}`]?.pan).toBe(-0.25);
    expect(useMixerStore.getState().channels.master).toBeDefined();
  });

  it('sets the transport from the active sequence', () => {
    expect(useTransportStore.getState().activeSequenceId).toBe(sequenceId);
    expect(useTransportStore.getState().bpm).toBe(128);
    expect(useTransportStore.getState().swingAmount).toBe(58);
  });
});

describe('flushDirtyKeys autosave persistence (spec §4.4)', () => {
  beforeEach(async () => {
    await hydrateStores(repos, projectId);
  });

  it('persists a mixer commit back to the track row', async () => {
    useMixerStore.getState().commit(`track:${trackId}.level`, 0.9);
    await flushDirtyKeys(repos, [dirtyKey.track(trackId)]);
    const row = await repos.tracks.getById(trackId);
    const strip = channelStripSchema.parse(JSON.parse(row!.mixer));
    expect(strip.level).toBe(0.9);
  });

  it('persists the master strip into the project payload', async () => {
    useMixerStore.getState().commit('master.level', 0.4);
    await flushDirtyKeys(repos, [dirtyKey.project(projectId)]);
    const row = await repos.projects.getById(projectId);
    const payload = JSON.parse(row!.payload) as { master?: { level: number } };
    expect(payload.master?.level).toBe(0.4);
  });

  it('creates a brand-new sequence row on first flush (upsert)', async () => {
    const seq = createDefaultSequence(projectId, 1, 'Seq B');
    useSequenceStore.getState().addSequence(seq);
    await flushDirtyKeys(repos, [dirtyKey.sequence(seq.id)]);
    expect(await repos.sequences.getById(seq.id)).toBeDefined();
  });

  it('replaces a track event lane', async () => {
    useSequenceStore.getState().addEvents(trackId, [
      { id: 'evt-3', tickStart: 960, durationTicks: 24, note: 42, velocity: 88, extra: null },
    ]);
    await flushDirtyKeys(repos, [dirtyKey.events(trackId)]);
    const page = await repos.midiEvents.listByTrack(trackId);
    expect(page.rows.map((r) => r.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('deletes a removed sequence on flush', async () => {
    useSequenceStore.getState().removeSequence(sequenceId);
    await flushDirtyKeys(repos, [dirtyKey.sequence(sequenceId)]);
    expect(await repos.sequences.getById(sequenceId)).toBeUndefined();
  });
});
