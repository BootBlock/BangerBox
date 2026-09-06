/**
 * A voice is RELEASED — spec §5.4 "note-off applies the amp envelope release; the `ended`
 * event finalises voice teardown" (issue #145).
 *
 * Nothing in the application used to reach {@link VoicePool.release}: the §7.1.4 dispatcher
 * discarded `noteOff`, `ScheduledEvent.durationSec` was read by nobody, `VoiceTriggerSpec` had
 * no duration field at all, and `triggerLiveNote(…, false)` reached only the scheduler. Every
 * voice therefore played its whole region and ended on the §5.4 declick, and the §6 release
 * stage was silent live and in every §9.5 bounce.
 *
 * **A sequenced note's off is laid at that note's own NOTE-ON, from the length the note
 * states.** That is what binds it to the voice it belongs to: `poly` lets two hits of one pad
 * overlap, so an off addressed by pad and note — all a §7.1.3 `noteOff` could carry — cannot
 * say which of them it ends, and a §9.5 render, which builds every voice before it applies any
 * ramp, would have no way to tell them apart either. {@link VoicePool.release} exists for the
 * §7.6 live path, where a held pad can only be held once.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope, type AhdsrEnvelope } from '@/core/project/schemas';
import { createFakeAudioContext, type FakeAudioContext } from '@/test/mocks/audioContext';
import { VoicePool, type VoiceTriggerSpec } from './voicePool';

/** Four seconds of region, so a note-off a second or two in is well inside it. */
const REGION_SECONDS = 4;

/** A 1 ms attack straight to full sustain: the only thing that moves the gain is the release. */
const FLAT: AhdsrEnvelope = { attack: 1, hold: 0, decay: 0, sustain: 1, release: 120, curve: 'linear' };

