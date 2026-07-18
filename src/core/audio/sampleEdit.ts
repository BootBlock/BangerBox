/**
 * Sample-editor destructive DSP (spec §8.5.4) — pure, non-destructive functions over planar
 * Float32 channels: Normalise, Reverse, Fade in/out and Trim. Each returns freshly allocated
 * channels and never mutates its input, so the caller can render the result to a new OPFS
 * file (new `sampleId`; undo swaps the pointer back — spec §8.5.4). Dependency-free for
 * trivial unit testing (spec §2.5); Chop and Time-stretch live in their own modules.
 */

/** The maximum absolute sample across all channels (0 for silence). */
export function peakOf(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const abs = Math.abs(channel[i]!);
      if (abs > peak) peak = abs;
    }
  }
  return peak;
}

/**
 * Peak-normalise so the loudest sample across all channels reaches `targetPeak` (spec §8.5.4).
 * One shared gain is applied to every channel so the stereo balance is preserved; silence is
 * returned unchanged (no divide-by-zero).
 */
export function normalise(channels: readonly Float32Array[], targetPeak = 1): Float32Array[] {
  const peak = peakOf(channels);
  const gain = peak > 0 ? targetPeak / peak : 1;
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) out[i] = channel[i]! * gain;
    return out;
  });
}

/** Reverse every channel (spec §8.5.4). */
export function reverse(channels: readonly Float32Array[]): Float32Array[] {
  return channels.map((channel) => {
    const out = new Float32Array(channel.length);
    const last = channel.length - 1;
    for (let i = 0; i < channel.length; i++) out[i] = channel[last - i]!;
    return out;
  });
}

/** Fade-curve laws (spec §8.5.4). Linear is the default; equal-power keeps constant energy. */
export type FadeCurve = 'linear' | 'equalPower';

function fadeGain(progress: number, curve: FadeCurve): number {
  return curve === 'equalPower' ? Math.sin(progress * (Math.PI / 2)) : progress;
}

/** Ramp the first `frames` samples up from silence to unity (spec §8.5.4). */
export function fadeIn(
  channels: readonly Float32Array[],
  frames: number,
  curve: FadeCurve = 'linear',
): Float32Array[] {
  return channels.map((channel) => {
    const span = Math.max(0, Math.min(frames, channel.length));
    const out = Float32Array.from(channel);
    for (let i = 0; i < span; i++) out[i] = channel[i]! * fadeGain(i / span, curve);
    return out;
  });
}

/**
 * Ramp the last `frames` samples down to silence at the final sample (spec §8.5.4). The
 * mirror of {@link fadeIn}: gain steps from `(span−1)/span` at the region start down to 0 at
 * the last sample, so a full-length fade-out is exactly the reverse of a full-length fade-in.
 */
export function fadeOut(
  channels: readonly Float32Array[],
  frames: number,
  curve: FadeCurve = 'linear',
): Float32Array[] {
  return channels.map((channel) => {
    const span = Math.max(0, Math.min(frames, channel.length));
    const out = Float32Array.from(channel);
    const last = channel.length - 1;
    for (let i = 0; i < span; i++) {
      const fromEnd = last - i; // absolute index; i = 0 is the final sample
      out[fromEnd] = channel[fromEnd]! * fadeGain(i / span, curve);
    }
    return out;
  });
}

/**
 * Run a length-preserving transform over just `[startFrame, endFrame)` and splice the result
 * back into a copy of the full sample (spec §8.5.4 region tools) — how Normalise and the fades
 * apply to the editor's selection rather than to the whole file. Audio outside the region is
 * copied through untouched.
 *
 * `transform` must return channels the same length it was given; it is handed the region, not
 * the file, so a fade's ramp spans the selection. A transform that changes the length (Trim)
 * cannot be spliced back and is applied directly instead.
 */
export function applyToRegion(
  channels: readonly Float32Array[],
  startFrame: number,
  endFrame: number,
  transform: (region: Float32Array[]) => Float32Array[],
): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  const start = Math.max(0, Math.min(startFrame, length));
  const end = Math.max(0, Math.min(endFrame, length));
  if (end <= start) throw new Error(`applyToRegion: empty range [${start}, ${end})`);
  const processed = transform(channels.map((channel) => channel.slice(start, end)));
  return channels.map((channel, index) => {
    const out = Float32Array.from(channel);
    const region = processed[index];
    if (region) out.set(region.subarray(0, end - start), start);
    return out;
  });
}

/**
 * Slice the half-open frame range `[startFrame, endFrame)` from every channel (spec §8.5.4
 * Trim). Bounds are clamped into the sample; an empty or inverted resulting range throws so a
 * zero-length sample is never written.
 */
export function trim(
  channels: readonly Float32Array[],
  startFrame: number,
  endFrame: number,
): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  const start = Math.max(0, Math.min(startFrame, length));
  const end = Math.max(0, Math.min(endFrame, length));
  if (end <= start) throw new Error(`trim: empty range [${start}, ${end})`);
  return channels.map((channel) => channel.slice(start, end));
}
