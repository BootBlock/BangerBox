/**
 * A pad's mixer strip survives a save and a reload (spec §4.4, §6, §9.3 — issue #133).
 *
 * The end-to-end shape of the defect, over a fixture in-memory DB: a level, a pan, a send and
 * an insert edited on §8.5.6's Pads tab must each reach the §6 payload the §9.3
 * `programs.payload` column holds, and must come back on the next load. Before the mirror,
 * `flushProgram` serialised a `useProgramStore` nothing ever wrote the strip into, so the
 * save reported success and stored the pad unchanged.
 *
 * The real §4.4 queue is used rather than a direct `flushDirtyKeys` call, because half of
 * what is being pinned is that the mixer commit marks the OWNING PROGRAM dirty — a
 * write-back nothing marks is a write-back nothing saves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelLevelPath, channelPanPath, channelSendPath } from '@/core/audio/params/registry';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memoryDriver';
import { migrations, runMigrations } from '@/core/storage/migrations';
import { createRepositories, type Repositories } from '@/core/storage/repositories';
import { subscribePadStripMirror } from '@/store/derive/padStripMirror';
import { clearUndoHistory } from '@/store';
import { useMixerStore } from '@/store/useMixerStore';
import { useProgramStore } from '@/store/useProgramStore';
import { AutosaveQueue } from './autosave';
import { registerAutosave, unregisterAutosave } from './dirty';
import { hydrateStores } from './hydrate';
import { flushDirtyKeys } from './persist';
import { createDefaultDrumProgram, createDefaultPad, createDefaultSequence, type Pad } from './schemas';

let driver: MemoryDriver;
let repos: Repositories;
let projectId: string;
let programId: string;
let queue: AutosaveQueue;
let dispose: (() => void) | null = null;

/** The pad as the §9.3 `programs.payload` column holds it — what a reload will read. */
async function padOnDisk(): Promise<Pad> {
  const row = await repos.programs.getById(programId);
  if (row === undefined) throw new Error('the fixture program has no row');
  return (JSON.parse(row.payload) as { pads: Pad[] }).pads[0]!;
}

/** `saveNow()` (spec §4.4) — the awaited flush the transport bar's Save button performs. */
const saveNow = (): Promise<unknown> => queue.flushNow();

/** `loadProject()` (spec §4.4) — re-read every row and repopulate the stores. */
const loadProject = (): Promise<void> => hydrateStores(repos, projectId);

beforeEach(async () => {
  driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  repos = createRepositories(driver);
  clearUndoHistory();

  const project = await repos.projects.create({ name: 'Fixture' });
  projectId = project.id;

  const program = { ...createDefaultDrumProgram('Kit'), pads: [createDefaultPad(0)] };
  programId = program.id;
  await repos.programs.create({
    id: program.id,
    project_id: projectId,
    name: program.name,
    type: 'drum',
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

describe('a pad strip survives saveNow() + loadProject() (issue #133)', () => {
  const padChannel = (): string => `pad:${programId}:0`;

  it('publishes a strip for the loaded program, so the Pads tab is live at all', () => {
    // Without this there is nothing for the rest of the file to edit: `resolvePath` finds no
    // strip and `commit` returns before it writes, so every control on the tab is inert.
    expect(useMixerStore.getState().channels[padChannel()]).toBeDefined();
  });

  it('carries a level, a pan, a send and an insert into the §6 payload on disk', async () => {
    const mixer = useMixerStore.getState();
    mixer.commit(channelLevelPath(padChannel()), 0.4);
    mixer.commit(channelPanPath(padChannel()), -0.5);
    mixer.commit(channelSendPath(padChannel(), 1), 0.6);
    mixer.addInsert(padChannel(), 'delay');

    await saveNow();

    const pad = await padOnDisk();
    expect(pad.mixer).toEqual({ level: 0.4, pan: -0.5, sendLevels: [0, 0.6, 0, 0] });
    // An add FILLS the first free slot of the §1.3.1 rack rather than appending past it
    // (issue #135), so the slot it created is the first one.
    expect(pad.inserts[0]).toMatchObject({ effectType: 'delay', enabled: true });
    // §5.7's own default, stated explicitly rather than left to the build (issue #131).
    expect(pad.inserts[0]!.params.time).toBe(350);
  });

  it('reads all four back onto the strip after a reload', async () => {
    const mixer = useMixerStore.getState();
    mixer.commit(channelLevelPath(padChannel()), 0.4);
    mixer.commit(channelPanPath(padChannel()), -0.5);
    mixer.commit(channelSendPath(padChannel(), 1), 0.6);
    mixer.addInsert(padChannel(), 'delay');

    await saveNow();
    await loadProject();

    const strip = useMixerStore.getState().channels[padChannel()];
    expect(strip).toMatchObject({ level: 0.4, pan: -0.5, sendLevels: [0, 0.6, 0, 0] });
    expect(strip?.inserts[0]).toMatchObject({ effectType: 'delay', params: { time: 350 } });
  });

  it('marks the owning PROGRAM dirty, not the project or a track (spec §4.4)', () => {
    useMixerStore.getState().commit(channelLevelPath(padChannel()), 0.4);
    expect(queue.pendingKeys).toEqual([`program:${programId}`]);
  });

  it('needs no §9.2 migration: a project written before the fix loads unchanged', async () => {
    // The strip only ever existed in memory, so nothing on disk is in a shape to correct.
    // The payload is the source the strip is DERIVED from, and every route in — §4.4
    // hydration, a §9.6 import, a §9.8 pack — already reaches it.
    const pad = await padOnDisk();
    expect(pad.mixer).toEqual({ level: 1, pan: 0, sendLevels: [0, 0, 0, 0] });
    await loadProject();
    expect(useMixerStore.getState().channels[padChannel()]).toMatchObject({ level: 1, pan: 0 });
  });

  it('saves an insert REORDER, which reaches the store through a bare upsertChannel', async () => {
    // §8.5.6's Reorder buttons call `upsertChannel`, which marks nothing dirty — so the
    // write-back marks the program itself rather than leaning on the commit that did not
    // happen. Without that, both stores agree in memory and the old order comes back.
    const mixer = useMixerStore.getState();
    mixer.addInsert(padChannel(), 'delay');
    mixer.addInsert(padChannel(), 'filter');
    await saveNow();
    // The two adds filled slots 1 and 2 of the §1.3.1 rack (issue #135); the reorder swaps
    // them, exactly as §8.5.6's Move-earlier button does on the second slot.
    const strip = useMixerStore.getState().channels[padChannel()]!;
    const inserts = [...strip.inserts];
    const [moved] = inserts.splice(1, 1);
    inserts.splice(0, 0, moved!);
    useMixerStore.getState().upsertChannel({ ...strip, inserts });
    expect(queue.pendingKeys).toEqual([`program:${programId}`]);

    await saveNow();
    await loadProject();
    const reloaded = useMixerStore.getState().channels[padChannel()];
    expect(reloaded?.inserts.map((slot) => slot.effectType).slice(0, 2)).toEqual(['filter', 'delay']);
  });

  it('does not disturb a pad the strip never touched', async () => {
    useProgramStore.getState().upsertPad(programId, createDefaultPad(5));
    useMixerStore.getState().commit(channelLevelPath(padChannel()), 0.4);
    await saveNow();
    const row = await repos.programs.getById(programId);
    const pads = (JSON.parse(row!.payload) as { pads: Pad[] }).pads;
    expect(pads.find((pad) => pad.padIndex === 5)?.mixer.level).toBe(1);
  });
});
