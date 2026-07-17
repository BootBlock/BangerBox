/**
 * Project `payload` schema (spec §9.3 projects.payload — "Zod-validated project extras
 * (master strip, groove templates)"). The master mixer strip persists here (its live
 * state lives in `useMixerStore` under the `master` channel, spec §4.2). Groove
 * templates (spec §7.5) arrive in Phase 4+; unknown keys are preserved (`.loose()`)
 * so a payload written by a later build round-trips through this one unharmed.
 */
import { z } from 'zod';
import { channelStripSchema } from './mixer';

export const projectPayloadSchema = z
  .object({
    master: channelStripSchema.optional(),
  })
  .loose();
export type ProjectPayload = z.infer<typeof projectPayloadSchema>;

/** The empty payload — a fresh project persists its master strip on first autosave. */
export function createDefaultProjectPayload(): ProjectPayload {
  return {};
}
