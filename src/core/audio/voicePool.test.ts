import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope, createDefaultLfo, type ModRoute } from '@/core/project/schemas';
import { createFakeAudioContext, liveNodeCount, type FakeAudioContext } from '@/test/mocks/audioContext';
import { playRegion, VoicePool, type VoiceTriggerSpec } from './voicePool';

/** Count fake nodes of a given type registered on the context. */
function nodeCount(fake: FakeAudioContext, type: string): number {
  return fake.nodes.filter((n) => n.nodeType === type).length;
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
    ...over,
  };
}

/** Reach into a fake source node to inspect its start/stop state. */
function sourceState(node: unknown): {
  started: boolean;
  stopped: boolean;
  startArgs: { when?: number; offset?: number; duration?: number } | null;
} {
  return node as {
    started: boolean;
    stopped: boolean;
    startArgs: { when?: number; offset?: number; duration?: number } | null;
  };
}

/** Access a fake AudioParam's recorded schedule calls. */
function paramCalls(param: unknown): { method: string; args: number[] }[] {
  return (param as { calls: { method: string; args: number[] }[] }).calls;
}

describe('voice pool (spec §5.4)', () => {
  it('starts a voice connected into the pad destination', () => {
    const { context } = createFakeAudioContext();
    const pool = new VoicePool(context);
    const destination = context.createGain();
    pool.trigger(spec(context, { id: 'v1', destination }));
    expect(pool.activeVoiceCount()).toBe(1);
    pool.destroy();
  });

  it('plays overlapping voices polyphonically', () => {
    const { context } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'a', padKey: 'p1:0' }));
    pool.trigger(spec(context, { id: 'b', padKey: 'p1:1' }));
    pool.trigger(spec(context, { id: 'c', padKey: 'p1:2' }));
    expect(pool.activeVoiceCount()).toBe(3);
    pool.destroy();
  });

  it('cuts the previous voice of the same pad in mono mode', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'a', playbackMode: 'mono', padKey: 'p1:0' }));
    const firstSource = fake.nodes.find((n) => n.nodeType === 'bufferSource');
    pool.trigger(spec(context, { id: 'b', playbackMode: 'mono', padKey: 'p1:0' }));
    expect(sourceState(firstSource).stopped).toBe(true); // retrigger cut the previous voice
    pool.destroy();
  });

  it('chokes other pads sharing a choke group (spec §5.4)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'openhat', padKey: 'p1:2', chokeGroup: 1 }));
    const openHatSource = fake.nodes.find((n) => n.nodeType === 'bufferSource');
    pool.trigger(spec(context, { id: 'closedhat', padKey: 'p1:3', chokeGroup: 1 }));
    expect(sourceState(openHatSource).stopped).toBe(true);
    pool.destroy();
  });

  it('steals a voice when the pool is exhausted, fading not cutting', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context, 2);
    pool.trigger(spec(context, { id: 'a', when: 0, padKey: 'p1:0' }));
    const oldest = fake.nodes.find((n) => n.nodeType === 'bufferSource');
    pool.trigger(spec(context, { id: 'b', when: 1, padKey: 'p1:1' }));
    pool.trigger(spec(context, { id: 'c', when: 2, padKey: 'p1:2' })); // exhausts → steals 'a'
    expect(sourceState(oldest).stopped).toBe(true);
    pool.destroy();
  });

  it('releases sustaining voices on note-off but not oneShot voices', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'poly', padKey: 'p1:0', playbackMode: 'poly' }));
    const polySource = fake.nodes.find((n) => n.nodeType === 'bufferSource');
    pool.release('p1:0', 1);
    expect(sourceState(polySource).stopped).toBe(true);

    const { context: ctx2, fake: fake2 } = createFakeAudioContext();
    const pool2 = new VoicePool(ctx2);
    pool2.trigger(spec(ctx2, { id: 'one', padKey: 'p1:0', playbackMode: 'oneShot' }));
    const oneShotSource = fake2.nodes.find((n) => n.nodeType === 'bufferSource');
    pool2.release('p1:0', 1);
    expect(sourceState(oneShotSource).stopped).toBe(false); // oneShot ignores note-off
    pool2.destroy();
    pool.destroy();
  });

  it('tears down every voice on destroy (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'a' }));
    pool.trigger(spec(context, { id: 'b' }));
    pool.destroy();
    expect(pool.activeVoiceCount()).toBe(0);
    expect(liveNodeCount(fake)).toBe(0);
  });
});

describe('playRegion (spec §6 trim)', () => {
  const buffer = (frames: number, rate = 48_000): AudioBuffer =>
    createFakeAudioContext(rate).context.createBuffer(1, frames, rate);

  it('plays the whole sample when the trim is the 0/0 schema default', () => {
    expect(playRegion(buffer(48_000), 0, 0)).toEqual({ offsetSeconds: 0, durationSeconds: 1 });
  });

  it('maps a frame range onto buffer seconds', () => {
    expect(playRegion(buffer(48_000), 12_000, 24_000)).toEqual({
      offsetSeconds: 0.25,
      durationSeconds: 0.25,
    });
  });

  it('falls back to the buffer end for an inverted or out-of-range trim', () => {
    // A stale trim must never silence a pad — it degrades to "play to the end".
    expect(playRegion(buffer(1_000), 400, 200).durationSeconds).toBeCloseTo(600 / 48_000);
    expect(playRegion(buffer(1_000), 0, 9_999).durationSeconds).toBeCloseTo(1_000 / 48_000);
  });
});

