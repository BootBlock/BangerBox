/**
 * Automation & control parameter address registry — spec §7.8 / §10.3. Automatable
 * parameters are addressed by canonical string paths; only registered paths accept
 * automation points and Q-Link/XYFX bindings (spec §7.8 "only registered, automatable
 * parameters accept points"). This module owns the address grammar (parse + build), the
 * value ranges, and the registration test — all pure and dependency-free so the grammar is
 * exhaustively unit-testable (spec §7.1.5).
 *
 * Canonical forms (spec §7.8):
 *   mixer.<channelId>.level                       e.g. mixer.track:<id>.level
 *   mixer.<channelId>.pan
 *   mixer.<channelId>.sendLevels.<0-3>            e.g. mixer.pad:<prog>:<idx>.sendLevels.2
 *   insert:<channelId>:slot<N>.<param>           e.g. insert:track:<id>:slot2.mix
 *
 * `<channelId>` is a mixer channel address (`master` | `track:<id>` | `pad:<prog>:<idx>` |
 * `return:0..3`). Program-scope sound-design addresses (`program:<id>.pad:<idx>.…`, spec
 * §7.8) register in Phase 5 with per-voice parameter automation; Phase 4 automates the
 * channel-level AudioParams the graph exposes (mixer + insert).
 */
import {
  FILTER_CUTOFF_RANGE,
  FILTER_RESONANCE_RANGE,
  LEVEL_RANGE,
  PAN_RANGE,
  SEND_LEVEL_RANGE,
  TUNE_SEMITONES_RANGE,
  type Range,
} from '@/core/project/schemas';
import { EFFECT_PARAM_RANGES, MIX_RANGE } from '@/core/audio/inserts/effectParams';
import type { EffectType } from '@/core/project/schemas';

/** The registered automatable parameter kinds (spec §7.8). */
export type ParamTarget =
  | { readonly kind: 'channelLevel'; readonly channelId: string }
  | { readonly kind: 'channelPan'; readonly channelId: string }
  | { readonly kind: 'channelSend'; readonly channelId: string; readonly sendIndex: number }
  | { readonly kind: 'insertParam'; readonly channelId: string; readonly slot: number; readonly param: string }
  | { readonly kind: 'programParam'; readonly programId: string; readonly padIndex: number; readonly param: string };

const SEND_PATTERN = /^mixer\.(.+)\.sendLevels\.(\d+)$/;
const LEVEL_PATTERN = /^mixer\.(.+)\.level$/;
const PAN_PATTERN = /^mixer\.(.+)\.pan$/;
const INSERT_PATTERN = /^insert:(.+):slot(\d+)\.([a-zA-Z0-9]+)$/;
/** Program-scope sound-design address, e.g. `program:<id>.pad:<idx>.filter.cutoff` (spec §7.8). */
const PROGRAM_PATTERN = /^program:(.+?)\.pad:(\d+)\.(.+)$/;

/** Number of send taps a channel can address (spec §1.3.1: 4 returns). */
const SEND_COUNT = 4;

/** Automatable program-scope sound-design leaves and their ranges (spec §6, §7.8). */
export const PROGRAM_PARAM_RANGES: Readonly<Record<string, Range>> = {
  'filter.cutoff': FILTER_CUTOFF_RANGE,
  'filter.resonance': FILTER_RESONANCE_RANGE,
  pitch: TUNE_SEMITONES_RANGE,
  amp: LEVEL_RANGE,
  pan: PAN_RANGE,
};

/** Parse a canonical automation address into its target, or null if unregistered (§7.8). */
export function parseParamTarget(path: string): ParamTarget | null {
  const send = SEND_PATTERN.exec(path);
  if (send) {
    const sendIndex = Number(send[2]);
    if (sendIndex < 0 || sendIndex >= SEND_COUNT) return null;
    return { kind: 'channelSend', channelId: send[1]!, sendIndex };
  }
  const level = LEVEL_PATTERN.exec(path);
  if (level) return { kind: 'channelLevel', channelId: level[1]! };
  const pan = PAN_PATTERN.exec(path);
  if (pan) return { kind: 'channelPan', channelId: pan[1]! };
  const insert = INSERT_PATTERN.exec(path);
  if (insert) {
    return { kind: 'insertParam', channelId: insert[1]!, slot: Number(insert[2]), param: insert[3]! };
  }
  const program = PROGRAM_PATTERN.exec(path);
  if (program) {
    const param = program[3]!;
    // Only registered sound-design leaves accept points (spec §7.8 gate).
    if (!(param in PROGRAM_PARAM_RANGES)) return null;
    return { kind: 'programParam', programId: program[1]!, padIndex: Number(program[2]), param };
  }
  return null;
}

/** True when `path` is a registered, automatable parameter address (spec §7.8). */
export function isAutomatable(path: string): boolean {
  return parseParamTarget(path) !== null;
}

// --- Canonical builders (never hand-format an address at a call site) --------------

export function channelLevelPath(channelId: string): string {
  return `mixer.${channelId}.level`;
}
export function channelPanPath(channelId: string): string {
  return `mixer.${channelId}.pan`;
}
export function channelSendPath(channelId: string, sendIndex: number): string {
  return `mixer.${channelId}.sendLevels.${sendIndex}`;
}
export function insertParamPath(channelId: string, slot: number, param: string): string {
  return `insert:${channelId}:slot${slot}.${param}`;
}
export function programParamPath(programId: string, padIndex: number, param: string): string {
  return `program:${programId}.pad:${padIndex}.${param}`;
}

/**
 * Value range for a target (spec §7.8). Insert-param ranges depend on the effect in the
 * slot, so `effectType` is required for `insertParam` targets; `mix` is common to all
 * effects. Returns null for an insert param the effect does not expose.
 */
export function targetRange(target: ParamTarget, effectType?: EffectType): Range | null {
  switch (target.kind) {
    case 'channelLevel':
      return LEVEL_RANGE;
    case 'channelPan':
      return PAN_RANGE;
    case 'channelSend':
      return SEND_LEVEL_RANGE;
    case 'insertParam': {
      if (target.param === 'mix') return MIX_RANGE;
      if (!effectType) return null;
      return EFFECT_PARAM_RANGES[effectType][target.param] ?? null;
    }
    case 'programParam':
      return PROGRAM_PARAM_RANGES[target.param] ?? null;
  }
}
