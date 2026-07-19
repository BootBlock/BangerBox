/**
 * Mixer channel-strip schemas (spec §4.2). A ChannelStrip is the persisted state of
 * one mixer lane (pad within the active program, track, return, or master); the audio
 * nodes it drives are built by the sync layer (spec §4.3).
 */
import { z } from 'zod';
import { effectTypeSchema } from './primitives';
import { ranged } from './primitives';
import { LEVEL_RANGE, PAN_RANGE, SEND_LEVEL_RANGE } from './ranges';

/** One insert slot: an effect (or empty) plus its enable flag and typed params (spec §4.2). */
export const insertSlotSchema = z.object({
  id: z.string(),
  effectType: effectTypeSchema.nullable(),
  enabled: z.boolean(),
  params: z.record(z.string(), z.number()),
});
export type InsertSlotState = z.infer<typeof insertSlotSchema>;

/** Four send taps → the four global return channels (spec §1.3.1, §5.2). */
export const sendLevelsSchema = z.tuple([
  ranged(SEND_LEVEL_RANGE),
  ranged(SEND_LEVEL_RANGE),
  ranged(SEND_LEVEL_RANGE),
  ranged(SEND_LEVEL_RANGE),
]);
export type SendLevels = z.infer<typeof sendLevelsSchema>;

export const channelStripSchema = z.object({
  id: z.string(),
  level: ranged(LEVEL_RANGE),
  pan: ranged(PAN_RANGE),
  mute: z.boolean(),
  solo: z.boolean(),
  sendLevels: sendLevelsSchema,
  inserts: z.array(insertSlotSchema),
});
export type ChannelStrip = z.infer<typeof channelStripSchema>;

/** A silent, centred, un-muted strip with no inserts — the neutral default (spec §4.2). */
export function createDefaultChannelStrip(id: string, insertSlots = 4): ChannelStrip {
  return {
    id,
    level: 1,
    pan: 0,
    mute: false,
    solo: false,
    sendLevels: [0, 0, 0, 0],
    inserts: Array.from({ length: insertSlots }, () => createEmptyInsertSlot()),
  };
}

/** An empty (effect-less) insert slot. */
export function createEmptyInsertSlot(): InsertSlotState {
  return { id: crypto.randomUUID(), effectType: null, enabled: false, params: {} };
}
