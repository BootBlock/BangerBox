/**
 * Q-Link binding resolution and encoder scaling — spec §10.3. Pure and dependency-free
 * (spec §2.5): the runtime that dispatches these values into stores lives in
 * `qlinkRuntime.ts`, so the whole mapping — lookup, curve, absolute vs relative, and each
 * mode's defaults — is unit-testable without a transport or a store.
 *
 * Encoder travel is mapped through the *same* taper the on-screen primitives draw
 * (`@/core/math`), so turning a hardware encoder and dragging the matching knob move a
 * parameter identically (spec §3.6 ZERO DRY).
 */
import { clamp, normalisedToValue, valueToNormalised, type ControlRange } from '@/core/math';
import {
  channelLevelPath,
  channelPanPath,
  parseParamTarget,
  programParamPath,
  targetRange,
  transportParamPath,
} from '@/core/audio/params/registry';
import type { QLinkBinding, QLinkMode } from '@/core/project/schemas';

/** Raw CC value bounds (spec §10.1 — 7-bit data bytes). */
const CC_MAX = 127;

/**
 * Detents a relative encoder needs for a full-scale sweep. Matching the absolute
 * resolution keeps both encoder modes feeling like the same control (spec §10.3).
 */
const RELATIVE_FULL_SCALE_DETENTS = 127;

/**
 * Default CC block for freshly created bindings: MIDI "sound controllers" 70+, the
 * conventional continuous-controller block, so a stock ESP32 build lands on sensible
 * numbers before the learn flow overwrites them with the real CC (spec §10.3).
 */
export const DEFAULT_QLINK_CC_BASE = 70;

/** The binding an incoming CC drives, or undefined when that CC is unbound (spec §10.3). */
export function bindingForCc(
  bindings: readonly QLinkBinding[],
  cc: number,
): QLinkBinding | undefined {
  let best: QLinkBinding | undefined;
  for (const candidate of bindings) {
    if (candidate.cc !== cc) continue;
    // Two encoders on one CC is a mis-mapping rather than an error; the lowest encoder
    // wins so the behaviour is at least deterministic.
    if (best === undefined || candidate.encoderIndex < best.encoderIndex) best = candidate;
  }
  return best;
}

function boundsOf(binding: QLinkBinding): ControlRange {
  return [binding.minValue, binding.maxValue];
}

/** Scale a raw CC value into the binding's range along its curve (spec §10.3). */
export function scaleCcToValue(ccValue: number, binding: QLinkBinding): number {
  const normalised = clamp(ccValue, 0, CC_MAX) / CC_MAX;
  return normalisedToValue(normalised, boundsOf(binding), binding.curve);
}

/**
 * Decode a relative encoder's two's-complement 7-bit increment (spec §10.3): 1..63 step
 * up, 65..127 step down (127 = −1), 0 is no movement.
 */
export function relativeIncrement(ccValue: number): number {
  const value = clamp(Math.round(ccValue), 0, CC_MAX);
  return value >= 64 ? value - 128 : value;
}

/**
 * The value a CC message produces for a binding: the scaled absolute position, or — for a
 * relative encoder — `current` nudged by the decoded increment along the binding's curve
 * (spec §10.3). Relative moves clamp at the bounds rather than wrapping.
 */
export function nextValueForCc(current: number, ccValue: number, binding: QLinkBinding): number {
  if (binding.mode === 'absolute') return scaleCcToValue(ccValue, binding);
  const bounds = boundsOf(binding);
  const travel = valueToNormalised(current, bounds, binding.curve);
  const stepped = travel + relativeIncrement(ccValue) / RELATIVE_FULL_SCALE_DETENTS;
  return normalisedToValue(stepped, bounds, binding.curve);
}

/** What the default bindings for a mode are computed against (spec §10.3 context-awareness). */
export interface QLinkContext {
  readonly programId: string | null;
  readonly padIndex: number | null;
}

/** Build a binding for a registry path, seeded with that path's registered range (§7.8). */
function bindingFor(
  encoderIndex: number,
  path: string,
  targetStore: QLinkBinding['targetStore'],
  curve: QLinkBinding['curve'] = 'linear',
): QLinkBinding | null {
  const target = parseParamTarget(path);
  const range = target ? targetRange(target) : null;
  if (!range) return null;
  return {
    encoderIndex,
    cc: DEFAULT_QLINK_CC_BASE + encoderIndex,
    targetStore,
    targetParameterPath: path,
    minValue: range[0],
    maxValue: range[1],
    curve,
    mode: 'absolute',
  };
}

/** Renumber encoders from zero so a mode's defaults always start at the first encoder. */
function sequence(bindings: readonly (QLinkBinding | null)[]): QLinkBinding[] {
  return bindings
    .filter((binding): binding is QLinkBinding => binding !== null)
    .map((binding, index) => ({
      ...binding,
      encoderIndex: index,
      cc: DEFAULT_QLINK_CC_BASE + index,
    }));
}

/**
 * The default bindings for a Q-Link mode (spec §10.3).
 *
 * - `screen` returns nothing: its bindings come from whichever panel currently holds
 *   focus, via the `useUIStore` focus registry (spec §10.3) — see `qlinkRuntime.ts`.
 * - `pad` is the spec's named set: Pitch / Filter Cutoff / Amp Attack / Amp Release of the
 *   selected pad.
 * - `program` maps the selected pad's wider sound-design surface. Spec §10.3 calls these
 *   "program macros", but §6 defines no macro layer, so rather than invent one (spec §3.1
 *   Strategic YAGNI, §13.6 naming freeze) these address registered §7.8 leaves directly.
 * - `project` is the spec's global set: master level and global swing. "Master filter" is
 *   an insert whose presence is not guaranteed, so it is left to the manual picker.
 */
export function defaultBindingsForMode(mode: QLinkMode, context: QLinkContext): QLinkBinding[] {
  const { programId, padIndex } = context;
  const hasPad = programId !== null && padIndex !== null;

  switch (mode) {
    case 'screen':
      return [];

    case 'pad':
      if (!hasPad) return [];
      return sequence([
        bindingFor(0, programParamPath(programId, padIndex, 'pitch'), 'program'),
        bindingFor(1, programParamPath(programId, padIndex, 'filter.cutoff'), 'program', 'log'),
        bindingFor(2, programParamPath(programId, padIndex, 'amp.attack'), 'program'),
        bindingFor(3, programParamPath(programId, padIndex, 'amp.release'), 'program'),
      ]);

    case 'program': {
      if (!hasPad) return [];
      // Level and pan are the pad's *mixer channel* (see `voiceParams.isPerVoiceTarget`),
      // so they are addressed there — routing them through the program payload instead
      // would move the graph while the Mixer's pad strip showed a stale value.
      const padChannel = `pad:${programId}:${padIndex}`;
      return sequence([
        bindingFor(0, channelLevelPath(padChannel), 'mixer'),
        bindingFor(1, channelPanPath(padChannel), 'mixer'),
        bindingFor(2, programParamPath(programId, padIndex, 'filter.cutoff'), 'program', 'log'),
        bindingFor(3, programParamPath(programId, padIndex, 'filter.resonance'), 'program'),
      ]);
    }

    case 'project':
      return sequence([
        bindingFor(0, channelLevelPath('master'), 'mixer'),
        bindingFor(1, transportParamPath('swing'), 'transport'),
      ]);
  }
}
