/**
 * Q-Link binding schema (spec §10.3). Bindings persist per mode in `app_settings`
 * (spec §10.3); the schema guards them on read. The BLE runtime itself arrives in
 * Phase 8 — Phase 2 owns only the persisted binding shape and the store that holds it.
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
