/**
 * Piano-keyboard geometry and zone arithmetic for the keygroup zone editor (spec §8.5.5
 * "keygroup zone editor with keyboard range drag").
 *
 * Kept apart from the canvas for the reason `waveformView.ts` gives: §3.3 forbids routing a drag
 * through React state, so the component redraws from refs and the part that is easy to get wrong —
 * where a black key sits, which note is under the cursor, what a drag may do to a zone's edges —
 * belongs in dependency-free functions that can be tested without a 2D context (spec §2.5).
 *
 * The keyboard is laid out the way a real one is: white keys tile the width evenly and black keys
 * are drawn over the joins between them. Zone spans are therefore *not* a uniform note axis, which
 * is deliberate — a musician locates C3 by the black-key pattern, not by counting semitones.
 */
import { clamp, clampInt } from '@/core/math';
import { noteName } from '@/features/pad-perform/scales';

/** Pitch classes played by a white key. The complement are the black keys. */
const WHITE_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11] as const;

/** A black key's width as a fraction of a white one — close enough to a real keyboard to read as one. */
const BLACK_KEY_WIDTH_RATIO = 0.58;

/** How tall a black key is relative to the keyboard strip. */
export const BLACK_KEY_HEIGHT_RATIO = 0.62;

export function isBlackKey(note: number): boolean {
  const pitchClass = ((note % 12) + 12) % 12;
  return !WHITE_PITCH_CLASSES.includes(pitchClass as (typeof WHITE_PITCH_CLASSES)[number]);
}

/** One drawn key: `x`/`width` in the same units as the `width` passed to {@link keyLayout}. */
export interface KeyRect {
  readonly note: number;
  readonly x: number;
  readonly width: number;
  readonly black: boolean;
}

export function whiteKeyCount(lowNote: number, highNote: number): number {
  let count = 0;
  for (let note = lowNote; note <= highNote; note++) if (!isBlackKey(note)) count++;
  return count;
}

/**
 * Every key from `lowNote` to `highNote` in note order. Black keys are centred on the join between
 * their neighbouring whites and overlap them, so a caller must paint the whites first and the
 * blacks over the top — the same two passes a physical keyboard's construction implies.
 */
export function keyLayout(lowNote: number, highNote: number, width: number): KeyRect[] {
  const whiteWidth = width / Math.max(1, whiteKeyCount(lowNote, highNote));
  const blackWidth = whiteWidth * BLACK_KEY_WIDTH_RATIO;
  const keys: KeyRect[] = [];
  let whitesPlaced = 0;
  for (let note = lowNote; note <= highNote; note++) {
    if (isBlackKey(note)) {
      keys.push({ note, x: whitesPlaced * whiteWidth - blackWidth / 2, width: blackWidth, black: true });
    } else {
      keys.push({ note, x: whitesPlaced * whiteWidth, width: whiteWidth, black: false });
      whitesPlaced++;
    }
  }
  return keys;
}

/** The rect for one note, or `null` when it falls outside the drawn range. */
export function keyRect(note: number, lowNote: number, highNote: number, width: number): KeyRect | null {
  if (note < lowNote || note > highNote) return null;
  return keyLayout(lowNote, highNote, width)[note - lowNote] ?? null;
}

/**
 * The note under `x`. Black keys are tested first because they are drawn on top: pressing the
 * upper half of the join between C and D must give C♯, as it would on a keyboard.
 */
export function noteAtX(x: number, lowNote: number, highNote: number, width: number): number {
  const keys = keyLayout(lowNote, highNote, width);
  for (const key of keys) {
    if (key.black && x >= key.x && x < key.x + key.width) return key.note;
  }
  for (const key of keys) {
    if (!key.black && x >= key.x && x < key.x + key.width) return key.note;
  }
  return x < 0 ? lowNote : highNote;
}

/** Horizontal span of a note range, from the left edge of its first key to the right of its last. */
export function noteSpanX(
  fromNote: number,
  toNote: number,
  lowNote: number,
  highNote: number,
  width: number,
): { left: number; right: number } {
  const keys = keyLayout(lowNote, highNote, width);
  const first = keys[clampInt(fromNote, lowNote, highNote) - lowNote]!;
  const last = keys[clampInt(toNote, lowNote, highNote) - lowNote]!;
  return { left: first.x, right: last.x + last.width };
}

/** How the canvas divides vertically: zone lanes on top, a coverage ribbon, then the keyboard. */
export interface ZoneEditorMetrics {
  readonly bandTop: number;
  readonly bandHeight: number;
  readonly ribbonTop: number;
  readonly ribbonHeight: number;
  readonly keyboardTop: number;
  readonly keyboardHeight: number;
}

const BAND_FRACTION = 0.42;
const RIBBON_FRACTION = 0.08;

export function editorMetrics(height: number): ZoneEditorMetrics {
  const bandHeight = height * BAND_FRACTION;
  const ribbonHeight = height * RIBBON_FRACTION;
  return {
    bandTop: 0,
    bandHeight,
    ribbonTop: bandHeight,
    ribbonHeight,
    keyboardTop: bandHeight + ribbonHeight,
    keyboardHeight: height - bandHeight - ribbonHeight,
  };
}

