/// <reference lib="webworker" />
/**
 * The sequencer scheduling Web Worker (spec §7.1.1 — a standard Web Worker, never the UI
 * thread, never an AudioWorklet). This file is a thin message shell (spec §11.3): all timing
 * logic lives in the pure {@link SchedulerCore} and all request handling in
 * {@link applySchedulerRequest}, driven here by the {@link ClockModel} and a
 * `SCHEDULER_INTERVAL_MS` wake loop. Each wake it estimates context time, ticks the core,
 * writes the playhead SAB (spec §7.1.4), and posts the resulting batches/notifications.
 * Inbound messages are Zod-guarded exactly like the DB worker (spec §1.3 #11).
 */
import { SCHEDULER_INTERVAL_MS } from '@/core/constants';
import { ClockModel } from './clockSync';
import { parseSchedulerRequest, type SchedulerResponse } from './messages';
import { PlayheadWriter } from './playheadSab';
import { applySchedulerRequest, type SchedulerRequestSink } from './schedulerDispatch';
import { SchedulerCore } from './schedulerCore';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

const core = new SchedulerCore();
const clock = new ClockModel();
let playhead: PlayheadWriter | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function post(response: SchedulerResponse): void {
  scope.postMessage(response);
}

const sink: SchedulerRequestSink = {
  core,
  toContextTime: (timestamp) => clock.estimateContextTime(timestamp),
  onInit: (playheadSab) => {
    playhead = new PlayheadWriter(playheadSab);
    startLoop();
  },
  onClockSync: (contextTime, performanceTime) => {
    const { snapped } = clock.applySync(contextTime, performanceTime);
    // spec §7.1.2: drift beyond 2 ms snaps and logs.
    if (snapped) console.warn('[scheduler] clock drift beyond 2 ms — offset snapped');
  },
};

scope.addEventListener('message', (event: MessageEvent) => {
  const request = parseSchedulerRequest(event.data);
  if (!request) return; // Zod guard (locked decision §1.3 #11): drop malformed traffic.
  applySchedulerRequest(sink, request);
  if (request.kind === 'transport') wake();
});

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
  for (const flush of result.recorded) {
    post({ kind: 'recorded', trackId: flush.trackId, events: flush.events });
  }
  for (const erase of result.erased) {
    post({ kind: 'erased', trackId: erase.trackId, eventIds: erase.eventIds });
  }
  for (const tick of result.loopWrapped) post({ kind: 'loopWrapped', tick });
  for (const entryIndex of result.songAdvanced) post({ kind: 'songAdvanced', entryIndex });
  // §7.9: the flushes above already ran, so a take in progress is persisted before the
  // main thread is told to stop — the ordering the spec calls for, not an accident of order.
  if (result.songEnded) post({ kind: 'songEnded' });

  playhead?.write(core.playheadTick(now), core.isPlaying, core.isRecording, core.isCapturing(now));
}
