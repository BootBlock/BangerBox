/**
 * useProgramStore — drum/keygroup program data (spec §4.2, §6). Plain data only: no
 * audio nodes live here (spec §4.2) — the sync layer builds them (spec §4.3). Program
 * and pad edits are undoable (spec §4.5 "program parameter commits", "pad assignment")
 * and mark the owning program dirty for autosave (spec §4.4). The generic
 * {@link updateProgram} carries the deep §6 editing surface Program Edit mode drives.
 *
 * {@link addPadLayer}, {@link setLayerSample}, {@link addKeygroupZone} and
 * {@link setZoneSample} are the sample-assignment seam (spec §8.5.7, §8.5.5). They own the §6
 * rules no caller should have to restate: a pad's velocity layers stay contiguous and
 * non-overlapping, a pad refuses a layer past `maxLayers`, and a new keygroup zone takes a
 * share of the keyboard rather than hiding every zone before it. {@link removePadLayer} and
 * {@link removeKeygroupZone} are part of the same seam, because removing a layer without
 * closing the band it held leaves the pad silent across that band.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { clamp, clampInt } from '@/core/math';
import { parseParamTarget, targetRange } from '@/core/audio/params/registry';
import { dirtyKey } from '@/core/project/dirty';
import {
  createDefaultKeygroupZone,
  createDefaultPad,
  createDefaultVelocityLayer,
  DEFAULT_MAX_VELOCITY_LAYERS,
  MAX_VELOCITY_LAYERS,
  NOTE_RANGE,
  PAD_INDEX_RANGE,
  ROOT_NOTE_RANGE,
  type KeygroupZone,
  type Pad,
  type Program,
  type Range,
  type VelocityLayer,
} from '@/core/project/schemas';
import { recordParamGesture } from './automationRecord';
import { publishTransient, settleTransient } from './transientChannel';
import { commit } from './commit';

/**
 * What an assignment action did (spec §8.5.7). A refusal carries a finished sentence rather
 * than a code, because every caller does the same thing with it — shows it to the user — and
 * the store is the only layer that knows *which* §6 rule refused. Returning `void` instead
 * would leave the UI reporting "nothing happened", which is how a control reads as broken.
 */
export type AssignResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function refuse(reason: string): AssignResult {
  return { ok: false, reason };
}

const ASSIGNED: AssignResult = { ok: true };

interface ProgramState {
  programs: Record<string, Program>;
  activeProgramId: string | null;
  activePadId: number | null;

  /** Replace every program on project load (spec §4.4). */
  setPrograms: (programs: Record<string, Program>) => void;

  addProgram: (program: Program) => void;
  removeProgram: (id: string) => void;

  /**
   * Add/remove programs WITHOUT recording undo or marking dirty — for callers that write
   * the rows themselves and own a single composite undo entry covering the whole operation
   * (the §9.8 kit merge: one "Install …" step, not one per program). Going through
   * {@link addProgram} there would push a stray per-program entry underneath the composite
   * one, whose redo would resurrect a program whose samples the composite undo had deleted.
   */
  mergePrograms: (programs: readonly Program[]) => void;
  dropPrograms: (ids: readonly string[]) => void;
  renameProgram: (id: string, name: string) => void;

  /** UI selection — not undoable/persisted (spec §4.5). */
  setActiveProgram: (id: string | null) => void;
  setActivePad: (padIndex: number | null) => void;

  /** Apply a pure transform to a program as one undoable commit (spec §4.5). */
  updateProgram: (id: string, updater: (program: Program) => Program, label?: string) => void;

  /** Assign or replace a drum pad (spec §4.5 pad assignment). */
  upsertPad: (programId: string, pad: Pad) => void;
  removePad: (programId: string, padIndex: number) => void;

  /**
   * Assign a sample to a drum pad as a new velocity layer, creating the pad if it does not
   * exist yet (spec §8.5.7 drag-to-pad, §8.5.5, §6). One undo entry (spec §4.5 "pad
   * assignment"). Refuses past `maxLayers` — spec §6 caps a pad at `maxLayers`, default 4.
   */
  addPadLayer: (programId: string, padIndex: number, sampleId: string, maxLayers?: number) => AssignResult;
  /** Point an existing velocity layer at a different sample, leaving its band alone (spec §6). */
  setLayerSample: (programId: string, padIndex: number, layerIndex: number, sampleId: string) => AssignResult;
  /**
   * Remove one velocity layer, closing the band it leaves behind so the pad still answers
   * every velocity (spec §6). Removing without closing the hole is a silent pad above or
   * below the gap, which is the same defect as never assigning at all.
   */
  removePadLayer: (programId: string, padIndex: number, layerIndex: number) => AssignResult;

