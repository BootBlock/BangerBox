/**
 * What a §9.5 render CONTAINS — decided before any audio node exists (spec §9.5, §5.2).
 *
 * §9.5 says the bounce builder "reconstructs the full graph … inside the offline context",
 * and §5.2 gives that graph ten stages. Two of the four §9.5 variants render a different
 * span of it, so which stages a render carries is a decision in its own right rather than a
 * detail of the wiring — and it has to be the SAME decision for the static strip values and
 * for the §7.8 automation that moves them, or a stem would sit at unity while its lane rode
 * the master fader. Both read {@link bounceIncludesChannel}.
 *
 * Pure and dependency-free (spec §2.5) so the rule is unit-testable without Web Audio; the
 * audible half is proven by an offline render in the browser (spec §11.2, §13.5).
 */
import { SCHEDULER_INTERVAL_MS } from '@/core/constants';
import type { AutomationPoint } from '@/core/project/schemas';
import {
  automatedTargets,
  automationRampForWindow,
  laneForTarget,
  type AutomationRamp,
} from '@/core/sequencer/automation';
import { secondsPerTick, secondsToTicks } from '@/core/sequencer/ppqn';
import type { SongSegment } from '@/core/sequencer/songMap';
import { parseParamTarget } from './params/registry';

/** Which §9.5 span a render covers — the two the §7.8 scopes are read against (spec §7.9). */
export type BounceMode = 'sequence' | 'song';

export interface BounceScope {
  /**
   * `sequence` renders one pass of one sequence; `song` renders the §7.9 playlist. The
   * distinction is not cosmetic: §7.8's two automation scopes first differ observably in
   * song mode, where a track lane spans the arrangement and a sequence lane restarts with
   * every repeat of its own pattern.
   */
  readonly mode: BounceMode;
  /**
   * The one track a §9.5 stem renders, or null for a full mix. A stem is "post-insert,
   * pre-master", so a non-null value also takes the master strip out of the render.
   */
  readonly stemTrackId: string | null;
}

/**
 * Whether a §5.2 channel strip is part of this render (spec §9.5).
 *
 * Only the master strip is ever excluded, and only from a stem: §9.5 places the stem tap
 * "post-insert, pre-master", which names stages 1–8 and leaves the master strip's own
 * inserts, fader, pan and mute (stage 9) out. Every other strip is either in the render or
 * has no voice feeding it, so it never gets built at all.
 *
 * The RETURN channels stay in a stem, and that is the one judgement here rather than a
 * reading of the spec. A stem set has to sum back to what the master bus was fed, or it is
 * not a set of stems; drop the returns and every send effect the user heard disappears from
 * the sum. Each stem carries only the return signal its OWN sends drove, so summing them
 * reconstructs stage 8's input rather than counting a shared reverb four times. (The sum is
 * exact only for a linear return chain — a compressor on a return responds to the whole bus,
 * not to one track's share of it. That is true of stems in any host and is recorded rather
 * than worked around.)
 */
export function bounceIncludesChannel(channelId: string, scope: BounceScope): boolean {
  return scope.stemTrackId === null || channelId !== 'master';
}

/**
 * The §7.8 automation ramps a render applies, in the order it applies them (spec §7.8, §9.5).
 *
 * This is the live scheduler's own emission rule run off the clock: each segment is walked in
 * `SCHEDULER_INTERVAL_MS` windows — the interval at which §7.1.4 actually reaches the graph —
 * and each window's ramp comes from {@link automationRampForWindow}, which is the only
 * implementation of that rule. Rendering the authored curve directly would be a second
 * implementation of §7.8's three curve shapes and would also render a mix the user has never
 * heard: the staircase is what live playback sounds like, and a bounce is of what was played.
 *
 * The VALUE tick follows §7.8's two scopes exactly as `SchedulerCore` reads them: a sequence
 * lane "loops with the pattern", so it is sampled at the segment's own sequence tick; a track
 * lane "spans the song arrangement", so in a song render it is sampled at the absolute song
 * tick. A sequence render has no arrangement to span — the pattern IS the arrangement — so it
 * samples both at the sequence tick.
 *
 * A lane addressing an unregistered path is dropped here rather than at the graph, because
 * §7.8 only admits registered addresses in the first place.
 */
export function bounceAutomationRamps(
  segments: readonly SongSegment[],
  lanes: Readonly<Record<string, readonly AutomationPoint[]>>,
  scope: BounceScope,
): AutomationRamp[] {
  const entries = Object.entries(lanes);
  const admitted = [...automatedTargets(entries)].filter((targetPath) => {
    const target = parseParamTarget(targetPath);
    if (target === null) return false;
    return !('channelId' in target) || bounceIncludesChannel(target.channelId, scope);
  });
  if (admitted.length === 0) return [];

  const ramps: AutomationRamp[] = [];
  for (const segment of segments) {
    // Resolved once per segment, not once per window: which lane governs a target depends on
    // the sequence PLAYING (spec §7.8), which is a property of the segment.
    const governing = admitted.map((targetPath) => ({
      targetPath,
      ...laneForTarget(entries, targetPath, segment.sequenceId),
    }));
    const perTick = secondsPerTick(segment.bpm);
    // At least one tick, so a nonsensically fast tempo cannot make the walk stand still.
    const windowTicks = Math.max(1, secondsToTicks(SCHEDULER_INTERVAL_MS / 1000, segment.bpm));
    for (let from = 0; from < segment.lengthTicks; from += windowTicks) {
      const to = Math.min(segment.lengthTicks, from + windowTicks);
      const when = segment.startSeconds + from * perTick;
      const rampEnd = segment.startSeconds + to * perTick;
      for (const lane of governing) {
        const valueTick = scope.mode === 'song' && lane.scope === 'track' ? segment.startTick + to : to;
        const ramp = automationRampForWindow(lane.targetPath, lane.points, valueTick, when, rampEnd);
        if (ramp) ramps.push(ramp);
      }
    }
  }
  return ramps;
}
