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
import { eventsInWindow, loopActive, loopPassAt, sequenceTickAt, type LoopRegion } from './lookahead';
import type { ScheduledEvent } from './messages';
import { noteRepeatHits, type HeldNote, type NoteRepeatDivision } from './noteRepeat';
import { secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from './ppqn';
import {
  buildSongMap,
  songSecondsToTick,
  songTickToSeconds,
  songWindowSlices,
  type SongSegment,
} from './songMap';
import { swingOffsetTicks } from './swing';

/** Everything the worker posts after one scheduler wake (spec §7.1.3). */
export interface SchedulerTickResult {
  readonly batch: ScheduledEvent[];
  readonly recorded: { trackId: string; events: MidiEvent[] }[];
  readonly erased: { trackId: string; eventIds: string[] }[];
  readonly loopWrapped: number[];
  readonly songAdvanced: number[];
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

  private readonly tracks = new Map<string, TrackEvents>();
  private readonly automation = new Map<string, AutomationPoint[]>();
  private readonly sequenceMeta = new Map<string, TimeSignature & { lengthBars: number; tempo: number | null }>();
  private orderedSequenceIds: string[] = [];
  private songMap: SongSegment[] = [];

  private noteRepeatEnabled = false;
  private noteRepeatDivision: NoteRepeatDivision = { value: 16, triplet: false };
  private arpEnabled = false;
  private arpConfig: ArpConfig = { mode: 'up', octaves: 1, gate: 0.5, division: { value: 16, triplet: false } };
  private readonly heldNotes = new Map<string, HeldNote & { trackId: string }>();
  private readonly eraseNotes = new Map<string, number>(); // `${trackId}:${note}` → note

  // --- recording capture ---
  private readonly openNotes = new Map<string, OpenNote>(); // `${trackId}:${note}`
  private readonly captured = new Map<string, MidiEvent[]>();

  // --- playback timing bookkeeping ---
  private playStartContext = 0; // gesture time (count-in begins here)
  private contentStartContext = 0; // content begins after count-in
  private originTick = 0; // linear/song tick at contentStartContext
  private nextScheduleTick = 0; // next linear/song tick to schedule from
  private nextClickIndex = 0;
  private lastLoopPass = 0;
  private lastEntryIndex = -1;
  private pendingStart = false;
  private stopRequested = false;

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

  setTempo(bpm: number): void {
    this.bpm = bpm;
  }
  setSwing(amount: number, division: SwingDivision): void {
    this.swingAmount = amount;
    this.swingDivision = division;
  }
  setLoop(loop: LoopRegion): void {
    this.loop = loop;
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

  applyEventsDiff(trackId: string, sequenceId: string, upserts: readonly MidiEvent[], deletes: readonly string[]): void {
    const track = this.tracks.get(trackId) ?? { sequenceId, events: [] };
    const byId = new Map(track.events.map((e) => [e.id, e]));
    for (const id of deletes) byId.delete(id);
    for (const event of upserts) byId.set(event.id, event);
    const events = [...byId.values()].sort((a, b) => a.tickStart - b.tickStart || a.id.localeCompare(b.id));
    this.tracks.set(trackId, { sequenceId, events });
  }

  applyAutomationDiff(scope: AutomationPoint['scope'], ownerId: string, targetPath: string, points: readonly AutomationPoint[]): void {
    const key = automationLaneKey(scope, ownerId, targetPath);
    if (points.length === 0) this.automation.delete(key);
    else this.automation.set(key, [...points].sort((a, b) => a.tick - b.tick));
  }

  setSongSequence(orderedSequenceIds: readonly string[]): void {
    this.orderedSequenceIds = [...orderedSequenceIds];
    this.rebuildSongMap();
  }

  setSequenceMeta(
    sequences: Readonly<Record<string, { lengthBars: number; timeSigNumerator: number; timeSigDenominator: 2 | 4 | 8 | 16; tempo: number | null }>>,
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
    const result: SchedulerTickResult = { batch: [], recorded: [], erased: [], loopWrapped: [], songAdvanced: [] };

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
    this.scheduleClicks(horizon, result);
    if (this.playbackMode === 'song') this.scheduleSong(horizon, result);
    else this.scheduleSequence(horizon, result);
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

  // --------------------------------------------------------------- internals ---

  private beginPlayback(now: number): void {
    this.playStartContext = now;
    this.originTick = this.startTick;
    const countInSeconds = this.recording && this.countInBars > 0 ? this.countInBars * this.barSeconds() : 0;
    this.contentStartContext = now + countInSeconds;
    this.nextScheduleTick = this.originTick;
    this.nextClickIndex = 0;
    this.lastLoopPass = loopPassAt(this.originTick, this.loop);
    this.lastEntryIndex = -1;
  }

  private resetPlayback(): void {
    this.playing = false;
    this.recording = false;
    this.openNotes.clear();
    this.heldNotes.clear();
  }

  private contentStarted(when: number): boolean {
    return this.playing && when >= this.contentStartContext;
  }

  /** Sequence/song tick at a context time (spec §7.1.4). */
  private positionTickAt(when: number): number {
    const elapsed = when - this.contentStartContext;
    if (elapsed <= 0) return this.originTick;
    if (this.playbackMode === 'song') {
      const base = songTickToSeconds(this.songMap, this.originTick);
      return songSecondsToTick(this.songMap, base + elapsed);
    }
    return sequenceTickAt(this.originTick + secondsToTicks(elapsed, this.bpm), this.loop);
  }

  // --- metronome + count-in (spec §7.7) ---
  private scheduleClicks(horizon: number, result: SchedulerTickResult): void {
    const beatSeconds = this.beatSeconds();
    const barBeats = this.activeTimeSig().numerator;
    let guard = 0;
    while (guard++ < WINDOW_GUARD) {
      const when = this.playStartContext + this.nextClickIndex * beatSeconds;
      if (when > horizon) break;
      const inCountIn = when < this.contentStartContext - 1e-9;
      if (inCountIn || this.metronomeEnabled) {
        result.batch.push({ kind: 'click', when, tick: 0, accented: this.nextClickIndex % barBeats === 0 });
      }
      this.nextClickIndex++;
    }
  }

  // --- sequence-mode content (spec §7.1.4, §7.4, §7.1.5) ---
  private scheduleSequence(horizon: number, result: SchedulerTickResult): void {
    const from = this.nextScheduleTick;
    const to = this.linearTickAt(horizon);
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
      for (let pass = this.lastLoopPass + 1; pass <= newPass; pass++) result.loopWrapped.push(this.loop.startTick);
      this.flushRecording(result); // overdub: merge each pass (spec §7.7)
      this.lastLoopPass = newPass;
    }
    this.nextScheduleTick = to;
  }

  /** Linear tick reached at context time `when` (sequence mode). */
  private linearTickAt(when: number): number {
    const elapsed = when - this.contentStartContext;
    return elapsed <= 0 ? this.originTick : this.originTick + secondsToTicks(elapsed, this.bpm);
  }

  private emitNote(result: SchedulerTickResult, trackId: string, event: MidiEvent, seqTick: number, linearTick: number): void {
    const swung = linearTick + swingOffsetTicks(seqTick, this.swingAmount, this.swingDivision);
    const when = this.contentStartContext + ticksToSeconds(swung - this.originTick, this.bpm);
    result.batch.push({
      kind: 'noteOn',
      when,
      tick: seqTick,
      trackId,
      note: event.note,
      velocity: event.velocity,
      durationSec: ticksToSeconds(event.durationTicks, this.bpm),
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
      const when = this.contentStartContext + ticksToSeconds(swung - this.originTick, this.bpm);
      result.batch.push({ kind: 'noteOn', when, tick: seqTick, trackId: owner.trackId, note: hit.note, velocity: hit.velocity, durationSec: 0 });
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
        const when = this.contentStartContext + ticksToSeconds(swung - this.originTick, this.bpm);
        result.batch.push({
          kind: 'noteOn',
          when,
          tick: seqTick,
          trackId,
          note: hit.note,
          velocity: hit.velocity,
          durationSec: ticksToSeconds(hit.durationTicks, this.bpm),
        });
        if (this.recording) this.captureAt(trackId, hit.note, hit.velocity, seqTick, seqTick + hit.durationTicks);
      }
    }
  }

  // --- automation (spec §7.8) ---
  private scheduleSequenceAutomation(result: SchedulerTickResult, from: number, to: number): void {
    // Time from linear ticks; value sampled at the wrapped sequence tick (loops with pattern).
    const when = this.contentStartContext + ticksToSeconds(from - this.originTick, this.bpm);
    const rampEnd = this.contentStartContext + ticksToSeconds(to - this.originTick, this.bpm);
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
  private collectErase(result: SchedulerTickResult, trackId: string, track: TrackEvents, from: number, to: number): void {
    if (this.eraseNotes.size === 0) return;
    const seqFrom = sequenceTickAt(from, this.loop);
    const seqTo = sequenceTickAt(to, this.loop);
    const lo = Math.min(seqFrom, seqTo);
    const hi = Math.max(seqFrom, seqTo);
    const ids: string[] = [];
    for (const event of track.events) {
      if (!this.eraseNotes.has(`${trackId}:${event.note}`)) continue;
      if (event.tickStart >= lo && event.tickStart < hi) ids.push(event.id);
    }
    if (ids.length > 0) {
      track.events = track.events.filter((e) => !ids.includes(e.id));
      result.erased.push({ trackId, eventIds: ids });
    }
  }

  // --- song mode (spec §7.9) ---
  private scheduleSong(horizon: number, result: SchedulerTickResult): void {
    if (this.songMap.length === 0) return;
    const from = this.nextScheduleTick;
    const base = songTickToSeconds(this.songMap, this.originTick);
    const to = songSecondsToTick(this.songMap, base + (horizon - this.contentStartContext));
    if (to <= from) return;

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
          const when = this.contentStartContext + (songTickToSeconds(this.songMap, songTick) - base);
          result.batch.push({ kind: 'noteOn', when, tick: event.tickStart, trackId, note: event.note, velocity: event.velocity, durationSec: ticksToSeconds(event.durationTicks, segment.bpm) });
        }
      }
    }
    this.nextScheduleTick = to;
  }

  private rebuildSongMap(): void {
    if (this.orderedSequenceIds.length === 0 || this.sequenceMeta.size === 0) {
      this.songMap = [];
      return;
    }
    // Rebuild a synthetic entry list (one entry per ordered id) + a Sequence-like lookup.
    const entries = this.orderedSequenceIds.map((sequenceId, position) => ({ id: `e${position}`, position, sequenceId, repeats: 1 }));
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

  private captureAt(trackId: string, note: number, velocity: number, startTick: number, endTick: number): void {
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
