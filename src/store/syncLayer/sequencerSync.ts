/**
 * Sequencer sync subscriber (spec §4.3, §7.1.3). The only place that forwards transport,
 * tempo, swing, loop, sequence metadata, events, automation, and song order into the
 * scheduler worker (spec §4.3 "transport/sequence changes: forwarded to the scheduler
 * worker as typed messages"). It pushes the full current state on registration (the
 * scheduler start resync) and then narrow, diff-based incremental updates (spec §3.3, §4.3).
 * Live notes and note-repeat are performance gestures driven straight to the client by the
 * input layer (spec §7.6), not through here.
 */
import type { SchedulerClient, SchedulerSequenceMeta, SchedulerSongEntry } from '@/core/sequencer';
import { sequenceLengthTicks } from '@/core/sequencer/songMap';
import { parseAutomationLaneKey, type AutomationPoint, type MidiEvent } from '@/core/project/schemas';
import { useSequenceStore } from '../useSequenceStore';
import { useTransportStore } from '../useTransportStore';
import { combineUnsubscribers, type Unsubscribe } from './bridge';

/** Effective project tempo — the active effective tempo stands in for the project default. */
function projectBpm(): number {
  return useTransportStore.getState().bpm;
}

/** Build the per-sequence metadata map for the scheduler (spec §7.9). */
function buildSequenceMeta(): Record<string, SchedulerSequenceMeta> {
  const { sequences } = useSequenceStore.getState();
  const meta: Record<string, SchedulerSequenceMeta> = {};
  for (const [id, sequence] of Object.entries(sequences)) {
    meta[id] = {
      lengthBars: sequence.lengthBars,
      timeSigNumerator: sequence.timeSig.numerator,
      timeSigDenominator: sequence.timeSig.denominator,
      tempo: sequence.tempo,
    };
  }
  return meta;
}

/** Ticks of the active sequence, for the implicit sequence-length loop (spec §7.1.4). */
function activeSequenceLengthTicks(): number {
  const { activeSequenceId } = useTransportStore.getState();
  const sequence = activeSequenceId ? useSequenceStore.getState().sequences[activeSequenceId] : undefined;
  return sequence ? sequenceLengthTicks(sequence) : 0;
}

/**
 * The song playlist in `position` order, repeats UNEXPANDED (spec §7.9, issue #130).
 *
 * This used to expand `repeats` here, which made an entry with `repeats: 2` two entries by
 * the time the worker saw it — so `songAdvanced { entryIndex }` indexed the flattened list
 * where §7.9 requires the index into the position-sorted ENTRY list. Sorting still happens
 * on this side, because `songEntries` is the store's own array and its `position` field is
 * the ordering §7.9 names; the worker then takes the array index as the entry index.
 */
function orderedSongEntries(): SchedulerSongEntry[] {
  const { songEntries } = useSequenceStore.getState();
  return [...songEntries]
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({ sequenceId: entry.sequenceId, repeats: entry.repeats }));
}

function pushMeta(scheduler: SchedulerClient): void {
  const { activeSequenceId, playbackMode } = useTransportStore.getState();
  scheduler.setSequenceMeta(buildSequenceMeta(), projectBpm(), activeSequenceId, playbackMode);
  scheduler.setSongSequence(orderedSongEntries());
}

/**
 * The active sequence's metadata AND the loop derived from it (spec §7.1.4, §7.9).
 *
 * With no user brace the loop IS the active sequence's own length, so everything that changes
 * which sequence is active — or that sequence's length — changes the loop as well. Pushing the
 * metadata alone left the worker looping the OLD sequence's length over the new pattern, which
 * stayed inaudible only while every sequence played at once (issue #132).
 */
function pushActiveSequence(scheduler: SchedulerClient): void {
  pushMeta(scheduler);
  pushLoop(scheduler);
}

/** The scheduler's loop region: the user brace when enabled, else the sequence length. */
function pushLoop(scheduler: SchedulerClient): void {
  const { loopEnabled, loopStartTick, loopEndTick } = useTransportStore.getState();
  if (loopEnabled) {
    scheduler.setLoop(true, loopStartTick, loopEndTick);
  } else {
    scheduler.setLoop(true, 0, activeSequenceLengthTicks());
  }
}

function pushTransport(scheduler: SchedulerClient): void {
  const { isPlaying, isRecording, loopEnabled, loopStartTick } = useTransportStore.getState();
  scheduler.setTransport(isPlaying, isRecording, loopEnabled ? loopStartTick : 0);
}

/** Send an events diff for one track by comparing previous and next event lists (spec §7.1.3). */
function diffTrackEvents(
  scheduler: SchedulerClient,
  trackId: string,
  prev: readonly MidiEvent[],
  next: readonly MidiEvent[],
): void {
  const nextIds = new Set(next.map((e) => e.id));
  const deletes = prev.filter((e) => !nextIds.has(e.id)).map((e) => e.id);
  const sequenceId = useSequenceStore.getState().tracks[trackId]?.sequenceId ?? '';
  scheduler.sendEventsDiff(trackId, sequenceId, next, deletes);
}

