// Procedural synthesis primitives for the factory kits (spec §9.8 "Provenance": ALL shipped
// audio is generated from pure synthesis — no sampled, recorded or third-party material, so
// the publicly deployed MIT-licensed repo carries no provenance risk).
//
// Everything here is a pure function of its arguments plus a seeded PRNG (`./prng.mjs`), so
// a rebuild reproduces identical Float32 output and therefore identical WAV bytes (§9.8).
// Buffers are planar mono Float32Array at the project rate; `encodeWav` turns them into the
// canonical 16-bit WAV the packs ship (§9.4, §9.8).

export const SAMPLE_RATE = 48_000; // spec §9.8: samples are 48 kHz mono 16-bit

const TAU = Math.PI * 2;

/** Frames needed for `seconds` at the factory sample rate. */
export function frames(seconds) {
  return Math.max(1, Math.round(seconds * SAMPLE_RATE));
}

/**
 * Exponential decay envelope with a short linear attack. `curve` > 1 decays faster early
 * (percussive); 1 is a plain exponential. Returns a value in [0, 1] for frame `i`.
 */
function decayEnvelope(i, length, attackFrames, curve) {
  if (i < attackFrames) return i / Math.max(1, attackFrames);
  const t = (i - attackFrames) / Math.max(1, length - attackFrames);
  return Math.exp(-curve * 5 * t);
}

/** Build a mono buffer of `length` frames from a per-frame generator. */
function render(length, generate) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = generate(i);
  return out;
}

/** A sine partial with an exponential pitch sweep from `startHz` to `endHz`. */
export function sweepSine({
  seconds,
  startHz,
  endHz,
  sweepTime = seconds * 0.35,
  attack = 0.001,
  curve = 1,
}) {
  const length = frames(seconds);
  const attackFrames = frames(attack);
  let phase = 0;
  return render(length, (i) => {
    const sweepPosition = Math.min(1, i / Math.max(1, frames(sweepTime)));
    // Exponential glide reads as a pitch drop rather than a linear ramp's audible slide.
    const hz = endHz * Math.pow(startHz / endHz, 1 - sweepPosition);
    phase += (TAU * hz) / SAMPLE_RATE;
    return Math.sin(phase) * decayEnvelope(i, length, attackFrames, curve);
  });
}

/** A steady sine partial with a percussive decay. */
export function tone({ seconds, hz, attack = 0.001, curve = 1, phaseOffset = 0 }) {
  const length = frames(seconds);
  const attackFrames = frames(attack);
  return render(length, (i) => {
    const value = Math.sin(phaseOffset + (TAU * hz * i) / SAMPLE_RATE);
    return value * decayEnvelope(i, length, attackFrames, curve);
  });
}

/** White noise with a percussive decay, drawn from the seeded PRNG (spec §9.8 determinism). */
export function noise({ seconds, rng, attack = 0.0005, curve = 1 }) {
  const length = frames(seconds);
  const attackFrames = frames(attack);
  return render(length, (i) => (rng() * 2 - 1) * decayEnvelope(i, length, attackFrames, curve));
}

/**
 * The classic analogue-drum-machine metallic source: a bank of detuned square waves at
 * inharmonic ratios. Squaring the sines keeps the spectrum dense and clangorous, which is
 * what makes hats and cymbals read as metal rather than as filtered noise.
 */
export function metallic({ seconds, baseHz, ratios, attack = 0.0002, curve = 1.6 }) {
  const length = frames(seconds);
  const attackFrames = frames(attack);
  return render(length, (i) => {
    let sum = 0;
    for (const ratio of ratios) {
      sum += Math.sign(Math.sin((TAU * baseHz * ratio * i) / SAMPLE_RATE));
    }
    return (sum / ratios.length) * decayEnvelope(i, length, attackFrames, curve);
  });
}

// --- Filters (one-pole and biquad; enough shaping for percussion) -------------------

/** One-pole low-pass. `hz` is the -3 dB point. */
export function lowPass(buffer, hz) {
  const alpha = 1 - Math.exp((-TAU * hz) / SAMPLE_RATE);
  const out = new Float32Array(buffer.length);
  let state = 0;
  for (let i = 0; i < buffer.length; i++) {
    state += alpha * (buffer[i] - state);
    out[i] = state;
  }
  return out;
}

/** One-pole high-pass, as the complement of the low-pass. */
export function highPass(buffer, hz) {
  const low = lowPass(buffer, hz);
  const out = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = buffer[i] - low[i];
  return out;
}

/** Resonant band-pass (RBJ constant-skirt biquad) — the tuned body of snares and rims. */
export function bandPass(buffer, hz, q = 1) {
  const w0 = (TAU * hz) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float32Array(buffer.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < buffer.length; i++) {
    const x0 = buffer[i];
    const y0 = (b0 * x0 + 0 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

// --- Mixing helpers ------------------------------------------------------------------

/** Sum buffers of differing lengths, each scaled by its gain, into one buffer. */
export function mix(...parts) {
  const length = Math.max(...parts.map(([buffer]) => buffer.length));
  const out = new Float32Array(length);
  for (const [buffer, gain] of parts) {
    for (let i = 0; i < buffer.length; i++) out[i] += buffer[i] * gain;
  }
  return out;
}

/** Delay a buffer by `seconds`, lengthening it — used to stagger the taps of a clap. */
export function delay(buffer, seconds) {
  const offset = frames(seconds);
  const out = new Float32Array(buffer.length + offset);
  out.set(buffer, offset);
  return out;
}

/**
 * Peak-normalise to `peak`, then apply a short fade-out so every sample ends at exactly
 * zero. A non-zero final frame clicks audibly when a one-shot is retriggered, and it also
 * defeats the point of shipping clean starter content.
 */
export function finalise(buffer, peak = 0.89) {
  let max = 0;
  for (const value of buffer) max = Math.max(max, Math.abs(value));
  const gain = max > 0 ? peak / max : 0;

  const fadeFrames = Math.min(frames(0.005), buffer.length);
  const out = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const remaining = buffer.length - 1 - i;
    const fade = remaining < fadeFrames ? remaining / fadeFrames : 1;
    out[i] = buffer[i] * gain * fade;
  }
  return out;
}
