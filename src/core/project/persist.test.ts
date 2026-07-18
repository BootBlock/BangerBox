/**
 * Autosave flush layer (spec §4.4) over a fixture in-memory DB.
 *
 * `hydrate.test.ts` covers the project/sequence/track/events round-trip incidentally; this
 * file covers the paths it does not — program, automation, song and settings — and the
 * flush contract itself: resolving means written, so a key no flush path can handle must
 * reject rather than let the queue clear the unsaved dot (issue #72).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memoryDriver';
import { migrations, runMigrations } from '@/core/storage/migrations';
import { createRepositories, type Repositories } from '@/core/storage/repositories';
import { clearUndoHistory } from '@/store';
import { useHardwareStore } from '@/store/useHardwareStore';
import { useProgramStore } from '@/store/useProgramStore';
import { useProjectStore } from '@/store/useProjectStore';
import { useSequenceStore } from '@/store/useSequenceStore';
import { UnflushableKeyError } from './autosave';
import { dirtyKey } from './dirty';
import { hydrateStores } from './hydrate';
import { flushDirtyKeys } from './persist';
import { createDefaultDrumProgram, createDefaultSequence } from './schemas';

let driver: MemoryDriver;
let repos: Repositories;
let projectId: string;
let sequenceId: string;
let trackId: string;

beforeEach(async () => {
  driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  repos = createRepositories(driver);
  clearUndoHistory();

  const project = await repos.projects.create({ name: 'Fixture' });
  projectId = project.id;

  const program = createDefaultDrumProgram('Kit');
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
    length_bars: sequence.lengthBars,
    time_sig_numerator: sequence.timeSig.numerator,
    time_sig_denominator: sequence.timeSig.denominator,
    tempo: sequence.tempo,
    swing_amount: sequence.swingAmount,
    swing_division: sequence.swingDivision,
  });

  trackId = crypto.randomUUID();
  await repos.tracks.create({
    id: trackId,
    sequence_id: sequenceId,
    program_id: program.id,
    position: 0,
    name: 'Drums',
    type: 'drum',
    mixer: '{}',
  });

  await hydrateStores(repos, projectId);
});

describe('flushDirtyKeys — previously untested kinds (spec §4.4)', () => {
  it('creates a brand-new program row on first flush', async () => {
    const program = createDefaultDrumProgram('Bass');
    useProgramStore.getState().addProgram(program);
    await flushDirtyKeys(repos, [dirtyKey.program(program.id)]);
    const row = await repos.programs.getById(program.id);
    expect(row?.name).toBe('Bass');
  });

  it('deletes a removed program on flush', async () => {
    const id = useProgramStore.getState().activeProgramId!;
    useProgramStore.getState().removeProgram(id);
    await flushDirtyKeys(repos, [dirtyKey.program(id)]);
    expect(await repos.programs.getById(id)).toBeUndefined();
  });

  it('replaces an automation lane', async () => {
    const targetPath = `mixer.track:${trackId}.level`;
    useSequenceStore
      .getState()
      .setAutomationLane('track', trackId, targetPath, [
        { id: 'pt-1', scope: 'track', ownerId: trackId, targetPath, tick: 0, value: 0.25, curve: 'linear' },
      ]);
    await flushDirtyKeys(repos, [dirtyKey.automation('track', trackId, targetPath)]);
    const page = await repos.automation.listByOwner('track', trackId);
    expect(page.rows.map((row) => row.value)).toEqual([0.25]);
  });

  it('replaces the song playlist', async () => {
    useSequenceStore.getState().setSongEntries([{ id: 'song-1', sequenceId, repeats: 3, position: 0 }]);
    await flushDirtyKeys(repos, [dirtyKey.song(projectId)]);
    const rows = await repos.songs.listByProject(projectId);
    expect(rows.map((row) => row.repeats)).toEqual([3]);
  });

  it('writes Q-Link bindings under their per-mode settings key', async () => {
    useHardwareStore.getState().upsertBinding({ encoderIndex: 0, targetPath: 'mixer.master.level' });
    await flushDirtyKeys(repos, [dirtyKey.settings('qlink:screen')]);
    const stored = await repos.settings.get('qlink:screen');
    expect(JSON.parse(stored!)).toEqual([{ encoderIndex: 0, targetPath: 'mixer.master.level' }]);
  });
});

describe('flushDirtyKeys — keys it cannot write (issue #72)', () => {
  it('rejects an unknown dirty-key kind instead of reporting success', async () => {
    await expect(flushDirtyKeys(repos, ['nonsense:1'])).rejects.toBeInstanceOf(UnflushableKeyError);
  });

  it('rejects a settings key with no flush path', async () => {
    await expect(flushDirtyKeys(repos, ['settings:theme'])).rejects.toBeInstanceOf(UnflushableKeyError);
  });

  it('rejects a project key that is no longer the active project', async () => {
    await expect(flushDirtyKeys(repos, [dirtyKey.project('some-other-project')])).rejects.toBeInstanceOf(
      UnflushableKeyError,
    );
  });

  it('names every unwritable key in one error', async () => {
    const error = await flushDirtyKeys(repos, ['settings:theme', 'nonsense:1']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnflushableKeyError);
    // Reported in the batch's flush order: known kinds rank ahead of unknown ones.
    expect((error as UnflushableKeyError).keys).toEqual(['settings:theme', 'nonsense:1']);
  });

  it('still writes the writable keys in a batch that also contains an unwritable one', async () => {
    useSequenceStore.getState().updateSequence(sequenceId, { name: 'Renamed' });
    await expect(
      flushDirtyKeys(repos, [dirtyKey.sequence(sequenceId), 'settings:theme']),
    ).rejects.toBeInstanceOf(UnflushableKeyError);
    expect((await repos.sequences.getById(sequenceId))?.name).toBe('Renamed');
  });

  it('leaves the project marked modified when a key cannot be written', async () => {
    useProjectStore.getState().setModified(true);
    await flushDirtyKeys(repos, ['settings:theme']).catch(() => undefined);
    expect(useProjectStore.getState().modifiedSinceLastSave).toBe(true);
  });
});
