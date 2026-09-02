/**
 * Playback-time buffer preparation for the §6 layer flags a voice cannot express on an
 * `AudioBufferSourceNode` (spec §5.4, §6).
 *
 * `reverse` is one of them: Web Audio has no reverse flag, so the sample is reversed once
 * per buffer and cached, and the voice plays the mirror image of its trim inside the
 * reversed copy. Reversing the whole buffer and then applying the SAME trim would play the
 * wrong part of the sample, which is why {@link mirroredTrim} exists rather than the two
 * frame numbers being reused as they stand.
 *
 * Reversal is per decoded buffer, not per voice: a pad hit sixteen times reverses nothing,
 * and a trim edit reverses nothing either, because the trim is applied to the same reversed
 * copy (spec §3.2 — no per-hit allocation).
 */

/** A reversed copy of `buffer`, channel for channel (spec §6 `VelocityLayer.reverse`). */
function reverseAudioBuffer(context: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const reversed = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const scratch = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    buffer.copyFromChannel(scratch, channel);
    scratch.reverse();
    reversed.copyToChannel(scratch, channel);
  }
  return reversed;
}

/**
 * The trim that plays `[startFrame, endFrame)` of a sample from a REVERSED copy of it
 * (spec §6). Frame `f` of the original is frame `frames − 1 − f` of the reverse, so the
 * region mirrors to `[frames − endFrame, frames − startFrame)` — the same audio, played
 * backwards, rather than whatever happens to sit at the original offsets.
 *
 * `endFrame` of 0 is the schema's "whole sample" default (spec §6), resolved against
 * `frames` here so the mirror has a real end to reflect. An out-of-range or inverted pair
 * falls back to the whole buffer, matching {@link playRegion}'s own tolerance.
 */
export function mirroredTrim(
  frames: number,
  startFrame: number,
  endFrame: number,
): { startFrame: number; endFrame: number } {
  const start = Math.min(Math.max(Math.floor(startFrame), 0), frames);
  const requestedEnd = Math.floor(endFrame);
  const end = requestedEnd > start && requestedEnd <= frames ? requestedEnd : frames;
  return { startFrame: frames - end, endFrame: frames - start };
}

/**
 * A cache of reversed buffers, keyed by the buffer they mirror. A `WeakMap` so a sample
 * dropped from the sample cache takes its reversed copy with it (spec §3.2) — nothing has
 * to remember to invalidate it.
 */
export class ReversedBufferCache {
  private readonly cache = new WeakMap<AudioBuffer, AudioBuffer>();

  constructor(private readonly context: BaseAudioContext) {}

  /** The reversed copy of `buffer`, reversing at most once per buffer. */
  get(buffer: AudioBuffer): AudioBuffer {
    const cached = this.cache.get(buffer);
    if (cached) return cached;
    const reversed = reverseAudioBuffer(this.context, buffer);
    this.cache.set(buffer, reversed);
    return reversed;
  }
}