  /**
   * Assign a sample to a keygroup program as a new zone (spec §8.5.5, §6). One undo entry.
   * `rootNote` is the sample's unity pitch (spec §9.3 `samples.root_note`).
   */
  addKeygroupZone: (programId: string, sampleId: string, rootNote?: number) => AssignResult;
  /** Point an existing zone at a different sample, leaving its key range alone (spec §6). */
  setZoneSample: (programId: string, zoneIndex: number, sampleId: string) => AssignResult;
  /** Remove one keygroup zone, freeing its key range for the next assignment (spec §6). */
  removeKeygroupZone: (programId: string, zoneIndex: number) => AssignResult;

  /**
   * Continuous-gesture update of a registered §7.8 program leaf: the value moves (and the
   * sync layer follows it to the sounding voices) with no undo entry or autosave write
   * (spec §4.1). `path` is a `program:<id>.pad:<idx>.<leaf>` address.
   */
  setPadParamTransient: (path: string, value: number) => void;
  /** Gesture end: one undo entry back to the pre-gesture value + autosave (spec §4.1). */
  commitPadParam: (path: string, value: number) => void;
}

/** Pre-gesture origin per program-parameter path — module-level, so it never re-renders. */
const padGestureOrigins = new Map<string, number>();

/**
 * Read a registered §7.8 leaf off a pad, or null when the address does not apply.
 * `pitch` is the pad tune, which §6 stores per velocity layer (spec §5.5 "pad tune"), so
 * the pad's tune reads from its first layer.
 */
function readPadLeaf(pad: Pad, leaf: string): number | null {
  switch (leaf) {
    case 'filter.cutoff':
      return pad.filter.cutoff;
    case 'filter.resonance':
      return pad.filter.resonance;
    case 'pitch':
      return pad.layers[0]?.tuneSemitones ?? 0;
    case 'amp':
      return pad.mixer.level;
    case 'pan':
      return pad.mixer.pan;
    case 'amp.attack':
      return pad.envelopes.amp.attack;
    case 'amp.release':
      return pad.envelopes.amp.release;
    default:
      return null;
  }
}

/** Return a pad with one registered §7.8 leaf replaced (immutably). */
function writePadLeaf(pad: Pad, leaf: string, value: number): Pad {
  switch (leaf) {
    case 'filter.cutoff':
      return { ...pad, filter: { ...pad.filter, cutoff: value } };
    case 'filter.resonance':
      return { ...pad, filter: { ...pad.filter, resonance: value } };
    case 'pitch':
      // Pad tune is a property of the pad, so every layer moves together (spec §5.5).
      return { ...pad, layers: pad.layers.map((layer) => ({ ...layer, tuneSemitones: value })) };
    case 'amp':
      return { ...pad, mixer: { ...pad.mixer, level: value } };
    case 'pan':
      return { ...pad, mixer: { ...pad.mixer, pan: value } };
    case 'amp.attack':
      return { ...pad, envelopes: { ...pad.envelopes, amp: { ...pad.envelopes.amp, attack: value } } };
    case 'amp.release':
      return { ...pad, envelopes: { ...pad.envelopes, amp: { ...pad.envelopes.amp, release: value } } };
    default:
      return pad;
  }
}

interface ResolvedPadLeaf {
  readonly programId: string;
  readonly padIndex: number;
  readonly leaf: string;
  readonly value: number;
  readonly current: number;
  /** The §7.8 registered bounds the value was clamped to; the recorder scales by them. */
  readonly range: Range;
}

