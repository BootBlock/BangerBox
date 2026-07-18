/// <reference lib="webworker" />
/**
 * The sequencer scheduling Web Worker (spec §7.1.1 — a standard Web Worker, never the UI
 * thread, never an AudioWorklet). This file is a thin message shell (spec §11.3): all timing
 * logic lives in the pure {@link SchedulerCore}, driven here by the {@link ClockModel} and a
 * `SCHEDULER_INTERVAL_MS` wake loop. Each wake it estimates context time, ticks the core,
 * writes the playhead SAB (spec §7.1.4), and posts the resulting batches/notifications.
 * Inbound messages are Zod-guarded exactly like the DB worker (spec §1.3 #11).
 */
import { SCHEDULER_INTERVAL_MS } from '@/core/constants';
import { ClockModel } from './clockSync';
import { parseSchedulerRequest, type SchedulerRequest, type SchedulerResponse } from './messages';
import { PlayheadWriter } from './playheadSab';
import { SchedulerCore } from './schedulerCore';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

const core = new SchedulerCore();
const clock = new ClockModel();
let playhead: PlayheadWriter | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function post(response: SchedulerResponse): void {
  scope.postMessage(response);
}

scope.addEventListener('message', (event: MessageEvent) => {
  const request = parseSchedulerRequest(event.data);
  if (!request) return; // Zod guard (locked decision §1.3 #11): drop malformed traffic.
  handle(request);
});

function handle(request: SchedulerRequest): void {
  switch (request.kind) {
    case 'init':
      playhead = new PlayheadWriter(request.playheadSab);
      startLoop();
      return;
    case 'clockSync': {
      const { snapped } = clock.applySync(request.contextTime, request.performanceTime);
      // spec §7.1.2: drift beyond 2 ms snaps and logs.
      if (snapped) console.warn('[scheduler] clock drift beyond 2 ms — offset snapped');
      return;
    }
    case 'transport':
      core.setTransport(request.isPlaying, request.isRecording, request.startTick);
      wake();
      return;
    case 'tempo':
      core.setTempo(request.bpm);
      return;
    case 'swing':
      core.setSwing(request.amount, request.division);
      return;
    case 'groove':
      core.setGroove(request.trackId, request.template);
      return;
    case 'loop':
      core.setLoop({ enabled: request.enabled, startTick: request.startTick, endTick: request.endTick });
      return;
    case 'eventsDiff':
      core.applyEventsDiff(request.trackId, request.sequenceId, request.upserts, request.deletes);
      return;
    case 'automationDiff':
      core.applyAutomationDiff(request.scope, request.ownerId, request.targetPath, request.points);
      return;
    case 'songSequence':
      core.setSongSequence(request.orderedSequenceIds);
      return;
    case 'sequenceMeta':
      core.setSequenceMeta(
        request.sequences,
        request.projectBpm,
        request.activeSequenceId,
        request.playbackMode,
      );
      return;
    case 'liveNote': {
      // The BLE/UI timestamp is in the performance.now() domain — map it to context time.
      const when = clock.estimateContextTime(request.timestamp);
      core.pushLiveNote(request.note, request.velocity, request.on, when, request.trackId);
      return;
    }
    case 'noteRepeat':
      core.setNoteRepeat(request.enabled, request.division);
      return;
    case 'arp':
      core.setArpeggiator(request.enabled, {
        mode: request.mode,
        octaves: request.octaves,
        gate: request.gate,
        division: request.division,
      });
      return;
    case 'metronome':
      core.setMetronome(request.enabled, request.countInBars);
      return;
    case 'liveErase':
      core.setLiveErase(request.trackId, request.note, request.active);
      return;
  }
}

function startLoop(): void {
  if (timer !== null) return;
  timer = setInterval(wake, SCHEDULER_INTERVAL_MS);
}

/** One scheduler wake (spec §7.1.4): estimate context time, tick, publish, post. */
function wake(): void {
  if (!clock.hasSync) return; // no clock model yet — nothing to schedule against
  // Estimate in the absolute-epoch domain so this worker's independent `timeOrigin`
  // cancels against the main thread's (spec §7.1.2, §14 2026-07-17 (f)).
  const now = clock.estimateContextTime(performance.timeOrigin + performance.now());
  const result = core.tick(now);

  if (result.batch.length > 0) post({ kind: 'scheduleBatch', events: result.batch });
  for (const flush of result.recorded)
    {post({ kind: 'recorded', trackId: flush.trackId, events: flush.events });}
  for (const erase of result.erased)
    {post({ kind: 'erased', trackId: erase.trackId, eventIds: erase.eventIds });}
  for (const tick of result.loopWrapped) post({ kind: 'loopWrapped', tick });
  for (const entryIndex of result.songAdvanced) post({ kind: 'songAdvanced', entryIndex });

  playhead?.write(core.playheadTick(now), core.isPlaying, core.isRecording);
}
