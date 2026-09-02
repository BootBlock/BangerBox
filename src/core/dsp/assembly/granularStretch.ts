// BangerBox `granularStretch` kernel — spec §5.6.4 / §5.7.9. Independent time-stretch and
// pitch-shift, WSOLA-style: `rate` 0.25–4× changes duration, `pitch` ±24 semitones changes
// pitch, each without affecting the other. Two stages: (1) resample the input by the pitch
// ratio (shifts pitch, scales length), (2) WSOLA time-stretch the result back to the target
// length — each synthesis grain's read position is correlation-aligned to the previous grain's
// natural continuation, so overlap-add preserves phase and pitch instead of comb-filtering.
// Hann grains at 50 % overlap (spec §5.7.9: grain 40–120 ms, overlap 50–75 %).
//
// Two entry points share the grain machinery:
//   * `render` — the offline whole-buffer stretch (the §8.5.4 Time-stretch tool).
//   * `createStream` / `prepareStream` / `streamBlock` — the real-time §5.7.9 warp source,
//     which produces one render quantum at a time from a resident region so the §5.2 stage-1
//     worklet source can play a pad with pitch and duration decoupled.
//
// The streaming path places grains on the fixed synthesis grid and does NOT run the WSOLA
// correlation search: the search costs roughly 3 M multiply-adds per grain at 48 kHz, far
// outside a render quantum's budget (§5.5). Offline the search is free, so `render` keeps
// it. At warp's own default — rate 1, no detune — Hann grains at 50 % overlap sum to unity,
// so the streaming path is then a bit-exact passthrough with nothing to correlate.
//
// Compiled `--runtime stub -O3` (§2.7); own memory per instance (§5.6.3). A phase-vocoder
// upgrade is roadmap, not v1 (§5.7.9).

const GRAIN_SECONDS: f32 = 0.05; // 50 ms grain

class GranularStretchKernel {
  private readonly sampleRate: f32;
  private readonly grainSize: i32;
  private readonly hop: i32; // synthesis hop = overlap length (50 %)
  private readonly search: i32; // WSOLA correlation search radius
  private readonly window: Float32Array;
  private readonly scratch: Float32Array; // resampled (pitch-shifted) intermediate

  // --- streaming state (spec §5.7.9 warp source) ---
  private readonly acc: Float32Array; // overlap-add accumulator, index 0 = output cursor
  private readonly maxBlock: i32;
  private streamIn: usize = 0;
  private streamInFrames: i32 = 0;
  private streamRate: f32 = 1.0;
  private readPos: f64 = 0.0; // input frames where the next grain begins
  private nextGrainOut: i32 = 0; // offset in acc where the next grain begins
  private produced: i32 = 0;
  private totalOut: i32 = 0;
  private firstGrain: bool = true;

  constructor(sampleRate: f32, maxInputFrames: i32, maxBlock: i32) {
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
    // Worst case: pitch −24 st (ratio 0.25) resamples to 4× the input length. A streaming
    // instance passes 0 and skips the intermediate entirely — it reads the region directly.
    const cap = maxInputFrames > 0 ? maxInputFrames * 4 + g + 4 : 0;
    this.scratch = new Float32Array(cap);
    // A grain started inside a block reaches grainSize frames past its start, so the
    // accumulator carries that tail into the next call (spec §5.5: no allocation there).
    this.maxBlock = maxBlock;
    this.acc = new Float32Array(maxBlock > 0 ? maxBlock + g : 0);
  }

  // ------------------------------------------------ streaming (spec §5.7.9 warp) ---

  /** Linear-interpolated read at a fractional input position, 0 outside the region. */
  private streamSampleAt(pos: f64): f32 {
    if (pos < 0.0 || pos >= <f64>(this.streamInFrames - 1)) return 0.0;
    const i0 = <i32>pos;
    const frac = <f32>(pos - <f64>i0);
    const a = load<f32>(this.streamIn + ((<usize>i0) << 2));
    const b = load<f32>(this.streamIn + ((<usize>(i0 + 1)) << 2));
    return a + (b - a) * frac;
  }

