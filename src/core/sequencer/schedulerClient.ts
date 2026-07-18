/**
 * Scheduler client — the main-thread half of the sequencer worker bridge (spec §7.1.1/3).
 * It owns the worker, feeds it the clock model source every `CLOCK_SYNC_INTERVAL_MS` from
 * `audioContext.getOutputTimestamp()` (spec §7.1.2), forwards typed transport/state
 * messages in, and routes the worker's batches/notifications to injected callbacks. The
 * audio realisation of a `scheduleBatch` lives in the engine dispatcher (spec §7.1.4);
 * this class stays audio-agnostic so it is unit-testable with a mock worker (spec §11.3).
 */
import { CLOCK_SYNC_INTERVAL_MS } from '@/core/constants';
import type { AutomationPoint, MidiEvent } from '@/core/project/schemas';
import type { SwingDivision } from '@/store/useTransportStore';
import type { WorkerLike } from '@/core/storage/rpc';
import {
  parseSchedulerResponse,
  type ScheduledEvent,
  type SchedulerRequest,
  type SchedulerSequenceMeta,
} from './messages';
import type { NoteRepeatDivision } from './noteRepeat';
import type { ArpConfig } from './arpeggiator';
import type { GrooveTemplate } from './groove';

export interface SchedulerClientCallbacks {
  /** Realise one scheduled event on the audio graph (spec §7.1.4). */
  dispatch: (event: ScheduledEvent) => void;
  /** A recording capture flush for a track (spec §7.7). */
  onRecorded: (trackId: string, events: MidiEvent[]) => void;
  /** Live-erase deletions for a track (spec §7.7). */
  onErased: (trackId: string, eventIds: string[]) => void;
  onLoopWrapped?: (tick: number) => void;
  onSongAdvanced?: (entryIndex: number) => void;
}

export interface SchedulerClientOptions extends SchedulerClientCallbacks {
  readonly playheadSab: SharedArrayBuffer;
  /** Current `{ contextTime, performanceTime }` from `getOutputTimestamp()` (spec §7.1.2). */
  readonly getClockPair: () => { contextTime: number; performanceTime: number };
  /** Injectable worker for tests; production creates the real module worker. */
  readonly worker?: WorkerLike;
}

export class SchedulerClient {
  readonly #worker: WorkerLike;
  readonly #options: SchedulerClientOptions;
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  constructor(options: SchedulerClientOptions) {
    this.#options = options;
    this.#worker =
      options.worker ??
      new Worker(new URL('./scheduler.worker.ts', import.meta.url), {
        type: 'module',
        name: 'bangerbox-scheduler',
      });
    this.#worker.addEventListener('message', this.#handleMessage);
  }

  /** Initialise the worker with the playhead SAB and begin clock syncing (spec §7.1.2). */
  start(): void {
    this.#send({ kind: 'init', playheadSab: this.#options.playheadSab });
    this.sendClockSync();
    this.#clockTimer = setInterval(() => this.sendClockSync(), CLOCK_SYNC_INTERVAL_MS);
  }

  /** Push one clock sync pair to the worker (spec §7.1.2). */
  sendClockSync(): void {
    const { contextTime, performanceTime } = this.#options.getClockPair();
    this.#send({ kind: 'clockSync', contextTime, performanceTime });
  }

  // --- Typed sends (spec §7.1.3) ---------------------------------------------------

  setTransport(isPlaying: boolean, isRecording: boolean, startTick: number): void {
    this.#send({ kind: 'transport', isPlaying, isRecording, startTick });
  }
  setTempo(bpm: number): void {
    this.#send({ kind: 'tempo', bpm });
  }
  setSwing(amount: number, division: SwingDivision): void {
    this.#send({ kind: 'swing', amount, division });
  }
  /** Assign or clear a track's groove template (spec §7.5, applied at schedule time). */
  setGroove(trackId: string, template: GrooveTemplate | null): void {
    this.#send({ kind: 'groove', trackId, template });
  }
  setLoop(enabled: boolean, startTick: number, endTick: number): void {
    this.#send({ kind: 'loop', enabled, startTick, endTick });
  }
  sendEventsDiff(
    trackId: string,
    sequenceId: string,
    upserts: readonly MidiEvent[],
    deletes: readonly string[],
  ): void {
    this.#send({ kind: 'eventsDiff', trackId, sequenceId, upserts, deletes });
  }
  sendAutomationDiff(
    scope: AutomationPoint['scope'],
    ownerId: string,
    targetPath: string,
    points: readonly AutomationPoint[],
  ): void {
    this.#send({ kind: 'automationDiff', scope, ownerId, targetPath, points });
  }
  setSongSequence(orderedSequenceIds: readonly string[]): void {
    this.#send({ kind: 'songSequence', orderedSequenceIds });
  }
  setSequenceMeta(
    sequences: Readonly<Record<string, SchedulerSequenceMeta>>,
    projectBpm: number,
    activeSequenceId: string | null,
    playbackMode: 'sequence' | 'song',
  ): void {
    this.#send({ kind: 'sequenceMeta', sequences, projectBpm, activeSequenceId, playbackMode });
  }
  sendLiveNote(note: number, velocity: number, on: boolean, timestamp: number, trackId: string): void {
    // `timestamp` is a `performance.now()`-domain reading (spec §10.1); convert to the
    // absolute-epoch domain the worker clock model uses (spec §14 2026-07-17 (f)).
    this.#send({
      kind: 'liveNote',
      note,
      velocity,
      on,
      timestamp: performance.timeOrigin + timestamp,
      trackId,
    });
  }
  setNoteRepeat(enabled: boolean, division: NoteRepeatDivision): void {
    this.#send({ kind: 'noteRepeat', enabled, division });
  }
  setArpeggiator(enabled: boolean, config: ArpConfig): void {
    this.#send({
      kind: 'arp',
      enabled,
      mode: config.mode,
      octaves: config.octaves,
      gate: config.gate,
      division: config.division,
    });
  }
  setMetronome(enabled: boolean, countInBars: 0 | 1 | 2): void {
    this.#send({ kind: 'metronome', enabled, countInBars });
  }
  setLiveErase(trackId: string, note: number, active: boolean): void {
    this.#send({ kind: 'liveErase', trackId, note, active });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#clockTimer !== null) clearInterval(this.#clockTimer);
    this.#clockTimer = null;
    this.#worker.removeEventListener('message', this.#handleMessage);
    this.#worker.terminate();
  }

  #send(request: SchedulerRequest): void {
    if (this.#disposed) return;
    this.#worker.postMessage(request);
  }

  #handleMessage = (event: MessageEvent): void => {
    const response = parseSchedulerResponse(event.data);
    if (!response) return;
    switch (response.kind) {
      case 'scheduleBatch':
        for (const scheduled of response.events) this.#options.dispatch(scheduled);
        return;
      case 'recorded':
        this.#options.onRecorded(response.trackId, [...response.events]);
        return;
      case 'erased':
        this.#options.onErased(response.trackId, [...response.eventIds]);
        return;
      case 'loopWrapped':
        this.#options.onLoopWrapped?.(response.tick);
        return;
      case 'songAdvanced':
        this.#options.onSongAdvanced?.(response.entryIndex);
        return;
    }
  };
}