describe('voice endings (spec §5.4 declick)', () => {
  /** The voice's own amp gain — the last gain node created by the trigger. */
  function ampGain(fake: FakeAudioContext): unknown {
    const gains = fake.nodes.filter((n) => n.nodeType === 'gain');
    return (gains[gains.length - 1] as unknown as { gain: unknown }).gain;
  }

  it('fades to zero at the end of the buffer rather than cutting hard', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'd', when: 0 })); // 1 s buffer at unity rate
    const ramps = paramCalls(ampGain(fake)).filter((c) => c.method === 'linearRampToValueAtTime');
    expect(ramps[ramps.length - 1]!.args).toEqual([0, 1]); // silent exactly at the buffer end
    pool.destroy();
  });

  it('places the declick relative to the trimmed end, not the buffer end', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 't', when: 0, startFrame: 0, endFrame: 24_000 }));
    const ramps = paramCalls(ampGain(fake)).filter((c) => c.method === 'linearRampToValueAtTime');
    expect(ramps[ramps.length - 1]!.args).toEqual([0, 0.5]);
    pool.destroy();
  });

  it('scales the end time by the voice detune, so a repitched voice fades at its real end', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // +1200 cents = double rate, so a 1 s buffer sounds for 0.5 s.
    pool.trigger(spec(context, { id: 'oct', when: 0, tuneCents: 1200 }));
    const ramps = paramCalls(ampGain(fake)).filter((c) => c.method === 'linearRampToValueAtTime');
    expect(ramps[ramps.length - 1]!.args[1]).toBeCloseTo(0.5);
    pool.destroy();
  });

  it('starts the source at the trim offset for the trimmed duration (spec §6)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'trim', when: 0, startFrame: 12_000, endFrame: 24_000 }));
    const source = fake.nodes.find((n) => n.nodeType === 'bufferSource');
    expect(sourceState(source).startArgs).toEqual({ when: 0, offset: 0.25, duration: 0.25 });
    pool.destroy();
  });
});

describe('enriched voice — §6 sound design', () => {
  it('inserts a biquad filter into the chain when the pad filter is active (spec §5.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'f', filter: { type: 'lp', cutoff: 800, resonance: 4, envDepth: 0 } }));
    expect(nodeCount(fake, 'biquad')).toBe(1);
    pool.destroy();
    expect(liveNodeCount(fake)).toBe(0);
  });

  it('omits the filter node when the pad filter is off', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(
      spec(context, { id: 'nf', filter: { type: 'off', cutoff: 800, resonance: 1, envDepth: 0 } }),
    );
    expect(nodeCount(fake, 'biquad')).toBe(0);
    pool.destroy();
  });

  it('wires an LFO oscillator for a routed LFO and tears it down leak-free (spec §6)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    const modMatrix: ModRoute[] = [{ source: 'lfo1', target: 'pitch', amount: 0.5 }];
    pool.trigger(
      spec(context, {
        id: 'lfo',
        lfos: [createDefaultLfo(), createDefaultLfo()],
        modMatrix,
      }),
    );
    expect(nodeCount(fake, 'oscillator')).toBe(1);
    pool.destroy();
    expect(liveNodeCount(fake)).toBe(0);
  });

  it('creates no oscillator when no LFO route is present', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(
      spec(context, { id: 'no-lfo', lfos: [createDefaultLfo(), createDefaultLfo()], modMatrix: [] }),
    );
    expect(nodeCount(fake, 'oscillator')).toBe(0);
    pool.destroy();
  });

  it('counts live voices per program (keygroup polyphony bookkeeping, spec §6)', () => {
    const { context } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'a', programId: 'keys', padKey: 'keys:0' }));
    pool.trigger(spec(context, { id: 'b', programId: 'keys', padKey: 'keys:0' }));
    pool.trigger(spec(context, { id: 'c', programId: 'drum', padKey: 'drum:0' }));
    expect(pool.programVoiceCount('keys')).toBe(2);
    expect(pool.programVoiceCount('drum')).toBe(1);
    pool.destroy();
  });

  it('caps a keygroup program to its polyphony, stealing the oldest voice (spec §6)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    const key = (id: string) =>
      spec(context, { id, programId: 'keys', padKey: `keys:${id}`, programPolyphony: 2 });
    pool.trigger(key('a'));
    const oldest = fake.nodes.find((n) => n.nodeType === 'bufferSource');
    pool.trigger(key('b'));
    pool.trigger(key('c')); // third voice exceeds polyphony 2 → oldest ('a') is stolen
    expect((oldest as { stopped: boolean }).stopped).toBe(true);
    pool.destroy();
  });

  it('portamentos into a mono glide note from the previous pitch (spec §6)', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    const glideSpec = (id: string, tuneSemitones: number) =>
      spec(context, { id, playbackMode: 'mono', padKey: 'keys:glide', glideMs: 100, tuneSemitones });
    pool.trigger(glideSpec('a', 0));
    pool.trigger(glideSpec('b', 12)); // glide from 0 → 1200 cents
    const sources = fake.nodes.filter((n) => n.nodeType === 'bufferSource');
    const newest = sources[sources.length - 1] as { detune: { calls: { method: string; args: number[] }[] } };
    const ramp = newest.detune.calls.find((c) => c.method === 'linearRampToValueAtTime');
    expect(ramp?.args[0]).toBe(1200); // ramps to the new note's detune
    const start = newest.detune.calls.find((c) => c.method === 'setValueAtTime');
    expect(start?.args[0]).toBe(0); // starting from the previous note's detune
    pool.destroy();
  });
});