/** Vertical slice of the band strip belonging to zone `index`; each zone gets its own lane. */
export function laneRect(index: number, count: number, metrics: ZoneEditorMetrics) {
  const laneHeight = metrics.bandHeight / Math.max(1, count);
  return { top: metrics.bandTop + index * laneHeight, height: laneHeight };
}

/** Which zone's lane contains `y`, or -1 when the point is outside the band strip. */
export function laneAtY(y: number, count: number, metrics: ZoneEditorMetrics): number {
  if (count <= 0 || y < metrics.bandTop || y >= metrics.bandTop + metrics.bandHeight) return -1;
  const laneHeight = metrics.bandHeight / count;
  return Math.min(count - 1, Math.floor((y - metrics.bandTop) / laneHeight));
}

/** Just the two fields the geometry cares about, so the maths never needs a whole `KeygroupZone`. */
export interface NoteRangeLike {
  readonly lowNote: number;
  readonly highNote: number;
}

/**
 * Move one edge of a zone to `note`.
 *
 * A drag that would invert the zone **clamps at the opposite edge** rather than swapping which
 * edge is held: pulling `lowNote` past `highNote` leaves a one-note zone sitting on `highNote`.
 * Swapping instead would make the edge under the finger jump to the other side of the zone
 * mid-gesture, and `lowNote <= highNote` (spec §6) has to hold at every intermediate frame anyway
 * because the transient repaint reads the same values the commit will.
 */
export function dragZoneEdge(
  zone: NoteRangeLike,
  edge: 'low' | 'high',
  note: number,
  range: readonly [number, number],
): NoteRangeLike {
  const target = clampInt(note, range[0], range[1]);
  return edge === 'low'
    ? { lowNote: Math.min(target, zone.highNote), highNote: zone.highNote }
    : { lowNote: zone.lowNote, highNote: Math.max(target, zone.lowNote) };
}

/**
 * Slide a whole zone by `deltaNotes`, keeping its width. The shift is clamped so the zone stops
 * against the ends of the range instead of being squashed against them — a moved zone that
 * silently narrowed would destroy the mapping the user spent the drag positioning.
 */
export function moveZoneRange(
  zone: NoteRangeLike,
  deltaNotes: number,
  range: readonly [number, number],
): NoteRangeLike {
  const shift = Math.round(clamp(deltaNotes, range[0] - zone.lowNote, range[1] - zone.highNote));
  return { lowNote: zone.lowNote + shift, highNote: zone.highNote + shift };
}

/** How many zones cover each note in the range, indexed by `note - lowNote`. */
export function coverageByNote(zones: readonly NoteRangeLike[], lowNote: number, highNote: number): number[] {
  const coverage = new Array<number>(highNote - lowNote + 1).fill(0);
  for (const zone of zones) {
    const from = Math.max(lowNote, Math.min(zone.lowNote, zone.highNote));
    const to = Math.min(highNote, Math.max(zone.lowNote, zone.highNote));
    for (let note = from; note <= to; note++) coverage[note - lowNote]!++;
  }
  return coverage;
}

/** Contiguous runs of notes no zone covers — the silent stretches of the keyboard. */
export function uncoveredRanges(
  zones: readonly NoteRangeLike[],
  lowNote: number,
  highNote: number,
): { from: number; to: number }[] {
  const coverage = coverageByNote(zones, lowNote, highNote);
  const gaps: { from: number; to: number }[] = [];
  let start = -1;
  coverage.forEach((count, index) => {
    const note = lowNote + index;
    if (count === 0 && start < 0) start = note;
    if (count !== 0 && start >= 0) {
      gaps.push({ from: start, to: note - 1 });
      start = -1;
    }
  });
  if (start >= 0) gaps.push({ from: start, to: highNote });
  return gaps;
}

/**
 * The screen-reader account of the same picture (spec §8.2). Note *names* throughout — a raw MIDI
 * number read aloud tells a musician nothing about where the zone sits.
 */
export function describeZones(
  zones: readonly (NoteRangeLike & { rootNote: number })[],
  lowNote: number,
  highNote: number,
): string {
  if (zones.length === 0) return 'Key zone map: no zones.';
  const spans = zones
    .map(
      (zone, index) =>
        `zone ${index + 1} ${noteName(zone.lowNote)} to ${noteName(zone.highNote)}, root ${noteName(
          zone.rootNote,
        )}`,
    )
    .join('; ');
  const gaps = uncoveredRanges(zones, lowNote, highNote)
    .map((gap) => (gap.from === gap.to ? noteName(gap.from) : `${noteName(gap.from)} to ${noteName(gap.to)}`))
    .join(', ');
  const overlaps = coverageByNote(zones, lowNote, highNote).some((count) => count > 1);
  return [
    `Key zone map: ${spans}.`,
    overlaps ? 'Some notes are covered by more than one zone.' : null,
    gaps === '' ? 'Every note is covered.' : `No zone covers ${gaps}.`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
}
