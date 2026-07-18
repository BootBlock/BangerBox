// BangerBox `transientDetect` kernel — spec §5.6.4 / §7.5. Onset detection for Chop (§8.5.4)
// and groove extraction (§7.5). It runs in a plain worker over a whole OPFS `.wav` (§7.5),
// analysing the mono signal frame-by-frame and returning onset frame indices. Compiled
// `--runtime stub -O3` (§2.7); own memory per instance (§5.6.3).
//
// Detection function: the per-frame energy of the first-difference signal (a high-frequency
// emphasis — the flux of the signal's spectral energy without a full FFT), from which a
// positive flux and an adaptive local-mean threshold pick peaks. `sensitivity` lowers the
// threshold; `minSpacing` suppresses double-triggers. (A full spectral-flux FFT is a later
// refinement — §14; the seam and the onset-accuracy contract are met — spec §1.3 #5.)

const FRAME: i32 = 1024;
const HOP: i32 = 512;
const LOCAL_WINDOW: i32 = 6; // frames each side for the adaptive threshold
const FLOOR: f32 = 1e-6; // absolute detection floor (ignore near-silence)
const MAX_ONSETS: i32 = 4096;

class TransientDetectKernel {
  private readonly sampleRate: f32;
  private readonly energy: Float32Array;
  private readonly flux: Float32Array;
  private readonly onsets: Int32Array;
  private readonly maxHops: i32;
  private onsetCount: i32 = 0;

  constructor(sampleRate: f32, maxFrames: i32) {
    this.sampleRate = sampleRate;
    const hops = maxFrames >= FRAME ? (maxFrames - FRAME) / HOP + 2 : 1;
    this.maxHops = hops;
    this.energy = new Float32Array(hops);
    this.flux = new Float32Array(hops);
    this.onsets = new Int32Array(MAX_ONSETS);
  }

  count(): i32 {
    return this.onsetCount;
  }

  onsetAt(i: i32): i32 {
    return i >= 0 && i < this.onsetCount ? this.onsets[i] : -1;
  }

  analyse(inPtr: usize, frames: i32, sensitivity: f32, minSpacingMs: f32): i32 {
    this.onsetCount = 0;
    if (frames < FRAME) return 0;
    const numHops = (frames - FRAME) / HOP + 1;
    const limit = numHops < this.maxHops ? numHops : this.maxHops;

    // Per-frame energy of the first difference (high-frequency-weighted).
    for (let h = 0; h < limit; h++) {
      const start = h * HOP;
      let e: f32 = 0.0;
      let prev = load<f32>(inPtr + ((<usize>start) << 2));
      for (let i = 1; i < FRAME; i++) {
        const x = load<f32>(inPtr + ((<usize>(start + i)) << 2));
        const d = x - prev;
        e += d * d;
        prev = x;
      }
      this.energy[h] = e;
    }

    // Positive flux (rectified frame-to-frame rise).
    this.flux[0] = this.energy[0];
    for (let h = 1; h < limit; h++) {
      const rise = this.energy[h] - this.energy[h - 1];
      this.flux[h] = rise > 0.0 ? rise : 0.0;
    }

    // sensitivity 0..1 → threshold factor 4 (strict) .. 1 (sensitive).
    const s = sensitivity < 0.0 ? 0.0 : sensitivity > 1.0 ? 1.0 : sensitivity;
    const factor: f32 = <f32>(1.0 + (1.0 - <f64>s) * 3.0);
    const minSpacingFrames = <i32>((minSpacingMs / 1000.0) * this.sampleRate);
    let lastOnset: i32 = -1;

    for (let h = 1; h < limit - 1; h++) {
      const lo = h - LOCAL_WINDOW < 0 ? 0 : h - LOCAL_WINDOW;
      const hi = h + LOCAL_WINDOW >= limit ? limit - 1 : h + LOCAL_WINDOW;
      let sum: f32 = 0.0;
      for (let k = lo; k <= hi; k++) sum += this.flux[k];
      const mean = sum / <f32>(hi - lo + 1);
      const threshold = mean * factor + FLOOR;
      const f = this.flux[h];
      if (f > threshold && f >= this.flux[h - 1] && f >= this.flux[h + 1]) {
        // Refine the hop-quantised position to the sharpest sample transition in the frame
        // window (≈ the true attack) so chop boundaries land on the onset, not a hop edge.
        const frame = this.refineOnset(inPtr, h * HOP, frames);
        if (lastOnset < 0 || frame - lastOnset >= minSpacingFrames) {
          if (this.onsetCount < MAX_ONSETS) {
            this.onsets[this.onsetCount] = frame;
            this.onsetCount += 1;
            lastOnset = frame;
          }
        }
      }
    }
    return this.onsetCount;
  }

  /** Sample index of the sharpest first-difference within the frame window at `start`. */
  private refineOnset(inPtr: usize, start: i32, frames: i32): i32 {
    const end = start + FRAME < frames ? start + FRAME : frames;
    let bestIndex = start;
    let bestDiff: f32 = 0.0;
    let prev = load<f32>(inPtr + ((<usize>start) << 2));
    for (let i = start + 1; i < end; i++) {
      const x = load<f32>(inPtr + ((<usize>i) << 2));
      const d = Mathf.abs(x - prev);
      if (d > bestDiff) {
        bestDiff = d;
        bestIndex = i;
      }
      prev = x;
    }
    return bestIndex;
  }
}

// spec §5.6.1 — kernel seam lifecycle (analysis kernel: create → analyse → read → free).
export function create(sampleRate: f32, maxFrames: i32): usize {
  return changetype<usize>(new TransientDetectKernel(sampleRate, maxFrames));
}
export function allocateBuffer(frames: i32): usize {
  return heap.alloc((<usize>frames) << 2);
}
export function freeBuffer(ptr: usize): void {
  heap.free(ptr);
}
export function analyse(handle: usize, inPtr: usize, frames: i32, sensitivity: f32, minSpacingMs: f32): i32 {
  return changetype<TransientDetectKernel>(handle).analyse(inPtr, frames, sensitivity, minSpacingMs);
}
export function onsetAt(handle: usize, index: i32): i32 {
  return changetype<TransientDetectKernel>(handle).onsetAt(index);
}
export function count(handle: usize): i32 {
  return changetype<TransientDetectKernel>(handle).count();
}
export function free(handle: usize): void {
  // Linear memory released when the host drops this instance (spec §5.6.3).
}
