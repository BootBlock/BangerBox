/**
 * Scheduler request dispatch — spec §7.1.3. The half of the worker that decides what a
 * validated message *does*, lifted out of `scheduler.worker.ts` so the shell is only I/O
 * (spec §11.3) and so a test can drive the real path a real message takes rather than
 * calling {@link SchedulerCore} directly.
 *
 * That distinction is not academic. Every groove test called `core.setGroove` and groove
 * looked well covered, while on the wire the `groove` message was dropped by the Zod guard
 * and no groove ever reached the core (issue #71). Sending a message through
 * `parseSchedulerRequest` and then through this function is the only way to prove the
 * whole chain, and the exhaustive switch below means a new request kind cannot be added
 * without a handler.
 */
import { SCHEDULER_PROTOCOL_VERSION, type SchedulerRequest } from './messages';
import type { SchedulerCore } from './schedulerCore';

/** The worker-shell concerns dispatch cannot own: the SAB, the clock model, the wake loop. */
export interface SchedulerRequestSink {
  readonly core: SchedulerCore;
  /** Map a timestamp in the absolute-epoch domain to context seconds (spec §7.1.2). */
  readonly toContextTime: (timestamp: number) => number;
  /** Bind the playhead SAB and start the wake loop (spec §7.1.4). */
  readonly onInit: (playheadSab: SharedArrayBuffer) => void;
  /** Fold one clock-sync pair into the clock model (spec §7.1.2). */
  readonly onClockSync: (contextTime: number, performanceTime: number) => void;
}

/** Apply one validated request (spec §7.1.3). Exhaustive: a new kind must be handled here. */
export function applySchedulerRequest(sink: SchedulerRequestSink, request: SchedulerRequest): void {
  const { core } = sink;
  switch (request.kind) {
    case 'init':
      // spec §7.1.3 — the protocol is versioned, and this is where the two halves compare
      // copies (issue #96). It reports rather than refuses: the Zod guard above already
      // drops any message shape this build cannot read, so a mismatch costs those messages
      // and no more, while refusing to start would cost the whole transport. Naming it is
      // the point — the §11.4 smoke fails on a console error, so a skew fails the gate
      // instead of presenting as a sequencer that quietly does nothing.
      if (request.protocolVersion !== SCHEDULER_PROTOCOL_VERSION) {
        console.error(
          `[scheduler] protocol version mismatch: the main thread sent ` +
            `${request.protocolVersion ?? 'no version'}, this worker speaks ` +
            `${SCHEDULER_PROTOCOL_VERSION}. Messages either side does not recognise will ` +
            `be dropped.`,
        );
      }
      sink.onInit(request.playheadSab);
      return;
    case 'clockSync':
      sink.onClockSync(request.contextTime, request.performanceTime);
      return;
    case 'transport':
      core.setTransport(request.isPlaying, request.isRecording, request.startTick);
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
    case 'songLoop':
      core.setSongLoop(request.enabled);
      return;
    case 'sequenceMeta':
      core.setSequenceMeta(
        request.sequences,
        request.projectBpm,
        request.activeSequenceId,
        request.playbackMode,
      );
      return;
    case 'liveNote':
      // The BLE/UI timestamp is in the performance.now() domain — map it to context time.
      core.pushLiveNote(
        request.note,
        request.velocity,
        request.on,
        sink.toContextTime(request.timestamp),
        request.trackId,
      );
      return;
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
