/**
 * Arpeggiator — spec §7.3. For keygroup tracks, the held chord is unfolded across octaves
 * and stepped at the chosen subdivision; modes are up / down / upDown / played / random,
 * with an octave range (1–4) and a note gate (5–100 %). This module is the pure grid
 * generator (spec §7.1.5): it enumerates the arp hits in a lookahead window; swing (§7.4)
 * is applied by the scheduler when it converts ticks to seconds. It shares the note-repeat
 * subdivision clock ({@link noteRepeatStepTicks}/{@link repeatTicksInWindow}, spec §7.3).
 */
import { noteRepeatStepTicks, repeatTicksInWindow, type NoteRepeatDivision } from './noteRepeat';

/** Arpeggiator play order across the held chord (spec §7.3). */
export type ArpMode = 'up' | 'down' | 'upDown' | 'played' | 'random';

/** Arpeggiator configuration (spec §7.3). */
export interface ArpConfig {
  readonly mode: ArpMode;
  readonly octaves: number; // 1..4
  readonly gate: number; // 0.05..1 — fraction of the step the note sounds
  readonly division: NoteRepeatDivision;
}

/** A note held for the arpeggiator (spec §7.3). Play order preserves the held order. */
export interface ArpHeldNote {
  readonly note: number;
  readonly velocity: number;
}

/** One generated arp trigger (spec §7.3). */
export interface ArpHit {
  readonly note: number;
  readonly velocity: number;
  readonly tick: number;
  readonly durationTicks: number;
}

/** Expand the held chord across `octaves` (adding 12 semitones per octave), spec §7.3. */
function acrossOctaves(held: readonly ArpHeldNote[], octaves: number): ArpHeldNote[] {
  const range = Math.max(1, Math.min(4, Math.trunc(octaves)));
  const out: ArpHeldNote[] = [];
  for (let octave = 0; octave < range; octave++) {
    for (const note of held) out.push({ note: note.note + octave * 12, velocity: note.velocity });
  }
  return out;
}

/**
 * The ordered note pool the arpeggiator cycles through for a mode (spec §7.3). `random`
 * returns the ascending pool; the caller picks from it per step so the sequence stays a
 * pure function of the step index (repeatable, spec §7.1.5).
 */
export function arpSequence(
  held: readonly ArpHeldNote[],
  mode: ArpMode,
  octaves: number,
): ArpHeldNote[] {
  if (held.length === 0) return [];
  const played = acrossOctaves(held, octaves); // preserves held order
  const up = [...played].sort((a, b) => a.note - b.note);
  switch (mode) {
    case 'played':
      return played;
    case 'up':
    case 'random':
      return up;
    case 'down':
      return [...up].reverse();
    case 'upDown': {
      // Up then back down, without repeating the top and bottom notes (classic MPC).
      const middle = up.slice(1, -1).reverse();
      return up.length <= 1 ? up : [...up, ...middle];
    }
  }
}

/** Deterministic pool index for a random-mode step (spec §7.3; repeatable per §7.1.5). */
function randomIndex(step: number, size: number): number {
  const hashed = Math.abs(Math.imul(step + 1, 2654435761)) % size;
  return hashed;
}

/**
 * Arp hits across `[from, to)` (spec §7.3). The step index is the absolute grid position,
 * so the arpeggio stays phase-locked to the bar as the window advances. Note duration is
 * `gate × stepTicks` (min 1 tick).
 */
export function arpeggiatorHits(
  held: readonly ArpHeldNote[],
  config: ArpConfig,
  from: number,
  to: number,
): ArpHit[] {
  const sequence = arpSequence(held, config.mode, config.octaves);
  if (sequence.length === 0) return [];
  const step = noteRepeatStepTicks(config.division);
  const gateTicks = Math.max(1, Math.round(step * Math.max(0.05, Math.min(1, config.gate))));
  const hits: ArpHit[] = [];
  for (const tick of repeatTicksInWindow(from, to, config.division)) {
    const stepIndex = Math.round(tick / step);
    const pick =
      config.mode === 'random'
        ? sequence[randomIndex(stepIndex, sequence.length)]!
        : sequence[stepIndex % sequence.length]!;
    hits.push({ note: pick.note, velocity: pick.velocity, tick, durationTicks: gateTicks });
  }
  return hits;
}
