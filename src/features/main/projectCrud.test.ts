/**
 * Sequence/track structural operations (issue #40, spec §8.5.1, §8.5.12, §4.5).
 *
 * These cover the rules that live in `projectCrud` rather than in the store actions it
 * calls: that a compound edit is ONE undo entry, that a duplicate is an independent copy
 * rather than a second reference to the same rows, that deleting a sequence takes its
 * dependants with it and never strands the transport, and that a track's mixer strip
 * follows its track in both directions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultDrumProgram, createDefaultSequence, createDefaultTrack } from '@/core/project/schemas';
import { clearUndoHistory, useUndoStore } from '@/store/undo';
import {
  useMixerStore,
  useProgramStore,
  useProjectStore,
  useSequenceStore,
  useTransportStore,
} from '@/store';
import {
  createSequence,
  createTrack,
  deleteSequence,
  deleteTrack,
  duplicateSequence,
  renameSequence,
  setTrackProgram,
  tracksOfSequence,
} from './projectCrud';

const PROJECT_ID = 'project-1';
const PROGRAM = createDefaultDrumProgram('Program 1');

/** A project with one sequence holding one track that has a single note. */
function seedProject(): { sequenceId: string; trackId: string } {
  const sequence = createDefaultSequence(PROJECT_ID, 0, 'Sequence 1');
  const track = createDefaultTrack(sequence.id, PROGRAM.id, 0, 'Track 1');
  useSequenceStore.getState().hydrate({
    sequences: { [sequence.id]: sequence },
    tracks: { [track.id]: track },
    events: {
      [track.id]: [{ id: 'event-1', tickStart: 0, durationTicks: 96, note: 36, velocity: 100, extra: null }],
    },
    automation: {},
    songEntries: [],
  });
  useTransportStore.getState().setActiveSequenceId(sequence.id);
  clearUndoHistory();
  return { sequenceId: sequence.id, trackId: track.id };
}

beforeEach(() => {
  useProjectStore.getState().applyProject({
    projectId: PROJECT_ID,
    projectName: 'Test',
    sampleRate: 48_000,
    bitDepth: '24',
    globalInsertLimit: 4,
  });
  useProgramStore.getState().setPrograms({ [PROGRAM.id]: PROGRAM });
  useProgramStore.getState().setActiveProgram(PROGRAM.id);
  useMixerStore.getState().setChannels({});
  clearUndoHistory();
});

describe('sequences', () => {
  it('creates a sequence, makes it active, and gives it a name no sibling holds', () => {
    seedProject();
    const id = createSequence();

    const { sequences } = useSequenceStore.getState();
    expect(Object.keys(sequences)).toHaveLength(2);
    expect(sequences[id]!.name).toBe('Sequence 2');
    expect(sequences[id]!.projectId).toBe(PROJECT_ID);
    expect(useTransportStore.getState().activeSequenceId).toBe(id);
  });

  it('never reuses a name a sibling already carries', () => {
    seedProject();
    // "Sequence 2" is taken by hand, so the count-based name would collide.
    renameSequence(createSequence(), 'Sequence 2');
    const third = createSequence();
    expect(useSequenceStore.getState().sequences[third]!.name).toBe('Sequence 3');
  });

  it('refuses to create one before a project is open (spec §9.3 foreign keys)', () => {
    seedProject();
    // Main renders before the boot path opens a project; the store reads unloaded until
    // it does. A sequence built then would carry projectId '' and fail its FK on insert.
    useProjectStore.getState().applyProject({
      projectId: '',
      projectName: '',
      sampleRate: 48_000,
      bitDepth: '24',
      globalInsertLimit: 4,
    });

    expect(createSequence()).toBeNull();
    expect(Object.keys(useSequenceStore.getState().sequences)).toHaveLength(1);
  });

  it('refuses to rename a sequence to blank — the name is all Song mode shows', () => {
    const { sequenceId } = seedProject();
    renameSequence(sequenceId, '   ');
    expect(useSequenceStore.getState().sequences[sequenceId]!.name).toBe('Sequence 1');
  });
});