function spec(context: AudioContext, over: Partial<VoiceTriggerSpec> = {}): VoiceTriggerSpec {
  return {
    id: over.id ?? crypto.randomUUID(),
    buffer: context.createBuffer(1, 48_000 * REGION_SECONDS, 48_000),
    destination: over.destination ?? context.createGain(),
    when: 0,
    velocity: 127,
    playbackMode: 'poly',
    chokeGroup: 0,
    programId: 'p1',
    padKey: 'p1:0',
    note: 0,
    amp: FLAT,
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

/** The amp gains of every voice built so far, in build order. */
function ampGains(fake: FakeAudioContext): FakeParam[] {
  return fake.nodes
    .filter((n) => n.nodeType === 'gain')
    .map((n) => (n as unknown as { gain: FakeParam }).gain)
    .filter((gain) => gain.calls.length > 0);
}

/** Context time the last ramp on an amp param reaches its target — where the voice goes silent. */
function silentAt(gain: FakeParam): number {
  const ramps = gain.calls.filter((call) => call.method === 'linearRampToValueAtTime');
  return ramps[ramps.length - 1]!.args[1]!;
}

/** The level the last fade on an amp param departs from — its `setValueAtTime` anchor. */
function departure(gain: FakeParam): { level: number; at: number } {
  const held = gain.calls.filter((call) => call.method === 'setValueAtTime');
  const last = held[held.length - 1]!;
  return { level: last.args[0]!, at: last.args[1]! };
}

/** Whether the nth voice's source has had `stop()` scheduled — a §5.4 steal, choke or mono cut. */
function sourceStopped(fake: FakeAudioContext, index: number): boolean {
  const sources = fake.nodes.filter((n) => n.nodeType === 'bufferSource');
  return (sources[index] as unknown as { stopped: boolean }).stopped;
}

/** Every ramp on an amp param that reaches zero, in the order they were scheduled. */
function fadesToZero(gain: FakeParam): number[] {
  return gain.calls
    .filter((call) => call.method === 'linearRampToValueAtTime' && call.args[0] === 0)
    .map((call) => call.args[1]!);
}

describe('a voice is released (spec §5.4, issue #145)', () => {
  it('lays a sequenced note-off from the length the note states', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'sequenced', durationSec: 0.5 }));
    // The §6 release runs from the note-off at 0.5 s and reaches zero 120 ms later — where
    // before this the only fade on the timeline was the §5.4 declick at the region's end.
    expect(silentAt(ampGains(fake)[0]!)).toBeCloseTo(0.62, 9);
    pool.destroy();
  });

  it('binds each overlapping voice of one pad to its OWN length', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // The case a §7.1.3 `noteOff` addressed by pad and note could not express, and the reason
    // the off is laid at the note-on instead: both voices are `p1:0` note 0 at once.
    pool.trigger(spec(context, { id: 'long', when: 0, durationSec: 2 }));
    pool.trigger(spec(context, { id: 'short', when: 0.25, durationSec: 0.25 }));
    const [long, short] = ampGains(fake);
    expect(silentAt(long!)).toBeCloseTo(2.12, 9);
    expect(silentAt(short!)).toBeCloseTo(0.62, 9);
    pool.destroy();
  });

  it('ignores a stated length on a oneShot pad, which plays to the sample end', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'one', playbackMode: 'oneShot', durationSec: 0.5 }));
    // spec §5.4: the only fade left is the declick landing on the region's own end.
    expect(silentAt(ampGains(fake)[0]!)).toBeCloseTo(REGION_SECONDS, 9);
    pool.destroy();
  });

  it('lays no note-off for a note that states no length', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // A §7.3 note-repeat hit emits `durationSec: 0` — it has no gate to state, and §7.7's
    // minimum note is one tick, so zero is never a length a note really has. A §7.6 live
    // audition omits the field entirely and is released when the pad is let go.
    pool.trigger(spec(context, { id: 'repeat', durationSec: 0 }));
    pool.trigger(spec(context, { id: 'live', when: 0.1 }));
    const [repeat, live] = ampGains(fake);
    expect(silentAt(repeat!)).toBeCloseTo(REGION_SECONDS, 9);
    expect(silentAt(live!)).toBeCloseTo(0.1 + REGION_SECONDS, 9);
    pool.destroy();
  });

  it('departs the release from the level the §6 contour holds at the note-off', () => {
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
    pool.trigger(spec(context, { id: 'decaying', amp: decaying, durationSec: 0.2 }));
    const anchor = departure(ampGains(fake)[0]!);
    expect(anchor.at).toBeCloseTo(0.2, 9);
    expect(anchor.level).toBeCloseTo(0.625, 6);
    pool.destroy();
  });

  it('keeps the §5.4 declick on the region end when the release outlives the region', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // A two-second release from a note-off three seconds into a four-second region: the ramp
    // would still be at a third of its level when the buffer runs out, which is the step §5.4's
    // declick exists to prevent. The declick keeps the region's end and departs from the
    // RELEASE line there, not from the §6 contour.
    const slow: AhdsrEnvelope = { ...FLAT, release: 2_000 };
    pool.trigger(spec(context, { id: 'ringing', amp: slow, durationSec: 3 }));
    const gain = ampGains(fake)[0]!;
    // Both fades are on the timeline, the declick last so it truncates the release into it.
    expect(fadesToZero(gain)).toEqual([REGION_SECONDS, 5, REGION_SECONDS]);
    const anchor = departure(gain);
    expect(anchor.at).toBeCloseTo(REGION_SECONDS - 0.003, 9);
    // 0.997 s into a 2 s release from unity: 1 − 0.997/2.
    expect(anchor.level).toBeCloseTo(0.5015, 6);
    pool.destroy();
  });

  it('lays nothing for a note-off inside the §5.4 declick, which has nothing left to fade', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // The last three milliseconds of the voice: that fade already reaches true zero at the
    // region's end, sooner than any §6 release could, and a release there could only lift the
    // level back up.
    pool.trigger(spec(context, { id: 'late', durationSec: REGION_SECONDS - 0.001 }));
    const gain = ampGains(fake)[0]!;
    expect(fadesToZero(gain)).toEqual([REGION_SECONDS]);
    pool.destroy();
  });

  it('releases only the note let go of, when a whole keygroup shares one pad key', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // `resolveKeygroupVoice` gives every voice of a keygroup program the one key
    // `${id}:keygroup`, so releasing by key alone would take the rest of the chord with the
    // key the player let go of.
    const key = 'keys:keygroup';
    pool.trigger(spec(context, { id: 'c', padKey: key, note: 60 }));
    pool.trigger(spec(context, { id: 'e', padKey: key, note: 64 }));
    pool.release(key, 60, 1);
    const [c, e] = ampGains(fake);
    expect(silentAt(c!)).toBeCloseTo(1.12, 9);
    expect(silentAt(e!)).toBeCloseTo(REGION_SECONDS, 9);
    pool.destroy();
  });

  it('keeps the first note-off a voice is given', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'held' }));
    pool.release('p1:0', 0, 1);
    pool.release('p1:0', 0, 2); // a second note-off for a pad already let go of
    expect(silentAt(ampGains(fake)[0]!)).toBeCloseTo(1.12, 9);
    pool.destroy();
  });

  it('steals a voice whose note-off has PASSED before an older one still sustaining', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context, 2);
    // spec §5.4 steals the oldest RELEASED voice first. A note-off laid ahead of time has
    // released nothing yet, so the oldest voice must not be judged released merely by carrying
    // one — that would steal the loudest voice in the pool every time.
    pool.trigger(spec(context, { id: 'oldest', when: 0, durationSec: 3 }));
    pool.trigger(spec(context, { id: 'newer', when: 0.5, durationSec: 0.1 }));
    // At 1 s the newer voice's note-off has passed and the older one's has not.
    pool.trigger(spec(context, { id: 'third', when: 1 }));
    expect(sourceStopped(fake, 0)).toBe(false);
    expect(sourceStopped(fake, 1)).toBe(true);
    pool.destroy();
  });
});

describe('a released voice and the rest of §5.4', () => {
  it('lets a choke depart from the release line the voice is already on', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(
      spec(context, { id: 'openhat', chokeGroup: 1, amp: { ...FLAT, release: 1_000 }, durationSec: 0.5 }),
    );
    // Half a second into a one-second release from unity, the voice holds 0.5 — and a §5.4
    // choke fade departs from where the voice ACTUALLY is, which before issue #145 could only
    // ever be the §6 contour because nothing released a voice at all.
    pool.trigger(spec(context, { id: 'closedhat', padKey: 'p1:1', note: 1, chokeGroup: 1, when: 1 }));
    const anchor = departure(ampGains(fake)[0]!);
    expect(anchor.at).toBeCloseTo(1, 9);
    expect(anchor.level).toBeCloseTo(0.5, 6);
    pool.destroy();
  });
});

describe('the §6 default playback mode (spec §5.4, §14 (bb))', () => {
  it('is what a note-off means for a pad nobody has configured', () => {
    // `createDefaultPad` is what a user gets by dropping a sample on a pad, and it is
    // `oneShot` by the human developer's §13.3.2 decision — so a hit rings out rather than
    // being cut at its 240-tick Grid length. The mode a user then picks means exactly what
    // §5.4 says it does, which is what this file's other cases pin.
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    const amp = createDefaultEnvelope();
    pool.trigger(spec(context, { id: 'default', playbackMode: 'oneShot', amp, durationSec: 0.125 }));
    expect(silentAt(ampGains(fake)[0]!)).toBeCloseTo(REGION_SECONDS, 9);
    pool.destroy();
  });
});
