/**
 * Shared Zod primitives and enumerations for the domain schemas (spec §6, §5.7).
 * British spelling throughout (spec §3.7). Kept dependency-free apart from Zod.
 */
import { z } from 'zod';
import type { Range } from './ranges';

/** A finite number within an inclusive `[min, max]` range (rejects NaN/Infinity). */
export function ranged([min, max]: Range): z.ZodNumber {
  return z.number().min(min).max(max);
}

/** A non-negative finite number (times in ms, frame offsets). */
export const nonNegative = z.number().min(0);

/** An integer within an inclusive `[min, max]` range. */
export function rangedInt([min, max]: Range): z.ZodNumber {
  return z.number().int().min(min).max(max);
}

/**
 * Note divisions used by synced LFOs (spec §6 LfoConfig) and the synced delay
 * (spec §5.7). Straight, dotted (`.`) and triplet (`T`) forms; the encoding is
 * this project's canonical string form (recorded so later phases reuse it, not
 * reinvent it — spec §13.6 anchor).
 */
export const NOTE_DIVISIONS = [
  '1/1',
  '1/2',
  '1/4',
  '1/8',
  '1/16',
  '1/32',
  '1/2.',
  '1/4.',
  '1/8.',
  '1/16.',
  '1/2T',
  '1/4T',
  '1/8T',
  '1/16T',
  '1/32T',
] as const;
export const noteDivisionSchema = z.enum(NOTE_DIVISIONS);
export type NoteDivision = z.infer<typeof noteDivisionSchema>;

/** Built-in insert effect identifiers (spec §5.7). */
export const EFFECT_TYPES = [
  'eq4',
  'filter',
  'delay',
  'compressor',
  'saturator',
  'reverb',
  'multibandComp',
  'limiter',
] as const;
export const effectTypeSchema = z.enum(EFFECT_TYPES);
export type EffectType = z.infer<typeof effectTypeSchema>;

/** Per-pad playback modes (spec §5.4). */
export const playbackModeSchema = z.enum(['poly', 'mono', 'oneShot']);
export type PlaybackMode = z.infer<typeof playbackModeSchema>;

/** Automation interpolation curves (spec §7.8). */
export const automationCurveSchema = z.enum(['step', 'linear', 'exp']);
export type AutomationCurve = z.infer<typeof automationCurveSchema>;

/** Automation scope: sequence-loops-with-pattern vs track-spans-arrangement (spec §7.8). */
export const automationScopeSchema = z.enum(['sequence', 'track']);
export type AutomationScope = z.infer<typeof automationScopeSchema>;

/** Track lane kinds (spec §9.3 tracks.type). */
export const trackTypeSchema = z.enum(['drum', 'keygroup', 'audio']);
export type TrackType = z.infer<typeof trackTypeSchema>;

/** Storage bit depth (spec §1.3 #18, §9.3). */
export const bitDepthSchema = z.enum(['16', '24', '32f']);
export type BitDepth = z.infer<typeof bitDepthSchema>;
