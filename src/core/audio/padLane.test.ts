/**
 * The §7.8 per-voice lane nodes of a pad (spec §6, §7.8, issue #138).
 *
 * `program:<id>.pad:<idx>.filter.cutoff`, `…filter.resonance` and `…pitch` used to be written
 * onto each SOUNDING voice, which reaches only the voices that exist at the moment of the
 * write. Live that left every note struck between two automation windows starting at the
 * patch value, and in the `OfflineAudioContext` a §9.5 bounce renders in — where every voice
 * of the whole render is built before any ramp is applied — it made the lane unrenderable, so
 * the bounce was given no voice pool at all.
 *
 * Each of the three now rides a `ConstantSourceNode` the whole pad shares, which every voice
 * of the pad is built against: the node carries the value, the voice carries only what the
 * §7.8 leaf does not own. These drive the real {@link VoicePool} against the §11.3 fake
 * context and read back what each param and each node ended up holding.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope, type ModRoute, type PadFilter } from '@/core/project/schemas';
import { createFakeAudioContext, liveNodeCount, type FakeAudioContext } from '@/test/mocks/audioContext';
import { VoicePool, type VoiceTriggerSpec } from './voicePool';

const LOWPASS: PadFilter = { type: 'lp', cutoff: 800, resonance: 1, envDepth: 0 };

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
    ...over,
  };
}

interface FakeParam {
  value: number;
  calls: { method: string; args: number[] }[];
}
interface FakeFilter {
  frequency: FakeParam;
  Q: FakeParam;
  detune: FakeParam;
}
interface FakeSource {
  detune: FakeParam;
}
interface FakeConstant {
  offset: FakeParam;
  started: boolean;
  stopped: boolean;
  startedAt: number | null;
  paramOutputs: unknown[];
}

function filtersOf(fake: FakeAudioContext): FakeFilter[] {
  return fake.nodes.filter((n) => n.nodeType === 'biquad') as unknown as FakeFilter[];
}
function sourcesOf(fake: FakeAudioContext): FakeSource[] {
  return fake.nodes.filter((n) => n.nodeType === 'bufferSource') as unknown as FakeSource[];
}
function constantsOf(fake: FakeAudioContext): FakeConstant[] {
  return fake.nodes.filter((n) => n.nodeType === 'constantSource') as unknown as FakeConstant[];
}

/** The constant source feeding `param`, identified by what it is connected to rather than by order. */
function feeding(fake: FakeAudioContext, param: FakeParam): FakeConstant | undefined {
  return constantsOf(fake).find((node) => node.paramOutputs.includes(param));
}

/** What a voice's filter actually cuts at: its own base plus the pad lane summed into it. */
function effectiveCutoff(fake: FakeAudioContext, filter: FakeFilter): number {
  return filter.frequency.value + (feeding(fake, filter.frequency)?.offset.value ?? 0);
}

/** What a voice is actually detuned by: its own base plus every node summed into it. */
function effectiveDetune(fake: FakeAudioContext, source: FakeSource): number {
  const summed = constantsOf(fake)
    .filter((node) => node.paramOutputs.includes(source.detune))
    .reduce((total, node) => total + node.offset.value, 0);
  return source.detune.value + summed;
}