  /**
   * Bind a resident region and reset the stream. rate is the time-stretch factor, fixed for
   * the life of the stream: the total output length depends on it, and the §5.4 declick is
   * laid against that length at note-on. Returns the output length in frames.
   */
  prepareStream(inPtr: usize, inFrames: i32, rate: f32): i32 {
    let r = rate;
    if (r < 0.25) r = 0.25;
    if (r > 4.0) r = 4.0;
    this.streamIn = inPtr;
    this.streamInFrames = inFrames;
    this.streamRate = r;
    this.readPos = 0.0;
    this.nextGrainOut = 0;
    this.produced = 0;
    this.firstGrain = true;
    this.totalOut = <i32>Mathf.round(<f32>inFrames / r);
    for (let i = 0; i < this.acc.length; i++) this.acc[i] = 0.0;
    return this.totalOut;
  }

  /**
   * Overlap-add one Hann grain into the accumulator at outOffset, reading the region at
   * pitchRatio frames per output frame. The FIRST grain's rising half is flat rather than
   * windowed: grains only ever start at or after output 0, so nothing overlaps that half,
   * and a Hann rise there would fade in the attack of every note over half a grain.
   */
  private placeStreamGrain(outOffset: i32, pitchRatio: f64): void {
    const first = this.firstGrain;
    for (let j = 0; j < this.grainSize; j++) {
      const o = outOffset + j;
      if (o < 0) continue;
      if (o >= this.acc.length) break;
      const w: f32 = first && j < this.hop ? 1.0 : this.window[j];
      this.acc[o] += this.streamSampleAt(this.readPos + <f64>j * pitchRatio) * w;
    }
    this.firstGrain = false;
  }

  /**
   * Produce up to frames output frames, shifted by detuneCents (spec §6 pitch), and return
   * how many were written. Zero means the region has run out.
   *
   * Pitch is read INSIDE the grain while the grain start advances by the synthesis hop times
   * rate, so detune shifts pitch without touching duration — which is the whole point of
   * §5.7.9's warp mode, and why detune here is not a playback rate the way it is on an
   * AudioBufferSourceNode.
   */
  streamBlock(outPtr: usize, frames: i32, detuneCents: f32): i32 {
    let n = frames;
    if (n > this.maxBlock) n = this.maxBlock;
    if (n <= 0) return 0;
    const remaining = this.totalOut - this.produced;
    if (remaining <= 0) return 0;

    let semis = detuneCents / 100.0;
    if (semis < -24.0) semis = -24.0;
    if (semis > 24.0) semis = 24.0;
    const pitchRatio = Math.pow(2.0, <f64>semis / 12.0);

    // Place every grain that begins inside this block, plus its tail into the carry region.
    while (this.nextGrainOut < n && this.produced + this.nextGrainOut < this.totalOut) {
      this.placeStreamGrain(this.nextGrainOut, pitchRatio);
      this.nextGrainOut += this.hop;
      this.readPos += <f64>this.hop * <f64>this.streamRate;
    }

    const written = n < remaining ? n : remaining;
    for (let i = 0; i < written; i++) store<f32>(outPtr + ((<usize>i) << 2), this.acc[i]);
    for (let i = written; i < n; i++) store<f32>(outPtr + ((<usize>i) << 2), 0.0);

    // Slide the accumulator so index 0 is the new output cursor, clearing the vacated tail.
    const len = this.acc.length;
    for (let i = 0; i + n < len; i++) this.acc[i] = this.acc[i + n];
    for (let i = len - n; i < len; i++) this.acc[i] = 0.0;
    this.nextGrainOut -= n;
    if (this.nextGrainOut < 0) this.nextGrainOut = 0;
    this.produced += written;
    return written;
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
  return changetype<usize>(new GranularStretchKernel(sampleRate, maxInputFrames, 0));
}
/** spec §5.6.1 — the same kernel as a real-time source (§5.7.9 warp), one block at a time. */
export function createStream(sampleRate: f32, maxBlock: i32): usize {
  return changetype<usize>(new GranularStretchKernel(sampleRate, 0, maxBlock));
}
export function prepareStream(handle: usize, inPtr: usize, inFrames: i32, rate: f32): i32 {
  return changetype<GranularStretchKernel>(handle).prepareStream(inPtr, inFrames, rate);
}
export function streamBlock(handle: usize, outPtr: usize, frames: i32, detuneCents: f32): i32 {
  return changetype<GranularStretchKernel>(handle).streamBlock(outPtr, frames, detuneCents);
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
  return changetype<GranularStretchKernel>(handle).render(
    inPtr,
    inFrames,
    outPtr,
    outCapacity,
    rate,
    pitchSemitones,
  );
}
export function free(handle: usize): void {
  // Linear memory released when the host drops this instance (spec §5.6.3).
}
