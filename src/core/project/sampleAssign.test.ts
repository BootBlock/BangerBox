/**
 * Chop-slice assignment — spec §8.5.4 "slices assign to pads or new program".
 *
 * `chopSampleToNewSamples` wrote the slice rows and assigned none of them, so a chopped break
 * produced audio no pad could reach (issue #37). These cover the two destinations and the
 * §4.5 grouping: the user chopped once, so one Ctrl+Z puts the programs back as they were.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SampleRow } from '@/core/storage/repositories';
import { createDefaultDrumProgram, createDefaultKeygroupProgram } from './schemas';
import type { DrumProgram } from './schemas';
import { useProgramStore, useUIStore } from '@/store';
import { useUndoStore } from '@/store/undo/useUndoStore';
import { assignSlicesToPads, createProgramFromSlices } from './sampleAssign';

const PROGRAM_ID = 'kit-1';

function slice(index: number): SampleRow {
  return {
    id: `slice-${index}`,
    project_id: 'project-a',
    name: `Break chop ${index + 1}`,
    opfs_path: `/projects/project-a/samples/slice-${index}.wav`,
    frames: 4_800,
    sample_rate: 48_000,
    channels: 1,
    root_note: 60,
    created_at: 0,
  };
}

const SLICES = [slice(0), slice(1), slice(2)];

function programNow(id: string): DrumProgram {
  const program = useProgramStore.getState().programs[id]!;
  if (program.type !== 'drum') throw new Error('expected a drum program');
  return program;
}

beforeEach(() => {
  useUndoStore.getState().clearHistory();
  useUIStore.setState({ toasts: [] });
  useProgramStore.getState().setPrograms({ [PROGRAM_ID]: createDefaultDrumProgram('Kit', PROGRAM_ID) });
  useProgramStore.getState().setActiveProgram(PROGRAM_ID);
});

describe('assignSlicesToPads (spec §8.5.4)', () => {
  it('lays the slices out on consecutive pads from the start index', () => {
    expect(assignSlicesToPads(PROGRAM_ID, 4, SLICES)).toBe(3);

    const pads = programNow(PROGRAM_ID).pads;
    expect(pads.map((pad) => pad.padIndex)).toEqual([4, 5, 6]);
    expect(pads.map((pad) => pad.layers[0]?.sampleId)).toEqual(['slice-0', 'slice-1', 'slice-2']);
    // Each slice is the whole of its pad, so every velocity sounds it (spec §6).
    for (const pad of pads) {
      expect(pad.layers).toHaveLength(1);
      expect(pad.layers[0]).toMatchObject({ velocityStart: 0, velocityEnd: 127 });
    }
  });

  it('replaces a pad rather than stacking under it — a chop is one sound divided', () => {
    useProgramStore.getState().addPadLayer(PROGRAM_ID, 0, 'previous');
    assignSlicesToPads(PROGRAM_ID, 0, SLICES);

    expect(programNow(PROGRAM_ID).pads[0]!.layers.map((layer) => layer.sampleId)).toEqual(['slice-0']);
  });

  it('is one undo entry for the whole chop (spec §4.5)', () => {
    assignSlicesToPads(PROGRAM_ID, 0, SLICES);

    expect(useUndoStore.getState().undoDepth).toBe(1);
    useUndoStore.getState().undo();
    expect(programNow(PROGRAM_ID).pads).toHaveLength(0);
  });

  it('drops slices that would run past pad 128, and says how many landed', () => {
    expect(assignSlicesToPads(PROGRAM_ID, 126, SLICES)).toBe(2);
    expect(programNow(PROGRAM_ID).pads.map((pad) => pad.padIndex)).toEqual([126, 127]);
    expect(useUIStore.getState().toasts.at(-1)?.message).toContain('2 of 3');
  });

  it('assigns nothing to a keygroup program, and says so', () => {
    useProgramStore.getState().addProgram(createDefaultKeygroupProgram('Piano', 'keys-1'));

    expect(assignSlicesToPads('keys-1', 0, SLICES)).toBe(0);
    expect(useUIStore.getState().toasts.at(-1)?.message).toContain('drum program');
  });
});

describe('createProgramFromSlices (spec §8.5.4)', () => {
  it('builds a drum program whose pads are the slices in order, and opens it', () => {
    const id = createProgramFromSlices('Break chop', SLICES);

    expect(id).not.toBeNull();
    const program = programNow(id!);
    expect(program.name).toBe('Break chop');
    expect(program.pads.map((pad) => pad.padIndex)).toEqual([0, 1, 2]);
    expect(program.pads.map((pad) => pad.layers[0]?.sampleId)).toEqual(['slice-0', 'slice-1', 'slice-2']);
    // Naming each pad after its slice is what makes the grid readable afterwards.
    expect(program.pads.map((pad) => pad.name)).toEqual(SLICES.map((row) => row.name));
    expect(useProgramStore.getState().activeProgramId).toBe(id);
  });

  it('is one undo entry, because the program is assembled before it reaches the store', () => {
    createProgramFromSlices('Break chop', SLICES);
    expect(useUndoStore.getState().undoDepth).toBe(1);
  });

  it('builds nothing from no slices', () => {
    expect(createProgramFromSlices('Break chop', [])).toBeNull();
  });
});