/** Resolve a program address against the live programs, clamped to its registered range. */
function resolvePadLeaf(
  programs: Record<string, Program>,
  path: string,
  value: number,
): ResolvedPadLeaf | null {
  const target = parseParamTarget(path);
  if (target?.kind !== 'programParam') return null;
  const range = targetRange(target);
  if (range === null) return null;
  const program = programs[target.programId];
  if (program?.type !== 'drum') return null;
  const pad = program.pads.find((candidate) => candidate.padIndex === target.padIndex);
  if (pad === undefined) return null;
  const current = readPadLeaf(pad, target.param);
  if (current === null) return null;
  return {
    programId: target.programId,
    padIndex: target.padIndex,
    leaf: target.param,
    value: clamp(value, range[0], range[1]),
    current,
    range,
  };
}

/**
 * Split `[0, span - 1]` into `count` contiguous, non-overlapping integer bands.
 *
 * This is what makes the §6 "layers may not overlap" rule hold *by construction* rather than
 * by validation: assigning a sample re-splits every band on the pad, so no arrangement of
 * assignments can produce an overlap or a velocity nothing answers. A rule enforced by
 * rejection would instead leave a user with four layers and no way to add a fifth sound
 * except by hand-editing three spinners first.
 */
function splitBands(span: number, count: number): { readonly low: number; readonly high: number }[] {
  const bands: { low: number; high: number }[] = [];
  for (let index = 0; index < count; index++) {
    bands.push({
      low: Math.round((index * span) / count),
      high: Math.round(((index + 1) * span) / count) - 1,
    });
  }
  return bands;
}

/** Re-split a pad's layers across the whole velocity span, preserving their order (spec §6). */
function withSplitVelocities(layers: readonly VelocityLayer[]): VelocityLayer[] {
  const bands = splitBands(128, layers.length);
  return layers.map((layer, index) => ({
    ...layer,
    velocityStart: bands[index]!.low,
    velocityEnd: bands[index]!.high,
  }));
}

/**
 * Close the hole a removed layer leaves, so no velocity stops answering (spec §6).
 *
 * The layer below the removed one grows up to where it ended; removing the first layer instead
 * grows the new first downwards. Every other boundary is left exactly where the user put it —
 * re-splitting the whole axis, the inverse of {@link withSplitVelocities}, would throw away
 * hand-tuned bands to fix a gap in one place.
 */
function withLayerRemoved(layers: readonly VelocityLayer[], index: number): VelocityLayer[] {
  const removed = layers[index];
  const kept = layers.filter((_, i) => i !== index);
  if (removed === undefined || kept.length === 0) return kept;
  // Below when there is one, else above: exactly one neighbour absorbs the freed band.
  const absorber = index > 0 ? index - 1 : 0;
  return kept.map((layer, i) => {
    if (i !== absorber) return layer;
    return index > 0
      ? { ...layer, velocityEnd: Math.max(layer.velocityEnd, removed.velocityEnd) }
      : { ...layer, velocityStart: Math.min(layer.velocityStart, removed.velocityStart) };
  });
}

/**
 * The key range a new zone should take, or null when the keyboard cannot carry another
 * (spec §6, §3.4).
 *
 * §6 permits zones to overlap, and `selectKeygroupZone` returns the FIRST zone covering a note,
 * so a zone added at 0..127 behind an existing one would never sound — a dead control by
 * construction. The new zone therefore takes the widest uncovered stretch of keyboard if one
 * exists, and otherwise halves the widest existing zone, which is the only way to make room
 * once the keyboard is full. Nothing else moves: re-splitting every zone on each add would
 * destroy a hand-mapped multisample to place one sample.
 */
interface ZonePlacement {
  readonly lowNote: number;
  readonly highNote: number;
  /** The zone to shrink to make room, when the keyboard had no gap. */
  readonly shrink?: { readonly index: number; readonly highNote: number };
}

