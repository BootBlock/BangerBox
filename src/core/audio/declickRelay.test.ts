/**
 * The §5.4 declick's RE-LAY, and the §6 contour it departs from (issue #146).
 *
 * A retune moves the moment a voice's region runs out, so the end-of-buffer fade is laid
 * again — and the level it departs from has to be the level the amp timeline really holds
 * there. `Voice.contourFrozenAt` used to model that as a running MINIMUM of every fade start
 * the voice has had, on §14 `(ay)`'s claim that each lay "truncates the §6 AHDSR at its own
 * fade start and nothing restarts it". Measured in Edge, the truncation is real and the
 * conclusion is not: nothing has to stop the contour, and freezing it holds a voice at a
 * level its own §6 envelope left behind — 3.91 dB on a 60 ms region under a 500 ms decay.
 *
 * These tests read the SCHEDULE rather than a rendered signal, because the §11.3 fake context
 * records calls rather than implementing them. The rendered answer is
 * `renderRetunedAmpProfileOffline` (spec §11.2) and the §11.4 `declickContourProof` step.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope } from '@/core/project/schemas';
import { createFakeAudioContext, type FakeAudioContext } from '@/test/mocks/audioContext';
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
    note: 0,
    amp: createDefaultEnvelope(),
    gainDb: 0,
    tuneSemitones: 0,
    tuneCents: 0,
    ...over,
  };
}

function paramCalls(param: unknown): { method: string; args: number[] }[] {
  return (param as { calls: { method: string; args: number[] }[] }).calls;
}

/** The first voice's amp `gain` — the only gain the pool schedules on. */
function ampGain(fake: FakeAudioContext): unknown {
  const node = fake.nodes.find(
    (n) => n.nodeType === 'gain' && paramCalls((n as { gain: unknown }).gain).length > 0,
  );
  return (node as { gain: unknown }).gain;
}

/** The last value pinned on the amp timeline — the level whatever ramp follows departs from. */
function lastDeparture(fake: FakeAudioContext): { method: string; args: number[] } | undefined {
  return paramCalls(ampGain(fake))
    .filter((c) => c.method === 'setValueAtTime')
    .at(-1);
}

/** Peak amp gain of the shared spec: velocity 100 of 127 at 0 dB (spec §5.4). */
const PEAK = 100 / 127;

/** A §6 envelope still decaying long after a short region's fade would begin. */
const SLOW_DECAY = createDefaultEnvelope({ attack: 1, hold: 0, decay: 500, sustain: 0.2 });

