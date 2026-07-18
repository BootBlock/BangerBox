/**
 * Metronome — spec §5.9. A tiny pre-rendered click (no network asset) with an accented
 * beat-1 variant, routed through its own level gain into the monitor bus so it is never
 * coloured by the master inserts (spec §5.2, §5.9). The sequencer worker will call
 * {@link Metronome.click} per scheduled tick in Phase 4 (§7.7 count-in); here the buffers
 * and routing are built and the level is live. The click waveform is a pure function so
 * its shape is unit-testable (spec §11.1).
 */
import { METRONOME_LEVEL_RANGE } from '@/core/project/schemas';
import { clamp } from '@/core/math';
import { cancelParams, rampParamLinear, setParamNow } from './params/ramps';

const CLICK_MS = 40;
const NORMAL_FREQ = 1_000;
const ACCENT_FREQ = 1_500;

/** A short decaying sine burst — the click waveform (spec §5.9). */
export function renderClickWaveform(
  sampleRate: number,
  freq: number,
  durationMs = CLICK_MS,
): Float32Array<ArrayBuffer> {
  const length = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const data = new Float32Array(length);
  const decay = durationMs / 1000 / 5; // ~5 time-constants across the click
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / decay);
  }
  return data;
}

function buildClickBuffer(context: BaseAudioContext, freq: number): AudioBuffer {
  const waveform = renderClickWaveform(context.sampleRate, freq);
  const buffer = context.createBuffer(1, waveform.length, context.sampleRate);
  buffer.getChannelData(0).set(waveform);
  return buffer;
}

export class Metronome {
  /** Level gain feeding the monitor bus (spec §5.9). */
  readonly output: GainNode;
  private readonly accentBuffer: AudioBuffer;
  private readonly normalBuffer: AudioBuffer;

  constructor(
    private readonly context: BaseAudioContext,
    monitorBus: AudioNode,
  ) {
    this.output = context.createGain();
    this.output.connect(monitorBus);
    setParamNow(this.output.gain, 0.8, context.currentTime); // sensible default level
    this.accentBuffer = buildClickBuffer(context, ACCENT_FREQ);
    this.normalBuffer = buildClickBuffer(context, NORMAL_FREQ);
  }

  /** Sound one click at context time `when`; beat 1 is accented (spec §5.9). */
  click(when: number, accented: boolean): void {
    const source = this.context.createBufferSource();
    source.buffer = accented ? this.accentBuffer : this.normalBuffer;
    source.connect(this.output);
    source.onended = () => source.disconnect();
    source.start(when);
  }

  /** Metronome level 0..1 (spec §4.2 metronomeLevel). */
  setLevel(level: number, when: number): void {
    rampParamLinear(this.output.gain, clamp(level, METRONOME_LEVEL_RANGE[0], METRONOME_LEVEL_RANGE[1]), when);
  }

  destroy(): void {
    cancelParams(this.output.gain);
    this.output.disconnect();
  }
}