function placeNewZone(zones: readonly KeygroupZone[]): ZonePlacement | null {
  // Widest gap first: covered[i] is true when some zone answers note i.
  const covered = new Array<boolean>(NOTE_RANGE[1] - NOTE_RANGE[0] + 1).fill(false);
  for (const zone of zones) {
    for (let note = zone.lowNote; note <= zone.highNote; note++) {
      const slot = note - NOTE_RANGE[0];
      if (slot >= 0 && slot < covered.length) covered[slot] = true;
    }
  }
  let best: { low: number; high: number } | null = null;
  let runStart = -1;
  for (let slot = 0; slot <= covered.length; slot++) {
    const free = slot < covered.length && !covered[slot];
    if (free && runStart === -1) runStart = slot;
    if (!free && runStart !== -1) {
      const candidate = { low: runStart, high: slot - 1 };
      if (best === null || candidate.high - candidate.low > best.high - best.low) best = candidate;
      runStart = -1;
    }
  }
  if (best !== null) {
    return { lowNote: NOTE_RANGE[0] + best.low, highNote: NOTE_RANGE[0] + best.high };
  }

  // No gap: halve the widest zone. A one-note zone cannot be halved, so a keyboard mapped
  // that finely is genuinely full.
  let widest = -1;
  for (let index = 0; index < zones.length; index++) {
    const zone = zones[index]!;
    const width = zone.highNote - zone.lowNote;
    if (widest === -1 || width > zones[widest]!.highNote - zones[widest]!.lowNote) widest = index;
  }
  const donor = widest === -1 ? undefined : zones[widest]!;
  if (donor === undefined || donor.highNote <= donor.lowNote) return null;
  const midpoint = Math.floor((donor.lowNote + donor.highNote) / 2);
  return {
    lowNote: midpoint + 1,
    highNote: donor.highNote,
    shrink: { index: widest, highNote: midpoint },
  };
}

/** Replace one pad inside a drum program (immutably). */
function withPad(program: Program, padIndex: number, leaf: string, value: number): Program {
  if (program.type !== 'drum') return program;
  return {
    ...program,
    pads: program.pads.map((pad) => (pad.padIndex === padIndex ? writePadLeaf(pad, leaf, value) : pad)),
  };
}

