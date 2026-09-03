/**
 * §6 `LfoConfig` applied at playback — `sync`, `phaseOffset` and `retrigger`.
 *
 * All three were persisted and read by no voice code (issue #107): a `1/16`-synced LFO ran
 * at its free Hz rate, a phase offset reached no oscillator, and every voice built its own
 * oscillator so `retrigger: false` was indistinguishable from `true`.
 */
import { describe, expect, it } from 'vitest';
import {
  createDefaultEnvelope,
  createDefaultLfo,
  type LfoConfig,
  type ModRoute,
} from '@/core/project/schemas';
import { createFakeAudioContext, type FakeAudioContext } from '@/test/mocks/audioContext';
import { VoicePool, type VoiceTriggerSpec } from './voicePool';

const PITCH_ROUTE: ModRoute = { source: 'lfo1', target: 'pitch', amount: 0.5 };

function lfos(patch: Partial<LfoConfig>): [LfoConfig, LfoConfig] {
  return [{ ...createDefaultLfo(), ...patch }, createDefaultLfo()];
}

function spec(context: AudioContext, over: Partial<VoiceTriggerSpec> = {}): VoiceTriggerSpec {
  return {
    id: over.id ?? crypto.randomUUID(),
    buffer: context.createBuffer(1, 48_000, 48_000),
    destination: over.destination ?? context.createGain(),
    when: 0,
    velocity: 100,
    playbackMode: 'poly',
    chokeGroup: 0,
    programId: 'p1',
    padKey: 'p1:0',
    amp: createDefaultEnvelope(),
    gainDb: 0,
    tuneSemitones: 0,
    tuneCents: 0,
    modMatrix: [PITCH_ROUTE],
    ...over,
  };
}

interface FakeOscillator {
  readonly nodeType: string;
  readonly type: OscillatorType;
  readonly frequency: { value: number };
  readonly periodicWave: { real: Float32Array; imag: Float32Array } | null;
  readonly started: boolean;
  readonly stopped: boolean;
  readonly startedAt: number | null;
  readonly outputs: unknown[];
}

function oscillators(fake: FakeAudioContext): FakeOscillator[] {
  return fake.nodes.filter((node) => node.nodeType === 'oscillator') as unknown as FakeOscillator[];
}

/** The nth voice's buffer source, so a test can end it the way Web Audio would. */
function sourceOf(fake: FakeAudioContext, index: number): { onended: (() => void) | null } {
  const sources = fake.nodes.filter((node) => node.nodeType === 'bufferSource');
  return sources[index] as unknown as { onended: (() => void) | null };
}

function setup(): { context: AudioContext; fake: FakeAudioContext; pool: VoicePool } {
  const { context, fake } = createFakeAudioContext();
  return { context, fake, pool: new VoicePool(context) };
}

describe('LfoConfig.sync (spec §6)', () => {
  it('runs a free LFO at its Hz rate whatever the tempo', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { lfos: lfos({ sync: 'free', rate: 4.5 }), bpm: 90 }));
    expect(oscillators(fake)[0]!.frequency.value).toBeCloseTo(4.5, 6);
  });

  it('locks a synced LFO to the transport tempo', () => {
    const { context, fake, pool } = setup();
    // A 1/16-synced LFO at 120 bpm: a sixteenth is 0.125 s, so 8 Hz.
    pool.trigger(spec(context, { lfos: lfos({ sync: '1/16', rate: 4.5 }), bpm: 120 }));
    expect(oscillators(fake)[0]!.frequency.value).toBeCloseTo(8, 6);
  });

  it('halves the rate when the tempo halves, so the LFO stays in time', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { lfos: lfos({ sync: '1/4' }), bpm: 60 }));
    expect(oscillators(fake)[0]!.frequency.value).toBeCloseTo(1, 6);
  });

  it('falls back to the project default tempo when the caller supplies none', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { lfos: lfos({ sync: '1/4' }) }));
    expect(oscillators(fake)[0]!.frequency.value).toBeCloseTo(2, 6); // 120 bpm
  });
});

describe('LfoConfig.phaseOffset (spec §6)', () => {
  it('keeps the native waveform when there is no offset', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { lfos: lfos({ shape: 'triangle', phaseOffset: 0 }) }));
    const osc = oscillators(fake)[0]!;
    expect(osc.type).toBe('triangle');
    expect(osc.periodicWave).toBeNull();
  });

  it('builds a rotated periodic wave when there is one', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { lfos: lfos({ shape: 'sine', phaseOffset: 0.25 }) }));
    const osc = oscillators(fake)[0]!;
    expect(osc.periodicWave).not.toBeNull();
    // A quarter turn of a sine moves all of its energy into the cosine term.
    expect(osc.periodicWave!.real[1]).toBeCloseTo(1, 6);
    expect(osc.periodicWave!.imag[1]).toBeCloseTo(0, 6);
  });
});

