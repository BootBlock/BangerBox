// BangerBox `multibandComp` kernel — spec §5.6.4 / §5.7. A 3-band compressor: two
// complementary one-pole crossovers split the signal into low/mid/high bands (they sum back
// to the input exactly, so unity settings are a true passthrough), each band runs an
// attack/release peak compressor with makeup, and the bands are summed. Compiled with
// `--runtime stub -O3` (§2.7); own memory per node instance (§5.6.3).

class Band {
  threshold: f32 = 1.0; // linear threshold (0 dBFS)
  ratio: f32 = 1.0;
  attackCoef: f32 = 0.0;
  releaseCoef: f32 = 0.0;
  makeup: f32 = 1.0;
  env: f32 = 0.0;

  setParams(sampleRate: f32, thresholdDb: f32, ratio: f32, attackMs: f32, releaseMs: f32, makeupDb: f32): void {
    this.threshold = <f32>Math.pow(10.0, <f64>thresholdDb / 20.0);
    this.ratio = ratio < 1.0 ? 1.0 : ratio;
    this.makeup = <f32>Math.pow(10.0, <f64>makeupDb / 20.0);
    this.attackCoef = coef(sampleRate, attackMs);
    this.releaseCoef = coef(sampleRate, releaseMs);
  }

  // Compress one sample of this band and return the processed value.
  render(x: f32): f32 {
    const mag = Mathf.abs(x);
    // Attack/release-smoothed peak envelope.
    const coefUsed = mag > this.env ? this.attackCoef : this.releaseCoef;
    this.env += (mag - this.env) * coefUsed;
    let gain: f32 = 1.0;
    if (this.env > this.threshold && this.env > 0.0) {
      const over = this.env / this.threshold; // > 1
      // desiredOut = threshold · over^(1/ratio); gain = desiredOut / env = over^(1/ratio − 1).
      gain = <f32>Math.pow(<f64>over, <f64>(1.0 / this.ratio - 1.0));
    }
    return x * gain * this.makeup;
  }
}

/** One-pole smoothing coefficient for a time constant in milliseconds. */
function coef(sampleRate: f32, ms: f32): f32 {
  if (ms <= 0.0) return 1.0;
  return 1.0 - <f32>Math.exp(-1.0 / ((<f64>ms / 1000.0) * <f64>sampleRate));
}

/** One-pole lowpass coefficient for a cutoff frequency. */
function lpCoef(sampleRate: f32, freq: f32): f32 {
  const x = <f64>freq / <f64>sampleRate;
  const a = 1.0 - Math.exp(-2.0 * Math.PI * x);
  return <f32>(a < 0.0 ? 0.0 : a > 1.0 ? 1.0 : a);
}

class MultibandCompKernel {
  private readonly sampleRate: f32;
  private readonly low: Band = new Band();
  private readonly mid: Band = new Band();
  private readonly high: Band = new Band();
  private a1: f32; // crossover 1 (low|mid) coefficient
  private a2: f32; // crossover 2 (mid|high) coefficient
  private lp1: f32 = 0.0; // one-pole states
  private lp2: f32 = 0.0;

  constructor(sampleRate: f32) {
    this.sampleRate = sampleRate;
    this.a1 = lpCoef(sampleRate, 200.0);
    this.a2 = lpCoef(sampleRate, 2000.0);
  }

  setCrossovers(lowMid: f32, midHigh: f32): void {
    this.a1 = lpCoef(this.sampleRate, lowMid);
    this.a2 = lpCoef(this.sampleRate, midHigh);
  }

  setBand(band: i32, thresholdDb: f32, ratio: f32, attackMs: f32, releaseMs: f32, makeupDb: f32): void {
    const target = band == 0 ? this.low : band == 1 ? this.mid : this.high;
    target.setParams(this.sampleRate, thresholdDb, ratio, attackMs, releaseMs, makeupDb);
  }

  process(inPtr: usize, outPtr: usize, frames: i32): void {
    for (let i = 0; i < frames; i++) {
      const x = load<f32>(inPtr + ((<usize>i) << 2));
      // Complementary split: low = LP1(x); rest = x − low; mid = LP2(rest); high = rest − mid.
      this.lp1 += this.a1 * (x - this.lp1);
      const lowBand = this.lp1;
      const rest = x - lowBand;
      this.lp2 += this.a2 * (rest - this.lp2);
      const midBand = this.lp2;
      const highBand = rest - midBand;

      const y = this.low.render(lowBand) + this.mid.render(midBand) + this.high.render(highBand);
      store<f32>(outPtr + ((<usize>i) << 2), y);
    }
  }
}

// spec §5.6.1 — kernel seam lifecycle.
export function create(sampleRate: f32, maxBlock: i32): usize {
  return changetype<usize>(new MultibandCompKernel(sampleRate));
}
export function setCrossovers(handle: usize, lowMid: f32, midHigh: f32): void {
  changetype<MultibandCompKernel>(handle).setCrossovers(lowMid, midHigh);
}
export function setBand(
  handle: usize,
  band: i32,
  thresholdDb: f32,
  ratio: f32,
  attackMs: f32,
  releaseMs: f32,
  makeupDb: f32,
): void {
  changetype<MultibandCompKernel>(handle).setBand(band, thresholdDb, ratio, attackMs, releaseMs, makeupDb);
}
export function allocateBuffer(frames: i32): usize {
  return heap.alloc((<usize>frames) << 2);
}
export function freeBuffer(ptr: usize): void {
  heap.free(ptr);
}
export function process(handle: usize, inPtr: usize, outPtr: usize, frames: i32): void {
  changetype<MultibandCompKernel>(handle).process(inPtr, outPtr, frames);
}
export function free(handle: usize): void {
  // Linear memory released when the host drops this instance (spec §5.6.3).
}
