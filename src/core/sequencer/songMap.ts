/**
 * Song-mode tick + tempo map — spec §7.9. Playback in `song` mode plays entries in order,
 * each repeated `repeats` times, honouring per-sequence tempo and length. This pure module
 * (spec §7.1.5) flattens the playlist into contiguous segments carrying absolute tick and
 * second offsets, so the scheduler can convert any song position to seconds and schedule a
 * lookahead window that spans an entry boundary correctly (spec §7.9, unit-tested).
 */
import type { Sequence, SongEntry } from '@/core/project/schemas';
import { secondsPerTick, ticksPerBar } from './ppqn';

/** One pass of a sequence at its absolute position in the song timeline (spec §7.9). */
export interface SongSegment {
  readonly entryIndex: number;
  readonly sequenceId: string;
  /** Absolute song tick where this pass begins. */
  readonly startTick: number;
  readonly lengthTicks: number;
  /** Effective tempo for the pass (sequence tempo, else project default) — spec §7.2. */
  readonly bpm: number;
  /** Absolute seconds where this pass begins (cumulative across the tempo map). */
  readonly startSeconds: number;
}

/** The effective tempo of a sequence: its own tempo, or the project default (spec §7.2). */
function effectiveBpm(sequence: Sequence, projectBpm: number): number {
  return sequence.tempo ?? projectBpm;
}

/** Length of one sequence pass in ticks (spec §7.2). */
export function sequenceLengthTicks(sequence: Sequence): number {
  return sequence.lengthBars * ticksPerBar(sequence.timeSig);
}

/**
 * Flatten the ordered playlist into a tick + tempo map (spec §7.9). Entries are taken in
 * `position` order; each contributes `repeats` segments. Entries whose sequence is missing
 * are skipped rather than breaking the map.
 */
export function buildSongMap(
  entries: readonly SongEntry[],
  sequences: Readonly<Record<string, Sequence>>,
  projectBpm: number,
): SongSegment[] {
  const ordered = [...entries].sort((a, b) => a.position - b.position);
  const segments: SongSegment[] = [];
  let startTick = 0;
  let startSeconds = 0;
  ordered.forEach((entry, entryIndex) => {
    const sequence = sequences[entry.sequenceId];
    if (!sequence) return;
    const lengthTicks = sequenceLengthTicks(sequence);
    const bpm = effectiveBpm(sequence, projectBpm);
    const secondsPerPass = lengthTicks * secondsPerTick(bpm);
    for (let repeat = 0; repeat < entry.repeats; repeat++) {
      segments.push({ entryIndex, sequenceId: entry.sequenceId, startTick, lengthTicks, bpm, startSeconds });
      startTick += lengthTicks;
      startSeconds += secondsPerPass;
    }
  });
  return segments;
}

/** Total length of the song in ticks (spec §7.9 duration readout). */
export function songTotalTicks(map: readonly SongSegment[]): number {
  const last = map[map.length - 1];
  return last ? last.startTick + last.lengthTicks : 0;
}

/** Total song duration in seconds (spec §7.9). */
export function songTotalSeconds(map: readonly SongSegment[]): number {
  const last = map[map.length - 1];
  return last ? last.startSeconds + last.lengthTicks * secondsPerTick(last.bpm) : 0;
}

/** The segment covering an absolute song tick, or undefined past the end (spec §7.9). */
export function segmentAtSongTick(map: readonly SongSegment[], songTick: number): SongSegment | undefined {
  return map.find((seg) => songTick >= seg.startTick && songTick < seg.startTick + seg.lengthTicks);
}

/** Convert an absolute song tick to seconds through the tempo map (spec §7.9). */
export function songTickToSeconds(map: readonly SongSegment[], songTick: number): number {
  const segment = segmentAtSongTick(map, songTick);
  if (!segment) return songTotalSeconds(map);
  return segment.startSeconds + (songTick - segment.startTick) * secondsPerTick(segment.bpm);
}

/** Convert absolute seconds back to a song tick through the tempo map (spec §7.9). */
export function songSecondsToTick(map: readonly SongSegment[], seconds: number): number {
  if (seconds <= 0) return 0;
  for (const segment of map) {
    const passSeconds = segment.lengthTicks * secondsPerTick(segment.bpm);
    if (seconds < segment.startSeconds + passSeconds) {
      return segment.startTick + (seconds - segment.startSeconds) / secondsPerTick(segment.bpm);
    }
  }
  return songTotalTicks(map);
}

/** A window slice within one segment (spec §7.9 boundary-spanning lookahead). */
export interface SongWindowSlice {
  readonly segment: SongSegment;
  /** Sequence tick (0-based within the pattern) where the slice starts. */
  readonly seqFrom: number;
  /** Sequence tick where the slice ends (exclusive). */
  readonly seqTo: number;
}

/**
 * Slice a song-tick window `[from, to)` per segment so the scheduler can select each
 * sequence's events for its portion — correctly spanning entry boundaries (spec §7.9).
 */
export function songWindowSlices(map: readonly SongSegment[], from: number, to: number): SongWindowSlice[] {
  const slices: SongWindowSlice[] = [];
  for (const segment of map) {
    const segEnd = segment.startTick + segment.lengthTicks;
    const lo = Math.max(from, segment.startTick);
    const hi = Math.min(to, segEnd);
    if (lo >= hi) continue;
    slices.push({ segment, seqFrom: lo - segment.startTick, seqTo: hi - segment.startTick });
  }
  return slices;
}
