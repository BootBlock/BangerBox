/**
 * What a Program Edit deletion takes, in the user's terms (spec §6, issue #54).
 *
 * A confirmation that only says "this cannot be undone" is ceremony: the user knows what they
 * pressed, and the question they cannot answer is how much is inside. These pin the counting,
 * so the wording is asserted without rendering a program editor (spec §2.5).
 */
import { describe, expect, it } from 'vitest';
import {
  createDefaultDrumProgram,
  createDefaultKeygroupProgram,
  createDefaultPad,
  type DrumProgram,
  type KeygroupZone,
  type VelocityLayer,
} from '@/core/project/schemas';
import { describePadContents, describeProgramContents } from './destructive';

const layer = (sampleId: string): VelocityLayer => ({
  ...createDefaultPad(0).layers[0]!,
  sampleId,
});

function drumWith(padSpecs: readonly { index: number; layers: number; routes?: number }[]): DrumProgram {
  const program = createDefaultDrumProgram('Kit', 'prog-1');
  return {
    ...program,
    pads: padSpecs.map((spec) => ({
      ...createDefaultPad(spec.index),
      layers: Array.from({ length: spec.layers }, (_, i) => layer(`sample-${spec.index}-${i}`)),
      modMatrix: Array.from({ length: spec.routes ?? 0 }, () => ({
        source: 'lfo1' as const,
        target: 'pitch' as const,
        amount: 0.5,
      })),
    })),
  };
}

describe('describeProgramContents (spec §6)', () => {
  it('counts the assigned pads and the sample assignments under them', () => {
    const program = drumWith([
      { index: 0, layers: 2 },
      { index: 1, layers: 1 },
    ]);
    expect(describeProgramContents(program)).toContain('2 assigned pads');
    expect(describeProgramContents(program)).toContain('3 sample assignments');
  });

  it('counts an unassigned pad as nothing, because it makes no sound', () => {
    const program = drumWith([
      { index: 0, layers: 1 },
      { index: 1, layers: 0 },
    ]);
    expect(describeProgramContents(program)).toContain('1 assigned pad');
    expect(describeProgramContents(program)).not.toContain('2 assigned');
  });

  it('says nothing about sample assignments when there are none to lose', () => {
    expect(describeProgramContents(drumWith([{ index: 0, layers: 0 }]))).not.toContain('assignment');
  });

  it('adds up the mod routes across every pad', () => {
    const program = drumWith([
      { index: 0, layers: 1, routes: 2 },
      { index: 1, layers: 1, routes: 3 },
    ]);
    expect(describeProgramContents(program)).toContain('5 mod-matrix routes');
  });

  it('counts a keygroup by its zones rather than by pads', () => {
    const program = createDefaultKeygroupProgram('Piano', 'prog-2');
    const zone: KeygroupZone = {
      sampleId: 'sample-a',
      rootNote: 60,
      lowNote: 0,
      highNote: 127,
      lowVelocity: 0,
      highVelocity: 127,
      tuneCents: 0,
      gainDb: 0,
    };
    const described = describeProgramContents({ ...program, zones: [zone, { ...zone }] });
    expect(described).toContain('2 keygroup zones');
    expect(described).not.toContain('pad');
  });

  it('always names the sound-design settings that go with it', () => {
    expect(describeProgramContents(drumWith([{ index: 0, layers: 1 }]))).toContain(
      'envelopes, filter and LFO settings',
    );
  });
});

describe('describePadContents (spec §6)', () => {
  it('counts the layers and routes on the one pad', () => {
    const pad = drumWith([{ index: 3, layers: 2, routes: 1 }]).pads[0]!;
    const described = describePadContents(pad);
    expect(described).toContain('2 sample layers');
    expect(described).toContain('1 mod-matrix route');
  });

  it('says the samples themselves survive, which is what §8.5.7 owns', () => {
    // The pad's audio stays in the library until the §8.5.7 purge; a dialog implying
    // otherwise would make clearing a pad read as deleting the sounds on it.
    const pad = drumWith([{ index: 0, layers: 1 }]).pads[0]!;
    expect(describePadContents(pad)).toContain("this pad's envelopes");
  });

  it('reads in the singular for one layer', () => {
    const pad = drumWith([{ index: 0, layers: 1 }]).pads[0]!;
    expect(describePadContents(pad)).toContain('1 sample layer,');
  });
});
