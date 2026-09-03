/**
 * SchedulerCore — the pure lookahead scheduler (spec §7.1). Per spec §11.3 the timing loop
 * is a pure class driven by an injected clock (the caller passes context seconds to
 * {@link tick}); the worker file (`scheduler.worker.ts`) is a thin message shell. Each wake
 * it computes every event in `[lastScheduled, now + LOOKAHEAD_MS]`, converts ticks to
 * context seconds through the tempo map, applies swing (§7.4) and loop wrapping (§7.1.5),
 * drives the metronome + count-in (§7.7), generates note repeat (§7.3), captures recording
 * (§7.7), spans song-entry boundaries (§7.9), and schedules automation ramps (§7.8).
 *
 * All maths delegates to the dependency-free modules in this folder, so the whole timing
 * surface is unit-testable with a fake clock (spec §7.1.5). The core is domain-agnostic
 * about audio — it emits {@link ScheduledEvent}s the main-thread dispatcher realises.
 */
import { LOOKAHEAD_MS } from '@/core/constants';
import {
  automationLaneKey,
  type AutomationPoint,
  type MidiEvent,
  type TimeSignature,
} from '@/core/project/schemas';
import type { SwingDivision } from '@/store/useTransportStore';
import { arpeggiatorHits, type ArpConfig, type ArpHeldNote } from './arpeggiator';
import { automationValueAt, resolveEffectivePoints } from './automation';
import {
  eventsInWindow,
  loopActive,
  loopPassAt,
  segmentWindow,
  sequenceTickAt,
  type LoopRegion,
} from './lookahead';
import type { ScheduledEvent } from './messages';
import { noteRepeatHits, type HeldNote, type NoteRepeatDivision } from './noteRepeat';
import { secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from './ppqn';
import {
  buildSongMap,
  songSecondsToTick,
  songTickToSeconds,
  songTotalSeconds,
  songWindowSlices,
  type SongSegment,
} from './songMap';
import { clamp } from '@/core/math';
import { swingOffsetTicks } from './swing';
import { grooveShiftAtTick, type GrooveTemplate } from './groove';

/** Everything the worker posts after one scheduler wake (spec §7.1.3). */
export interface SchedulerTickResult {
  readonly batch: ScheduledEvent[];
  readonly recorded: { trackId: string; events: MidiEvent[] }[];
  readonly erased: { trackId: string; eventIds: string[] }[];
  readonly loopWrapped: number[];
  readonly songAdvanced: number[];
  /** The song reached its end with looping off, so the transport stops (spec §7.9). */
  songEnded: boolean;
}

interface TrackEvents {
  readonly sequenceId: string;
  events: MidiEvent[];
}

interface OpenNote {
  readonly startTick: number;
  readonly velocity: number;
}

const DEFAULT_TIME_SIG: TimeSignature = { numerator: 4, denominator: 4 };
const WINDOW_GUARD = 4096; // structural guard on the metronome click loop

export class SchedulerCore {
  // --- transport / musical state ---
  private playing = false;
  private recording = false;
  private startTick = 0;
  private bpm = 120;
  private projectBpm = 120;
  private swingAmount = 50;
  private swingDivision: SwingDivision = 16;
  private loop: LoopRegion = { enabled: false, startTick: 0, endTick: 0 };
  private metronomeEnabled = false;
  private countInBars: 0 | 1 | 2 = 0;
  private playbackMode: 'sequence' | 'song' = 'sequence';
  private activeSequenceId: string | null = null;
  /** spec §7.9: wrap at the end of the song instead of stopping there. Off by default. */
  private songLoopEnabled = false;

  private readonly tracks = new Map<string, TrackEvents>();
  /** Per-track groove templates, applied at schedule time like swing (spec §7.5). */
  private readonly grooves = new Map<string, GrooveTemplate>();
  private readonly automation = new Map<string, AutomationPoint[]>();
  private readonly sequenceMeta = new Map<
    string,
    TimeSignature & { lengthBars: number; tempo: number | null }
  >();
  private orderedSequenceIds: string[] = [];
  private songMap: SongSegment[] = [];

  private noteRepeatEnabled = false;
  private noteRepeatDivision: NoteRepeatDivision = { value: 16, triplet: false };
  private arpEnabled = false;
  private arpConfig: ArpConfig = {
    mode: 'up',
    octaves: 1,
    gate: 0.5,
    division: { value: 16, triplet: false },
  };
  private readonly heldNotes = new Map<string, HeldNote & { trackId: string }>();
  private readonly eraseNotes = new Map<string, number>(); // `${trackId}:${note}` → note

  // --- recording capture ---
  private readonly openNotes = new Map<string, OpenNote>(); // `${trackId}:${note}`
  private readonly captured = new Map<string, MidiEvent[]>();

  // --- playback timing bookkeeping ---
  private playStartContext = 0; // gesture time (count-in begins here)
  private contentStartContext = 0; // content begins after count-in
  /**
   * The context time the tempo map is measured from, and the tick and song seconds standing at
   * it (spec §7.2, issue #74).
   *
   * Distinct from {@link contentStartContext}, which stays where the content genuinely began
   * and is what the §7.7 count-in gate compares a live note's timestamp against. The anchor
   * MOVES: a mid-playback tempo change re-anchors it to the moment of the change, so the new
   * tempo applies from there onward instead of re-timing everything already played. Keeping
   * one field for both jobs would have made a §10.2 latency-compensated note, timestamped just
   * before the change, look like it had arrived during a count-in.
   */
  private anchorContext = 0;
  private anchorSongSeconds = 0;
  private originTick = 0; // linear/song tick at anchorContext
  private nextScheduleTick = 0; // next linear tick to schedule from (sequence mode)
  /**
   * Song mode's schedule cursor, in song seconds measured from song tick 0 and NOT wrapped
   * at the end (spec §7.9): pass `k` occupies `[k × songTotalSeconds, (k+1) × …)`. Keeping
   * it monotonic is what lets a lookahead window straddle a wrap without double-scheduling.
   */
  private nextSongSeconds = 0;
  private nextClickIndex = 0;
  /**
   * Which beat of the bar click index 0 falls on (spec §5.9 accents beat 1).
   *
   * Captured once from the start tick, never re-derived: `originTick` moves to an arbitrary
   * mid-bar position when a tempo change re-anchors it (issue #74), and reading the phase
   * from it there put the accent permanently off the bar line. A tempo change does not move
   * which beat of the bar the grid is on, so the phase is invariant across one.
   */
  private clickBeatPhase = 0;
  private lastLoopPass = 0;
  private lastEntryIndex = -1;
  private lastSongPass = 0;
  private pendingStart = false;
  private stopRequested = false;
  /** A tempo set while playing, applied at the next wake with a re-anchor (issue #74). */
  private pendingBpm: number | null = null;

  // ---------------------------------------------------------------- setters ----

  setTransport(isPlaying: boolean, isRecording: boolean, startTick: number): void {
    if (isPlaying && !this.playing) {
      this.playing = true;
      this.pendingStart = true;
      this.startTick = startTick;
      this.recording = isRecording;
    } else if (!isPlaying && this.playing) {
      this.stopRequested = true;
      this.recording = isRecording;
    } else if (this.playing) {
      // Arm/disarm mid-playback (spec §7.7). Disarming flushes what was captured.
      this.recording = isRecording;
    }
  }

  /**
   * spec §7.2 — a tempo change applies from the change onward, never retroactively (issue #74).
   *
   * The new tempo is held until the next {@link tick}, because the core has no clock of its own:
   * `tick(now)` is where a trustworthy context time arrives (spec §11.3 — the worker file is a
   * thin message shell), and re-anchoring needs one. The wait is at most
   * `SCHEDULER_INTERVAL_MS`, and nothing reads a position in between.
   */
  setTempo(bpm: number): void {
    if (!this.playing) {
      this.bpm = bpm;
      return;
    }
    this.pendingBpm = bpm;
  }
  setSwing(amount: number, division: SwingDivision): void {
    this.swingAmount = amount;
    this.swingDivision = division;
  }
  setLoop(loop: LoopRegion): void {
    this.loop = loop;
  }
  /**
   * Assign (or clear, with `null`) a track's groove template — spec §7.5: a groove is a
   * non-destructive quantisation map "applied at schedule time like swing", so the stored
   * events are never rewritten.
   */
  setGroove(trackId: string, template: GrooveTemplate | null): void {
    if (template) this.grooves.set(trackId, template);
    else this.grooves.delete(trackId);
  }
  setMetronome(enabled: boolean, countInBars: 0 | 1 | 2): void {
    this.metronomeEnabled = enabled;
    this.countInBars = countInBars;
  }
  setNoteRepeat(enabled: boolean, division: NoteRepeatDivision): void {
    this.noteRepeatEnabled = enabled;
    this.noteRepeatDivision = division;
  }
  setArpeggiator(enabled: boolean, config: ArpConfig): void {
    this.arpEnabled = enabled;
    this.arpConfig = config;
  }

  applyEventsDiff(
    trackId: string,
    sequenceId: string,
    upserts: readonly MidiEvent[],
    deletes: readonly string[],
  ): void {
    const track = this.tracks.get(trackId) ?? { sequenceId, events: [] };
    const byId = new Map(track.events.map((e) => [e.id, e]));
    for (const id of deletes) byId.delete(id);
    for (const event of upserts) byId.set(event.id, event);
    const events = [...byId.values()].sort((a, b) => a.tickStart - b.tickStart || a.id.localeCompare(b.id));
    this.tracks.set(trackId, { sequenceId, events });
  }

  applyAutomationDiff(
    scope: AutomationPoint['scope'],
    ownerId: string,
    targetPath: string,
    points: readonly AutomationPoint[],
  ): void {
    const key = automationLaneKey(scope, ownerId, targetPath);
    if (points.length === 0) this.automation.delete(key);
    else {
      this.automation.set(
        key,
        [...points].sort((a, b) => a.tick - b.tick),
      );
    }
  }

  /** spec §7.9: `songLoopEnabled` — wrap at the end of the song rather than stopping. */
  setSongLoop(enabled: boolean): void {
    this.songLoopEnabled = enabled;
  }

  setSongSequence(orderedSequenceIds: readonly string[]): void {
    this.orderedSequenceIds = [...orderedSequenceIds];
    this.rebuildSongMap();
  }

  setSequenceMeta(
    sequences: Readonly<
      Record<
        string,
        {
          lengthBars: number;
          timeSigNumerator: number;
          timeSigDenominator: 2 | 4 | 8 | 16;
          tempo: number | null;
        }
      >
    >,
    projectBpm: number,
    activeSequenceId: string | null,
    playbackMode: 'sequence' | 'song',
  ): void {
    this.sequenceMeta.clear();
    for (const [id, meta] of Object.entries(sequences)) {
      this.sequenceMeta.set(id, {
        numerator: meta.timeSigNumerator,
        denominator: meta.timeSigDenominator,
        lengthBars: meta.lengthBars,
        tempo: meta.tempo,
      });
    }
    this.projectBpm = projectBpm;
    this.activeSequenceId = activeSequenceId;
    this.playbackMode = playbackMode;
    this.rebuildSongMap();
  }

  /** A played pad (spec §7.6). `when` is context seconds; recording captures it (§7.7). */
  pushLiveNote(note: number, velocity: number, on: boolean, when: number, trackId: string): void {
    const key = `${trackId}:${note}`;
    if (on) {
      this.heldNotes.set(key, { note, velocity, trackId });
      if (this.recording && this.contentStarted(when)) {
        this.openNotes.set(key, { startTick: this.positionTickAt(when), velocity });
      }
    } else {
      this.heldNotes.delete(key);
      const open = this.openNotes.get(key);
      if (open && this.recording) {
        this.openNotes.delete(key);
        this.captureNote(trackId, note, open, this.positionTickAt(when));
      }
    }
  }

  setLiveErase(trackId: string, note: number, active: boolean): void {
    const key = `${trackId}:${note}`;
    if (active) this.eraseNotes.set(key, note);
    else this.eraseNotes.delete(key);
  }

  // ------------------------------------------------------------- scheduling ----

  /** Advance the scheduler to context time `now`, returning what to post (spec §7.1.4). */
  tick(now: number): SchedulerTickResult {
    const result: SchedulerTickResult = {
      batch: [],
      recorded: [],
      erased: [],
      loopWrapped: [],
      songAdvanced: [],
      songEnded: false,
    };

    this.applyPendingTempo(now);

    if (this.stopRequested) {
      this.closeOpenNotes(now, result);
      this.flushRecording(result);
      this.resetPlayback();
      this.stopRequested = false;
      return result;
    }
    if (!this.playing) return result;
    if (this.pendingStart) {
      this.beginPlayback(now);
      this.pendingStart = false;
    }

    const horizon = now + LOOKAHEAD_MS / 1000;
    // Content first, then the click: the end of a song stops playback (spec §7.9), and a
    // click loop that ran before it would have already filled the lookahead window with a
    // metronome the user hears after the transport has stopped.
    if (this.playbackMode === 'song') this.scheduleSong(now, horizon, result);
    else this.scheduleSequence(horizon, result);
    if (this.playing) this.scheduleClicks(now, horizon, result);
    return result;
  }

  /** Current playhead tick for the playhead SAB (spec §7.1.4). */
  playheadTick(now: number): number {
    if (!this.playing || now < this.contentStartContext) return this.startTick;
    return this.positionTickAt(now);
  }

  get isPlaying(): boolean {
    return this.playing;
  }
  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * Recording *and* past the count-in, so `playheadTick(now)` beside it is a real position
   * (spec §7.7). The same gate note capture uses, published for the playhead SAB so the
   * main thread can hold automation capture back through the count-in too (spec §7.8).
   */
  isCapturing(now: number): boolean {
    return this.recording && this.contentStarted(now);
  }

  // --------------------------------------------------------------- internals ---

  private beginPlayback(now: number): void {
    this.playStartContext = now;
    this.originTick = this.startTick;
    const countInSeconds = this.recording && this.countInBars > 0 ? this.countInBars * this.barSeconds() : 0;
    this.contentStartContext = now + countInSeconds;
    this.anchorContext = this.contentStartContext;
    this.anchorSongSeconds = songTickToSeconds(this.songMap, this.originTick);
    this.pendingBpm = null; // a tempo set before the gesture is already in force
    this.nextScheduleTick = this.originTick;
    this.nextSongSeconds = this.anchorSongSeconds;
    this.nextClickIndex = 0;
    this.clickBeatPhase = this.beatPhaseOf(this.originTick);
    this.lastLoopPass = loopPassAt(this.originTick, this.loop);
    this.lastEntryIndex = -1;
    this.lastSongPass = 0;
  }

  private resetPlayback(): void {
    this.playing = false;
    this.recording = false;
    this.openNotes.clear();
    this.heldNotes.clear();
    // Live erase is armed by holding a pad over Erase (spec §7.7), and a stop releases neither
    // for the worker. Leaving it armed meant the next playback silently deleted notes the user
    // never asked to erase, on a gesture they had finished with (issue #95). Clearing it costs
    // a user still holding Erase through a stop one re-press; not clearing it costs their notes.
    this.eraseNotes.clear();
  }

  private contentStarted(when: number): boolean {
    return this.playing && when >= this.contentStartContext;
  }

  /**
   * Apply a tempo set mid-playback, from `now` onward (spec §7.2, issue #74).
   *
   * Re-anchoring is the whole of the fix. `positionTickAt` computes the position as
   * `originTick + secondsToTicks(now − anchorContext, bpm)`; with the anchor left where
   * playback began, changing `bpm` re-read the ENTIRE elapsed history at the new tempo, so
   * halving the tempo halved the computed position and the playhead jumped backwards with no
   * time having passed. Moving the anchor to `now` — with the tick and song seconds standing
   * there, measured at the OLD tempo — makes the elapsed part immutable and the new tempo
   * govern only what follows.
   *
   * `nextScheduleTick` is deliberately left alone: it marks how far the lookahead has already
   * scheduled, and those events have been posted. On a slow-down it now sits ahead of the
   * playhead, so `scheduleSequence` simply schedules nothing until the clock reaches it.
   */
  private applyPendingTempo(now: number): void {
    const bpm = this.pendingBpm;
    if (bpm === null) return;
    this.pendingBpm = null;
    if (!this.playing) {
      this.bpm = bpm;
      return;
    }
    if (now > this.anchorContext) {
      this.reanchorClicks(now, bpm);
      this.anchorSongSeconds += now - this.anchorContext;
      this.originTick = this.linearTickAt(now); // at the old tempo, before it changes
      this.anchorContext = now;
      this.bpm = bpm;
      return;
    }
    // Still inside the §7.7 count-in. No content has elapsed — the playhead is parked at
    // `startTick` — so there is nothing to preserve and the whole count-in simply runs at the
    // new tempo, which is what "two bars at 90 bpm" means. Its length is re-derived and the
    // click grid re-phased from the gesture, skipping the beats already posted.
    this.bpm = bpm;
    const countInSeconds = this.recording && this.countInBars > 0 ? this.countInBars * this.barSeconds() : 0;
    this.contentStartContext = this.playStartContext + countInSeconds;
    this.anchorContext = this.contentStartContext;
  }

  /**
   * Re-phase the §7.7 click grid onto the new tempo without re-timing the beats already
   * scheduled (issue #74).
   *
   * The grid is `playStartContext + index × beatSeconds`, so changing `beatSeconds` alone
   * would move every click including the ones already posted. The grid is rebuilt around the
   * NEXT unemitted click instead, which is placed at whichever of three times comes first
   * without falling in the past:
   *
   *  - where the old tempo was going to put it, so the beat the change interrupts finishes at
   *    the tempo it started under;
   *  - one NEW beat from here, so a big speed-up does not have to wait out the old, longer
   *    beat before anything sounds faster;
   *  - never before `now` or before the click already emitted, because a past `when` reaches
   *    the dispatcher and Web Audio plays it immediately, as a stray beat.
   *
   * No click index is skipped, which is what keeps the §5.9 accent on the bar line: the accent
   * follows `clickBeatPhase + index`, so dropping an index would move every later accent.
   */
  private reanchorClicks(now: number, bpm: number): void {
    const oldBeatSeconds = this.beatSeconds();
    const newBeatSeconds = ticksToSeconds(ticksPerBeat(this.activeTimeSig()), bpm);
    if (!(oldBeatSeconds > 0) || !(newBeatSeconds > 0) || this.nextClickIndex === 0) return;
    const lastEmitted = this.playStartContext + (this.nextClickIndex - 1) * oldBeatSeconds;
    const nextWhen = lastEmitted + oldBeatSeconds;
    const earliest = Math.max(now, lastEmitted);
    const at = Math.min(Math.max(nextWhen, now), earliest + newBeatSeconds);
    this.playStartContext = at - this.nextClickIndex * newBeatSeconds;
  }

  /**
   * Sequence/song tick at a context time (spec §7.1.4).
   *
   * There is no early return for a zero elapsed: `originTick` is a LINEAR tick, and a
   * re-anchored one is an arbitrary point part-way through a loop pass, so it has to be
   * folded onto its sequence tick like any other position. Returning it raw was safe only
   * while the anchor could not move (issue #74).
   */
  private positionTickAt(when: number): number {
    const elapsed = Math.max(0, when - this.anchorContext);
    if (this.playbackMode === 'song') {
      // Absolute (unwrapped) song seconds, folded back into one pass when the song loops
      // (spec §7.9) so the playhead restarts at 0 rather than clamping at the end.
      const absolute = this.anchorSongSeconds + elapsed;
      const total = songTotalSeconds(this.songMap);
      const within = this.songLoopEnabled && total > 0 ? absolute % total : absolute;
      return songSecondsToTick(this.songMap, within);
    }
    return sequenceTickAt(this.originTick + secondsToTicks(elapsed, this.bpm), this.loop);
  }

  // --- metronome + count-in (spec §7.7) ---
  private scheduleClicks(now: number, horizon: number, result: SchedulerTickResult): void {
    const beatSeconds = this.beatSeconds();
    const timeSig = this.activeTimeSig();
    // §5.9 accents beat 1, so the accent must follow the *bar line*, not the play gesture:
    // `startTick` is the loop start (§7.1.5), which the user may place mid-bar. Phase the
    // click index by the origin's beat offset within its bar. A count-in is always a whole
    // number of bars, so the same expression accents the count-in on that same bar grid.
    const barBeats = Math.max(1, Math.round(timeSig.numerator));
    const beatPhase = this.clickBeatPhase;
    let guard = 0;
    while (guard++ < WINDOW_GUARD) {
      const when = this.playStartContext + this.nextClickIndex * beatSeconds;
      if (when > horizon) break;
      const inCountIn = when < this.contentStartContext - 1e-9;
      // A click more than one beat stale is not emitted, but its index is still consumed
      // (issue #74). Scheduling a past `when` makes Web Audio play it instantly, so a wake
      // after a backgrounded tab would otherwise dump every elapsed beat as a single burst.
      // The tolerance is one beat rather than zero because a click a few milliseconds late is
      // still the beat the user is expecting, and dropping it would silence the metronome. The
      // index is ADVANCED rather than skipped, which is what keeps the §5.9 accent on the bar
      // line: the accent follows the index, not the number of clicks emitted.
      if ((inCountIn || this.metronomeEnabled) && when >= now - beatSeconds) {
        const accented = (beatPhase + this.nextClickIndex) % barBeats === 0;
        result.batch.push({ kind: 'click', when, tick: 0, accented });
      }
      this.nextClickIndex++;
    }
  }

  // --- sequence-mode content (spec §7.1.4, §7.4, §7.1.5) ---
  private scheduleSequence(horizon: number, result: SchedulerTickResult): void {
    const from = this.nextScheduleTick;
    const requested = this.linearTickAt(horizon);
    if (requested <= from) return;
    // `segmentWindow` bounds its own iteration, and a window it could not walk in full must
    // shorten this pass rather than be scheduled as though it had (issue #95). Everything
    // below — including `nextScheduleTick` at the end — then works to the same `to`, so the
    // remainder is picked up on the next wake instead of being dropped.
    const walk = segmentWindow(from, requested, this.loop);
    if (walk.truncated) {
      console.warn(
        `[scheduler] lookahead window ${from}..${requested} exceeded the segment guard; ` +
          `scheduling to ${walk.reachedTo} and deferring the rest`,
      );
    }
    const to = walk.reachedTo;
    if (to <= from) return;

    for (const [trackId, track] of this.tracks) {
      for (const windowed of eventsInWindow(track.events, (e) => e.tickStart, from, to, this.loop)) {
        this.emitNote(result, trackId, windowed.item, windowed.tick, windowed.linearTick);
      }
      this.collectErase(result, trackId, track, from, to);
    }
    this.scheduleNoteRepeat(result, from, to);
    this.scheduleArpeggiator(result, from, to);
    this.scheduleSequenceAutomation(result, from, to);

    const newPass = loopPassAt(to, this.loop);
    if (loopActive(this.loop) && newPass > this.lastLoopPass) {
      for (let pass = this.lastLoopPass + 1; pass <= newPass; pass++) {
        result.loopWrapped.push(this.loop.startTick);
      }
      this.flushRecording(result); // overdub: merge each pass (spec §7.7)
      this.lastLoopPass = newPass;
    }
    this.nextScheduleTick = to;
    // The counterpart of the song cursor's own catch-up: a switch INTO song mode resumes at
    // the elapsed position instead of replaying the song from its start (spec §8.5.12).
    this.nextSongSeconds = Math.max(0, this.anchorSongSeconds + (horizon - this.anchorContext));
  }

  /** Linear tick reached at context time `when` (sequence mode). */
  private linearTickAt(when: number): number {
    const elapsed = when - this.anchorContext;
    return elapsed <= 0 ? this.originTick : this.originTick + secondsToTicks(elapsed, this.bpm);
  }

  /**
   * The schedule-time shaping a note at `seqTick` on `trackId` receives: swing (§7.4) and the
   * track's groove (§7.5) are both non-destructive tick offsets, and they compose — a grooved
   * track still swings. Shared by sequence and song mode so a pattern cannot sound different
   * depending on which transport mode plays it.
   */
  private shapeNote(
    trackId: string,
    seqTick: number,
    velocity: number,
  ): { offsetTicks: number; velocity: number } {
    const groove = this.grooves.get(trackId);
    const shift = groove ? grooveShiftAtTick(groove, seqTick) : null;
    return {
      offsetTicks:
        swingOffsetTicks(seqTick, this.swingAmount, this.swingDivision) + (shift?.offsetTicks ?? 0),
      velocity: shift ? clamp(Math.round(velocity * shift.velocityScale), 1, 127) : velocity,
    };
  }

  private emitNote(
    result: SchedulerTickResult,
    trackId: string,
    event: MidiEvent,
    seqTick: number,
    linearTick: number,
  ): void {
    const shaped = this.shapeNote(trackId, seqTick, event.velocity);
    const when =
      this.anchorContext + ticksToSeconds(linearTick + shaped.offsetTicks - this.originTick, this.bpm);
    result.batch.push({
      kind: 'noteOn',
      when,
      tick: seqTick,
      trackId,
      note: event.note,
      velocity: shaped.velocity,
      durationSec: ticksToSeconds(event.durationTicks, this.bpm),
      bpm: this.bpm,
    });
  }

  // --- note repeat (spec §7.3) ---
  private scheduleNoteRepeat(result: SchedulerTickResult, from: number, to: number): void {
    if (!this.noteRepeatEnabled || this.heldNotes.size === 0) return;
    const held: (HeldNote & { trackId: string })[] = [...this.heldNotes.values()];
    for (const hit of noteRepeatHits(held, this.noteRepeatDivision, from, to)) {
      const owner = held.find((h) => h.note === hit.note)!;
      const seqTick = sequenceTickAt(hit.tick, this.loop);
      const swung = hit.tick + swingOffsetTicks(seqTick, this.swingAmount, this.swingDivision);
      const when = this.anchorContext + ticksToSeconds(swung - this.originTick, this.bpm);
      result.batch.push({
        kind: 'noteOn',
        when,
        tick: seqTick,
        trackId: owner.trackId,
        note: hit.note,
        velocity: hit.velocity,
        durationSec: 0,
        bpm: this.bpm,
      });
      if (this.recording) this.captureAt(owner.trackId, hit.note, hit.velocity, seqTick, seqTick + 1);
    }
  }

  // --- arpeggiator (spec §7.3) ---
  private scheduleArpeggiator(result: SchedulerTickResult, from: number, to: number): void {
    if (!this.arpEnabled || this.heldNotes.size === 0) return;
    // Arpeggiate each track's held chord independently (keygroup tracks, spec §7.3).
    const byTrack = new Map<string, ArpHeldNote[]>();
    for (const held of this.heldNotes.values()) {
      const list = byTrack.get(held.trackId) ?? [];
      list.push({ note: held.note, velocity: held.velocity });
      byTrack.set(held.trackId, list);
    }
    for (const [trackId, chord] of byTrack) {
      for (const hit of arpeggiatorHits(chord, this.arpConfig, from, to)) {
        const seqTick = sequenceTickAt(hit.tick, this.loop);
        const swung = hit.tick + swingOffsetTicks(seqTick, this.swingAmount, this.swingDivision);
        const when = this.anchorContext + ticksToSeconds(swung - this.originTick, this.bpm);
        result.batch.push({
          kind: 'noteOn',
          when,
          tick: seqTick,
          trackId,
          note: hit.note,
          velocity: hit.velocity,
          durationSec: ticksToSeconds(hit.durationTicks, this.bpm),
          bpm: this.bpm,
        });
        if (this.recording) {
          this.captureAt(trackId, hit.note, hit.velocity, seqTick, seqTick + hit.durationTicks);
        }
      }
    }
  }

  // --- automation (spec §7.8) ---
  private scheduleSequenceAutomation(result: SchedulerTickResult, from: number, to: number): void {
    // Time from linear ticks; value sampled at the wrapped sequence tick (loops with pattern).
    const when = this.anchorContext + ticksToSeconds(from - this.originTick, this.bpm);
    const rampEnd = this.anchorContext + ticksToSeconds(to - this.originTick, this.bpm);
    const seqTo = sequenceTickAt(to, this.loop);
    for (const targetPath of this.automatedTargets()) {
      const points = this.effectivePoints(targetPath);
      const value = automationValueAt(points, seqTo);
      if (value === null) continue;
      result.batch.push({ kind: 'automationRamp', when, tick: seqTo, target: targetPath, value, rampEnd });
    }
  }

  /** Distinct automatable target paths across all lanes (spec §7.8). */
  private automatedTargets(): Set<string> {
    const targets = new Set<string>();
    for (const key of this.automation.keys()) {
      // key = `${scope}:${ownerId}:${targetPath}`
      const secondColon = key.indexOf(':', key.indexOf(':') + 1);
      targets.add(key.slice(secondColon + 1));
    }
    return targets;
  }

  /** Track-scope wins over sequence-scope for a target (spec §7.8). Sequence lane only for the active sequence. */
  private effectivePoints(targetPath: string): readonly AutomationPoint[] {
    let trackPoints: AutomationPoint[] | undefined;
    let sequencePoints: AutomationPoint[] | undefined;
    for (const [key, points] of this.automation) {
      const firstColon = key.indexOf(':');
      const secondColon = key.indexOf(':', firstColon + 1);
      const scope = key.slice(0, firstColon);
      const ownerId = key.slice(firstColon + 1, secondColon);
      const path = key.slice(secondColon + 1);
      if (path !== targetPath) continue;
      if (scope === 'track') trackPoints = points;
      else if (scope === 'sequence' && ownerId === this.activeSequenceId) sequencePoints = points;
    }
    return resolveEffectivePoints(trackPoints, sequencePoints);
  }

  // --- live erase (spec §7.7) ---
  private collectErase(
    result: SchedulerTickResult,
    trackId: string,
    track: TrackEvents,
    from: number,
    to: number,
  ): void {
    if (this.eraseNotes.size === 0) return;
    // Same wrap-aware window as note scheduling: folding `from`/`to` and taking min/max
    // yields the *complement* of the window whenever it straddles the loop end (spec §7.1.4).
    const ids = new Set<string>();
    for (const windowed of eventsInWindow(track.events, (e) => e.tickStart, from, to, this.loop)) {
      if (!this.eraseNotes.has(`${trackId}:${windowed.item.note}`)) continue;
      ids.add(windowed.item.id);
    }
    if (ids.size > 0) {
      track.events = track.events.filter((e) => !ids.has(e.id));
      result.erased.push({ trackId, eventIds: [...ids] });
    }
  }

  // --- song mode (spec §7.9) ---

  /**
   * Schedule the song's lookahead window and enforce §7.9's end of song.
   *
   * The cursor is kept in ABSOLUTE song seconds ({@link nextSongSeconds}) rather than in
   * song ticks, because a looping song has no monotonic tick: pass 2's tick 0 is the same
   * number as pass 1's. Absolute seconds are monotonic, so one window can straddle a wrap
   * and each pass still schedules its events exactly once (spec §7.1.5).
   */
  private scheduleSong(now: number, horizon: number, result: SchedulerTickResult): void {
    const total = songTotalSeconds(this.songMap);
    // A song whose entries all contribute nothing has `songTotalTicks === 0`, and §7.9
    // requires it to stop rather than loop endlessly over a zero-length map — so the
    // zero-length case stops whatever `songLoopEnabled` says.
    const zeroLength = this.songMap.length === 0 || total <= 0;
    const origin = zeroLength ? 0 : this.anchorSongSeconds;
    // The end is reached when the PLAYHEAD arrives, not when the lookahead does: stopping
    // at schedule time would cut the last `LOOKAHEAD_MS` of the song off the end of it.
    //
    // It is the end of the pass IN PROGRESS, not of the first one: turning the loop off
    // part-way through pass two must end that pass, not stop the transport the instant the
    // toggle moves because the song is already past where pass one finished.
    if ((zeroLength || !this.songLoopEnabled) && now >= this.currentPassEnd(total, origin)) {
      this.endSong(now, result);
      return;
    }
    if (zeroLength) return;

    const fromAbs = this.nextSongSeconds;
    let toAbs = origin + (horizon - this.anchorContext);
    if (!this.songLoopEnabled && toAbs > total) toAbs = total;
    if (toAbs <= fromAbs) return;

    let cursor = fromAbs;
    let guard = 0;
    while (cursor < toAbs && guard++ < WINDOW_GUARD) {
      const pass = Math.floor(cursor / total);
      const passStart = pass * total;
      const crosses = toAbs >= passStart + total;
      this.emitSongPass(result, pass, cursor - passStart, crosses ? total : toAbs - passStart, origin, total);
      cursor = crosses ? passStart + total : toAbs;
    }
    this.nextSongSeconds = toAbs;
    // Keep the sequence-mode bookkeeping level with the horizon. The playback mode is
    // switchable while the transport rolls (spec §8.5.12), and a cursor left behind at the
    // song's start would make the first sequence-mode wake schedule every tick since then in
    // one burst — with a loop wrap and a capture flush for every pass it swept through.
    this.nextScheduleTick = this.linearTickAt(horizon);
    this.lastLoopPass = loopPassAt(this.nextScheduleTick, this.loop);
  }

  /**
   * Wall-clock time at which the pass in progress ends (spec §7.9).
   *
   * The pass is the one the scheduler has last emitted for, not the one `now` falls in.
   * With looping off from the start that is pass 0, so the song ends at its own end. With
   * looping on it advances each wrap, so turning the toggle off part-way through pass two
   * ends THAT pass rather than stopping the instant the toggle moves. Near a wrap the
   * lookahead has already scheduled the next pass, and the answer defers to it — those
   * notes are going to be heard, so cutting them off would be worse than one more pass.
   */
  private currentPassEnd(total: number, origin: number): number {
    if (total <= 0) return this.anchorContext;
    return this.anchorContext + ((this.lastSongPass + 1) * total - origin);
  }

  /**
   * Emit one pass's slice of the window, given in song seconds within that pass. Each pass
   * re-announces its entries (spec §7.9: a wrap "resets its last-entry cursor so
   * `songAdvanced` fires again for the first entry").
   */
  private emitSongPass(
    result: SchedulerTickResult,
    pass: number,
    fromSeconds: number,
    toSeconds: number,
    origin: number,
    total: number,
  ): void {
    const from = songSecondsToTick(this.songMap, fromSeconds);
    const to = songSecondsToTick(this.songMap, toSeconds);
    if (to <= from) return;
    if (pass !== this.lastSongPass) {
      this.lastSongPass = pass;
      this.lastEntryIndex = -1;
    }
    // Wall-clock time of this pass's song tick 0.
    const passOrigin = this.anchorContext + pass * total - origin;

    for (const slice of songWindowSlices(this.songMap, from, to)) {
      const { segment } = slice;
      if (segment.entryIndex !== this.lastEntryIndex) {
        result.songAdvanced.push(segment.entryIndex);
        this.lastEntryIndex = segment.entryIndex;
      }
      for (const [trackId, track] of this.tracks) {
        if (track.sequenceId !== segment.sequenceId) continue;
        for (const event of track.events) {
          if (event.tickStart < slice.seqFrom || event.tickStart >= slice.seqTo) continue;
          const songTick = segment.startTick + event.tickStart;
          // Swing (§7.4) and groove (§7.5) are "applied at schedule time" with no song-mode
          // exemption, so the offset is added here too. It is added in *seconds at the
          // segment's tempo* rather than to `songTick`, so a note near a segment boundary
          // cannot be nudged across it and re-timed by the next segment's tempo (§7.9).
          const shaped = this.shapeNote(trackId, event.tickStart, event.velocity);
          const when =
            passOrigin +
            songTickToSeconds(this.songMap, songTick) +
            ticksToSeconds(shaped.offsetTicks, segment.bpm);
          result.batch.push({
            kind: 'noteOn',
            when,
            tick: event.tickStart,
            trackId,
            note: event.note,
            velocity: shaped.velocity,
            durationSec: ticksToSeconds(event.durationTicks, segment.bpm),
            // The SEGMENT's tempo, not the transport's: a sequence with a tempo of its own
            // plays at it (spec §7.9), and a §6 synced LFO has to follow the same one.
            bpm: segment.bpm,
          });
        }
      }
    }
  }

  /**
   * §7.9's stop path: the worker ceases scheduling and reports `songEnded`, having first
   * closed any open notes and flushed the take. That ordering is specified, not incidental —
   * it is the last chance to persist a recording the user is still making.
   */
  private endSong(now: number, result: SchedulerTickResult): void {
    this.closeOpenNotes(now, result);
    this.flushRecording(result);
    this.resetPlayback();
    // spec §7.9: "the playhead returns to tick 0". The next play re-sends its own start
    // tick, so clearing it here cannot move where a later sequence-mode play begins.
    this.startTick = 0;
    result.songEnded = true;
  }

  private rebuildSongMap(): void {
    if (this.orderedSequenceIds.length === 0 || this.sequenceMeta.size === 0) {
      this.songMap = [];
      return;
    }
    // Rebuild a synthetic entry list (one entry per ordered id) + a Sequence-like lookup.
    const entries = this.orderedSequenceIds.map((sequenceId, position) => ({
      id: `e${position}`,
      position,
      sequenceId,
      repeats: 1,
    }));
    const sequences: Record<string, import('@/core/project/schemas').Sequence> = {};
    for (const [id, meta] of this.sequenceMeta) {
      sequences[id] = {
        id,
        projectId: '',
        position: 0,
        name: id,
        lengthBars: meta.lengthBars,
        timeSig: { numerator: meta.numerator, denominator: meta.denominator },
        tempo: meta.tempo,
        swingAmount: 50,
        swingDivision: 16,
      };
    }
    this.songMap = buildSongMap(entries, sequences, this.projectBpm);
  }

  // --- recording capture (spec §7.7) ---
  private captureNote(trackId: string, note: number, open: OpenNote, endTick: number): void {
    this.captureAt(trackId, note, open.velocity, open.startTick, endTick);
  }

  private captureAt(
    trackId: string,
    note: number,
    velocity: number,
    startTick: number,
    endTick: number,
  ): void {
    const list = this.captured.get(trackId) ?? [];
    list.push({
      id: crypto.randomUUID(),
      tickStart: Math.max(0, Math.round(startTick)),
      durationTicks: Math.max(1, Math.round(endTick - startTick)), // min 1 tick (spec §7.7)
      note,
      velocity,
      extra: null,
    });
    this.captured.set(trackId, list);
  }

  private closeOpenNotes(now: number, _result: SchedulerTickResult): void {
    const endTick = this.positionTickAt(now);
    for (const [key, open] of this.openNotes) {
      const [trackId, note] = key.split(':');
      this.captureNote(trackId!, Number(note), open, endTick);
    }
    this.openNotes.clear();
  }

  private flushRecording(result: SchedulerTickResult): void {
    for (const [trackId, events] of this.captured) {
      if (events.length > 0) result.recorded.push({ trackId, events });
    }
    this.captured.clear();
  }

  // --- musical helpers ---
  /** Which beat of the bar `tick` falls on, for the §5.9 accent (spec §7.7). */
  private beatPhaseOf(tick: number): number {
    const timeSig = this.activeTimeSig();
    const barBeats = Math.max(1, Math.round(timeSig.numerator));
    const beat = Math.floor(tick / ticksPerBeat(timeSig));
    return ((beat % barBeats) + barBeats) % barBeats;
  }

  private activeTimeSig(): TimeSignature {
    const meta = this.activeSequenceId ? this.sequenceMeta.get(this.activeSequenceId) : undefined;
    return meta ? { numerator: meta.numerator, denominator: meta.denominator } : DEFAULT_TIME_SIG;
  }
  private beatSeconds(): number {
    return ticksToSeconds(ticksPerBeat(this.activeTimeSig()), this.bpm);
  }
  private barSeconds(): number {
    return ticksToSeconds(ticksPerBar(this.activeTimeSig()), this.bpm);
  }
}
