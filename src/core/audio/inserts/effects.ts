/**
 * Native insert-effect cores — spec §5.7. Each builder wires a small Web Audio sub-graph
 * (`eq4`, `filter`, `delay`, `compressor`, `saturator`, `reverb` v1) and exposes a
 * uniform {@link EffectCore}: a single input/output, a `setParam` that dezippers changes
 * (spec §4.3), a reported `latencySamples` for PDC (spec §5.7.3 — native effects report
 * 0), and a `destroy()` that disconnects every node and cancels its scheduled params
 * (spec §3.2). The dry/wet `mix` and
 * true-bypass are the wrapper's concern (spec §5.7), not the core's.
 */
import { clamp } from '@/core/math';
import type { EffectType } from '@/core/project/schemas';
import { getKernelModule, type WorkletKernelName } from '@/core/dsp/kernelModules';
import { dbToGain } from '../params/faderLaw';
import { cancelParams, rampParamTarget, setParamNow } from '../params/ramps';
import type { DspEffectMessage } from '../worklets/dspEffectProtocol';
import { DSP_EFFECT_PROCESSOR } from '../worklets/dspEffectProtocol';
import { makeReverbImpulse, makeSaturatorCurve } from './dspCurves';
import { EFFECT_PARAM_RANGES, FILTER_TYPES, FILTER_TYPE_TO_BIQUAD, SATURATOR_CURVES } from './effectParams';

export interface EffectCore {
  readonly input: AudioNode;
  readonly output: AudioNode;
  readonly latencySamples: number;
  setParam: (name: string, value: number, when: number) => void;
  destroy: () => void;
}

/** Clamp a param to its effect's declared range (spec §5.7); unknown names pass through. */
function clampParam(effectType: EffectType, name: string, value: number): number {
  const range = EFFECT_PARAM_RANGES[effectType][name];
  return range ? clamp(value, range[0], range[1]) : value;
}

function buildEq4(context: BaseAudioContext, params: Record<string, number>): EffectCore {
  const low = context.createBiquadFilter();
  const p1 = context.createBiquadFilter();
  const p2 = context.createBiquadFilter();
  const high = context.createBiquadFilter();
  low.type = 'lowshelf';
  p1.type = 'peaking';
  p2.type = 'peaking';
  high.type = 'highshelf';
  low.connect(p1);
  p1.connect(p2);
  p2.connect(high);

  const now = context.currentTime;
  const bands: Record<string, AudioParam> = {
    lowFreq: low.frequency,
    lowGain: low.gain,
    peak1Freq: p1.frequency,
    peak1Gain: p1.gain,
    peak1Q: p1.Q,
    peak2Freq: p2.frequency,
    peak2Gain: p2.gain,
    peak2Q: p2.Q,
    highFreq: high.frequency,
    highGain: high.gain,
  };
  for (const [name, param] of Object.entries(bands)) {
    if (params[name] !== undefined) setParamNow(param, clampParam('eq4', name, params[name]!), now);
  }

  return {
    input: low,
    output: high,
    latencySamples: 0,
    setParam: (name, value, when) => {
      const param = bands[name];
      if (param) rampParamTarget(param, clampParam('eq4', name, value), when);
    },
    destroy: () => {
      cancelParams(...Object.values(bands));
      for (const node of [low, p1, p2, high]) node.disconnect();
    },
  };
}

function buildFilter(context: BaseAudioContext, params: Record<string, number>): EffectCore {
  const biquad = context.createBiquadFilter();
  const now = context.currentTime;
  const setType = (index: number) => {
    biquad.type = FILTER_TYPE_TO_BIQUAD[FILTER_TYPES[clamp(Math.round(index), 0, 3)]!];
  };
  setType(params.type ?? 0);
  if (params.cutoff !== undefined) {
    setParamNow(biquad.frequency, clampParam('filter', 'cutoff', params.cutoff), now);
  }
  if (params.resonance !== undefined) {
    setParamNow(biquad.Q, clampParam('filter', 'resonance', params.resonance), now);
  }

  return {
    input: biquad,
    output: biquad,
    latencySamples: 0,
    setParam: (name, value, when) => {
      if (name === 'type') setType(value);
      else if (name === 'cutoff') {
        rampParamTarget(biquad.frequency, clampParam('filter', 'cutoff', value), when);
      } else if (name === 'resonance') {
        rampParamTarget(biquad.Q, clampParam('filter', 'resonance', value), when);
      }
    },
    destroy: () => {
      cancelParams(biquad.frequency, biquad.Q);
      biquad.disconnect();
    },
  };
}