export const useProgramStore = create<ProgramState>()(
  subscribeWithSelector((set, get) => ({
    programs: {},
    activeProgramId: null,
    activePadId: null,

    setPrograms: (programs) => set({ programs: { ...programs } }),

    mergePrograms: (incoming) =>
      set((state) => {
        const programs = { ...state.programs };
        for (const program of incoming) programs[program.id] = program;
        return { programs };
      }),

    dropPrograms: (ids) =>
      set((state) => {
        const programs = { ...state.programs };
        for (const id of ids) delete programs[id];
        return { programs };
      }),

    addProgram: (program) => {
      const write = (value: Program | undefined) =>
        set((state) => {
          const programs = { ...state.programs };
          if (value === undefined) delete programs[program.id];
          else programs[program.id] = value;
          return { programs };
        });
      commit({
        label: 'Add program',
        apply: () => write(program),
        revert: () => write(undefined),
        dirtyKeys: [dirtyKey.program(program.id)],
      });
    },

    removeProgram: (id) => {
      const prev = get().programs[id];
      if (prev === undefined) return;
      const write = (value: Program | undefined) =>
        set((state) => {
          const programs = { ...state.programs };
          if (value === undefined) delete programs[id];
          else programs[id] = value;
          return { programs };
        });
      commit({
        label: 'Delete program',
        apply: () => write(undefined),
        revert: () => write(prev),
        dirtyKeys: [dirtyKey.program(id)],
      });
    },

    renameProgram: (id, name) => {
      get().updateProgram(id, (program) => ({ ...program, name }), 'Rename program');
    },

    setActiveProgram: (activeProgramId) => set({ activeProgramId }),
    setActivePad: (activePadId) => set({ activePadId }),

    updateProgram: (id, updater, label = 'Edit program') => {
      const prev = get().programs[id];
      if (prev === undefined) return;
      const next = updater(prev);
      const write = (value: Program) => set((state) => ({ programs: { ...state.programs, [id]: value } }));
      commit({
        label,
        apply: () => write(next),
        revert: () => write(prev),
        dirtyKeys: [dirtyKey.program(id)],
      });
    },

    upsertPad: (programId, pad) => {
      get().updateProgram(
        programId,
        (program) => {
          if (program.type !== 'drum') return program; // pads exist only on drum programs (spec §6)
          const pads = program.pads.filter((existing) => existing.padIndex !== pad.padIndex);
          return { ...program, pads: [...pads, pad].sort((a, b) => a.padIndex - b.padIndex) };
        },
        'Assign pad',
      );
    },

    removePad: (programId, padIndex) => {
      get().updateProgram(
        programId,
        (program) => {
          if (program.type !== 'drum') return program;
          return { ...program, pads: program.pads.filter((pad) => pad.padIndex !== padIndex) };
        },
        'Clear pad',
      );
    },

    addPadLayer: (programId, padIndex, sampleId, maxLayers = DEFAULT_MAX_VELOCITY_LAYERS) => {
      const program = get().programs[programId];
      if (program === undefined) return refuse('That program is no longer open.');
      if (program.type !== 'drum') {
        return refuse(`${program.name} is a keygroup program, so it has zones rather than pads.`);
      }
      if (!Number.isInteger(padIndex) || padIndex < PAD_INDEX_RANGE[0] || padIndex > PAD_INDEX_RANGE[1]) {
        return refuse(`Pad ${padIndex + 1} is outside the 128-pad range.`);
      }
      // Assigning to an untouched pad is the common case, so the pad is minted here rather
      // than making every caller create it first (spec §6 — pads are sparse).
      const pad =
        program.pads.find((candidate) => candidate.padIndex === padIndex) ?? createDefaultPad(padIndex);
      const cap = clampInt(maxLayers, 1, MAX_VELOCITY_LAYERS);
      if (pad.layers.length >= cap) {
        return refuse(
          `Pad ${padIndex + 1} already holds ${pad.layers.length} velocity layer${
            pad.layers.length === 1 ? '' : 's'
          }. Remove one before adding another.`,
        );
      }
      const layers = withSplitVelocities([...pad.layers, createDefaultVelocityLayer(sampleId)]);
      get().upsertPad(programId, { ...pad, layers });
      return ASSIGNED;
    },

    setLayerSample: (programId, padIndex, layerIndex, sampleId) => {
      const program = get().programs[programId];
      if (program === undefined) return refuse('That program is no longer open.');
      if (program.type !== 'drum') return refuse(`${program.name} is a keygroup program, so it has no pads.`);
      const pad = program.pads.find((candidate) => candidate.padIndex === padIndex);
      if (pad === undefined) return refuse(`Pad ${padIndex + 1} holds no layers yet.`);
      if (pad.layers[layerIndex] === undefined) {
        return refuse(`Pad ${padIndex + 1} has no layer ${layerIndex + 1}.`);
      }
      const layers = pad.layers.map((layer, index) =>
        index === layerIndex ? { ...layer, sampleId } : layer,
      );
      get().upsertPad(programId, { ...pad, layers });
      return ASSIGNED;
    },

    removePadLayer: (programId, padIndex, layerIndex) => {
      const program = get().programs[programId];
      if (program === undefined) return refuse('That program is no longer open.');
      if (program.type !== 'drum') return refuse(`${program.name} is a keygroup program, so it has no pads.`);
      const pad = program.pads.find((candidate) => candidate.padIndex === padIndex);
      if (pad?.layers[layerIndex] === undefined) {
        return refuse(`Pad ${padIndex + 1} has no layer ${layerIndex + 1}.`);
      }
      get().upsertPad(programId, { ...pad, layers: withLayerRemoved(pad.layers, layerIndex) });
      return ASSIGNED;
    },

    addKeygroupZone: (programId, sampleId, rootNote = 60) => {
      const program = get().programs[programId];
      if (program === undefined) return refuse('That program is no longer open.');
      if (program.type !== 'keygroup') {
        return refuse(`${program.name} is a drum program, so it has pads rather than zones.`);
      }
      const placement = placeNewZone(program.zones);
      if (placement === null) {
        return refuse(`${program.name} maps every key already; remove a zone to make room.`);
      }
      // A root note out of §6 range would fail Zod on the next load, so it is clamped at the
      // action boundary like every other stored value (spec §4.1).
      const root = clampInt(rootNote, ROOT_NOTE_RANGE[0], ROOT_NOTE_RANGE[1]);
      const existing =
        placement.shrink === undefined
          ? program.zones
          : program.zones.map((zone, index) =>
              index === placement.shrink!.index ? { ...zone, highNote: placement.shrink!.highNote } : zone,
            );
      const zones = [
        ...existing,
        {
          ...createDefaultKeygroupZone(sampleId, root),
          lowNote: placement.lowNote,
          highNote: placement.highNote,
        },
      ];
      get().updateProgram(
        programId,
        (current) => (current.type === 'keygroup' ? { ...current, zones } : current),
        'Assign zone',
      );
      return ASSIGNED;
    },

    setZoneSample: (programId, zoneIndex, sampleId) => {
      const program = get().programs[programId];
      if (program === undefined) return refuse('That program is no longer open.');
      if (program.type !== 'keygroup') {
        return refuse(`${program.name} is a drum program, so it has no zones.`);
      }
      if (program.zones[zoneIndex] === undefined) {
        return refuse(`${program.name} has no zone ${zoneIndex + 1}.`);
      }
      const zones = program.zones.map((zone, index) => (index === zoneIndex ? { ...zone, sampleId } : zone));
      get().updateProgram(
        programId,
        (current) => (current.type === 'keygroup' ? { ...current, zones } : current),
        'Assign zone',
      );
      return ASSIGNED;
    },

    removeKeygroupZone: (programId, zoneIndex) => {
      const program = get().programs[programId];
      if (program === undefined) return refuse('That program is no longer open.');
      if (program.type !== 'keygroup') {
        return refuse(`${program.name} is a drum program, so it has no zones.`);
      }
      if (program.zones[zoneIndex] === undefined) {
        return refuse(`${program.name} has no zone ${zoneIndex + 1}.`);
      }
      // The freed key range is left uncovered rather than absorbed by a neighbour: §6 lets a
      // keygroup leave keys silent on purpose, and the next assignment will take the gap.
      const zones = program.zones.filter((_, index) => index !== zoneIndex);
      get().updateProgram(
        programId,
        (current) => (current.type === 'keygroup' ? { ...current, zones } : current),
        'Remove zone',
      );
      return ASSIGNED;
    },

    /**
     * spec §4.1, §3.3 — a gesture moves the GRAPH and nothing else (issue #27).
     *
     * The mixer's `setTransient` records the same reasoning at length. The consequence here
     * is broader: `programs` is selected whole by `MainMode`, `MixerMode`, `MutingMode`,
     * `GridMode`, `PadPerformMode` and `ProgramEditPanel`, so a `set()` per pointer sample
     * re-rendered six modes' worth of subscribers to move one filter cutoff.
     */
    setPadParamTransient: (path, value) => {
      const resolved = resolvePadLeaf(get().programs, path, value);
      if (resolved === null) return;
      // The pre-gesture value, recorded the first time this path moves (spec §4.1). Read
      // from the store, which no longer moves during a gesture, so it stays pre-gesture
      // however many samples have already been sent.
      if (!padGestureOrigins.has(path)) padGestureOrigins.set(path, resolved.current);
      publishTransient(path, resolved.value);
      // spec §7.8: a gesture made while recording also writes automation — the same tap
      // the mixer's transient channel carries, for the pad-scope §10.3 Q-Link defaults.
      recordParamGesture(path, resolved.value, 'move', resolved.range);
    },

    commitPadParam: (path, value) => {
      const resolved = resolvePadLeaf(get().programs, path, value);
      if (resolved === null) return;
      const origin = padGestureOrigins.get(path) ?? resolved.current;
      padGestureOrigins.delete(path);
      // Publish before settling and before the store write, for the reason
      // `useMixerStore.commit` records: the committed value need not be where the gesture
      // left off, and the store diff cannot see a change the store never made.
      publishTransient(path, resolved.value);
      settleTransient(path);
      const write = (next: number) =>
        set((state) => ({
          programs: {
            ...state.programs,
            [resolved.programId]: withPad(
              state.programs[resolved.programId]!,
              resolved.padIndex,
              resolved.leaf,
              next,
            ),
          },
        }));
      // One gesture = one undo entry back to the pre-gesture origin (spec §3.3, §4.5).
      // Closes the recorded pass BEFORE the parameter's own commit, for the reason
      // `useMixerStore.commit` records: an unkeyed commit closes the pass's coalesce run.
      recordParamGesture(path, resolved.value, 'end', resolved.range);
      commit({
        label: 'Edit program parameter',
        apply: () => write(resolved.value),
        revert: () => write(origin),
        dirtyKeys: [dirtyKey.program(resolved.programId)],
      });
    },
  })),
);
