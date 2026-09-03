/**
 * §6 `VelocityLayer.reverse` at playback (issue #84). The flag was persisted, had a live
 * checkbox in the layers editor, and nothing downstream ever read it.
 *
 * The mirror is the part worth testing: reversing the whole buffer and then applying the
 * SAME trim plays a different part of the sample, so the trim has to be mirrored into the
 * reversed copy's own frame numbering.
 */
import { describe, expect, it } from 'vitest';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import { mirroredTrim, ReversedBufferCache } from './voiceBuffer';
import { playRegion } from './voicePool';

function ramp(context: BaseAudioContext, frames: number, channels = 1): AudioBuffer {
  const buffer = context.createBuffer(channels, frames, 48_000);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < frames; i++) data[i] = i + channel * 1000;
  }
  return buffer;
}

describe('the reversed copy (spec §6)', () => {
  it('reverses every channel independently', () => {
    const { context } = createFakeAudioContext();
    const reversed = new ReversedBufferCache(context).get(ramp(context, 5, 2));
    expect([...reversed.getChannelData(0)]).toEqual([4, 3, 2, 1, 0]);
    expect([...reversed.getChannelData(1)]).toEqual([1004, 1003, 1002, 1001, 1000]);
  });

  it('preserves length, channel count and sample rate', () => {
    const { context } = createFakeAudioContext();
    const source = ramp(context, 7, 2);
    const reversed = new ReversedBufferCache(context).get(source);
    expect(reversed.length).toBe(source.length);
    expect(reversed.numberOfChannels).toBe(source.numberOfChannels);
    expect(reversed.sampleRate).toBe(source.sampleRate);
  });

  it('leaves the original untouched', () => {
    const { context } = createFakeAudioContext();
    const source = ramp(context, 4);
    new ReversedBufferCache(context).get(source);
    expect([...source.getChannelData(0)]).toEqual([0, 1, 2, 3]);
  });
});

describe('mirroredTrim (spec §6)', () => {
  it('mirrors a trim into the reversed copy, so the same audio plays backwards', () => {
    // Frames 2..6 of a 10-frame sample are frames 4..8 of its reverse.
    expect(mirroredTrim(10, 2, 6)).toEqual({ startFrame: 4, endFrame: 8 });
  });

  it('keeps the region the same length', () => {
    const trim = mirroredTrim(100, 10, 40);
    expect(trim.endFrame - trim.startFrame).toBe(30);
  });

  it('treats endFrame 0 as the whole sample, as the schema default means it to', () => {
    expect(mirroredTrim(10, 3, 0)).toEqual({ startFrame: 0, endFrame: 7 });
    expect(mirroredTrim(10, 0, 0)).toEqual({ startFrame: 0, endFrame: 10 });
  });

  it('falls back to the whole sample on an inverted or out-of-range pair', () => {
    expect(mirroredTrim(10, 6, 2)).toEqual({ startFrame: 0, endFrame: 4 });
    expect(mirroredTrim(10, 0, 99)).toEqual({ startFrame: 0, endFrame: 10 });
  });

  it('names the region playRegion would resolve, mirrored', () => {
    const { context } = createFakeAudioContext();
    const buffer = ramp(context, 1000);
    const forward = playRegion(buffer, 100, 400);
    const trim = mirroredTrim(buffer.length, 100, 400);
    const backward = playRegion(buffer, trim.startFrame, trim.endFrame);
    expect(backward.durationSeconds).toBeCloseTo(forward.durationSeconds, 9);
    // The reversed region starts where the forward one ended, counting from the far end.
    expect(backward.offsetSeconds).toBeCloseTo((1000 - 400) / 48_000, 9);
  });
});

describe('ReversedBufferCache (spec §3.2)', () => {
  it('reverses a buffer once, however many voices ask for it', () => {
    const { context } = createFakeAudioContext();
    const cache = new ReversedBufferCache(context);
    const buffer = ramp(context, 8);
    expect(cache.get(buffer)).toBe(cache.get(buffer));
  });

  it('keeps a separate copy per source buffer', () => {
    const { context } = createFakeAudioContext();
    const cache = new ReversedBufferCache(context);
    expect(cache.get(ramp(context, 8))).not.toBe(cache.get(ramp(context, 8)));
  });
});