function buildDelay(context: BaseAudioContext, params: Record<string, number>): EffectCore {
  const delay = context.createDelay(2); // free time max 2000 ms (spec §5.7)
  const feedback = context.createGain();
  const tone = context.createBiquadFilter();
  tone.type = 'lowpass';
  // input → delay → output(wet); delay → tone(lp) → feedback → delay (loop).
  delay.connect(tone);
  tone.connect(feedback);
  feedback.connect(delay);

  const now = context.currentTime;
  setParamNow(delay.delayTime, clampParam('delay', 'time', params.time ?? 350) / 1000, now);
  setParamNow(feedback.gain, clampParam('delay', 'feedback', params.feedback ?? 0.35), now);
  setParamNow(tone.frequency, clampParam('delay', 'tone', params.tone ?? 6_000), now);

  return {
    input: delay,
    output: delay,
    latencySamples: 0,
    setParam: (name, value, when) => {
      if (name === 'time') rampParamTarget(delay.delayTime, clampParam('delay', 'time', value) / 1000, when);
      else if (name === 'feedback') {
        rampParamTarget(feedback.gain, clampParam('delay', 'feedback', value), when);
      } else if (name === 'tone') rampParamTarget(tone.frequency, clampParam('delay', 'tone', value), when);
    },
    destroy: () => {
      cancelParams(delay.delayTime, feedback.gain, tone.frequency);
      for (const node of [delay, feedback, tone]) node.disconnect();
    },
  };
}

function buildCompressor(context: BaseAudioContext, params: Record<string, number>): EffectCore {
  const comp = context.createDynamicsCompressor();
  const makeup = context.createGain();
  comp.connect(makeup);
  const now = context.currentTime;
  if (params.threshold !== undefined) {
    setParamNow(comp.threshold, clampParam('compressor', 'threshold', params.threshold), now);
  }
  if (params.ratio !== undefined) {
    setParamNow(comp.ratio, clampParam('compressor', 'ratio', params.ratio), now);
  }
  if (params.attack !== undefined) {
    setParamNow(comp.attack, clampParam('compressor', 'attack', params.attack) / 1000, now);
  }
  if (params.release !== undefined) {
    setParamNow(comp.release, clampParam('compressor', 'release', params.release) / 1000, now);
  }
  if (params.knee !== undefined) setParamNow(comp.knee, clampParam('compressor', 'knee', params.knee), now);
  setParamNow(makeup.gain, dbToGain(clampParam('compressor', 'makeup', params.makeup ?? 0)), now);

  return {
    input: comp,
    output: makeup,
    latencySamples: 0,
    setParam: (name, value, when) => {
      if (name === 'threshold') {
        rampParamTarget(comp.threshold, clampParam('compressor', 'threshold', value), when);
      } else if (name === 'ratio') {
        rampParamTarget(comp.ratio, clampParam('compressor', 'ratio', value), when);
      } else if (name === 'attack') {
        rampParamTarget(comp.attack, clampParam('compressor', 'attack', value) / 1000, when);
      } else if (name === 'release') {
        rampParamTarget(comp.release, clampParam('compressor', 'release', value) / 1000, when);
      } else if (name === 'knee') rampParamTarget(comp.knee, clampParam('compressor', 'knee', value), when);
      else if (name === 'makeup') {
        rampParamTarget(makeup.gain, dbToGain(clampParam('compressor', 'makeup', value)), when);
      }
    },
    destroy: () => {
      cancelParams(comp.threshold, comp.ratio, comp.attack, comp.release, comp.knee, makeup.gain);
      comp.disconnect();
      makeup.disconnect();
    },
  };
}

function buildSaturator(context: BaseAudioContext, params: Record<string, number>): EffectCore {
  const shaper = context.createWaveShaper();
  shaper.oversample = '4x'; // spec §5.5 oversampling for non-linear stages
  const trim = context.createGain();
  shaper.connect(trim);

  let drive = clampParam('saturator', 'drive', params.drive ?? 6);
  let curveIndex = Math.round(clampParam('saturator', 'curve', params.curve ?? 0));
  const regenerate = () => {
    shaper.curve = makeSaturatorCurve(SATURATOR_CURVES[curveIndex]!, drive);
  };
  regenerate();
  setParamNow(
    trim.gain,
    dbToGain(clampParam('saturator', 'output', params.output ?? 0)),
    context.currentTime,
  );

  return {
    input: shaper,
    output: trim,
    latencySamples: 0,
    setParam: (name, value, when) => {
      if (name === 'drive') {
        drive = clampParam('saturator', 'drive', value);
        regenerate();
      } else if (name === 'curve') {
        curveIndex = Math.round(clampParam('saturator', 'curve', value));
        regenerate();
      } else if (name === 'output') {
        rampParamTarget(trim.gain, dbToGain(clampParam('saturator', 'output', value)), when);
      }
    },
    destroy: () => {
      cancelParams(trim.gain);
      shaper.curve = null;
      shaper.disconnect();
      trim.disconnect();
    },
  };
}