describe('LfoConfig.retrigger (spec §6)', () => {
  it('gives each voice its own oscillator when retrigger is on', () => {
    const { context, fake, pool } = setup();
    const config = { lfos: lfos({ retrigger: true }) };
    pool.trigger(spec(context, { ...config, id: 'a' }));
    pool.trigger(spec(context, { ...config, id: 'b' }));
    expect(oscillators(fake)).toHaveLength(2);
  });

  it('shares one free-running oscillator across a pad’s voices when retrigger is off', () => {
    const { context, fake, pool } = setup();
    const config = { lfos: lfos({ retrigger: false }) };
    pool.trigger(spec(context, { ...config, id: 'a', when: 0 }));
    pool.trigger(spec(context, { ...config, id: 'b', when: 1 }));
    const built = oscillators(fake);
    expect(built).toHaveLength(1);
    // Its phase origin is the FIRST note, not the second — that is what free-running means.
    expect(built[0]!.startedAt).toBe(0);
  });

  it('gives a different pad its own free-running oscillator', () => {
    const { context, fake, pool } = setup();
    const config = { lfos: lfos({ retrigger: false }) };
    pool.trigger(spec(context, { ...config, id: 'a', padKey: 'p1:0' }));
    pool.trigger(spec(context, { ...config, id: 'b', padKey: 'p1:1' }));
    expect(oscillators(fake)).toHaveLength(2);
  });

  it('rebuilds the shared oscillator when the LFO config changes', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { id: 'a', lfos: lfos({ retrigger: false, rate: 2 }) }));
    pool.trigger(spec(context, { id: 'b', lfos: lfos({ retrigger: false, rate: 6 }) }));
    const built = oscillators(fake);
    expect(built).toHaveLength(2);
    expect(built[1]!.frequency.value).toBeCloseTo(6, 6);
  });

  it('leaves a replaced oscillator running for the voices still sounding through it', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { id: 'a', lfos: lfos({ retrigger: false, rate: 2 }) }));
    const old = oscillators(fake)[0]!;

    // The config change replaces the pad's LFO. Stopping the old oscillator here would cut
    // the modulation out from under the note still sounding through it.
    pool.trigger(spec(context, { id: 'b', lfos: lfos({ retrigger: false, rate: 6 }) }));
    expect(old.stopped).toBe(false);
    expect(old.outputs).toHaveLength(1);

    // …and it goes as soon as that last voice ends, rather than living to the pool's end.
    sourceOf(fake, 0).onended?.();
    expect(old.stopped).toBe(true);
    expect(old.outputs).toHaveLength(0);
    expect(oscillators(fake)[1]!.stopped).toBe(false);
  });

  it('releases a replaced oscillator at once when nothing was borrowing it', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { id: 'a', lfos: lfos({ retrigger: false, rate: 2 }) }));
    sourceOf(fake, 0).onended?.();
    const old = oscillators(fake)[0]!;
    expect(old.stopped).toBe(false); // still free-running with no voice on it

    pool.trigger(spec(context, { id: 'b', lfos: lfos({ retrigger: false, rate: 6 }) }));
    expect(old.stopped).toBe(true);
  });

  it('leaves the shared oscillator running when a voice using it ends', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { id: 'a', lfos: lfos({ retrigger: false }) }));
    pool.release('p1:0', 1);
    expect(oscillators(fake)[0]!.stopped).toBe(false);
  });

  it('stops and disconnects every shared oscillator on destroy (spec §3.2)', () => {
    const { context, fake, pool } = setup();
    pool.trigger(spec(context, { id: 'a', lfos: lfos({ retrigger: false }) }));
    pool.destroy();
    const osc = oscillators(fake)[0]!;
    expect(osc.stopped).toBe(true);
    expect(osc.outputs).toHaveLength(0);
  });

  it('detaches a dead voice’s gain from the shared oscillator it borrowed (spec §3.2)', () => {
    const { context, fake, pool } = setup();
    const config = { lfos: lfos({ retrigger: false }) };
    pool.trigger(spec(context, { ...config, id: 'a' }));
    const osc = oscillators(fake)[0]!;
    expect(osc.outputs).toHaveLength(1);

    // A voice reaching the end of its buffer tears itself down through `ended`. The gain it
    // built must leave with it, or the free-running LFO — which survives the voice by design
    // — accumulates one dead gain per note for the life of the pool.
    sourceOf(fake, 0).onended?.();
    expect(osc.outputs).toHaveLength(0);
    expect(osc.stopped).toBe(false); // …and the LFO itself keeps running

    // The next note on the pad borrows the same oscillator and gets a fresh gain.
    pool.trigger(spec(context, { ...config, id: 'b' }));
    expect(oscillators(fake)).toHaveLength(1);
    expect(osc.outputs).toHaveLength(1);
  });
});