describe('duplicate sequence', () => {
  it('copies the tracks and their notes under fresh ids', () => {
    const { sequenceId, trackId } = seedProject();
    const copyId = duplicateSequence(sequenceId)!;

    const state = useSequenceStore.getState();
    const copiedTracks = tracksOfSequence(state.tracks, copyId);
    expect(copiedTracks).toHaveLength(1);

    const copiedTrack = copiedTracks[0]!;
    expect(copiedTrack.id).not.toBe(trackId);
    expect(copiedTrack.name).toBe('Track 1');
    expect(state.events[copiedTrack.id]).toHaveLength(1);
    // A shared event id would make the two tracks the same rows to the autosave layer.
    expect(state.events[copiedTrack.id]![0]!.id).not.toBe(state.events[trackId]![0]!.id);
    expect(state.sequences[copyId]!.name).toBe('Sequence 1 copy');
  });

  it('gives the copy its own mixer strip', () => {
    const { sequenceId } = seedProject();
    const copyId = duplicateSequence(sequenceId)!;
    const copiedTrack = tracksOfSequence(useSequenceStore.getState().tracks, copyId)[0]!;
    expect(useMixerStore.getState().channels[`track:${copiedTrack.id}`]).toBeDefined();
  });

  it('undoes as a single entry, not one per copied row (spec §4.5)', () => {
    const { sequenceId } = seedProject();
    duplicateSequence(sequenceId);
    expect(useUndoStore.getState().undoDepth).toBe(1);

    useUndoStore.getState().undo();
    expect(Object.keys(useSequenceStore.getState().sequences)).toHaveLength(1);
    expect(Object.keys(useSequenceStore.getState().tracks)).toHaveLength(1);
  });

  it('redo replays every step of the group, not only the last', () => {
    const { sequenceId } = seedProject();
    duplicateSequence(sequenceId);
    useUndoStore.getState().undo();
    useUndoStore.getState().redo();

    const state = useSequenceStore.getState();
    expect(Object.keys(state.sequences)).toHaveLength(2);
    // The sequence AND its track must both come back — coalescing would restore only one.
    expect(Object.keys(state.tracks)).toHaveLength(2);
  });
});

describe('delete sequence', () => {
  it('removes its tracks, their events, and its song entries', () => {
    const { sequenceId, trackId } = seedProject();
    const otherId = createSequence();
    useSequenceStore.getState().setSongEntries([
      { id: 'entry-1', position: 0, sequenceId, repeats: 2 },
      { id: 'entry-2', position: 1, sequenceId: otherId, repeats: 1 },
    ]);

    expect(deleteSequence(sequenceId)).toBe(true);

    const state = useSequenceStore.getState();
    expect(state.sequences[sequenceId]).toBeUndefined();
    expect(state.tracks[trackId]).toBeUndefined();
    expect(state.events[trackId]).toBeUndefined();
    // The surviving entry is renumbered so positions stay dense (spec §9.3).
    expect(state.songEntries).toEqual([{ id: 'entry-2', position: 0, sequenceId: otherId, repeats: 1 }]);
  });

  it('retargets the transport rather than leaving it on a deleted sequence', () => {
    const { sequenceId } = seedProject();
    const otherId = createSequence();
    useTransportStore.getState().setActiveSequenceId(sequenceId);

    deleteSequence(sequenceId);
    expect(useTransportStore.getState().activeSequenceId).toBe(otherId);
  });

  it('refuses to delete the last sequence — every mode addresses the active one', () => {
    const { sequenceId } = seedProject();
    expect(deleteSequence(sequenceId)).toBe(false);
    expect(useSequenceStore.getState().sequences[sequenceId]).toBeDefined();
  });
});

describe('tracks', () => {
  it('adds a track to the sequence with a mixer strip so its fader moves something', () => {
    const { sequenceId } = seedProject();
    const id = createTrack(sequenceId)!;

    const track = useSequenceStore.getState().tracks[id]!;
    expect(track.sequenceId).toBe(sequenceId);
    expect(track.name).toBe('Track 2');
    expect(track.programId).toBe(PROGRAM.id);
    expect(useMixerStore.getState().channels[`track:${id}`]).toBeDefined();
  });

  it('deletes a track with its strip, and undo restores both', () => {
    const { trackId } = seedProject();
    expect(deleteTrack(trackId)).toBe(true);
    expect(useSequenceStore.getState().tracks[trackId]).toBeUndefined();
    expect(useMixerStore.getState().channels[`track:${trackId}`]).toBeUndefined();

    useUndoStore.getState().undo();
    expect(useSequenceStore.getState().tracks[trackId]).toBeDefined();
    // Without the strip the restored track would show a fader wired to nothing.
    expect(useMixerStore.getState().channels[`track:${trackId}`]).toBeDefined();
  });

  it('deletes as one undo entry despite touching the track, its events and its strip', () => {
    const { trackId } = seedProject();
    deleteTrack(trackId);
    expect(useUndoStore.getState().undoDepth).toBe(1);
  });

  it('moves the track type with the program it is pointed at (spec §6)', () => {
    const { trackId } = seedProject();
    setTrackProgram(trackId, null);
    expect(useSequenceStore.getState().tracks[trackId]!.programId).toBeNull();

    setTrackProgram(trackId, PROGRAM.id);
    const track = useSequenceStore.getState().tracks[trackId]!;
    expect(track.programId).toBe(PROGRAM.id);
    expect(track.type).toBe('drum');
  });
});