describe('VoicePool — the §5.4 declick re-lay (issue #146)', () => {
  it('departs a re-laid fade from the level the §6 contour holds at the NEW fade start', () => {
    // A 60 ms region under the default 60 ms decay: the first fade begins at 57 ms, while the
    // contour is still decaying. Bending down an octave 10 ms in doubles what is left, so the
    // region ends at 110 ms and the fade begins at 107 ms — past the contour's own decay end
    // at 61 ms, where it holds peak × sustain. Freezing the contour at 57 ms departs from
    // 0.63936 instead, a level the envelope has already left behind.
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'relay', when: 0, startFrame: 0, endFrame: 2_880 }));
    pool.applyProgramDetune('p1', -1200, 0.01);
    const departure = lastDeparture(fake);
    expect(departure?.args[1]).toBeCloseTo(0.107, 6);
    expect(departure?.args[0]).toBeCloseTo(PEAK * 0.8, 5); // 0.62992
    pool.destroy();
  });

  it('keeps following the contour across successive re-lays, rather than walking a frozen one', () => {
    // A §7.8 pitch lane re-lays every `SCHEDULER_INTERVAL_MS`, so this is the shape that
    // matters most. A 60 ms region under a 500 ms decay is still a long way from its sustain
    // when its first fade begins; two retunes push the fade out to 197 ms, where the contour
    // holds 0.41899. The frozen reading stays at the 57 ms level, 0.65752 — 3.91 dB louder
    // than the voice's own §6 envelope, and it never comes back down.
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'twice', when: 0, startFrame: 0, endFrame: 2_880, amp: SLOW_DECAY }));
    pool.applyProgramDetune('p1', -1200, 0.01);
    pool.applyProgramDetune('p1', -2400, 0.02);
    const departure = lastDeparture(fake);
    expect(departure?.args[1]).toBeCloseTo(0.197, 6);
    expect(departure?.args[0]).toBeCloseTo(0.41899, 5);
    pool.destroy();
  });

  it('re-writes the §6 contour over the stretch a re-lay adds, not just the fade at its end', () => {
    // The level above is only right if the contour is really running there, and that is a
    // claim about the SCHEDULE. The re-lay must anchor on the contour's value at the retune
    // (0.76492 at 10 ms) and RAMP from there to its value at the new fade start (0.55978 at
    // 107 ms), because the level any of this file's readers gives is a lie unless a segment on
    // the param draws it. The old shape wrote neither: it erased at the old fade start and put
    // one `setValueAtTime` at the new one, so the param held the 57 ms level in between.
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'contour', when: 0, startFrame: 0, endFrame: 2_880, amp: SLOW_DECAY }));
    const before = paramCalls(ampGain(fake)).length;
    pool.applyProgramDetune('p1', -1200, 0.01);
    const written = paramCalls(ampGain(fake)).slice(before);
    const anchor = written.find((c) => c.method === 'setValueAtTime');
    expect(anchor?.args).toEqual([expect.closeTo(0.76492, 5), expect.closeTo(0.01, 6)]);
    const ramp = written.find((c) => c.method === 'exponentialRampToValueAtTime');
    expect(ramp?.args).toEqual([expect.closeTo(0.55978, 5), expect.closeTo(0.107, 6)]);
    pool.destroy();
  });

  it('departs a SHORTENED region’s fade from the contour there too', () => {
    // The mirror case, and the one the running minimum could never have caught: bending UP
    // pulls the region's end in, so the new fade start is EARLIER than the old one.
    // `contourFrozenAt` does move for this one — it is a minimum — so the level it gave was
    // right, and the timeline underneath it was not. The first lay's `cancelAndHoldAtTime`
    // had replaced the §6 decay ramp with a held value, and the re-lay's earlier cancel then
    // removed that too: measured in Edge, the param holds the PEAK across the whole stretch
    // and steps DOWN to the departure level at the fade start, which is the click §5.4 forbids.
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'short', when: 0, startFrame: 0, endFrame: 9_600, amp: SLOW_DECAY }));
    const before = paramCalls(ampGain(fake)).length;
    pool.applyProgramDetune('p1', 1200, 0.01); // an octave up halves what is left: 200 ms → 105 ms
    const written = paramCalls(ampGain(fake)).slice(before);
    const ramp = written.find((c) => c.method === 'exponentialRampToValueAtTime');
    expect(ramp?.args).toEqual([expect.closeTo(0.56886, 5), expect.closeTo(0.102, 6)]);
    const departure = lastDeparture(fake);
    expect(departure?.args).toEqual([expect.closeTo(0.56886, 5), expect.closeTo(0.102, 6)]);
    pool.destroy();
  });

  it('erases from where this lay BEGINS, never from the old fade start', () => {
    // The one cancel a lay makes, and the whole reason it sits where it does.
    // `cancelAndHoldAtTime` truncates the ramp it finds at or after the cancel time and
    // REPLACES it with a held value — so cancelling at the old fade start leaves the stretch
    // before it described by that held value alone, and the next lay, cancelling earlier
    // still, removes it and the stretch with it. Cancelling where this lay begins finds the
    // previous span's closing ramp instead, which truncates correctly.
    //
    // The §11.3 fake context records the call rather than performing it, so this is the half a
    // unit test can see. What the param then HOLDS is `declickContourProof`'s retuned profile.
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'erase', when: 0, startFrame: 0, endFrame: 2_880, amp: SLOW_DECAY }));
    pool.applyProgramDetune('p1', -1200, 0.01);
    const cancels = paramCalls(ampGain(fake)).filter((c) => c.method === 'cancelAndHoldAtTime');
    expect(cancels.at(-1)?.args[0]).toBeCloseTo(0.01, 6); // the retune, not the 57 ms fade start
    pool.destroy();
  });

  it('departs a §5.4 steal after a re-lay from the running contour, not the frozen one', () => {
    // §14 `(az)` item (12) made `ampLevelNow` clamp to `contourFrozenAt` so this file kept ONE
    // model of the timeline, and said plainly that whether the model was right at all was this
    // issue. It is not: a steal at 80 ms, after a retune has pushed the region's end out to
    // 110 ms, departs from the contour's 0.61060 rather than the 0.65752 frozen at 57 ms.
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(
      spec(context, {
        id: 'stolen',
        when: 0,
        startFrame: 0,
        endFrame: 2_880,
        amp: SLOW_DECAY,
        playbackMode: 'mono',
      }),
    );
    const amp = ampGain(fake);
    pool.applyProgramDetune('p1', -1200, 0.01);
    const before = paramCalls(amp).length;
    // A mono retrigger of the same pad cuts the sounding voice (spec §5.4).
    pool.trigger(
      spec(context, {
        id: 'next',
        when: 0.08,
        startFrame: 0,
        endFrame: 2_880,
        amp: SLOW_DECAY,
        playbackMode: 'mono',
      }),
    );
    const cut = paramCalls(amp)
      .slice(before)
      .filter((c) => c.method === 'setValueAtTime')
      .find((c) => Math.abs(c.args[1]! - 0.08) < 1e-6);
    expect(cut?.args[0]).toBeCloseTo(0.6106, 4);
    pool.destroy();
  });

  it('departs a §5.4 note-off after a re-lay from the running contour', () => {
    // The other reader of the same model (issue #145): `preDeclickLevel` is where a note-off
    // joins it, so whatever this issue settles has to move both answers together. A note-off
    // at 80 ms on a voice whose region a retune pushed to 110 ms departs from the same 0.61060.
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { id: 'held', when: 0, startFrame: 0, endFrame: 2_880, amp: SLOW_DECAY }));
    const amp = ampGain(fake);
    pool.applyProgramDetune('p1', -1200, 0.01);
    const before = paramCalls(amp).length;
    pool.release('p1:0', 0, 0.08);
    const off = paramCalls(amp)
      .slice(before)
      .filter((c) => c.method === 'setValueAtTime')
      .find((c) => Math.abs(c.args[1]! - 0.08) < 1e-6);
    expect(off?.args[0]).toBeCloseTo(0.6106, 4);
    pool.destroy();
  });
});
