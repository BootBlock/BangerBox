/**
 * Sequencer barrel (spec §7). The pure timing maths, the message protocol, the playhead
 * SAB, and the main-thread {@link SchedulerClient} the audio engine drives. The worker file
 * (`scheduler.worker.ts`) is loaded via `new Worker(new URL(...))` and is not re-exported.
 */
export { SchedulerClient, type SchedulerClientOptions, type SchedulerClientCallbacks } from './schedulerClient';
export { SchedulerCore, type SchedulerTickResult } from './schedulerCore';
export {
  createPlayheadSab,
  PlayheadReader,
  PlayheadWriter,
  type PlayheadReading,
} from './playheadSab';
export {
  SCHEDULER_PROTOCOL_VERSION,
  type ScheduledEvent,
  type SchedulerRequest,
  type SchedulerResponse,
  type SchedulerSequenceMeta,
} from './messages';
export { tickToBarBeatTick, type BarBeatTick } from './ppqn';
export { quantiseEvents, type QuantiseGrid, type QuantiseOptions } from './quantise';
export type { NoteRepeatDivision } from './noteRepeat';
