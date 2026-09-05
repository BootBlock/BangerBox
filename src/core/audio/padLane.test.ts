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
import {
  createDefaultEnvelope,
  type AhdsrEnvelope,
  type ModRoute,
  type PadFilter,
} from '@/core/project/schemas';
import { createFakeAudioContext, liveNodeCount, type FakeAudioContext } from '@/test/mocks/audioContext';
import { DECLICK_FADE_MS as DECLICK_MS, SCHEDULER_INTERVAL_MS } from '@/core/constants';
import { ampLevelAt } from './voiceEnvelope';
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

/** Every voice's amp-envelope gain, in the order the voices were built. */
function ampGainsOf(fake: FakeAudioContext): FakeParam[] {
  return fake.nodes
    .filter((n) => n.nodeType === 'gain' && (n as unknown as { gain: FakeParam }).gain.calls.length > 0)
    .map((n) => (n as unknown as { gain: FakeParam }).gain);
}

/** The voice's amp-envelope gain — the only gain the pool schedules anything on. */
function ampGainOf(fake: FakeAudioContext): FakeParam {
  const gain = ampGainsOf(fake)[0];
  if (!gain) throw new Error('no amp gain was scheduled');
  return gain;
}

/**
 * How long the §6 attack currently written on an amp gain lasts, in seconds.
 *
 * `scheduleAmpAttack` opens with `setValueAtTime(0, when)` followed by a linear ramp to the
 * peak, so the LAST such pair is the contour in force — a re-lay cancels and rewrites, and
 * what matters is what the timeline ends up holding.
 */
function ampAttackSeconds(gain: FakeParam): number {
  for (let i = gain.calls.length - 2; i >= 0; i -= 1) {
    const open = gain.calls[i]!;
    const ramp = gain.calls[i + 1]!;
    if (open.method !== 'setValueAtTime' || open.args[0] !== 0) continue;
    if (ramp.method !== 'linearRampToValueAtTime') continue;
    return ramp.args[1]! - open.args[1]!;
  }
  throw new Error('no amp attack was scheduled');
}

