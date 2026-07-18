/**
 * Program-scope transient/commit channel — spec §4.1. Pad-mode Q-Link encoders address
 * §6 sound-design leaves (spec §10.3), and a turning encoder must stream values without
 * flooding the undo stack, exactly like a fader drag: `setPadParamTransient` during the
 * turn, one `commitPadParam` when it settles (spec §4.1, §3.3).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { programParamPath } from '@/core/audio/params/registry';
import { createDefaultDrumProgram, createDefaultPad } from '@/core/project/schemas';
import { useProgramStore } from './useProgramStore';
import { useUndoStore } from './undo/useUndoStore';

const PROGRAM_ID = 'prog-1';
const PAD_INDEX = 3;
const path = (param: string) => programParamPath(PROGRAM_ID, PAD_INDEX, param);

function seed() {
  useUndoStore.getState().clearHistory();
  const program = createDefaultDrumProgram('Kit', PROGRAM_ID);
  useProgramStore.getState().setPrograms({
    [PROGRAM_ID]: { ...program, pads: [createDefaultPad(PAD_INDEX)] },
  });
}

const padNow = () => {
  const program = useProgramStore.getState().programs[PROGRAM_ID]!;
  if (program.type !== 'drum') throw new Error('expected a drum program');
  return program.pads.find((pad) => pad.padIndex === PAD_INDEX)!;
};

describe('program parameter transient channel (spec §4.1, §10.3)', () => {
  beforeEach(seed);

  it('writes the filter cutoff without an undo entry', () => {
    useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), 4_000);
    expect(padNow().filter.cutoff).toBe(4_000);
    expect(useUndoStore.getState().undoDepth).toBe(0);
  });

  it('writes the filter resonance', () => {
    useProgramStore.getState().setPadParamTransient(path('filter.resonance'), 8);
    expect(padNow().filter.resonance).toBe(8);
  });

  it('writes the amp envelope attack and release', () => {
    useProgramStore.getState().setPadParamTransient(path('amp.attack'), 250);
    useProgramStore.getState().setPadParamTransient(path('amp.release'), 900);
    expect(padNow().envelopes.amp.attack).toBe(250);
    expect(padNow().envelopes.amp.release).toBe(900);
  });

  it('applies pitch to every layer as the pad tune (spec §5.5 "pad tune")', () => {
    const pad = padNow();
    useProgramStore.getState().upsertPad(PROGRAM_ID, {
      ...pad,
      layers: [
        { ...createDefaultPad(PAD_INDEX).layers[0]!, sampleId: 'a' },
        { ...createDefaultPad(PAD_INDEX).layers[0]!, sampleId: 'b' },
      ],
    });
    useProgramStore.getState().setPadParamTransient(path('pitch'), 7);
    expect(padNow().layers.map((layer) => layer.tuneSemitones)).toEqual([7, 7]);
  });

  it('clamps into the registered range (spec §7.8)', () => {
    useProgramStore.getState().setPadParamTransient(path('filter.resonance'), 999);
    expect(padNow().filter.resonance).toBe(20);
  });

  it('ignores an unregistered leaf', () => {
    const before = padNow();
    useProgramStore.getState().setPadParamTransient(path('nonsense'), 1);
    expect(padNow()).toEqual(before);
  });

  it('ignores an address for a pad that is not assigned', () => {
    expect(() =>
      useProgramStore.getState().setPadParamTransient(programParamPath(PROGRAM_ID, 99, 'pitch'), 3),
    ).not.toThrow();
  });

  it('ignores a mixer address', () => {
    const before = padNow();
    useProgramStore.getState().setPadParamTransient('mixer.master.level', 0.5);
    expect(padNow()).toEqual(before);
  });
});

describe('program parameter commit (spec §4.1, §3.3)', () => {
  beforeEach(seed);

  it('records exactly one undo entry for a whole gesture', () => {
    for (const value of [1_000, 2_000, 3_000]) {
      useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), value);
    }
    useProgramStore.getState().commitPadParam(path('filter.cutoff'), 3_000);
    expect(useUndoStore.getState().undoDepth).toBe(1);
  });

  it('undoes back to the value from before the gesture began', () => {
    const original = padNow().filter.cutoff;
    useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), 1_000);
    useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), 2_000);
    useProgramStore.getState().commitPadParam(path('filter.cutoff'), 2_000);
    useUndoStore.getState().undo();
    expect(padNow().filter.cutoff).toBe(original);
  });

  it('redoes to the committed value', () => {
    useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), 5_000);
    useProgramStore.getState().commitPadParam(path('filter.cutoff'), 5_000);
    useUndoStore.getState().undo();
    useUndoStore.getState().redo();
    expect(padNow().filter.cutoff).toBe(5_000);
  });

  it('keeps two separate gestures as two undo entries', () => {
    useProgramStore.getState().commitPadParam(path('filter.cutoff'), 1_000);
    useProgramStore.getState().commitPadParam(path('filter.cutoff'), 2_000);
    expect(useUndoStore.getState().undoDepth).toBe(2);
  });
});
