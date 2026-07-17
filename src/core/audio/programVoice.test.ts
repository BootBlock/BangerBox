import { describe, expect, it } from 'vitest';
import {
  createDefaultDrumProgram,
  createDefaultKeygroupProgram,
  createDefaultPad,
  type KeygroupZone,
  type VelocityLayer,
} from '@/core/project/schemas';
import {
  keygroupDetuneCents,
  programChannelId,
  resolveDrumVoice,
  resolveKeygroupVoice,
  resolveVoice,
  selectKeygroupZone,
  selectVelocityLayer,
} from './programVoice';

function layer(overrides: Partial<VelocityLayer>): VelocityLayer {
  return {
    sampleId: 'sample',
    velocityStart: 0,
    velocityEnd: 127,
    tuneSemitones: 0,
    tuneCents: 0,
    gainDb: 0,
    startFrame: 0,
    endFrame: 0,
    reverse: false,
    ...overrides,
  };
}

function zone(overrides: Partial<KeygroupZone>): KeygroupZone {
  return {
    sampleId: 'zone-sample',
    rootNote: 60,
    lowNote: 0,
    highNote: 127,
    lowVelocity: 0,
    highVelocity: 127,
    tuneCents: 0,
    gainDb: 0,
    ...overrides,
  };
}

describe('selectVelocityLayer (spec §6 velocity switching)', () => {
  const soft = layer({ sampleId: 'soft', velocityStart: 1, velocityEnd: 63 });
  const hard = layer({ sampleId: 'hard', velocityStart: 64, velocityEnd: 127 });

  it('picks the band that contains the velocity', () => {
    expect(selectVelocityLayer([soft, hard], 30)?.sampleId).toBe('soft');
    expect(selectVelocityLayer([soft, hard], 100)?.sampleId).toBe('hard');
  });

  it('is inclusive of band boundaries', () => {
    expect(selectVelocityLayer([soft, hard], 63)?.sampleId).toBe('soft');
    expect(selectVelocityLayer([soft, hard], 64)?.sampleId).toBe('hard');
  });

  it('returns null when no band matches', () => {
    expect(selectVelocityLayer([soft, hard], 0)).toBeNull();
    expect(selectVelocityLayer([], 100)).toBeNull();
  });
});

describe('selectKeygroupZone (spec §6 key + velocity ranges)', () => {
  const low = zone({ sampleId: 'low', lowNote: 36, highNote: 59 });
  const high = zone({ sampleId: 'high', lowNote: 60, highNote: 83 });

  it('picks the zone covering both key and velocity', () => {
    expect(selectKeygroupZone([low, high], 48, 100)?.sampleId).toBe('low');
    expect(selectKeygroupZone([low, high], 72, 100)?.sampleId).toBe('high');
  });

  it('respects the velocity window', () => {
    const softOnly = zone({ sampleId: 'soft', lowVelocity: 1, highVelocity: 40 });
    expect(selectKeygroupZone([softOnly], 60, 20)?.sampleId).toBe('soft');
    expect(selectKeygroupZone([softOnly], 60, 90)).toBeNull();
  });

  it('returns null when no zone covers the note', () => {
    expect(selectKeygroupZone([low, high], 100, 100)).toBeNull();
  });
});

describe('keygroupDetuneCents (spec §6 coupled repitch)', () => {
  const root = zone({ rootNote: 60 });

  it('is zero at the root note', () => {
    expect(keygroupDetuneCents(60, root)).toBe(0);
  });

  it('is +1200 cents an octave up and −1200 an octave down', () => {
    expect(keygroupDetuneCents(72, root)).toBe(1200);
    expect(keygroupDetuneCents(48, root)).toBe(-1200);
  });

  it('adds the zone fine-tune in cents', () => {
    expect(keygroupDetuneCents(61, zone({ rootNote: 60, tuneCents: 25 }))).toBe(125);
  });
});

describe('resolveDrumVoice (spec §6)', () => {
  it('resolves the pad at the note index with the velocity-matched layer', () => {
    const program = createDefaultDrumProgram('Kit');
    const pad = createDefaultPad(4);
    pad.chokeGroup = 3;
    pad.playbackMode = 'oneShot';
    pad.layers = [
      layer({ sampleId: 'soft', velocityStart: 1, velocityEnd: 63, tuneSemitones: 2, tuneCents: 10 }),
      layer({ sampleId: 'hard', velocityStart: 64, velocityEnd: 127 }),
    ];
    program.pads = [pad];

    const soft = resolveDrumVoice(program, 4, 20);
    expect(soft?.sampleId).toBe('soft');
    expect(soft?.detuneCents).toBe(210); // 2 semitones + 10 cents
    expect(soft?.chokeGroup).toBe(3);
    expect(soft?.playbackMode).toBe('oneShot');
    expect(soft?.channelId).toBe(programChannelId(program.id, 4));

    expect(resolveDrumVoice(program, 4, 100)?.sampleId).toBe('hard');
  });

  it('returns null for an unassigned pad or an unmatched velocity', () => {
    const program = createDefaultDrumProgram('Kit');
    program.pads = [{ ...createDefaultPad(0), layers: [layer({ velocityStart: 64, velocityEnd: 127 })] }];
    expect(resolveDrumVoice(program, 7, 100)).toBeNull(); // no pad 7
    expect(resolveDrumVoice(program, 0, 10)).toBeNull(); // velocity below the only layer
  });
});

describe('resolveKeygroupVoice (spec §6)', () => {
  it('repitches the matched zone and routes to the program-scope channel', () => {
    const program = createDefaultKeygroupProgram('Keys');
    program.zones = [zone({ sampleId: 'keys', rootNote: 60 })];
    const voice = resolveKeygroupVoice(program, 72, 100);
    expect(voice?.sampleId).toBe('keys');
    expect(voice?.detuneCents).toBe(1200);
    expect(voice?.channelId).toBe(programChannelId(program.id, 0));
    expect(voice?.polyphony).toBe(program.polyphony);
  });

  it('is monophonic when glide is engaged, polyphonic otherwise', () => {
    const program = createDefaultKeygroupProgram('Keys');
    program.zones = [zone({})];
    expect(resolveKeygroupVoice({ ...program, glideMs: 0 }, 60, 100)?.playbackMode).toBe('poly');
    expect(resolveKeygroupVoice({ ...program, glideMs: 120 }, 60, 100)?.playbackMode).toBe('mono');
  });

  it('returns null when no zone covers the note', () => {
    const program = createDefaultKeygroupProgram('Keys');
    program.zones = [zone({ lowNote: 60, highNote: 72 })];
    expect(resolveKeygroupVoice(program, 40, 100)).toBeNull();
  });
});

describe('resolveVoice dispatch (spec §6)', () => {
  it('routes by program type', () => {
    const drum = createDefaultDrumProgram('Kit');
    drum.pads = [{ ...createDefaultPad(0), layers: [layer({ sampleId: 'kick' })] }];
    expect(resolveVoice(drum, 0, 100)?.sampleId).toBe('kick');

    const keys = createDefaultKeygroupProgram('Keys');
    keys.zones = [zone({ sampleId: 'pad' })];
    expect(resolveVoice(keys, 60, 100)?.sampleId).toBe('pad');
  });
});
