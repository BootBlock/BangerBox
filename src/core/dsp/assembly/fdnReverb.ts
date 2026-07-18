// BangerBox `fdnReverb` kernel — spec §5.6.4 / §5.7. A feedback delay network: four fixed
// delay lines mixed through a normalised (energy-preserving) Hadamard matrix with a damping
// one-pole in each feedback path, fed from a variable pre-delay. `size` sets the decay time,
// `damping` the high-frequency absorption. The kernel outputs the WET signal only; the insert
// wrapper does the dry/wet mix (spec §5.7). Compiled `--runtime stub -O3` (§2.7); own memory
// per node instance (§5.6.3). Orthogonal feedback with gain < 1 guarantees a decaying tail.

// Delay-line lengths in seconds (mutually incommensurate to smear echoes into a dense tail).
const DELAY_SECONDS: StaticArray<f32> = [0.0297, 0.0371, 0.0411, 0.0437];
const MAX_PREDELAY_SECONDS: f32 = 0.2; // spec §5.7 pre-delay 0–200 ms

class DelayLine {
  private readonly buf: Float32Array;
  private pos: i32 = 0;
  readonly length: i32;

  constructor(length: i32) {
    this.length = length;
    this.buf = new Float32Array(length);
  }

  read(): f32 {
    return this.buf[this.pos];
  }

  write(v: f32): void {
    this.buf[this.pos] = v;
    this.pos += 1;
    if (this.pos >= this.length) this.pos = 0;
  }
}

class FdnReverbKernel {
  private readonly sampleRate: f32;
  private readonly lines: StaticArray<DelayLine>;
  private readonly damp: Float32Array = new Float32Array(4); // damping one-pole states
  private meanDelaySec: f32;

  private readonly predelayBuf: Float32Array;
  private predelayPos: i32 = 0;
  private predelaySamples: i32 = 0;

  private feedback: f32 = 0.85;
  private dampCoef: f32 = 1.0; // 1 = no damping

  constructor(sampleRate: f32) {
    this.sampleRate = sampleRate;
    // Build the delay lines into a local first so every `this` field is assigned before any
    // `this` member access (AssemblyScript strict field-init, TS2564).
    const lines = new StaticArray<DelayLine>(4);
    let total: f32 = 0.0;
    for (let i = 0; i < 4; i++) {
      const len = <i32>Mathf.round(DELAY_SECONDS[i] * sampleRate);
      lines[i] = new DelayLine(len < 1 ? 1 : len);
      total += DELAY_SECONDS[i];
    }
    this.lines = lines;
    this.meanDelaySec = total / 4.0;
    const maxPre = <i32>Mathf.round(MAX_PREDELAY_SECONDS * sampleRate) + 1;
    this.predelayBuf = new Float32Array(maxPre);
    this.setSize(1.8);
  }

  setSize(seconds: f32): void {
    // Feedback gain for an RT60 of `seconds`: g = 10^(−3·meanDelay/RT60).
    const rt60 = seconds < 0.05 ? 0.05 : seconds;
    let g = <f32>Math.pow(10.0, <f64>((-3.0 * this.meanDelaySec) / rt60));
    if (g > 0.995) g = 0.995; // keep strictly stable
    this.feedback = g;
  }

  setDamping(amount: f32): void {
    const a = amount < 0.0 ? 0.0 : amount > 1.0 ? 1.0 : amount;
    this.dampCoef = <f32>(1.0 - <f64>a * 0.9); // 1 = open, 0.1 = heavy lowpass
  }

  setPredelay(ms: f32): void {
    let s = <i32>Mathf.round((ms / 1000.0) * this.sampleRate);
    const max = this.predelayBuf.length - 1;
    if (s < 0) s = 0;
    if (s > max) s = max;
    this.predelaySamples = s;
  }

  private throughPredelay(x: f32): f32 {
    const size = this.predelayBuf.length;
    this.predelayBuf[this.predelayPos] = x;
    let readPos = this.predelayPos - this.predelaySamples;
    if (readPos < 0) readPos += size;
    const out = this.predelayBuf[readPos];
    this.predelayPos += 1;
    if (this.predelayPos >= size) this.predelayPos = 0;
    return out;
  }

  process(inPtr: usize, outPtr: usize, frames: i32): void {
    const g = this.feedback;
    for (let i = 0; i < frames; i++) {
      const x = this.throughPredelay(load<f32>(inPtr + ((<usize>i) << 2)));

      // Read the four delay outputs and apply per-line damping.
      const d0 = this.dampen(0, this.lines[0].read());
      const d1 = this.dampen(1, this.lines[1].read());
      const d2 = this.dampen(2, this.lines[2].read());
      const d3 = this.dampen(3, this.lines[3].read());

      // Normalised 4×4 Hadamard mix (orthogonal → energy-preserving).
      const m0: f32 = 0.5 * (d0 + d1 + d2 + d3);
      const m1: f32 = 0.5 * (d0 - d1 + d2 - d3);
      const m2: f32 = 0.5 * (d0 + d1 - d2 - d3);
      const m3: f32 = 0.5 * (d0 - d1 - d2 + d3);

      // Inject the (pre-delayed) input and recirculate.
      this.lines[0].write(x + g * m0);
      this.lines[1].write(x + g * m1);
      this.lines[2].write(x + g * m2);
      this.lines[3].write(x + g * m3);

      // Wet output: the summed delay taps, scaled to keep it in range.
      store<f32>(outPtr + ((<usize>i) << 2), 0.5 * (d0 + d1 + d2 + d3));
    }
  }

  private dampen(line: i32, value: f32): f32 {
    this.damp[line] += this.dampCoef * (value - this.damp[line]);
    return this.damp[line];
  }
}

// spec §5.6.1 — kernel seam lifecycle.
export function create(sampleRate: f32, maxBlock: i32): usize {
  return changetype<usize>(new FdnReverbKernel(sampleRate));
}
export function setSize(handle: usize, seconds: f32): void {
  changetype<FdnReverbKernel>(handle).setSize(seconds);
}
export function setDamping(handle: usize, amount: f32): void {
  changetype<FdnReverbKernel>(handle).setDamping(amount);
}
export function setPredelay(handle: usize, ms: f32): void {
  changetype<FdnReverbKernel>(handle).setPredelay(ms);
}
export function allocateBuffer(frames: i32): usize {
  return heap.alloc((<usize>frames) << 2);
}
export function freeBuffer(ptr: usize): void {
  heap.free(ptr);
}
export function process(handle: usize, inPtr: usize, outPtr: usize, frames: i32): void {
  changetype<FdnReverbKernel>(handle).process(inPtr, outPtr, frames);
}
export function free(handle: usize): void {
  // Linear memory released when the host drops this instance (spec §5.6.3).
}
