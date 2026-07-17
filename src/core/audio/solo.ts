/**
 * Solo-in-place evaluation — spec §5.2. Solo is implemented as *computed mutes* in the
 * sync layer (never in the UI): while any pad/track is soloed, every non-soloed pad/track
 * is muted. Master and returns follow only their own mute flag, so a soloed channel's
 * sends still feed the returns (its reverb tail stays audible). Pure and unit-tested
 * (spec §11.1); the bridge applies the result to the graph channels.
 */

export interface MuteSoloState {
  readonly mute: boolean;
  readonly solo: boolean;
}

/** A channel participates in solo-in-place only if it is a pad or track (spec §5.2). */
function isSoloable(channelId: string): boolean {
  return channelId.startsWith('pad:') || channelId.startsWith('track:');
}

/**
 * Effective (audible) mute per channel given every strip's mute/solo flags (spec §5.2).
 * `true` ⇒ the channel is silenced.
 */
export function computeEffectiveMutes(
  channels: Readonly<Record<string, MuteSoloState>>,
): Record<string, boolean> {
  let anySolo = false;
  for (const [id, strip] of Object.entries(channels)) {
    if (isSoloable(id) && strip.solo) {
      anySolo = true;
      break;
    }
  }

  const result: Record<string, boolean> = {};
  for (const [id, strip] of Object.entries(channels)) {
    result[id] = isSoloable(id) ? strip.mute || (anySolo && !strip.solo) : strip.mute;
  }
  return result;
}
