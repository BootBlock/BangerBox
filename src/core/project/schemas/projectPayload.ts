/**
 * Project `payload` schema (spec §9.3 projects.payload — "Zod-validated project extras
 * (master strip, groove templates)"). The master mixer strip persists here (its live
 * state lives in `useMixerStore` under the `master` channel, spec §4.2), as do the §7.5
 * groove templates §9.3 names, the track assignments that spend them, and the §7.9
 * song-loop toggle (all live in `useSequenceStore` / `useTransportStore`). Unknown keys
 * are preserved (`.loose()`) so a payload written by a later build round-trips unharmed.
 */
import { z } from 'zod';
import { grooveTemplateSchema } from '@/core/sequencer/groove';
import { channelStripSchema } from './mixer';

export const projectPayloadSchema = z
  .object({
    master: channelStripSchema.optional(),
    /** The four global return strips (spec §5.2); project-scoped like the master. */
    returns: z.array(channelStripSchema).optional(),
    /**
     * spec §7.5 groove templates, keyed by the name they were extracted under, and the
     * track-to-template assignments that apply them non-destructively at schedule time.
     * Both are optional: a project saved before the groove path was wired has neither.
     */
    grooveTemplates: z.record(z.string(), grooveTemplateSchema).optional(),
    trackGrooveIds: z.record(z.string(), z.string()).optional(),
    /**
     * spec §7.9 `songLoopEnabled` — whether the song wraps at its end instead of stopping.
     * Optional so a project written before this field loads as "stops at the end", which
     * is §7.9's own default rather than a guess.
     */
    songLoopEnabled: z.boolean().optional(),
  })
  .loose();
export type ProjectPayload = z.infer<typeof projectPayloadSchema>;
