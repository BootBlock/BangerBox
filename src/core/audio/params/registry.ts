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
 * §7.8) resolve through the per-voice parameter path; the channel-level addresses resolve
 * to the AudioParams the graph exposes (mixer + insert).
 */
import {
  BPM_RANGE,
  ENVELOPE_TIME_MS_RANGE,
  FILTER_CUTOFF_RANGE,
  FILTER_RESONANCE_RANGE,
  GLOBAL_INSERT_LIMIT_RANGE,
  LEVEL_RANGE,
  PAD_INDEX_RANGE,
  PAN_RANGE,
  SEND_LEVEL_RANGE,
  SWING_RANGE,
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
  | {
      readonly kind: 'insertParam';
      readonly channelId: string;
      readonly slot: number;
      readonly param: string;
    }
  | {
      readonly kind: 'programParam';
      readonly programId: string;
      readonly padIndex: number;
      readonly param: string;
    }
  | { readonly kind: 'transportParam'; readonly param: TransportParam };

/**
 * Global transport parameters addressable by a control surface (spec §10.3 names "global
 * swing" among the project-mode Q-Link macros, and `QLinkBinding.targetStore` already
 * admits `'transport'`). Added in Phase 8 — see §14 2026-07-18 (k).
 */
export const TRANSPORT_PARAM_RANGES = {
  swing: SWING_RANGE,
  bpm: BPM_RANGE,
} as const satisfies Record<string, Range>;
export type TransportParam = keyof typeof TRANSPORT_PARAM_RANGES;

const SEND_PATTERN = /^mixer\.(.+)\.sendLevels\.(\d+)$/;
const LEVEL_PATTERN = /^mixer\.(.+)\.level$/;
const PAN_PATTERN = /^mixer\.(.+)\.pan$/;
const INSERT_PATTERN = /^insert:(.+):slot(\d+)\.([a-zA-Z0-9]+)$/;
/** Program-scope sound-design address, e.g. `program:<id>.pad:<idx>.filter.cutoff` (spec §7.8). */
const PROGRAM_PATTERN = /^program:(.+?)\.pad:(\d+)\.(.+)$/;
/** Global transport address, e.g. `transport.swing` (spec §10.3 project-mode macros). */
const TRANSPORT_PATTERN = /^transport\.([a-zA-Z0-9]+)$/;

/** Number of send taps a channel can address (spec §1.3.1: 4 returns). */
const SEND_COUNT = 4;

/**
 * A decimal index from an address, or null when it is out of range or not canonical
 * (issue #97).
 *
 * §7.8 makes `isAutomatable` the gate on what may be stored: an address that parses but
 * can never resolve lets a §9.3 `automation_points` row or a §10.3 Q-Link binding persist
 * against a parameter that does not exist. `insert:master:slot999.mix` and
 * `program:abc.pad:9999.pitch` both used to pass, because the send index above was the only
 * one bounded.
 *
 * The round-trip test is the second half: `sendLevels.00` names send 0 but is not the
 * string {@link channelSendPath} builds, so a point saved under it would never be found
 * again by anything reading the canonical address.
 */
function canonicalIndex(raw: string, [min, max]: Range): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return String(value) === raw ? value : null;
}

/**
 * Automatable program-scope sound-design leaves and their ranges (spec §6, §7.8). The two
 * amp-envelope times were added in Phase 8 because §10.3 names Amp Attack and Amp Release
 * among the pad-mode Q-Link defaults, and only registered addresses may be bound (§7.8
 * gate) — see §14 2026-07-18 (k).
 */
export const PROGRAM_PARAM_RANGES: Readonly<Record<string, Range>> = {
  'filter.cutoff': FILTER_CUTOFF_RANGE,
  'filter.resonance': FILTER_RESONANCE_RANGE,
  pitch: TUNE_SEMITONES_RANGE,
  amp: LEVEL_RANGE,
  pan: PAN_RANGE,
  'amp.attack': ENVELOPE_TIME_MS_RANGE,
  'amp.release': ENVELOPE_TIME_MS_RANGE,
};

/** Parse a canonical automation address into its target, or null if unregistered (§7.8). */
export function parseParamTarget(path: string): ParamTarget | null {
  const send = SEND_PATTERN.exec(path);
  if (send) {
    const sendIndex = canonicalIndex(send[2]!, [0, SEND_COUNT - 1]);
    if (sendIndex === null) return null;
    return { kind: 'channelSend', channelId: send[1]!, sendIndex };
  }
  const level = LEVEL_PATTERN.exec(path);
  if (level) return { kind: 'channelLevel', channelId: level[1]! };
  const pan = PAN_PATTERN.exec(path);
  if (pan) return { kind: 'channelPan', channelId: pan[1]! };
  const insert = INSERT_PATTERN.exec(path);
  if (insert) {
    // Slots are 1-based and bounded by the §1.3.1 configurable insert limit (1..8).
    const slot = canonicalIndex(insert[2]!, GLOBAL_INSERT_LIMIT_RANGE);
    if (slot === null) return null;
    return { kind: 'insertParam', channelId: insert[1]!, slot, param: insert[3]! };
  }
  const transport = TRANSPORT_PATTERN.exec(path);
  if (transport) {
    const param = transport[1]!;
    if (!(param in TRANSPORT_PARAM_RANGES)) return null;
    return { kind: 'transportParam', param: param as TransportParam };
  }
  const program = PROGRAM_PATTERN.exec(path);
  if (program) {
    const param = program[3]!;
    // Only registered sound-design leaves accept points (spec §7.8 gate).
    if (!(param in PROGRAM_PARAM_RANGES)) return null;
    const padIndex = canonicalIndex(program[2]!, PAD_INDEX_RANGE);
    if (padIndex === null) return null;
    return { kind: 'programParam', programId: program[1]!, padIndex, param };
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
export function transportParamPath(param: TransportParam): string {
  return `transport.${param}`;
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
    case 'transportParam':
      return TRANSPORT_PARAM_RANGES[target.param];
  }
}
