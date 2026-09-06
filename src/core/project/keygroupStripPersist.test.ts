/**
 * A keygroup program's §4.2 mixer strip is reachable and it survives a save and a reload
 * (spec §4.4, §6, §9.3 — issue #139).
 *
 * §6 gives a keygroup one program-scope `mixer` and `inserts`, and `resolveKeygroupVoice` has
 * always merged its voices into `pad:<programId>:0` — so those values SOUND, live and
 * in every §9.5 bounce, and nothing could edit them: `padStripsForProgram` published no strip
 * there, so `useMixerStore.commit` found none and returned before it wrote anything, and
 * §8.5.6 rendered no control to press. A control that sounds and cannot be reached is §3.4's
 * mirror image of a dead one.
 *
 * The end-to-end shape over a fixture in-memory DB: a level, a pan, a send and an insert
 * committed on §8.5.6's Pads tab must each reach the §6 payload the §9.3 `programs.payload`
 * column holds, and must come back on the next load. The real §4.4 queue is used rather than
 * a direct `flushDirtyKeys` call, because half of what is being pinned is that the mixer
 * commit marks the OWNING PROGRAM dirty — a write-back nothing marks is one nothing saves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelLevelPath, channelPanPath, channelSendPath } from '@/core/audio/params/registry';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memoryDriver';
import { migrations, runMigrations } from '@/core/storage/migrations';
import { createRepositories, type Repositories } from '@/core/storage/repositories';
import { subscribePadStripMirror } from '@/store/derive/padStripMirror';
import { clearUndoHistory } from '@/store';
import { useMixerStore } from '@/store/useMixerStore';
import { AutosaveQueue } from './autosave';
import { registerAutosave, unregisterAutosave } from './dirty';
import { hydrateStores } from './hydrate';
import { flushDirtyKeys } from './persist';
import { createDefaultKeygroupProgram, createDefaultSequence, type KeygroupProgram } from './schemas';

let driver: MemoryDriver;
let repos: Repositories;
let projectId: string;
let programId: string;
let queue: AutosaveQueue;
let dispose: (() => void) | null = null;

/** The program as the §9.3 `programs.payload` column holds it — what a reload will read. */
async function programOnDisk(): Promise<KeygroupProgram> {
  const row = await repos.programs.getById(programId);
  if (row === undefined) throw new Error('the fixture program has no row');
  return JSON.parse(row.payload) as KeygroupProgram;
}

/** `saveNow()` (spec §4.4) — the awaited flush the transport bar's Save button performs. */
const saveNow = (): Promise<unknown> => queue.flushNow();

/** `loadProject()` (spec §4.4) — re-read every row and repopulate the stores. */
const loadProject = (): Promise<void> => hydrateStores(repos, projectId);

/** The §4.2 channel a keygroup's program-scope mixer answers to (spec §4.2). */
const keygroupChannel = (): string => `pad:${programId}:0`;

beforeEach(async () => {
  driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  repos = createRepositories(driver);
  clearUndoHistory();

  const project = await repos.projects.create({ name: 'Fixture' });
  projectId = project.id;

  const program = createDefaultKeygroupProgram('Bass');
  programId = program.id;
  await repos.programs.create({
    id: program.id,
    project_id: projectId,
    name: program.name,
    type: 'keygroup',
    payload: JSON.stringify(program),
  });

  const sequence = createDefaultSequence(projectId, 0, 'Seq A');
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

  await hydrateStores(repos, projectId);
  queue = new AutosaveQueue({ flush: (keys) => flushDirtyKeys(repos, keys) });
  registerAutosave(queue, { onDirty: () => {} });
  dispose = subscribePadStripMirror();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  unregisterAutosave();
  queue.dispose();
});

describe('a keygroup’s program-scope strip survives saveNow() + loadProject() (issue #139)', () => {
  it('publishes a strip for the loaded keygroup, so the Pads tab is live at all', () => {
    // Without this there is nothing for the rest of the file to edit: `resolvePath` finds no
    // strip and `commit` returns before it writes, so every control on the tab is inert
    // while `ensureProgramChannel` goes on sounding the payload's values.
    expect(useMixerStore.getState().channels[keygroupChannel()]).toBeDefined();
  });

  it('carries a level, a pan, a send and an insert into the §6 payload on disk', async () => {
    const mixer = useMixerStore.getState();
    mixer.commit(channelLevelPath(keygroupChannel()), 0.4);
    mixer.commit(channelPanPath(keygroupChannel()), -0.5);
    mixer.commit(channelSendPath(keygroupChannel(), 1), 0.6);
    mixer.addInsert(keygroupChannel(), 'delay');

    await saveNow();

    const program = await programOnDisk();
    expect(program.mixer).toEqual({ level: 0.4, pan: -0.5, sendLevels: [0, 0.6, 0, 0] });
    // An add FILLS the first free slot of the §1.3.1 rack rather than appending past it
    // (issue #135), so the slot it created is the first one.
    expect(program.inserts[0]).toMatchObject({ effectType: 'delay', enabled: true });
    // §5.7's own default, stated explicitly rather than left to the build (issue #131).
    expect(program.inserts[0]!.params.time).toBe(350);
  });

  it('reads all four back onto the strip after a reload', async () => {
    const mixer = useMixerStore.getState();
    mixer.commit(channelLevelPath(keygroupChannel()), 0.4);
    mixer.commit(channelPanPath(keygroupChannel()), -0.5);
    mixer.commit(channelSendPath(keygroupChannel(), 1), 0.6);
    mixer.addInsert(keygroupChannel(), 'delay');

    await saveNow();
    await loadProject();

    const strip = useMixerStore.getState().channels[keygroupChannel()];
    expect(strip).toMatchObject({ level: 0.4, pan: -0.5, sendLevels: [0, 0.6, 0, 0] });
    expect(strip?.inserts[0]).toMatchObject({ effectType: 'delay', params: { time: 350 } });
  });

  it('keeps the rest of the §6 keygroup payload intact through the round trip', async () => {
    // The write-back names two members of a record that carries eleven, so the guard is that
    // it moves those two and nothing else — a keygroup's zones are the whole instrument.
    const before = await programOnDisk();
    useMixerStore.getState().commit(channelLevelPath(keygroupChannel()), 0.4);
    await saveNow();
    const after = await programOnDisk();
    expect({ ...after, mixer: before.mixer }).toEqual(before);
  });

  it('marks the owning PROGRAM dirty, not the project or a track (spec §4.4)', () => {
    useMixerStore.getState().commit(channelLevelPath(keygroupChannel()), 0.4);
    expect(queue.pendingKeys).toEqual([`program:${programId}`]);
  });

  it('needs no §9.2 migration: a project written before the fix loads unchanged', async () => {
    // The strip only ever existed in memory — for a keygroup it never existed at all — so
    // nothing on disk is in a shape to correct. The payload is the source the strip is
    // DERIVED from, and every route in already reaches it.
    const program = await programOnDisk();
    expect(program.mixer).toEqual({ level: 1, pan: 0, sendLevels: [0, 0, 0, 0] });
    await loadProject();
    expect(useMixerStore.getState().channels[keygroupChannel()]).toMatchObject({ level: 1, pan: 0 });
  });
});
