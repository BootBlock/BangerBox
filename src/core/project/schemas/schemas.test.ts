/**
 * Domain schema accept/reject fixtures (spec §11.1). Proves the §6/§4.2 schemas
 * accept valid payloads and the default factories, and reject out-of-range or
 * malformed ones at the load/import boundary (spec §6).
 */
import { describe, expect, it } from 'vitest';
import {
  channelStripSchema,
  createDefaultChannelStrip,
  createDefaultDrumProgram,
  createDefaultKeygroupProgram,
  createDefaultPad,
  createDefaultSequence,
  createDefaultTrack,
  midiEventSchema,
  modRouteSchema,
  padSchema,
  programSchema,
  projectPayloadSchema,
  qLinkBindingSchema,
  sequenceSchema,
  trackSchema,
} from './index';

describe('channelStripSchema', () => {
  it('accepts the default strip and round-trips it', () => {
    const strip = createDefaultChannelStrip('master');
    expect(channelStripSchema.parse(strip)).toEqual(strip);
  });

  it('rejects a level above the 1.2 fader ceiling (spec §4.2)', () => {
    expect(channelStripSchema.safeParse({ ...createDefaultChannelStrip('m'), level: 1.5 }).success).toBe(
      false,
    );
  });

  it('rejects a pan outside -1..1', () => {
    expect(channelStripSchema.safeParse({ ...createDefaultChannelStrip('m'), pan: 2 }).success).toBe(false);
  });

  it('rejects the wrong number of sends (must be exactly four, spec §5.2)', () => {
    expect(
      channelStripSchema.safeParse({ ...createDefaultChannelStrip('m'), sendLevels: [0, 0, 0] }).success,
    ).toBe(false);
  });
});

describe('programSchema', () => {
  it('accepts a default drum program (discriminated on type)', () => {
    const program = createDefaultDrumProgram('Kit');
    const parsed = programSchema.parse(program);
    expect(parsed.type).toBe('drum');
  });

  it('accepts a default keygroup program', () => {
    const program = createDefaultKeygroupProgram('Bass');
    const parsed = programSchema.parse(program);
    expect(parsed.type).toBe('keygroup');
    if (parsed.type === 'keygroup') expect(parsed.pitchBendRange).toBe(2);
  });

  it('rejects an unknown program type', () => {
    expect(programSchema.safeParse({ id: 'x', name: 'n', type: 'sampler', pads: [] }).success).toBe(false);
  });

  it('accepts a pad at the 8-layer cap but rejects nine (spec §6)', () => {
    const base = createDefaultPad(0);
    const layer = {
      sampleId: 's',
      velocityStart: 0,
      velocityEnd: 127,
      tuneSemitones: 0,
      tuneCents: 0,
      gainDb: 0,
      startFrame: 0,
      endFrame: 0,
      reverse: false,
    };
    expect(padSchema.safeParse({ ...base, layers: Array.from({ length: 8 }, () => layer) }).success).toBe(
      true,
    );
    expect(padSchema.safeParse({ ...base, layers: Array.from({ length: 9 }, () => layer) }).success).toBe(
      false,
    );
  });
});

describe('modRouteSchema (spec §6)', () => {
  it('accepts a fixed target and an insert-address target', () => {
    expect(modRouteSchema.safeParse({ source: 'lfo1', target: 'filterCutoff', amount: 0.5 }).success).toBe(
      true,
    );
    expect(modRouteSchema.safeParse({ source: 'velocity', target: 'insert2:mix', amount: -1 }).success).toBe(
      true,
    );
  });

  it('rejects an unknown target and an out-of-range amount', () => {
    expect(modRouteSchema.safeParse({ source: 'lfo1', target: 'wobble', amount: 0 }).success).toBe(false);
    expect(modRouteSchema.safeParse({ source: 'lfo1', target: 'pitch', amount: 2 }).success).toBe(false);
  });
});

describe('midiEventSchema (spec §9.3)', () => {
  const base = { id: 'e', tickStart: 0, durationTicks: 24, note: 60, velocity: 100, extra: null };

  it('accepts a well-formed event', () => {
    expect(midiEventSchema.safeParse(base).success).toBe(true);
  });

  it('rejects velocity 0 (min 1) and duration 0 (min 1 tick, spec §7.7)', () => {
    expect(midiEventSchema.safeParse({ ...base, velocity: 0 }).success).toBe(false);
    expect(midiEventSchema.safeParse({ ...base, durationTicks: 0 }).success).toBe(false);
  });
});

describe('sequence & track schemas', () => {
  it('accepts a default sequence with a null (follow-project) tempo', () => {
    const seq = createDefaultSequence('proj');
    expect(sequenceSchema.parse(seq).tempo).toBeNull();
  });

  it('rejects an unsupported time-signature denominator', () => {
    const seq = createDefaultSequence('proj');
    expect(sequenceSchema.safeParse({ ...seq, timeSig: { numerator: 4, denominator: 3 } }).success).toBe(
      false,
    );
  });

  it('accepts a default track with a null programId', () => {
    const track = createDefaultTrack('seq', null);
    expect(trackSchema.parse(track).programId).toBeNull();
  });
});

describe('projectPayloadSchema', () => {
  it('preserves unknown keys for forward compatibility (spec §9.3 .loose)', () => {
    const parsed = projectPayloadSchema.parse({ grooveTemplates: [{ id: 'g' }] });
    expect(parsed).toHaveProperty('grooveTemplates');
  });
});

describe('qLinkBindingSchema (spec §10.3)', () => {
  it('rejects an encoder index above 15', () => {
    expect(
      qLinkBindingSchema.safeParse({
        encoderIndex: 16,
        cc: 20,
        targetStore: 'mixer',
        targetParameterPath: 'mixer.master.level',
        minValue: 0,
        maxValue: 1,
        curve: 'linear',
        mode: 'absolute',
      }).success,
    ).toBe(false);
  });
});
