import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope } from '@/core/project/schemas';
import { createFakeAudioContext, liveNodeCount } from '@/test/mocks/audioContext';
import { VoicePool, type VoiceTriggerSpec } from './voicePool';

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
function sourceState(node: unknown): { started: boolean; stopped: boolean } {
  return node as { started: boolean; stopped: boolean };
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
