/**
 * Program-scope transient/commit channel — spec §4.1. Pad-mode Q-Link encoders address
 * §6 sound-design leaves (spec §10.3), and a turning encoder must stream values without
 * flooding the undo stack, exactly like a fader drag: `setPadParamTransient` during the
 * turn, one `commitPadParam` when it settles (spec §4.1, §3.3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { programParamPath } from '@/core/audio/params/registry';
import { createDefaultDrumProgram, createDefaultPad } from '@/core/project/schemas';
import { useProgramStore } from './useProgramStore';
import { resetTransientChannel, subscribeTransientChannel } from './transientChannel';
import { useUndoStore } from './undo/useUndoStore';

const PROGRAM_ID = 'prog-1';
const PAD_INDEX = 3;
const path = (param: string) => programParamPath(PROGRAM_ID, PAD_INDEX, param);

/**
 * What the §4.1 transient channel published (issue #27).
 *
 * A turning encoder is a §3.3 continuous value, so it reaches the graph through the channel
 * and never writes `programs` — a map six modes select whole, which is why a `set()` per CC
 * frame re-rendered all of them to move one filter cutoff.
 */
let published: { path: string; value: number }[] = [];
let unsubscribe: (() => void) | null = null;
/** The last value published for `path`, or undefined when the address reached nothing. */
const publishedFor = (target: string) => published.filter((entry) => entry.path === target).at(-1)?.value;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  resetTransientChannel();
});

function seed() {
  published = [];
  resetTransientChannel();
  unsubscribe?.();
  unsubscribe = subscribeTransientChannel((target, value) => published.push({ path: target, value }));
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

  it('publishes the filter cutoff without an undo entry', () => {
    useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), 4_000);
    expect(publishedFor(path('filter.cutoff'))).toBe(4_000);
    expect(useUndoStore.getState().undoDepth).toBe(0);
  });

  it('publishes the filter resonance', () => {
    useProgramStore.getState().setPadParamTransient(path('filter.resonance'), 8);
    expect(publishedFor(path('filter.resonance'))).toBe(8);
  });

  it('publishes the amp envelope attack and release', () => {
    useProgramStore.getState().setPadParamTransient(path('amp.attack'), 250);
    useProgramStore.getState().setPadParamTransient(path('amp.release'), 900);
    expect(publishedFor(path('amp.attack'))).toBe(250);
    expect(publishedFor(path('amp.release'))).toBe(900);
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
    expect(publishedFor(path('pitch'))).toBe(7);
    // The pad tune reaches every layer at the COMMIT — one address, applied per §5.5 to the
    // whole pad — where it is one undo entry rather than one per pointer sample.
    useProgramStore.getState().commitPadParam(path('pitch'), 7);
    expect(padNow().layers.map((layer) => layer.tuneSemitones)).toEqual([7, 7]);
  });

  it('clamps into the registered range (spec §7.8)', () => {
    useProgramStore.getState().setPadParamTransient(path('filter.resonance'), 999);
    expect(publishedFor(path('filter.resonance'))).toBe(20);
  });

  it('ignores an unregistered leaf', () => {
    const before = padNow();
    useProgramStore.getState().setPadParamTransient(path('nonsense'), 1);
    expect(published).toEqual([]);
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
    expect(published).toEqual([]);
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

/**
 * Issue #27 and spec §3.3: `programs` is selected whole by `MainMode`, `MixerMode`,
 * `MutingMode`, `GridMode`, `PadPerformMode` and `ProgramEditPanel`, so a `set()` per CC
 * frame re-rendered six modes' worth of subscribers to move one parameter.
 */
describe('a gesture never re-renders a React consumer (spec §3.3, issue #27)', () => {
  beforeEach(seed);

  it('leaves the programs map identical through a whole turn', () => {
    const before = useProgramStore.getState().programs;
    for (let frame = 0; frame < 60; frame += 1) {
      useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), 1_000 + frame);
    }
    expect(useProgramStore.getState().programs).toBe(before);
  });

  it('notifies no store subscriber during the turn, and once at the commit', () => {
    let notifications = 0;
    const stop = useProgramStore.subscribe(
      (state) => state.programs,
      () => {
        notifications += 1;
      },
    );
    for (let frame = 0; frame < 60; frame += 1) {
      useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), 1_000 + frame);
    }
    expect(notifications).toBe(0);
    useProgramStore.getState().commitPadParam(path('filter.cutoff'), 2_000);
    expect(notifications).toBe(1);
    stop();
  });

  it('publishes the COMMITTED value, not merely the last one the gesture sent', () => {
    useProgramStore.getState().setPadParamTransient(path('filter.cutoff'), 1_000);
    useProgramStore.getState().commitPadParam(path('filter.cutoff'), 9_000);
    expect(published.at(-1)).toEqual({ path: path('filter.cutoff'), value: 9_000 });
  });
});