/** How long the release ramp scheduled at `when` lasts, in seconds. */
function ampReleaseSeconds(gain: FakeParam, when: number): number {
  const ramps = gain.calls.filter((call) => call.method === 'linearRampToValueAtTime');
  return ramps[ramps.length - 1]!.args[1]! - when;
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

  it('keeps each §6 LAYER at its own tune, and moves them together', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // §6 stores `tuneSemitones` per layer and §8.5.5 sets them independently, while the §7.8
    // leaf names one value for the pad: the pad's is the FIRST layer's and the rest are carried
    // as differences from it, so a shared node cannot flatten them onto each other.
    pool.trigger(spec(context, { id: 'soft', tuneSemitones: 0, layerTuneCents: 0 }));
    pool.trigger(spec(context, { id: 'hard', when: 1, tuneSemitones: 0, layerTuneCents: 1_200 }));
    expect(effectiveDetune(fake, sourcesOf(fake)[0]!)).toBe(0);
    expect(effectiveDetune(fake, sourcesOf(fake)[1]!)).toBe(1_200);

    // A lane moves the PAD, so the octave between the two layers survives it.
    pool.applyPadParam('p1:0', 'detune', 700, 2);
    expect(effectiveDetune(fake, sourcesOf(fake)[0]!)).toBe(700);
    expect(effectiveDetune(fake, sourcesOf(fake)[1]!)).toBe(1_900);
    pool.destroy();
  });

  it('re-seeds a lane from the §6 payload when the payload has MOVED, and not otherwise', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    const filter = { ...LOWPASS };
    pool.trigger(spec(context, { id: 'first', filter }));
    // A §6 edit that never publishes — a keygroup's filter, or a project loaded over the top of
    // the one open — reaches the node through the next note that carries it.
    pool.trigger(spec(context, { id: 'edited', when: 1, filter: { ...filter, cutoff: 2_000 } }));
    expect(effectiveCutoff(fake, filtersOf(fake)[1]!)).toBe(2_000);

    // A §7.8 ramp does not write the store, so an unmoved payload never undoes it.
    pool.applyPadParam('p1:0', 'filterFrequency', 5_000, 2);
    pool.trigger(spec(context, { id: 'after', when: 3, filter: { ...filter, cutoff: 2_000 } }));
    expect(effectiveCutoff(fake, filtersOf(fake)[2]!)).toBe(5_000);
    pool.destroy();
  });

  it('releases the lanes of a program whose §6 record leaves the store (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'gone', programId: 'p1', padKey: 'p1:0', filter: LOWPASS }));
    pool.trigger(spec(context, { id: 'kept', programId: 'p2', padKey: 'p2:0', filter: LOWPASS }));
    expect(constantsOf(fake)).toHaveLength(6); // three per pad

    pool.releaseProgramLanes('p1');
    const stopped = constantsOf(fake).filter((node) => node.stopped);
    expect(stopped).toHaveLength(3);
    // The other program's are untouched — a project switch must not silence what it kept.
    pool.applyPadParam('p2:0', 'filterFrequency', 5_000, 1);
    expect(effectiveCutoff(fake, filtersOf(fake)[1]!)).toBe(5_000);
    pool.destroy();
  });

  it('leaves a voice that has not STARTED to the window that reaches it', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'later', when: 5 }));
    const gain = ampGainOf(fake);
    const before = gain.calls.length;
    // A lane writes every `SCHEDULER_INTERVAL_MS` across a whole §9.5 render, so re-laying a
    // future voice's declick on every window integrates the same contour once per
    // (voice × window) — an apparent hang on a long song with a pitch lane.
    for (let when = 0; when < 1; when += 0.025) pool.applyPadParam('p1:0', 'detune', when * 100, when);
    expect(gain.calls.length).toBe(before);

    // …and the window that DOES reach it re-lays it, so nothing is lost.
    pool.applyPadParam('p1:0', 'detune', -1_200, 5);
    expect(gain.calls.length).toBeGreaterThan(before);
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
    const gain = ampGainOf(fake);
    const fadeEnd = (): number => {
      const ramps = gain.calls.filter((c) => c.method === 'linearRampToValueAtTime');
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

/**
 * The two §7.8 amp-ENVELOPE leaves (spec §6, §7.8, issue #143).
 *
 * `program:<id>.pad:<idx>.amp.attack` and `...amp.release` were registered, offered by the
 * §8.5.2 lane selector and named among §10.3's pad-mode defaults, and `programParamChange`
 * mapped neither — so both were inert live and rendered as nothing.
 *
 * They cannot ride a `ConstantSourceNode` the way the other three do: an envelope TIME is
 * consumed by JavaScript when a voice starts (spec §6), never sampled continuously by the
 * graph. The pad holds the value instead, and **a voice's §6 amp envelope is the pad's
 * envelope as of that voice's own note-on** — one rule, and the same rule live and in a §9.5
 * render. A voice already sounding is never re-shaped; a voice whose note-on has not yet
 * arrived is, because offline every voice of the render is built before any ramp.
 */
describe('a §7.8 lane on a §6 amp-envelope time (spec §6, §7.8, issue #143)', () => {
  const FAST: AhdsrEnvelope = { attack: 1, hold: 0, decay: 0, sustain: 1, release: 120, curve: 'linear' };
  /** One §7.1.4 automation window in seconds — the spacing a §7.8 lane really writes at. */
  const WINDOW = SCHEDULER_INTERVAL_MS / 1_000;

  it('reaches a voice struck AFTER the ramp, and leaves the sounding one alone', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'before', amp: FAST }));
    pool.applyPadParam('p1:0', 'ampAttack', 200, 0.5);
    pool.trigger(spec(context, { id: 'after', when: 1, amp: FAST }));

    const [first, second] = ampGainsOf(fake);
    // The sounding voice keeps the attack it was built with: its attack has already run, and
    // the §5.4 declick has already departed from the contour that laid it.
    expect(ampAttackSeconds(first!)).toBeCloseTo(0.001, 9);
    // The one the defect lost: built from the §6 payload's 1 ms a full automation window
    // after the lane had already moved the pad to 200 ms.
    expect(ampAttackSeconds(second!)).toBeCloseTo(0.2, 9);
    pool.destroy();
  });

  it('re-shapes a voice whose note-on has not yet arrived, which is what a §9.5 render needs', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // Offline the whole render is built before any ramp is applied, so "the voices sounding
    // now" is empty and a value merely remembered for the next voice renders as nothing. The
    // §7.8 windows then tile the span at `SCHEDULER_INTERVAL_MS`, exactly as
    // `bounceAutomationRamps` emits them, and the voice takes the last one before its note-on.
    pool.trigger(spec(context, { id: 'future', when: 1, amp: FAST }));
    for (let when = 0; when < 1.5; when += WINDOW) pool.applyPadParam('p1:0', 'ampAttack', 200, when);
    expect(ampAttackSeconds(ampGainsOf(fake)[0]!)).toBeCloseTo(0.2, 9);
    pool.destroy();
  });

  it('gives each voice the value the lane held at its OWN note-on', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'early', when: 1, amp: FAST }));
    pool.trigger(spec(context, { id: 'late', when: 3, amp: FAST }));
    // A §9.5 render applies its windows in time order, so each voice keeps the last value
    // written at or before its own note-on — which is what a lane STEPPING between the two
    // note-ons has to show, and what a single value applied to both would not.
    for (let when = 0; when < 3.5; when += WINDOW) {
      pool.applyPadParam('p1:0', 'ampAttack', when < 2 ? 100 : 300, when);
    }

    const [early, late] = ampGainsOf(fake);
    expect(ampAttackSeconds(early!)).toBeCloseTo(0.1, 9);
    expect(ampAttackSeconds(late!)).toBeCloseTo(0.3, 9);
    pool.destroy();
  });

  it('gives the release the voice releases with (spec §5.4 note-off)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'before', amp: FAST }));
    pool.applyPadParam('p1:0', 'ampRelease', 400, 0.5);
    pool.trigger(spec(context, { id: 'after', when: 1, amp: FAST }));
    pool.release('p1:0', 2);

    const [first, second] = ampGainsOf(fake);
    expect(ampReleaseSeconds(first!, 2)).toBeCloseTo(0.12, 9);
    expect(ampReleaseSeconds(second!, 2)).toBeCloseTo(0.4, 9);
    pool.destroy();
  });

  it('re-seeds from the §6 payload when the payload has MOVED, and not otherwise', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'first', amp: FAST }));
    pool.applyPadParam('p1:0', 'ampAttack', 200, 0.5);
    // A §7.8 ramp does not write the store, so an unmoved payload never undoes it.
    pool.trigger(spec(context, { id: 'unmoved', when: 1, amp: FAST }));
    expect(ampAttackSeconds(ampGainsOf(fake)[1]!)).toBeCloseTo(0.2, 9);
    // A §6 edit that never publishes reaches the pad through the next note that carries it.
    pool.trigger(spec(context, { id: 'edited', when: 2, amp: { ...FAST, attack: 30 } }));
    expect(ampAttackSeconds(ampGainsOf(fake)[2]!)).toBeCloseTo(0.03, 9);
    pool.destroy();
  });

  it('moves nothing across a flat span of a lane', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'future', when: 1, amp: FAST }));
    pool.applyPadParam('p1:0', 'ampAttack', 200, 0.95);
    const settled = ampGainsOf(fake)[0]!.calls.length;
    // A lane writes every `SCHEDULER_INTERVAL_MS` for the whole span of a §9.5 render, so an
    // unchanged value has to cost nothing rather than re-lay every future voice.
    pool.applyPadParam('p1:0', 'ampAttack', 200, 0.975);
    expect(ampGainsOf(fake)[0]!.calls.length).toBe(settled);
    pool.destroy();
  });

  it('reaches only the pad it addresses', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'other', when: 1, padKey: 'p1:1', amp: FAST }));
    pool.applyPadParam('p1:0', 'ampAttack', 200, 0.95);
    expect(ampAttackSeconds(ampGainsOf(fake)[0]!)).toBeCloseTo(0.001, 9);
    pool.destroy();
  });

  it('departs a note-off from the level the §6 contour holds there', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // A 400 ms linear decay to a quarter of the peak: half way down it holds 0.625 of peak.
    const decaying: AhdsrEnvelope = {
      attack: 0,
      hold: 0,
      decay: 400,
      sustain: 0.25,
      release: 100,
      curve: 'linear',
    };
    pool.trigger(spec(context, { id: 'decaying', velocity: 127, gainDb: 0, amp: decaying }));
    pool.release('p1:0', 0.2);
    const gain = ampGainsOf(fake)[0]!;
    const held = gain.calls.filter((call) => call.method === 'setValueAtTime');
    // The last `setValueAtTime` is the release's own departure level, at the note-off.
    const departure = held[held.length - 1]!;
    expect(departure.args[1]).toBeCloseTo(0.2, 9);
    expect(departure.args[0]).toBeCloseTo(0.625, 6);
    pool.destroy();
  });

  it('leaves a voice beyond the §7.1.4 lookahead to the window that reaches it', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // §7.1.4 builds a note at most `LOOKAHEAD_MS` before it sounds, so that horizon is what a
    // voice "whose note-on has not yet arrived" means. A §9.5 render holds every voice of the
    // span, and without the bound each window re-lays all of them — the (voice × window) cost
    // §14 (aw) records as an apparent hang, every pass of it superseded by the next.
    pool.trigger(spec(context, { id: 'far', when: 30, amp: FAST }));
    const settled = ampGainsOf(fake)[0]!.calls.length;
    pool.applyPadParam('p1:0', 'ampAttack', 200, 1);
    expect(ampGainsOf(fake)[0]!.calls.length).toBe(settled);

    // …and the window that DOES reach it re-lays it, so nothing is lost.
    pool.applyPadParam('p1:0', 'ampAttack', 300, 29.99);
    expect(ampAttackSeconds(ampGainsOf(fake)[0]!)).toBeCloseTo(0.3, 9);
    pool.destroy();
  });

  it('schedules nothing for a release write, which is read at the note-OFF', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'future', when: 1, amp: FAST }));
    const settled = ampGainsOf(fake)[0]!.calls.length;
    // A release moves no boundary `scheduleAmpAttack` writes, so re-laying the contour for one
    // would rewrite an identical timeline once per §7.1.4 window.
    pool.applyPadParam('p1:0', 'ampRelease', 400, 0.95);
    expect(ampGainsOf(fake)[0]!.calls.length).toBe(settled);
    // It still reaches the voice, which is what the note-off reads.
    pool.release('p1:0', 1.5);
    expect(ampReleaseSeconds(ampGainsOf(fake)[0]!, 1.5)).toBeCloseTo(0.4, 9);
    pool.destroy();
  });

  it('re-bases the frozen contour it erases, so the fade departs from where it now stops', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // A four-second decay under a one-second region, so the contour is still running at BOTH
    // the old fade start and the new one and the two levels differ.
    const decaying: AhdsrEnvelope = {
      attack: 0,
      hold: 0,
      decay: 4_000,
      sustain: 0,
      release: 20,
      curve: 'linear',
    };
    pool.trigger(spec(context, { id: 'future', when: 1, velocity: 127, gainDb: 0, amp: decaying }));
    // A §10.2 bend an octave DOWN on a voice that has not started: it doubles the region, so
    // the fade moves later while `contourFrozenAt` keeps the earlier point (issue #144).
    pool.applyProgramDetune('p1', -1_200, 0.95);
    // The re-lay writes the contour AFRESH from the note-on, so no earlier freeze survives it:
    // the level the fade departs from is the contour's value at THIS fade's own start, and the
    // stale frozen point would depart from a level the timeline no longer holds.
    pool.applyPadParam('p1:0', 'ampAttack', 5, 0.95);
    const gain = ampGainsOf(fake)[0]!;
    const held = gain.calls.filter((call) => call.method === 'setValueAtTime');
    const departure = held[held.length - 1]!;
    const fadeStart = departure.args[1]!;
    expect(fadeStart).toBeGreaterThan(2.5); // the bend really did push the region out
    // The contour the re-lay wrote is the one it departs from, read where THAT contour stops.
    expect(departure.args[0]).toBeCloseTo(ampLevelAt(1, { ...decaying, attack: 5 }, 1, fadeStart), 6);
    pool.destroy();
  });

  it('departs an interruption from where the contour STOPPED, not from where it would be', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    const decaying: AhdsrEnvelope = {
      attack: 0,
      hold: 0,
      decay: 4_000,
      sustain: 0,
      release: 20,
      curve: 'linear',
    };
    // A one-second region under a four-second decay: the §5.4 declick freezes the contour a
    // quarter of the way down, and a retune that pushes the region's end out does not restart it.
    pool.trigger(spec(context, { id: 'frozen', velocity: 127, gainDb: 0, amp: decaying }));
    const frozen = ampLevelAt(1, decaying, 0, 1 - DECLICK_MS / 1_000);
    pool.applyPadParam('p1:0', 'detune', -1_200, 0.2);
    // The note-off lands between the old fade start and the new one: `rescheduleDeclick` reads
    // the frozen point and so must this, or the two disagree about one timeline (issue #146).
    pool.release('p1:0', 1.5);
    const gain = ampGainsOf(fake)[0]!;
    const held = gain.calls.filter((call) => call.method === 'setValueAtTime');
    expect(held[held.length - 1]!.args[0]).toBeCloseTo(frozen, 6);
    pool.destroy();
  });

  it('refuses a non-finite time rather than collapsing the contour', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'future', when: 1, amp: FAST }));
    // `clamp` maps NaN to its MINIMUM, which for an envelope time is 0 ms — an instant attack
    // rather than no change at all. A value nobody can interpret contributes nothing (§14 (ak)).
    pool.applyPadParam('p1:0', 'ampAttack', Number.NaN, 0.95);
    expect(ampAttackSeconds(ampGainsOf(fake)[0]!)).toBeCloseTo(0.001, 9);
    pool.destroy();
  });
});
