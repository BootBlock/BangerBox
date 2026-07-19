/**
 * Q-Link binding schema (spec §10.3). Bindings persist per mode in `app_settings`
 * (spec §10.3); the schema guards them on read. This module owns only the persisted
 * binding shape — the BLE runtime that acts on a binding lives in `core/midi` (spec §10.4).
 */
import { z } from 'zod';
import { rangedInt } from './primitives';
import { CC_RANGE, ENCODER_INDEX_RANGE } from './ranges';

export const qLinkModeSchema = z.enum(['screen', 'pad', 'program', 'project']);
export type QLinkMode = z.infer<typeof qLinkModeSchema>;

export const qLinkBindingSchema = z.object({
  encoderIndex: rangedInt(ENCODER_INDEX_RANGE),
  cc: rangedInt(CC_RANGE),
  targetStore: z.enum(['mixer', 'program', 'transport', 'project']),
  targetParameterPath: z.string(),
  minValue: z.number(),
  maxValue: z.number(),
  curve: z.enum(['linear', 'log']),
  mode: z.enum(['absolute', 'relative']),
});
export type QLinkBinding = z.infer<typeof qLinkBindingSchema>;
