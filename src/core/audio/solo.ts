/**
 * Solo-in-place evaluation — spec §5.2. Solo is implemented as *computed mutes* in the
 * sync layer (never in the UI): while any channel of a group is soloed, every non-soloed
 * channel OF THAT GROUP is muted. Master and returns follow only their own mute flag, so a
 * soloed channel's sends still feed the returns (its reverb tail stays audible). Pure and
 * unit-tested (spec §11.1); the bridge applies the result to the graph channels.
 *
 * Pads and tracks are separate groups, and that is not a refinement of §5.2's wording but
 * the only reading under which soloing a track is audible at all: a pad channel's output
 * feeds its track's input (§5.2 stage 5), so muting every pad while a track is soloed
 * silences the very track that was soloed. §8.5.3 and §8.5.6 present the two as separate
 * lists for the same reason — a solo is pressed within one of them.
 */

export interface MuteSoloState {
  readonly mute: boolean;
  readonly solo: boolean;
}

/** The solo group a channel takes part in, or null when it takes part in none (spec §5.2). */
function soloGroup(channelId: string): 'pad' | 'track' | null {
  if (channelId.startsWith('pad:')) return 'pad';
  if (channelId.startsWith('track:')) return 'track';
  return null;
}

/**
 * Effective (audible) mute per channel given every strip's mute/solo flags (spec §5.2).
 * `true` ⇒ the channel is silenced.
 */
export function computeEffectiveMutes(
  channels: Readonly<Record<string, MuteSoloState>>,
): Record<string, boolean> {
  const soloed = new Set<'pad' | 'track'>();
  for (const [id, strip] of Object.entries(channels)) {
    const group = soloGroup(id);
    if (group !== null && strip.solo) soloed.add(group);
  }

  const result: Record<string, boolean> = {};
  for (const [id, strip] of Object.entries(channels)) {
    const group = soloGroup(id);
    result[id] = group === null ? strip.mute : strip.mute || (soloed.has(group) && !strip.solo);
  }
  return result;
}
