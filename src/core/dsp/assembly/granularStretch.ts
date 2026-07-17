// BangerBox `granularStretch` kernel — spec §5.6.4 / §5.7.9. Independent time-stretch and
// pitch-shift, WSOLA-style: `rate` 0.25–4× changes duration, `pitch` ±24 semitones changes
// pitch, each without affecting the other. Two stages: (1) resample the input by the pitch
// ratio (shifts pitch, scales length), (2) WSOLA time-stretch the result back to the target
// length — each synthesis grain's read position is correlation-aligned to the previous grain's
// natural continuation, so overlap-add preserves phase and pitch instead of comb-filtering.
// Hann grains at 50 % overlap (spec §5.7.9: grain 40–120 ms, overlap 50–75 %). An offline
// whole-buffer render (stretch tool + warp pre-render). Compiled `--runtime stub -O3` (§2.7);
// own memory per instance (§5.6.3). A phase-vocoder upgrade is roadmap, not v1 (§5.7.9).

const GRAIN_SECONDS: f32 = 0.05; // 50 ms grain

class GranularStretchKernel {
  private readonly sampleRate: f32;
  private readonly grainSize: i32;
  private readonly hop: i32; // synthesis hop = overlap length (50 %)
  private readonly search: i32; // WSOLA correlation search radius
  private readonly window: Float32Array;
  private readonly scratch: Float32Array; // resampled (pitch-shifted) intermediate

  constructor(sampleRate: f32, maxInputFrames: i32) {
    this.sampleRate = sampleRate;
    let g = <i32>Mathf.round(GRAIN_SECONDS * sampleRate);
    if (g < 4) g = 4;
    if ((g & 1) == 1) g += 1; // keep it even for a clean 50 % hop
    this.grainSize = g;
    this.hop = g / 2;
    this.search = g / 4;
    const win = new Float32Array(g);
    for (let i = 0; i < g; i++) win[i] = <f32>(0.5 - 0.5 * Math.cos((2.0 * Math.PI * <f64>i) / <f64>g));
    this.window = win;
    // Worst case: pitch −24 st (ratio 0.25) resamples to 4× the input length.
    const cap = maxInputFrames * 4 + g + 4;
    this.scratch = new Float32Array(cap);
  }

  /** Linear-interpolated read of the input at a fractional position (0 outside the buffer). */
  private sampleAt(inPtr: usize, inFrames: i32, pos: f32): f32 {
    if (pos < 0.0 || pos >= <f32>(inFrames - 1)) return 0.0;
    const i0 = <i32>pos;
    const frac = pos - <f32>i0;
    const a = load<f32>(inPtr + ((<usize>i0) << 2));
    const b = load<f32>(inPtr + ((<usize>(i0 + 1)) << 2));
    return a + (b - a) * frac;
  }

  render(inPtr: usize, inFrames: i32, outPtr: usize, outCapacity: i32, rate: f32, pitchSemitones: f32): i32 {
    let r = rate;
    if (r < 0.25) r = 0.25;
    if (r > 4.0) r = 4.0;
    let semis = pitchSemitones;
    if (semis < -24.0) semis = -24.0;
    if (semis > 24.0) semis = 24.0;
    const pitchRatio = <f32>Math.pow(2.0, <f64>semis / 12.0);

    // Stage 1: resample by the pitch ratio → scratch (pitch shifted, length inFrames/ratio).
    let resampledLen = <i32>Mathf.floor(<f32>inFrames / pitchRatio);
    if (resampledLen > this.scratch.length) resampledLen = this.scratch.length;
    for (let m = 0; m < resampledLen; m++) {
      this.scratch[m] = this.sampleAt(inPtr, inFrames, <f32>m * pitchRatio);
    }

    let outFrames = <i32>Mathf.round(<f32>inFrames / r);
    if (outFrames > outCapacity) outFrames = outCapacity;
    if (outFrames < 0) outFrames = 0;
    for (let i = 0; i < outFrames; i++) store<f32>(outPtr + ((<usize>i) << 2), 0.0);
    if (resampledLen < this.grainSize || outFrames < this.grainSize) {
      // Too short to WSOLA — straight copy of what fits.
      const n = resampledLen < outFrames ? resampledLen : outFrames;
      for (let i = 0; i < n; i++) store<f32>(outPtr + ((<usize>i) << 2), this.scratch[i]);
      return outFrames;
    }

    // Stage 2: WSOLA time-stretch scratch → output (length outFrames).
    const grain = this.grainSize;
    const hop = this.hop;
    const overlap = hop; // 50 % overlap length
    // Analysis hop advances the read cursor so the whole intermediate is consumed.
    const analysisHop = <i32>Mathf.round((<f32>hop * <f32>resampledLen) / <f32>outFrames);

    let readPos = 0;
    let outPos = 0;
    this.placeGrain(outPtr, outFrames, readPos, outPos);
    while (true) {
      outPos += hop;
      if (outPos + grain > outFrames) break;
      // Target: the previous grain's natural continuation (its tail region).
      const target = readPos + hop;
      const nominal = readPos + analysisHop;
      readPos = this.bestMatch(nominal, target, overlap, resampledLen);
      this.placeGrain(outPtr, outFrames, readPos, outPos);
    }
    return outFrames;
  }

  /** Overlap-add one Hann-windowed grain read from `readPos` at output `outPos`. */
  private placeGrain(outPtr: usize, outFrames: i32, readPos: i32, outPos: i32): void {
    for (let j = 0; j < this.grainSize; j++) {
      const idx = readPos + j;
      if (idx < 0 || idx >= this.scratch.length) continue;
      const o = outPos + j;
      if (o >= outFrames) break;
      const acc = load<f32>(outPtr + ((<usize>o) << 2));
      store<f32>(outPtr + ((<usize>o) << 2), acc + this.scratch[idx] * this.window[j]);
    }
  }

  /** WSOLA search: read position near `nominal` best correlating with the continuation `target`. */
  private bestMatch(nominal: i32, target: i32, overlap: i32, resampledLen: i32): i32 {
    let bestPos = nominal;
    let bestScore: f32 = -1e30;
    const lo = nominal - this.search;
    const hi = nominal + this.search;
    for (let cand = lo; cand <= hi; cand++) {
      if (cand < 0 || cand + overlap >= resampledLen || target + overlap >= resampledLen) continue;
      let score: f32 = 0.0;
      for (let j = 0; j < overlap; j++) score += this.scratch[cand + j] * this.scratch[target + j];
      if (score > bestScore) {
        bestScore = score;
        bestPos = cand;
      }
    }
    if (bestPos < 0) bestPos = 0;
    return bestPos;
  }
}

// spec §5.6.1 — kernel seam lifecycle (offline render kernel).
export function create(sampleRate: f32, maxInputFrames: i32): usize {
  return changetype<usize>(new GranularStretchKernel(sampleRate, maxInputFrames));
}
export function allocateBuffer(frames: i32): usize {
  return heap.alloc((<usize>frames) << 2);
}
export function freeBuffer(ptr: usize): void {
  heap.free(ptr);
}
export function render(
  handle: usize,
  inPtr: usize,
  inFrames: i32,
  outPtr: usize,
  outCapacity: i32,
  rate: f32,
  pitchSemitones: f32,
): i32 {
  return changetype<GranularStretchKernel>(handle).render(inPtr, inFrames, outPtr, outCapacity, rate, pitchSemitones);
}
export function free(handle: usize): void {
  // Linear memory released when the host drops this instance (spec §5.6.3).
}
