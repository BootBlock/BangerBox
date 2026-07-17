// BangerBox `lookaheadLimiter` kernel — spec §5.6.4 / §5.7. A true-peak-safe brickwall
// limiter with a fixed 1.5 ms lookahead (reported as latency for PDC, spec §5.7.3 / §5.7).
// Compiled by `npm run build:wasm` with `--runtime stub -O3` (§2.7); each node instantiates
// its own module + linear memory (§5.6.3), so the class-per-handle allocations live and die
// with the instance (stub is a bump allocator; `free` is host-driven instance disposal).
//
// Guarantee: the emitted gain for each output sample is the minimum gain over that sample's
// forward lookahead window, so |output| never exceeds the ceiling — the attack is implicit in
// the window minimum; a bounded upward slope gives a smooth release without breaking the bound.

const LOOKAHEAD_SECONDS: f32 = 0.0015; // spec §5.7 — fixed 1.5 ms lookahead

class LimiterKernel {
  private readonly sampleRate: f32;
  private readonly lookahead: i32; // L samples
  private readonly hist: Float32Array; // input delay ring, length L+1
  private readonly gains: Float32Array; // per-slot instantaneous gains, length L+1
  private cursor: i32 = 0;
  private ceiling: f32 = 1.0; // linear ceiling (0 dBFS)
  private releaseSlope: f32; // max gain rise per sample
  private emitted: f32 = 1.0; // last emitted (release-smoothed) gain

  constructor(sampleRate: f32) {
    this.sampleRate = sampleRate;
    let l = <i32>Mathf.round(LOOKAHEAD_SECONDS * sampleRate);
    if (l < 1) l = 1;
    this.lookahead = l;
    this.hist = new Float32Array(l + 1);
    this.gains = new Float32Array(l + 1);
    for (let i = 0; i <= l; i++) this.gains[i] = 1.0;
    this.releaseSlope = this.slopeFor(150.0); // default 150 ms release
  }

  latency(): i32 {
    return this.lookahead;
  }

  private slopeFor(releaseMs: f32): f32 {
    const samples = Mathf.max(1.0, (releaseMs / 1000.0) * this.sampleRate);
    return 1.0 / samples; // seconds to recover unity gain
  }

  setCeiling(dbfs: f32): void {
    this.ceiling = <f32>Math.pow(10.0, <f64>dbfs / 20.0);
  }

  setRelease(releaseMs: f32): void {
    this.releaseSlope = this.slopeFor(releaseMs);
  }

  process(inPtr: usize, outPtr: usize, frames: i32): void {
    const size = this.lookahead + 1;
    for (let i = 0; i < frames; i++) {
      const x = load<f32>(inPtr + ((<usize>i) << 2));
      // Instantaneous gain that would tame this incoming sample.
      const mag = Mathf.abs(x);
      const g: f32 = mag > this.ceiling ? this.ceiling / mag : 1.0;

      // The oldest slot is the sample that has now seen its whole forward window.
      const outSample = this.hist[this.cursor];
      // Overwrite the oldest slot with the newest sample/gain.
      this.hist[this.cursor] = x;
      this.gains[this.cursor] = g;
      this.cursor = (this.cursor + 1) % size;

      // Window minimum gain over the L+1 slots (covers the emitted sample's lookahead).
      let rawMin: f32 = 1.0;
      for (let k = 0; k < size; k++) {
        const gk = this.gains[k];
        if (gk < rawMin) rawMin = gk;
      }
      // Release: let the emitted gain rise only by the slope, capped at rawMin. When rawMin
      // drops below the emitted gain the cap forces an instant attack; otherwise it recovers
      // smoothly — and emitted ≤ rawMin always, so the peak-safety bound holds.
      let next = this.emitted + this.releaseSlope;
      if (next > rawMin) next = rawMin;
      this.emitted = next;

      store<f32>(outPtr + ((<usize>i) << 2), outSample * this.emitted);
    }
  }
}

// spec §5.6.1 — kernel seam lifecycle.
export function create(sampleRate: f32, maxBlock: i32): usize {
  return changetype<usize>(new LimiterKernel(sampleRate));
}
export function setCeiling(handle: usize, dbfs: f32): void {
  changetype<LimiterKernel>(handle).setCeiling(dbfs);
}
export function setRelease(handle: usize, releaseMs: f32): void {
  changetype<LimiterKernel>(handle).setRelease(releaseMs);
}
export function latencySamples(handle: usize): i32 {
  return changetype<LimiterKernel>(handle).latency();
}
export function allocateBuffer(frames: i32): usize {
  return heap.alloc((<usize>frames) << 2);
}
export function freeBuffer(ptr: usize): void {
  heap.free(ptr);
}
export function process(handle: usize, inPtr: usize, outPtr: usize, frames: i32): void {
  changetype<LimiterKernel>(handle).process(inPtr, outPtr, frames);
}
export function free(handle: usize): void {
  // Linear memory is released when the host drops this instance (spec §5.6.3).
}