describe('a §7.8 lane on a §6 sound-design parameter (spec §6, §7.8, issue #138)', () => {
  it('reaches a voice struck AFTER the ramp, not only the ones already sounding', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'before', filter: LOWPASS }));
    pool.applyPadParam('p1:0', 'filterFrequency', 5_000, 0.5);
    pool.trigger(spec(context, { id: 'after', when: 1, filter: LOWPASS }));

    const [first, second] = filtersOf(fake);
    expect(effectiveCutoff(fake, first!)).toBe(5_000);
    // The one the defect lost: built from the §6 payload at 800 Hz, a full automation window
    // after the lane had already moved the pad to 5 kHz.
    expect(effectiveCutoff(fake, second!)).toBe(5_000);
    pool.destroy();
  });

  it('moves both voices of a pad through ONE node rather than writing each', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'a', filter: LOWPASS }));
    pool.trigger(spec(context, { id: 'b', filter: LOWPASS }));
    pool.applyPadParam('p1:0', 'filterFrequency', 5_000, 0.5);

    const [first, second] = filtersOf(fake);
    expect(feeding(fake, first!.frequency)).toBe(feeding(fake, second!.frequency));
    // Neither voice's own param was written: the pad's node carries the value for both.
    expect(first!.frequency.calls).toEqual([]);
    expect(second!.frequency.calls).toEqual([]);
    expect(effectiveCutoff(fake, second!)).toBe(5_000);
    pool.destroy();
  });

  it('does the same for resonance', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'before', filter: LOWPASS }));
    pool.applyPadParam('p1:0', 'filterQ', 12, 0.5);
    pool.trigger(spec(context, { id: 'after', when: 1, filter: LOWPASS }));

    const [first, second] = filtersOf(fake);
    for (const filter of [first!, second!]) {
      expect(filter.Q.value + (feeding(fake, filter.Q)?.offset.value ?? 0)).toBe(12);
    }
    pool.destroy();
  });

  it('REPLACES the pad tune rather than adding to it', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // A pad tuned +5 semitones, then a lane that says +7 semitones.
    pool.trigger(spec(context, { id: 'tuned', tuneSemitones: 5 }));
    expect(effectiveDetune(fake, sourcesOf(fake)[0]!)).toBe(500);
    pool.applyPadParam('p1:0', 'detune', 700, 0.5);
    // +7 semitones, which is what the lane says. Summing the lane onto the pad's own tune
    // sounded it at +12, and a voice struck afterwards at +5.
    expect(effectiveDetune(fake, sourcesOf(fake)[0]!)).toBe(700);
    pool.trigger(spec(context, { id: 'next', when: 1, tuneSemitones: 5 }));
    expect(effectiveDetune(fake, sourcesOf(fake)[1]!)).toBe(700);
    pool.destroy();
  });

  it('keeps a §6 layer fine tune on the voice, where no §7.8 leaf addresses it', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'fine', tuneSemitones: 5, tuneCents: 25 }));
    pool.applyPadParam('p1:0', 'detune', 700, 0.5);
    // The lane owns the semitone tune and nothing else: the layer's 25 cents survives it.
    expect(effectiveDetune(fake, sourcesOf(fake)[0]!)).toBe(725);
    pool.destroy();
  });

  it('sums a §10.2 bend with the pitch lane instead of superseding it', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'bent' }));
    pool.applyPadParam('p1:0', 'detune', 700, 0.4);
    pool.applyProgramDetune('p1', -1200, 0.5);
    // A bend is a performance gesture layered OVER the programmed pitch (spec §10.2), and a
    // §7.8 lane is programmed pitch. The two are separate nodes, so they sum.
    expect(effectiveDetune(fake, sourcesOf(fake)[0]!)).toBe(-500);
    pool.destroy();
  });

  it('accepts a ramp that arrives before the pad has ever sounded', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.applyPadParam('p1:0', 'filterFrequency', 5_000, 0.1);
    pool.trigger(spec(context, { id: 'first', when: 1, filter: LOWPASS }));
    // The node the ramp built is the one the voice is wired to, so the first hit of a pad
    // whose lane has already run is at the lane's value and not the patch's.
    expect(effectiveCutoff(fake, filtersOf(fake)[0]!)).toBe(5_000);
    pool.destroy();
  });

  it('starts on the context clock, not on the note that built it', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // A §9.5 render builds its voices track by track rather than in time order, so a lane
    // started at the first voice's `when` would contribute nothing to an earlier one.
    pool.trigger(spec(context, { id: 'late', when: 5 }));
    expect(constantsOf(fake)[0]!.startedAt).toBe(0);
    pool.destroy();
  });

  it('reaches nothing on a pad whose §6 filter is off', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'unfiltered' }));
    pool.applyPadParam('p1:0', 'filterFrequency', 5_000, 0.5);
    // No filter node is materialised mid-note — that would click (spec §6).
    expect(filtersOf(fake)).toHaveLength(0);
    pool.destroy();
  });

  it('keeps the voice’s own static §6 cutoff modulation, in cents beside the envelope', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    const routes: ModRoute[] = [{ source: 'velocity', target: 'filterCutoff', amount: 0.25 }];
    pool.trigger(spec(context, { id: 'modulated', velocity: 127, filter: LOWPASS, modMatrix: routes }));

    const filter = filtersOf(fake)[0]!;
    // The pad's cutoff is shared, so what is per VOICE — velocity, note number, its own
    // random — is summed on `filter.detune`, where it multiplies the shared value.
    expect(effectiveCutoff(fake, filter)).toBe(800);
    expect(filter.detune.value).toBeCloseTo(1_200, 6); // 0.25 × 4 octaves = one octave up
    pool.destroy();
  });

  it('moves the end-of-region declick when a pitch lane changes the playback rate', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'swept', when: 0 }));
    const ampGain = fake.nodes.find(
      (n) => n.nodeType === 'gain' && (n as unknown as { gain: FakeParam }).gain.calls.length > 0,
    ) as unknown as { gain: FakeParam };
    const fadeEnd = (): number => {
      const ramps = ampGain.gain.calls.filter((c) => c.method === 'linearRampToValueAtTime');
      return ramps[ramps.length - 1]!.args[1]!;
    };
    const unswept = fadeEnd();
    // An octave down halves the playback rate, so the one-second region lasts about twice
    // as long — detune IS the rate (spec §5.4, issue #87).
    pool.applyPadParam('p1:0', 'detune', -1_200, 0.2);
    expect(fadeEnd()).toBeGreaterThan(unswept + 0.5);
    pool.destroy();
  });

  it('releases its nodes from a voice that has ended, and stops them on destroy (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'ended', filter: LOWPASS }));
    const lanes = constantsOf(fake);
    expect(lanes).toHaveLength(3); // cutoff, resonance and pitch
    expect(lanes.every((node) => node.started)).toBe(true);

    // The voice ends on its own; the pad's lanes outlive it, so their connections into its
    // params are what would otherwise keep its filter and source alive.
    const source = fake.nodes.find((n) => n.nodeType === 'bufferSource') as unknown as {
      onended: (() => void) | null;
    };
    source.onended?.();
    expect(lanes.every((node) => node.paramOutputs.length === 0)).toBe(true);

    pool.destroy();
    expect(lanes.every((node) => node.stopped)).toBe(true);
    expect(liveNodeCount(fake)).toBe(0);
  });
});
