/**
 * Sequencer sync subscriber (spec §4.3, §7.1.3). The only place that forwards transport,
 * tempo, swing, loop, sequence metadata, events, automation, and song order into the
 * scheduler worker (spec §4.3 "transport/sequence changes: forwarded to the scheduler
 * worker as typed messages"). It pushes the full current state on registration (the
 * scheduler start resync) and then narrow, diff-based incremental updates (spec §3.3, §4.3).
 * Live notes and note-repeat are performance gestures driven straight to the client by the
 * input layer (spec §7.6), not through here.
 */
import type { SchedulerClient, SchedulerSequenceMeta } from '@/core/sequencer';
import { sequenceLengthTicks } from '@/core/sequencer/songMap';
import type { MidiEvent } from '@/core/project/schemas';
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

/** Flatten the song playlist into repeat-expanded sequence ids (spec §7.9). */
function flattenSong(): string[] {
  const { songEntries } = useSequenceStore.getState();
  const ordered: string[] = [];
  for (const entry of [...songEntries].sort((a, b) => a.position - b.position)) {
    for (let repeat = 0; repeat < entry.repeats; repeat++) ordered.push(entry.sequenceId);
  }
  return ordered;
}

function pushMeta(scheduler: SchedulerClient): void {
  const { activeSequenceId, playbackMode } = useTransportStore.getState();
  scheduler.setSequenceMeta(buildSequenceMeta(), projectBpm(), activeSequenceId, playbackMode);
  scheduler.setSongSequence(flattenSong());
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
  scheduler.setMetronome(useTransportStore.getState().metronomeEnabled, useTransportStore.getState().countInBars);
  for (const [trackId, events] of Object.entries(useSequenceStore.getState().events)) {
    diffTrackEvents(scheduler, trackId, [], events);
  }
  for (const [key, points] of Object.entries(useSequenceStore.getState().automation)) {
    const { scope, ownerId, targetPath } = splitLaneKey(key);
    scheduler.sendAutomationDiff(scope, ownerId, targetPath, points);
  }
  pushTransport(scheduler);

  let prevEvents = useSequenceStore.getState().events;
  let prevAutomation = useSequenceStore.getState().automation;

  const unsubs: Unsubscribe[] = [
    useTransportStore.subscribe((s) => s.bpm, (bpm) => scheduler.setTempo(bpm)),
    useTransportStore.subscribe(
      (s) => `${s.swingAmount}:${s.swingDivision}`,
      () => scheduler.setSwing(useTransportStore.getState().swingAmount, useTransportStore.getState().swingDivision),
    ),
    useTransportStore.subscribe(
      (s) => `${s.loopEnabled}:${s.loopStartTick}:${s.loopEndTick}`,
      () => pushLoop(scheduler),
    ),
    useTransportStore.subscribe(
      (s) => `${s.metronomeEnabled}:${s.countInBars}`,
      () => scheduler.setMetronome(useTransportStore.getState().metronomeEnabled, useTransportStore.getState().countInBars),
    ),
    useTransportStore.subscribe(
      (s) => `${s.activeSequenceId}:${s.playbackMode}`,
      () => pushMeta(scheduler),
    ),
    // Transport play/record is the last thing forwarded so the worker already has state.
    useTransportStore.subscribe(
      (s) => `${s.isPlaying}:${s.isRecording}`,
      () => pushTransport(scheduler),
    ),
    useSequenceStore.subscribe(
      (s) => s.sequences,
      () => pushMeta(scheduler),
    ),
    useSequenceStore.subscribe(
      (s) => s.songEntries,
      () => scheduler.setSongSequence(flattenSong()),
    ),
    useSequenceStore.subscribe(
      (s) => s.events,
      (events) => {
        for (const [trackId, list] of Object.entries(events)) {
          if (list !== prevEvents[trackId]) diffTrackEvents(scheduler, trackId, prevEvents[trackId] ?? [], list);
        }
        prevEvents = events;
      },
    ),
    useSequenceStore.subscribe(
      (s) => s.automation,
      (automation) => {
        for (const [key, points] of Object.entries(automation)) {
          if (points !== prevAutomation[key]) {
            const { scope, ownerId, targetPath } = splitLaneKey(key);
            scheduler.sendAutomationDiff(scope, ownerId, targetPath, points);
          }
        }
        for (const key of Object.keys(prevAutomation)) {
          if (!(key in automation)) {
            const { scope, ownerId, targetPath } = splitLaneKey(key);
            scheduler.sendAutomationDiff(scope, ownerId, targetPath, []); // lane cleared
          }
        }
        prevAutomation = automation;
      },
    ),
  ];

  return combineUnsubscribers(unsubs);
}

/** Split a lane key `${scope}:${ownerId}:${targetPath}` (targetPath may contain colons). */
function splitLaneKey(key: string): { scope: 'sequence' | 'track'; ownerId: string; targetPath: string } {
  const first = key.indexOf(':');
  const second = key.indexOf(':', first + 1);
  return {
    scope: key.slice(0, first) as 'sequence' | 'track',
    ownerId: key.slice(first + 1, second),
    targetPath: key.slice(second + 1),
  };
}
