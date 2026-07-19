/**
 * Project `payload` schema (spec §9.3 projects.payload — "Zod-validated project extras
 * (master strip, groove templates)"). The master mixer strip persists here (its live
 * state lives in `useMixerStore` under the `master` channel, spec §4.2). The groove
 * templates §9.3 also names have no field here yet — grooves are only ever baked
 * destructively into events, so none survives to persist (see issue #71). Unknown keys
 * are preserved (`.loose()`) so a payload written by a later build round-trips unharmed.
 */
import { z } from 'zod';
import { channelStripSchema } from './mixer';

export const projectPayloadSchema = z
  .object({
    master: channelStripSchema.optional(),
    /** The four global return strips (spec §5.2); project-scoped like the master. */
    returns: z.array(channelStripSchema).optional(),
  })
  .loose();
export type ProjectPayload = z.infer<typeof projectPayloadSchema>;

/** The empty payload — a fresh project persists its master strip on first autosave. */
export function createDefaultProjectPayload(): ProjectPayload {
  return {};
}
