/**
 * The sample-assignment seam on the program store — spec §8.5.7, §8.5.5, §6, §4.5.
 *
 * Until this existed no action could put a `sampleId` on a pad layer or a keygroup zone, so
 * every pad in the application was permanently silent (issue #37). The cases that matter are
 * the §6 invariants an assignment must hold by construction: velocity layers that never
 * overlap, a pad that refuses a fifth layer, zones that never hide one another, and one undo
 * entry per assignment rather than one per row touched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultDrumProgram,
  createDefaultKeygroupProgram,
  createDefaultKeygroupZone,
  createDefaultPad,
  DEFAULT_MAX_VELOCITY_LAYERS,
} from '@/core/project/schemas';
import type { DrumProgram, KeygroupProgram } from '@/core/project/schemas';
import { useProgramStore } from './useProgramStore';
import { useUndoStore } from './undo/useUndoStore';

const DRUM_ID = 'drum-1';
const KEYS_ID = 'keys-1';
const PAD = 3;

beforeEach(() => {
  useUndoStore.getState().clearHistory();
  useProgramStore.getState().setPrograms({
    [DRUM_ID]: createDefaultDrumProgram('Kit', DRUM_ID),
    [KEYS_ID]: createDefaultKeygroupProgram('Piano', KEYS_ID),
  });
});

function drum(): DrumProgram {
  const program = useProgramStore.getState().programs[DRUM_ID]!;
  if (program.type !== 'drum') throw new Error('expected a drum program');
  return program;
}

function keys(): KeygroupProgram {
  const program = useProgramStore.getState().programs[KEYS_ID]!;
  if (program.type !== 'keygroup') throw new Error('expected a keygroup program');
  return program;
}

const padNow = () => drum().pads.find((pad) => pad.padIndex === PAD);

describe('addPadLayer (spec §8.5.7, §6)', () => {
  it('creates the pad and gives the first layer the whole velocity span', () => {
    expect(padNow()).toBeUndefined();

    const result = useProgramStore.getState().addPadLayer(DRUM_ID, PAD, 'sample-a');

    expect(result).toEqual({ ok: true });
    expect(padNow()?.layers).toEqual([
      expect.objectContaining({ sampleId: 'sample-a', velocityStart: 0, velocityEnd: 127 }),
    ]);
  });

  it('re-splits the velocity axis so layers never overlap and no velocity is silent', () => {
    const store = useProgramStore.getState();
    store.addPadLayer(DRUM_ID, PAD, 'soft');
    store.addPadLayer(DRUM_ID, PAD, 'medium');
    store.addPadLayer(DRUM_ID, PAD, 'hard');

    const bands = padNow()!.layers.map((layer) => [layer.velocityStart, layer.velocityEnd]);
    expect(bands).toEqual([
      [0, 42],
      [43, 84],
      [85, 127],
    ]);
    // Contiguous and non-overlapping is the §6 rule; stated as an invariant, not as literals.
    for (let i = 1; i < bands.length; i++) expect(bands[i]![0]).toBe(bands[i - 1]![1]! + 1);
  });

  it(`refuses past the default cap of ${DEFAULT_MAX_VELOCITY_LAYERS} layers, saying why`, () => {
    const store = useProgramStore.getState();
    for (let i = 0; i < DEFAULT_MAX_VELOCITY_LAYERS; i++) store.addPadLayer(DRUM_ID, PAD, `s${i}`);

    const result = store.addPadLayer(DRUM_ID, PAD, 'one-too-many');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('velocity layers');
    expect(padNow()!.layers).toHaveLength(DEFAULT_MAX_VELOCITY_LAYERS);
  });

  it('honours a raised cap, since §6 allows maxLayers up to 8', () => {
    const store = useProgramStore.getState();
    for (let i = 0; i < 5; i++) store.addPadLayer(DRUM_ID, PAD, `s${i}`, 8);
    expect(padNow()!.layers).toHaveLength(5);
  });

  it('records exactly one undo entry per assignment, and undo removes the layer', () => {
    useProgramStore.getState().addPadLayer(DRUM_ID, PAD, 'sample-a');

    expect(useUndoStore.getState().undoDepth).toBe(1);
    useUndoStore.getState().undo();
    expect(padNow()).toBeUndefined();
  });

  it('refuses a pad index outside the 128-pad range (spec §1.3.1)', () => {
    expect(useProgramStore.getState().addPadLayer(DRUM_ID, 128, 'sample-a').ok).toBe(false);
    expect(useProgramStore.getState().addPadLayer(DRUM_ID, -1, 'sample-a').ok).toBe(false);
    expect(drum().pads).toHaveLength(0);
  });

  it('refuses a keygroup program, which has zones rather than pads (spec §6)', () => {
    const result = useProgramStore.getState().addPadLayer(KEYS_ID, PAD, 'sample-a');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('keygroup');
  });

  it('leaves the pad untouched when the program is gone', () => {
    expect(useProgramStore.getState().addPadLayer('nope', PAD, 'sample-a').ok).toBe(false);
  });
});

describe('setLayerSample (spec §6)', () => {
  it('repoints one layer and leaves its velocity band alone', () => {
    const store = useProgramStore.getState();
    store.addPadLayer(DRUM_ID, PAD, 'soft');
    store.addPadLayer(DRUM_ID, PAD, 'hard');
    const before = padNow()!.layers.map((layer) => [layer.velocityStart, layer.velocityEnd]);

    expect(store.setLayerSample(DRUM_ID, PAD, 1, 'harder')).toEqual({ ok: true });

    expect(padNow()!.layers.map((layer) => layer.sampleId)).toEqual(['soft', 'harder']);
    expect(padNow()!.layers.map((layer) => [layer.velocityStart, layer.velocityEnd])).toEqual(before);
  });

  it('refuses a layer that does not exist', () => {
    useProgramStore.getState().upsertPad(DRUM_ID, createDefaultPad(PAD));
    const result = useProgramStore.getState().setLayerSample(DRUM_ID, PAD, 0, 'sample-a');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('layer 1');
  });
});

describe('removePadLayer (spec §6)', () => {
  it('closes the band a removed layer leaves, so no velocity goes silent', () => {
    const store = useProgramStore.getState();
    store.addPadLayer(DRUM_ID, PAD, 'soft');
    store.addPadLayer(DRUM_ID, PAD, 'hard'); // bands 0..63 and 64..127

    expect(store.removePadLayer(DRUM_ID, PAD, 1)).toEqual({ ok: true });

    // Plain filtering would leave 64..127 answered by nothing, and the pad silent above
    // half velocity — the very defect assignment exists to prevent.
    expect(padNow()!.layers).toEqual([
      expect.objectContaining({ sampleId: 'soft', velocityStart: 0, velocityEnd: 127 }),
    ]);
  });

  it('grows the layer above when the first one goes', () => {
    const store = useProgramStore.getState();
    store.addPadLayer(DRUM_ID, PAD, 'soft');
    store.addPadLayer(DRUM_ID, PAD, 'hard');

    store.removePadLayer(DRUM_ID, PAD, 0);

    expect(padNow()!.layers).toEqual([
      expect.objectContaining({ sampleId: 'hard', velocityStart: 0, velocityEnd: 127 }),
    ]);
  });

  it('leaves hand-tuned boundaries elsewhere alone', () => {
    const store = useProgramStore.getState();
    for (const id of ['a', 'b', 'c']) store.addPadLayer(DRUM_ID, PAD, id);
    // Hand-move the first boundary, as the spinners and the §8.5.5 range bar allow.
    const pad = padNow()!;
    store.upsertPad(DRUM_ID, {
      ...pad,
      layers: [
        { ...pad.layers[0]!, velocityEnd: 20 },
        { ...pad.layers[1]!, velocityStart: 21 },
        pad.layers[2]!,
      ],
    });

    store.removePadLayer(DRUM_ID, PAD, 2);

    expect(padNow()!.layers.map((layer) => [layer.velocityStart, layer.velocityEnd])).toEqual([
      [0, 20],
      [21, 127],
    ]);
  });

  it('removes the only layer without inventing a band', () => {
    const store = useProgramStore.getState();
    store.addPadLayer(DRUM_ID, PAD, 'only');
    store.removePadLayer(DRUM_ID, PAD, 0);
    expect(padNow()!.layers).toEqual([]);
  });

  it('refuses a layer that does not exist', () => {
    expect(useProgramStore.getState().removePadLayer(DRUM_ID, PAD, 0).ok).toBe(false);
  });
});

describe('addKeygroupZone (spec §8.5.5, §6)', () => {
  it('gives the first zone the whole keyboard, at the sample root note', () => {
    const result = useProgramStore.getState().addKeygroupZone(KEYS_ID, 'sample-a', 48);

    expect(result).toEqual({ ok: true });
    expect(keys().zones).toEqual([
      expect.objectContaining({ sampleId: 'sample-a', rootNote: 48, lowNote: 0, highNote: 127 }),
    ]);
  });

  it('halves the widest zone when the keyboard is fully covered (spec §3.4)', () => {
    const store = useProgramStore.getState();
    store.addKeygroupZone(KEYS_ID, 'low');
    store.addKeygroupZone(KEYS_ID, 'high');

    // A zone added at 0..127 behind an existing one would never sound, since
    // `selectKeygroupZone` returns the FIRST covering zone.
    expect(keys().zones.map((zone) => [zone.lowNote, zone.highNote])).toEqual([
      [0, 63],
      [64, 127],
    ]);
  });

  it('takes the widest uncovered stretch, leaving a hand-mapped multisample alone', () => {
    const store = useProgramStore.getState();
    // A deliberate mapping: two narrow zones with a wide gap between them.
    store.updateProgram(KEYS_ID, (program) =>
      program.type === 'keygroup'
        ? {
            ...program,
            zones: [
              { ...createDefaultKeygroupZone('bass', 36), lowNote: 0, highNote: 11 },
              { ...createDefaultKeygroupZone('lead', 84), lowNote: 100, highNote: 127 },
            ],
          }
        : program,
    );

    store.addKeygroupZone(KEYS_ID, 'middle', 60);

    expect(keys().zones.map((zone) => [zone.sampleId, zone.lowNote, zone.highNote])).toEqual([
      ['bass', 0, 11],
      ['lead', 100, 127],
      ['middle', 12, 99],
    ]);
  });

  it('clamps a root note outside the §6 range rather than storing it', () => {
    useProgramStore.getState().addKeygroupZone(KEYS_ID, 'sample-a', 500);
    expect(keys().zones[0]!.rootNote).toBe(127);
  });

  it('records one undo entry, and undo removes the zone', () => {
    useProgramStore.getState().addKeygroupZone(KEYS_ID, 'sample-a');
    expect(useUndoStore.getState().undoDepth).toBe(1);
    useUndoStore.getState().undo();
    expect(keys().zones).toHaveLength(0);
  });

  it('refuses a drum program, which has pads rather than zones (spec §6)', () => {
    const result = useProgramStore.getState().addKeygroupZone(DRUM_ID, 'sample-a');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('drum');
  });
});

describe('setZoneSample (spec §6)', () => {
  it('repoints one zone and leaves its key range alone', () => {
    const store = useProgramStore.getState();
    store.addKeygroupZone(KEYS_ID, 'low');
    store.addKeygroupZone(KEYS_ID, 'high');

    expect(store.setZoneSample(KEYS_ID, 0, 'lower')).toEqual({ ok: true });

    expect(keys().zones.map((zone) => zone.sampleId)).toEqual(['lower', 'high']);
    expect(keys().zones.map((zone) => [zone.lowNote, zone.highNote])).toEqual([
      [0, 63],
      [64, 127],
    ]);
  });

  it('refuses a zone that does not exist', () => {
    expect(useProgramStore.getState().setZoneSample(KEYS_ID, 0, 'sample-a').ok).toBe(false);
  });
});

describe('removeKeygroupZone (spec §6)', () => {
  it('removes the zone and frees its keys for the next assignment', () => {
    const store = useProgramStore.getState();
    store.addKeygroupZone(KEYS_ID, 'low');
    store.addKeygroupZone(KEYS_ID, 'high'); // 0..63 and 64..127

    expect(store.removeKeygroupZone(KEYS_ID, 0)).toEqual({ ok: true });
    expect(keys().zones.map((zone) => [zone.sampleId, zone.lowNote, zone.highNote])).toEqual([
      ['high', 64, 127],
    ]);

    // The freed 0..63 is now the widest gap, so the next zone takes it rather than
    // halving the surviving one.
    store.addKeygroupZone(KEYS_ID, 'replacement');
    expect(keys().zones.map((zone) => [zone.sampleId, zone.lowNote, zone.highNote])).toEqual([
      ['high', 64, 127],
      ['replacement', 0, 63],
    ]);
  });

  it('records one undo entry, and undo restores the zone', () => {
    useProgramStore.getState().addKeygroupZone(KEYS_ID, 'sample-a');
    useUndoStore.getState().clearHistory();

    useProgramStore.getState().removeKeygroupZone(KEYS_ID, 0);

    expect(useUndoStore.getState().undoDepth).toBe(1);
    useUndoStore.getState().undo();
    expect(keys().zones).toHaveLength(1);
  });

  it('refuses a zone that does not exist', () => {
    expect(useProgramStore.getState().removeKeygroupZone(KEYS_ID, 0).ok).toBe(false);
  });
});
