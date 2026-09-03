/**
 * Tempo and swing persist to the sequence row that owns them (spec §9.3, §7.9 — issue #93).
 *
 * Before this, the transport-bar knobs wrote `useTransportStore.bpm` and nothing else. That
 * field is documented as the *derived mirror* of the active sequence's tempo, so the round
 * trip was broken one way: `sequences.tempo` never moved, autosave was never armed, the
 * unsaved dot never lit, and the next hydrate overwrote the mirror from the untouched row.
 * The user changed the tempo, reloaded, and it was silently back to where it started.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitSwing, commitTempo, setSwingTransient, setTempoTransient } from './tempo';
import { subscribeTransportMirror } from './derive/transportMirror';
import { useProjectStore } from './useProjectStore';
import { useSequenceStore } from './useSequenceStore';
import { useTransportStore } from './useTransportStore';
import { clearUndoHistory, useUndoStore } from './undo';
import { dirtyKey, registerAutosave, unregisterAutosave } from '@/core/project/dirty';
import type { Sequence } from '@/core/project/schemas';

const PROJECT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SEQUENCE_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

function sequence(patch: Partial<Sequence> = {}): Sequence {
  return {
    id: SEQUENCE_ID,
    projectId: PROJECT_ID,
    position: 0,
    name: 'Sequence 1',
    lengthBars: 2,
    timeSig: { numerator: 4, denominator: 4 },
    tempo: null,
    swingAmount: 50,
    swingDivision: 16,
    ...patch,
  };
}

/** Records the keys autosave was told about, which is what "the edit is persisted" means. */
const dirtied: string[] = [];

beforeEach(() => {
  dirtied.length = 0;
  useProjectStore.setState({ projectId: PROJECT_ID, bpmDefault: 120, modifiedSinceLastSave: false });
  useSequenceStore.getState().hydrate({
    sequences: { [SEQUENCE_ID]: sequence() },
    tracks: {},
    events: {},
    automation: {},
    songEntries: [],
  });
  useTransportStore.getState().setActiveSequenceId(SEQUENCE_ID);
  useTransportStore.getState().setBpm(120);
  useTransportStore.getState().setSwing(50, 16);
  clearUndoHistory();
  registerAutosave({ markDirty: (key: string) => dirtied.push(key) } as never, { onDirty: () => undefined });
});

afterEach(() => unregisterAutosave());

describe('tempo and swing reach the sequence row (spec §9.3, issue #93)', () => {
  it('writes the active sequence tempo, not only the transport mirror', () => {
    commitTempo(128);

    expect(useSequenceStore.getState().sequences[SEQUENCE_ID]!.tempo).toBe(128);
    expect(useTransportStore.getState().bpm).toBe(128);
  });

  it('arms autosave against the sequence, so the unsaved dot lights and the edit survives', () => {
    commitTempo(128);
    expect(dirtied).toContain(dirtyKey.sequence(SEQUENCE_ID));
  });

  it('writes the active sequence swing amount and division', () => {
    commitSwing(62, 8);

    const stored = useSequenceStore.getState().sequences[SEQUENCE_ID]!;
    expect(stored.swingAmount).toBe(62);
    expect(stored.swingDivision).toBe(8);
    expect(useTransportStore.getState().swingAmount).toBe(62);
    expect(useTransportStore.getState().swingDivision).toBe(8);
    expect(dirtied).toContain(dirtyKey.sequence(SEQUENCE_ID));
  });

  it('clamps to the §4.1 ranges wherever the value came from', () => {
    commitTempo(9999);
    expect(useSequenceStore.getState().sequences[SEQUENCE_ID]!.tempo).toBe(300);
    commitSwing(1000);
    expect(useSequenceStore.getState().sequences[SEQUENCE_ID]!.swingAmount).toBe(75);
  });

  it('moves the mirror only during a gesture, leaving the row for the commit', () => {
    setTempoTransient(140);
    expect(useTransportStore.getState().bpm).toBe(140);
    expect(useSequenceStore.getState().sequences[SEQUENCE_ID]!.tempo).toBeNull();
    expect(dirtied).toEqual([]);

    setSwingTransient(60);
    expect(useTransportStore.getState().swingAmount).toBe(60);
    expect(useSequenceStore.getState().sequences[SEQUENCE_ID]!.swingAmount).toBe(50);
    expect(dirtied).toEqual([]);
  });

  it('falls back to the project default when no sequence owns the tempo', () => {
    useTransportStore.getState().setActiveSequenceId(null);
    commitTempo(96);

    // §9.3: `sequences.tempo` is nullable and NULL means the project default, so with no
    // sequence to write to the edit belongs on the project row.
    expect(useProjectStore.getState().bpmDefault).toBe(96);
    expect(useTransportStore.getState().bpm).toBe(96);
    expect(dirtied).toContain(dirtyKey.project(PROJECT_ID));
  });
});

describe('the transport mirror follows its source (spec §7.9, issue #93)', () => {
  it('re-derives after an undo, so the readout never contradicts the row', () => {
    const stop = subscribeTransportMirror();
    try {
      commitTempo(128);
      expect(useTransportStore.getState().bpm).toBe(128);

      useUndoStore.getState().undo();

      expect(useSequenceStore.getState().sequences[SEQUENCE_ID]!.tempo).toBeNull();
      expect(useTransportStore.getState().bpm).toBe(120); // the project default again
    } finally {
      stop();
    }
  });

  it('follows the active sequence when the user switches to another one', () => {
    const otherId = 'cccccccc-0000-4000-8000-000000000003';
    useSequenceStore.getState().hydrate({
      sequences: {
        [SEQUENCE_ID]: sequence({ tempo: 90, swingAmount: 54, swingDivision: 16 }),
        [otherId]: sequence({ id: otherId, tempo: 174, swingAmount: 66, swingDivision: 8 }),
      },
      tracks: {},
      events: {},
      automation: {},
      songEntries: [],
    });

    const stop = subscribeTransportMirror();
    try {
      expect(useTransportStore.getState().bpm).toBe(90);
      useTransportStore.getState().setActiveSequenceId(otherId);

      expect(useTransportStore.getState().bpm).toBe(174);
      expect(useTransportStore.getState().swingAmount).toBe(66);
      expect(useTransportStore.getState().swingDivision).toBe(8);
    } finally {
      stop();
    }
  });

  it('unsubscribes cleanly, leaving the stores alone afterwards', () => {
    const stop = subscribeTransportMirror();
    stop();

    useSequenceStore.getState().updateSequence(SEQUENCE_ID, { tempo: 200 });
    expect(useTransportStore.getState().bpm).toBe(120);
  });
});
