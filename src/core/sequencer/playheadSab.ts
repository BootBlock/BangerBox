/**
 * Playhead SharedArrayBuffer — spec §7.1.4. Every wake the scheduler worker writes the
 * current tick (Float64) and the transport flags into this SAB; UI canvases read it in a
 * shared rAF loop (never a `postMessage` stream, spec §5.5). A seqlock (odd generation =
 * write in progress) keeps the non-atomic Float64 read tear-free for the single-writer /
 * single-reader case. Import-safe inside the worklet/worker global scope (no DOM) like the
 * meter SAB (`metering.ts`); the reader runs on the main thread.
 */

/** Int32 header words: [0] = seqlock generation, [1] = transport flags. */
const HEADER_INTS = 2;
const HEADER_BYTES = HEADER_INTS * 4;
/** One Float64: the current tick (spec §7.1.4). */
const FLOAT_COUNT = 1;

/** Transport flag bits packed into the header (spec §7.1.4). */
export const PLAYHEAD_FLAG_PLAYING = 1 << 0;
export const PLAYHEAD_FLAG_RECORDING = 1 << 1;

/** Allocate the single playhead SAB (spec §7.1.4). */
export function createPlayheadSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + FLOAT_COUNT * 8);
}

/** A decoded playhead reading (spec §7.1.4). */
export interface PlayheadReading {
  readonly currentTick: number;
  readonly isPlaying: boolean;
  readonly isRecording: boolean;
  readonly generation: number;
}

/** Worker-side single writer (spec §7.1.4). Bumps the seqlock around every write. */
export class PlayheadWriter {
  private readonly header: Int32Array;
  private readonly data: Float64Array;

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.data = new Float64Array(sab, HEADER_BYTES, FLOAT_COUNT);
  }

  /** Publish the current tick + transport flags tear-free (spec §7.1.4). */
  write(currentTick: number, isPlaying: boolean, isRecording: boolean): void {
    const generation = Atomics.load(this.header, 0);
    Atomics.store(this.header, 0, generation + 1); // odd → write in progress
    this.data[0] = currentTick;
    const flags =
      (isPlaying ? PLAYHEAD_FLAG_PLAYING : 0) | (isRecording ? PLAYHEAD_FLAG_RECORDING : 0);
    Atomics.store(this.header, 1, flags);
    Atomics.store(this.header, 0, generation + 2); // even → write complete
  }
}

/** Main-thread reader (spec §7.1.4). Retries briefly if it catches a write in progress. */
export class PlayheadReader {
  private readonly header: Int32Array;
  private readonly data: Float64Array;

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.data = new Float64Array(sab, HEADER_BYTES, FLOAT_COUNT);
  }

  read(): PlayheadReading {
    let currentTick = 0;
    let flags = 0;
    let generation = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = Atomics.load(this.header, 0);
      if (before % 2 !== 0) continue; // writer mid-write — retry
      currentTick = this.data[0]!;
      flags = Atomics.load(this.header, 1);
      const after = Atomics.load(this.header, 0);
      generation = after;
      if (before === after) break; // consistent snapshot
    }
    return {
      currentTick,
      isPlaying: (flags & PLAYHEAD_FLAG_PLAYING) !== 0,
      isRecording: (flags & PLAYHEAD_FLAG_RECORDING) !== 0,
      generation,
    };
  }
}
