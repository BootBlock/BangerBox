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
const PLAYHEAD_FLAG_PLAYING = 1 << 0;
const PLAYHEAD_FLAG_RECORDING = 1 << 1;
/**
 * Recording *and* past the count-in, so the tick beside it is a real position to capture
 * against (spec §7.7). Distinct from the recording bit because the two differ for the
 * whole count-in: recording is armed, but the playhead is still parked at the start tick
 * and note capture is gated the same way. Without it, an automation move made during the
 * count-in would land as a point at the start tick (spec §7.8).
 */
const PLAYHEAD_FLAG_CAPTURING = 1 << 2;

/** Allocate the single playhead SAB (spec §7.1.4). */
export function createPlayheadSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + FLOAT_COUNT * 8);
}

/** A decoded playhead reading (spec §7.1.4). */
export interface PlayheadReading {
  readonly currentTick: number;
  readonly isPlaying: boolean;
  readonly isRecording: boolean;
  /** Recording and past the count-in — see {@link PLAYHEAD_FLAG_CAPTURING}. */
  readonly isCapturing: boolean;
  readonly generation: number;
  /**
   * True when every seqlock attempt caught the writer mid-write, so the values beside it are
   * the previous reading held over rather than a fresh snapshot (issue #95).
   */
  readonly stale: boolean;
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
  write(currentTick: number, isPlaying: boolean, isRecording: boolean, isCapturing = false): void {
    const generation = Atomics.load(this.header, 0);
    Atomics.store(this.header, 0, generation + 1); // odd → write in progress
    this.data[0] = currentTick;
    const flags =
      (isPlaying ? PLAYHEAD_FLAG_PLAYING : 0) |
      (isRecording ? PLAYHEAD_FLAG_RECORDING : 0) |
      (isCapturing ? PLAYHEAD_FLAG_CAPTURING : 0);
    Atomics.store(this.header, 1, flags);
    Atomics.store(this.header, 0, generation + 2); // even → write complete
  }
}

/**
 * Main-thread reader (spec §7.1.4). Retries briefly if it catches a write in progress.
 *
 * When all eight attempts tear, the reader HOLDS its last good reading and marks it `stale`
 * (issue #95). It used to return tick 0 as though it were a real position, which read as the
 * playhead snapping back to bar 1 mid-playback — a value every consumer believed. Holding is
 * done here rather than at each call site so no consumer has to remember to.
 */
export class PlayheadReader {
  private readonly header: Int32Array;
  private readonly data: Float64Array;
  /** The last tear-free snapshot, held over whenever a read fails. */
  private last: PlayheadReading = {
    currentTick: 0,
    isPlaying: false,
    isRecording: false,
    isCapturing: false,
    generation: 0,
    stale: false,
  };

  constructor(sab: SharedArrayBuffer) {
    this.header = new Int32Array(sab, 0, HEADER_INTS);
    this.data = new Float64Array(sab, HEADER_BYTES, FLOAT_COUNT);
  }

  read(): PlayheadReading {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = Atomics.load(this.header, 0);
      if (before % 2 !== 0) continue; // writer mid-write — retry
      const currentTick = this.data[0]!;
      const flags = Atomics.load(this.header, 1);
      const after = Atomics.load(this.header, 0);
      if (before !== after) continue; // torn — retry
      this.last = {
        currentTick,
        isPlaying: (flags & PLAYHEAD_FLAG_PLAYING) !== 0,
        isRecording: (flags & PLAYHEAD_FLAG_RECORDING) !== 0,
        isCapturing: (flags & PLAYHEAD_FLAG_CAPTURING) !== 0,
        generation: after,
        stale: false,
      };
      return this.last;
    }
    return { ...this.last, stale: true };
  }
}