export function subscribeSequencerSync(scheduler: SchedulerClient): Unsubscribe {
  // --- initial full resync (scheduler start) ---
  pushMeta(scheduler);
  scheduler.setTempo(useTransportStore.getState().bpm);
  scheduler.setSwing(useTransportStore.getState().swingAmount, useTransportStore.getState().swingDivision);
  pushLoop(scheduler);
  scheduler.setMetronome(
    useTransportStore.getState().metronomeEnabled,
    useTransportStore.getState().countInBars,
  );
  for (const [trackId, events] of Object.entries(useSequenceStore.getState().events)) {
    diffTrackEvents(scheduler, trackId, [], events);
  }
  for (const [key, points] of Object.entries(useSequenceStore.getState().automation)) {
    pushLane(scheduler, key, points);
  }
  pushGrooves(scheduler);
  scheduler.setSongLoop(useTransportStore.getState().songLoopEnabled);
  pushTransport(scheduler);

  let prevTrackGrooves = useSequenceStore.getState().trackGrooveIds;
  let prevTemplates = useSequenceStore.getState().grooveTemplates;
  let prevEvents = useSequenceStore.getState().events;
  let prevAutomation = useSequenceStore.getState().automation;

  const unsubs: Unsubscribe[] = [
    useTransportStore.subscribe(
      (s) => s.bpm,
      (bpm) => scheduler.setTempo(bpm),
    ),
    useTransportStore.subscribe(
      (s) => `${s.swingAmount}:${s.swingDivision}`,
      () =>
        scheduler.setSwing(
          useTransportStore.getState().swingAmount,
          useTransportStore.getState().swingDivision,
        ),
    ),
    useTransportStore.subscribe(
      (s) => `${s.loopEnabled}:${s.loopStartTick}:${s.loopEndTick}`,
      () => pushLoop(scheduler),
    ),
    useTransportStore.subscribe(
      (s) => `${s.metronomeEnabled}:${s.countInBars}`,
      () =>
        scheduler.setMetronome(
          useTransportStore.getState().metronomeEnabled,
          useTransportStore.getState().countInBars,
        ),
    ),
    useTransportStore.subscribe(
      (s) => `${s.activeSequenceId}:${s.playbackMode}`,
      () => pushActiveSequence(scheduler),
    ),
    // spec §7.9: what the worker does when it reaches `songTotalTicks`.
    useTransportStore.subscribe(
      (s) => s.songLoopEnabled,
      (enabled) => scheduler.setSongLoop(enabled),
    ),
    // Transport play/record is the last thing forwarded so the worker already has state.
    useTransportStore.subscribe(
      (s) => `${s.isPlaying}:${s.isRecording}`,
      () => pushTransport(scheduler),
    ),
    useSequenceStore.subscribe(
      (s) => s.sequences,
      () => pushActiveSequence(scheduler),
    ),
    useSequenceStore.subscribe(
      (s) => s.songEntries,
      () => scheduler.setSongSequence(orderedSongEntries()),
    ),
    // Groove is non-destructive schedule-time shaping, so only the assignment travels —
    // the events themselves never change (spec §7.5).
    useSequenceStore.subscribe(
      (s) => s.trackGrooveIds,
      (assignments) => {
        const templates = useSequenceStore.getState().grooveTemplates;
        for (const [trackId, templateId] of Object.entries(assignments)) {
          if (assignments[trackId] !== prevTrackGrooves[trackId]) {
            scheduler.setGroove(trackId, templates[templateId] ?? null);
          }
        }
        for (const trackId of Object.keys(prevTrackGrooves)) {
          if (!(trackId in assignments)) scheduler.setGroove(trackId, null);
        }
        prevTrackGrooves = assignments;
      },
    ),
    // A template is keyed by its source sample's name (spec §14 (ai)), so re-extracting
    // REPLACES one that tracks are already assigned to. Without this the worker keeps
    // shaping notes with the template it was handed first, and the only way to see the new
    // one is to toggle the assignment or reload the project.
    useSequenceStore.subscribe(
      (s) => s.grooveTemplates,
      (templates) => {
        const assignments = useSequenceStore.getState().trackGrooveIds;
        for (const [trackId, templateId] of Object.entries(assignments)) {
          if (templates[templateId] !== prevTemplates[templateId]) {
            scheduler.setGroove(trackId, templates[templateId] ?? null);
          }
        }
        prevTemplates = templates;
      },
    ),
    useSequenceStore.subscribe(
      (s) => s.events,
      (events) => {
        for (const [trackId, list] of Object.entries(events)) {
          if (list !== prevEvents[trackId]) {
            diffTrackEvents(scheduler, trackId, prevEvents[trackId] ?? [], list);
          }
        }
        prevEvents = events;
      },
    ),
    useSequenceStore.subscribe(
      (s) => s.automation,
      (automation) => {
        for (const [key, points] of Object.entries(automation)) {
          if (points !== prevAutomation[key]) pushLane(scheduler, key, points);
        }
        for (const key of Object.keys(prevAutomation)) {
          if (!(key in automation)) pushLane(scheduler, key, []); // lane cleared
        }
        prevAutomation = automation;
      },
    ),
  ];

  return combineUnsubscribers(unsubs);
}

/** Push every track's groove assignment to the worker (spec §7.5). */
function pushGrooves(scheduler: SchedulerClient): void {
  const { trackGrooveIds, grooveTemplates } = useSequenceStore.getState();
  for (const [trackId, templateId] of Object.entries(trackGrooveIds)) {
    scheduler.setGroove(trackId, grooveTemplates[templateId] ?? null);
  }
}

/**
 * Forward one lane's points, or skip a key that is not a lane key at all (spec §7.8).
 *
 * The split lives in `parseAutomationLaneKey`, beside the `automationLaneKey` that builds
 * it, rather than being open-coded here: this copy also cast the scope to its union without
 * checking it, so a malformed key would have reached the worker claiming to be a scope the
 * §7.1.3 guard then rejected, dropping the lane in silence (issue #96).
 */
function pushLane(scheduler: SchedulerClient, key: string, points: readonly AutomationPoint[]): void {
  const lane = parseAutomationLaneKey(key);
  if (!lane) return;
  scheduler.sendAutomationDiff(lane.scope, lane.ownerId, lane.targetPath, points);
}