function buildReverb(context: BaseAudioContext, params: Record<string, number>): EffectCore {
  const predelay = context.createDelay(0.2); // spec §5.7 pre-delay 0–200 ms
  const convolver = context.createConvolver();
  convolver.normalize = true;
  predelay.connect(convolver);

  let size = clampParam('reverb', 'size', params.size ?? 1.8);
  let damping = clampParam('reverb', 'damping', params.damping ?? 0.5);
  const regenerate = () => {
    const channelData = makeReverbImpulse(context.sampleRate, size, damping, 2);
    const buffer = context.createBuffer(2, channelData[0]!.length, context.sampleRate);
    for (let c = 0; c < channelData.length; c++) buffer.getChannelData(c).set(channelData[c]!);
    convolver.buffer = buffer;
  };
  regenerate();
  setParamNow(
    predelay.delayTime,
    clampParam('reverb', 'predelay', params.predelay ?? 12) / 1000,
    context.currentTime,
  );

  return {
    input: predelay,
    output: convolver,
    latencySamples: 0,
    setParam: (name, value, when) => {
      if (name === 'size') {
        size = clampParam('reverb', 'size', value);
        regenerate();
      } else if (name === 'damping') {
        damping = clampParam('reverb', 'damping', value);
        regenerate();
      } else if (name === 'predelay') {
        rampParamTarget(predelay.delayTime, clampParam('reverb', 'predelay', value) / 1000, when);
      }
    },
    destroy: () => {
      cancelParams(predelay.delayTime);
      convolver.buffer = null;
      predelay.disconnect();
      convolver.disconnect();
    },
  };
}

/**
 * Worklet + WASM core (spec §5.6.2 / §5.7) for the `multibandComp`, `limiter` and (Phase 6+)
 * `fdnReverb` reverb engines. The precompiled kernel module is handed to the `dsp-effect`
 * processor via processorOptions; params flow over the port (kernels apply directly — the
 * native-node dezipper, §4.3, does not apply). The limiter reports its lookahead as latency for
 * PDC (spec §5.7.3); the others report 0.
 */
function buildWorkletEffect(
  context: BaseAudioContext,
  kernel: WorkletKernelName,
  effectType: EffectType,
  module: WebAssembly.Module,
  params: Record<string, number>,
): EffectCore {
  const clamped: Record<string, number> = {};
  for (const [name, value] of Object.entries(params)) clamped[name] = clampParam(effectType, name, value);
  const node = new AudioWorkletNode(context, DSP_EFFECT_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: { module, kernel, maxBlock: 128, params: clamped },
  });
  const latencySamples = kernel === 'limiter' ? Math.round(0.0015 * context.sampleRate) : 0;
  return {
    input: node,
    output: node,
    latencySamples,
    setParam: (name, value) => {
      const message: DspEffectMessage = { kind: 'param', name, value: clampParam(effectType, name, value) };
      node.port.postMessage(message);
    },
    destroy: () => {
      const dispose: DspEffectMessage = { kind: 'dispose' };
      node.port.postMessage(dispose);
      node.disconnect();
    },
  };
}

/**
 * Passthrough fallback used only when the kernel modules have not been loaded (e.g. unit tests
 * without the start gate). In the live app and offline renders the worklet cores above run the
 * real WASM DSP (spec §5.7).
 */
function buildPassthrough(context: BaseAudioContext): EffectCore {
  const node = context.createGain();
  return {
    input: node,
    output: node,
    latencySamples: 0,
    setParam: () => {},
    destroy: () => node.disconnect(),
  };
}

/** Build the native DSP core for `effectType` (spec §5.7). */
export function buildEffectCore(
  context: BaseAudioContext,
  effectType: EffectType,
  params: Record<string, number>,
): EffectCore {
  switch (effectType) {
    case 'eq4':
      return buildEq4(context, params);
    case 'filter':
      return buildFilter(context, params);
    case 'delay':
      return buildDelay(context, params);
    case 'compressor':
      return buildCompressor(context, params);
    case 'saturator':
      return buildSaturator(context, params);
    case 'reverb': {
      // spec §5.7: v1 native ConvolverNode; Phase 6+ the fdnReverb worklet when its module is
      // loaded (start gate / offline prepare). Native remains the fallback (e.g. unit tests).
      const module = getKernelModule('fdnReverb');
      return module
        ? buildWorkletEffect(context, 'fdnReverb', 'reverb', module, params)
        : buildReverb(context, params);
    }
    case 'multibandComp': {
      const module = getKernelModule('multibandComp');
      return module
        ? buildWorkletEffect(context, 'multibandComp', 'multibandComp', module, params)
        : buildPassthrough(context);
    }
    case 'limiter': {
      const module = getKernelModule('limiter');
      return module
        ? buildWorkletEffect(context, 'limiter', 'limiter', module, params)
        : buildPassthrough(context);
    }
    default:
      return buildPassthrough(context);
  }
}
