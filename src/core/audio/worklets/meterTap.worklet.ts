/**
 * Metering tap AudioWorkletProcessor — spec §5.8. Instantiated per metered point
 * (master L/R, per-track, per-return, selected pad); computes `[peak, rms]` per channel
 * for each render quantum and writes them lock-free into its assigned slot of the global
 * meter SAB, bumping the generation counter via `Atomics`. It NEVER posts messages and
 * allocates nothing in `process()` (spec §5.5). The node has one input and one output so
 * it can sit inline (input passes through unchanged) or as a branch tap.
 */
import {
  HEADER_INTS,
  METER_SLOTS,
  VALUES_PER_SLOT,
  slotFloatBase,
} from '../metering';

interface MeterTapOptions {
  sab: SharedArrayBuffer;
  slot: number;
}

class MeterTapProcessor extends AudioWorkletProcessor {
  private readonly data: Float32Array;
  private readonly header: Int32Array;
  private readonly base: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const { sab, slot } = options.processorOptions as unknown as MeterTapOptions;
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.data = new Float32Array(sab, HEADER_INTS * 4, METER_SLOTS * VALUES_PER_SLOT);
    this.base = slotFloatBase(slot);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      // No signal this quantum: decay the meter toward zero without allocating.
      this.data[this.base] = 0;
      this.data[this.base + 1] = 0;
      this.data[this.base + 2] = 0;
      this.data[this.base + 3] = 0;
      return true;
    }

    for (let channel = 0; channel < 2; channel++) {
      const samples = input[Math.min(channel, input.length - 1)];
      let peak = 0;
      let sumSquares = 0;
      if (samples) {
        for (let i = 0; i < samples.length; i++) {
          const value = samples[i]!;
          const abs = value < 0 ? -value : value;
          if (abs > peak) peak = abs;
          sumSquares += value * value;
        }
        const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;
        this.data[this.base + channel * 2] = peak;
        this.data[this.base + channel * 2 + 1] = rms;
      }
      // Pass the signal through unchanged so the tap can sit inline (spec §5.8).
      const outChannel = output?.[channel];
      if (outChannel && samples) outChannel.set(samples);
    }

    Atomics.add(this.header, 0, 1); // liveness signal (spec §5.8)
    return true;
  }
}

registerProcessor('meter-tap', MeterTapProcessor);
