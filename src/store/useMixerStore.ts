/**
 * useMixerStore — per-channel strip state (spec §4.2): pads of the active program,
 * tracks, the 4 returns, and master. Home of the transient/commit channel (spec §4.1):
 * a fader/knob drag streams `setTransient` updates (graph moves, no undo/autosave),
 * then a single `commit` on release records one undo entry back to the pre-gesture
 * value (spec §3.3) and marks the owning entity dirty (spec §4.4). Solo is stored as a
 * flag here and evaluated as computed mutes in the sync layer (spec §5.2).
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { clamp } from '@/core/math';
import { dirtyKey } from '@/core/project/dirty';
import {
  createEmptyInsertSlot,
  LEVEL_RANGE,
  PAN_RANGE,
  SEND_LEVEL_RANGE,
  type ChannelStrip,
  type EffectType,
  type InsertSlotState,
  type Range,
} from '@/core/project/schemas';
import {
  channelLevelPath,
  channelPanPath,
  channelSendPath,
  parseParamTarget,
  targetRange,
} from '@/core/audio/params/registry';
import { recordParamGesture } from './automationRecord';
import { publishTransient, settleTransient } from './transientChannel';
import { commit } from './commit';
import { useProjectStore } from './useProjectStore';

interface MixerState {
  channels: Record<string, ChannelStrip>;

  /** Replace every strip on project load (spec §4.4). */
  setChannels: (channels: Record<string, ChannelStrip>) => void;
  /** Upsert one strip (hydration / channel creation). */
  upsertChannel: (strip: ChannelStrip) => void;
  /**
   * Drop one strip (track delete). Not undoable in its own right: the strip's existence
   * follows its track, so the track's own undo entry is what restores it (spec §4.5).
   */
  removeChannel: (channelId: string) => void;

  /** Continuous-gesture update: graph moves, no undo/autosave (spec §4.1). */
  setTransient: (path: string, value: number) => void;
  /** Gesture end: one undo entry to the pre-gesture value + autosave (spec §4.1, §3.3). */
  commit: (path: string, value: number) => void;

  setMute: (channelId: string, mute: boolean) => void;
  setSolo: (channelId: string, solo: boolean) => void;

  addInsert: (channelId: string, effectType: EffectType) => void;
  /** Swap the effect in one slot, keeping its chain position (spec §8.5.6). */
  replaceInsert: (channelId: string, slotId: string, effectType: EffectType) => void;
  removeInsert: (channelId: string, slotId: string) => void;
  setInsertEnabled: (channelId: string, slotId: string, enabled: boolean) => void;
}

/** Pre-gesture origin per transient path — module-level so it never triggers re-renders. */
const gestureOrigins = new Map<string, number>();

type ScalarField =
  | { readonly kind: 'level' }
  | { readonly kind: 'pan' }
  | { readonly kind: 'send'; readonly index: 0 | 1 | 2 | 3 }
  | { readonly kind: 'insertParam'; readonly slotIndex: number; readonly param: string };

interface ParsedPath {
  readonly channelId: string;
  readonly field: ScalarField;
  readonly range: Range;
  /**
   * The §7.8 registry address for this field, whatever form the caller wrote.
   *
   * The transient channel and the §4.3 sync layer behind it apply an address through the
   * registry's own parser, so a legacy `<channelId>.<field>` path has to be rewritten before
   * it is published or it would reach the graph as nothing at all (issue #27).
   */
  readonly canonicalPath: string;
}

const SEND_PATH = /\.sendLevels\.([0-3])$/;

/**
 * Parse a parameter address into the strip field it addresses.
 *
 * The canonical grammar is the §7.8 registry's (`mixer.<channelId>.level`,
 * `insert:<channelId>:slot<N>.<param>`), and it is parsed by the registry itself so the
 * grammar has exactly one owner (spec §13.6 naming freeze). The bare `<channelId>.<field>`
 * form is also accepted: it predates the registry, and a persisted Q-Link binding or an
 * imported project may still carry one. No surface in the application writes it any more —
 * the last, `AudioEnginePanel`'s master fader, moved to the canonical form because only
 * that parses through the registry and so only that records automation (spec §7.8).
 * Insert ranges depend on the effect in the slot, so the strip is needed to resolve them
 * (spec §5.7).
 */
function parseMixerPath(path: string, strip: ChannelStrip | undefined): ParsedPath | null {
  const target = parseParamTarget(path);
  if (target !== null) {
    switch (target.kind) {
      case 'channelLevel':
        return {
          channelId: target.channelId,
          field: { kind: 'level' },
          range: LEVEL_RANGE,
          canonicalPath: path,
        };
      case 'channelPan':
        return {
          channelId: target.channelId,
          field: { kind: 'pan' },
          range: PAN_RANGE,
          canonicalPath: path,
        };
      case 'channelSend':
        return {
          channelId: target.channelId,
          field: { kind: 'send', index: target.sendIndex as 0 | 1 | 2 | 3 },
          range: SEND_LEVEL_RANGE,
          canonicalPath: path,
        };
      case 'insertParam': {
        // Slots are addressed 1-based in the registry grammar (spec §7.8 `slot2`).
        const slotIndex = target.slot - 1;
        const slot = strip?.inserts[slotIndex];
        if (!slot?.effectType) return null;
        const range = targetRange(target, slot.effectType);
        if (range === null) return null;
        return {
          channelId: target.channelId,
          field: { kind: 'insertParam', slotIndex, param: target.param },
          range,
          canonicalPath: path,
        };
      }
      case 'programParam':
      case 'transportParam':
        // Program sound design and transport globals belong to their own stores (§4.2).
        return null;
    }
  }

  const send = SEND_PATH.exec(path);
  if (send) {
    const channelId = path.slice(0, send.index);
    const index = Number(send[1]) as 0 | 1 | 2 | 3;
    return {
      channelId,
      field: { kind: 'send', index },
      range: SEND_LEVEL_RANGE,
      canonicalPath: channelSendPath(channelId, index),
    };
  }
  if (path.endsWith('.level')) {
    const channelId = path.slice(0, -6);
    return {
      channelId,
      field: { kind: 'level' },
      range: LEVEL_RANGE,
      canonicalPath: channelLevelPath(channelId),
    };
  }
  if (path.endsWith('.pan')) {
    const channelId = path.slice(0, -4);
    return {
      channelId,
      field: { kind: 'pan' },
      range: PAN_RANGE,
      canonicalPath: channelPanPath(channelId),
    };
  }
  return null;
}

/** The channel a path addresses, before the strip is known (insert ranges need the strip). */
function channelIdOf(path: string): string | null {
  const target = parseParamTarget(path);
  if (target !== null) {
    // Program and transport addresses are other stores' concerns (spec §4.2 ownership).
    if (target.kind === 'programParam' || target.kind === 'transportParam') return null;
    return target.channelId;
  }
  const send = SEND_PATH.exec(path);
  if (send) return path.slice(0, send.index);
  if (path.endsWith('.level')) return path.slice(0, -6);
  if (path.endsWith('.pan')) return path.slice(0, -4);
  return null;
}

/**
 * The §7.8 address a path settles under, WITHOUT needing the strip (issue #27).
 *
 * `parseMixerPath` needs the strip to resolve an insert parameter's range, so it returns null
 * once the slot's effect changes — but a gesture that already published still has an overlay
 * entry under this address, and `commit` has to be able to clear it either way.
 */
function canonicalPathOf(path: string): string | null {
  if (parseParamTarget(path) !== null) return path;
  const send = SEND_PATH.exec(path);
  if (send) return channelSendPath(path.slice(0, send.index), Number(send[1]));
  if (path.endsWith('.level')) return channelLevelPath(path.slice(0, -6));
  if (path.endsWith('.pan')) return channelPanPath(path.slice(0, -4));
  return null;
}

/** Resolve a path against the live channel map, or null when it addresses nothing. */
function resolvePath(channels: Record<string, ChannelStrip>, path: string): ParsedPath | null {
  const channelId = channelIdOf(path);
  if (channelId === null) return null;
  return parseMixerPath(path, channels[channelId]);
}

/** Read the current scalar at a parsed path, or null when the channel is absent. */
function readScalar(channels: Record<string, ChannelStrip>, parsed: ParsedPath): number | null {
  const strip = channels[parsed.channelId];
  if (strip === undefined) return null;
  if (parsed.field.kind === 'level') return strip.level;
  if (parsed.field.kind === 'pan') return strip.pan;
  if (parsed.field.kind === 'send') return strip.sendLevels[parsed.field.index] ?? null;
  const slot = strip.inserts[parsed.field.slotIndex];
  if (slot === undefined) return null;
  // An unset param reads as the bottom of its range so the first move has an origin.
  return slot.params[parsed.field.param] ?? parsed.range[0];
}

/** Return a strip with one scalar replaced (immutably). */
function writeScalar(strip: ChannelStrip, field: ScalarField, value: number): ChannelStrip {
  if (field.kind === 'level') return { ...strip, level: value };
  if (field.kind === 'pan') return { ...strip, pan: value };
  if (field.kind === 'send') {
    const sendLevels = [...strip.sendLevels] as ChannelStrip['sendLevels'];
    sendLevels[field.index] = value;
    return { ...strip, sendLevels };
  }
  // A new inserts array identity is what the §4.3 sync layer diffs on to push params.
  const inserts = strip.inserts.map((slot, index) =>
    index === field.slotIndex ? { ...slot, params: { ...slot.params, [field.param]: value } } : slot,
  );
  return { ...strip, inserts };
}

/** Map a channel id to the entity whose persistence owns its strip (spec §5.2, §9.3). */
function mixerChannelDirtyKey(channelId: string): string {
  if (channelId.startsWith('track:')) return dirtyKey.track(channelId.slice('track:'.length));
  if (channelId.startsWith('pad:')) return dirtyKey.program(channelId.split(':')[1] ?? '');
  // master + returns persist in the project payload (spec §9.3 projects.payload).
  return dirtyKey.project(useProjectStore.getState().projectId);
}

export const useMixerStore = create<MixerState>()(
  subscribeWithSelector((set, get) => ({
    channels: {},

    setChannels: (channels) => set({ channels: { ...channels } }),
    upsertChannel: (strip) => set((state) => ({ channels: { ...state.channels, [strip.id]: strip } })),
    removeChannel: (channelId) =>
      set((state) => {
        if (!(channelId in state.channels)) return {};
        const channels = { ...state.channels };
        delete channels[channelId];
        return { channels };
      }),

    /**
     * spec §4.1, §3.3 — a gesture moves the GRAPH and nothing else (issue #27).
     *
     * This deliberately does not `set()`. Doing so replaced the `channels` map's identity on
     * every pointer sample and every rAF-aligned CC frame, re-rendering `MixerMode`,
     * `MutingMode`, `XyfxMode` and `QLinkEditMode` about sixty times a second — exactly what
     * §3.3 forbids a mid-gesture value from causing. The value reaches the graph through the
     * transient channel instead, and React sees it at the commit.
     */
    setTransient: (path, value) => {
      const channels = get().channels;
      const parsed = resolvePath(channels, path);
      if (parsed === null) return;
      const current = readScalar(channels, parsed);
      if (current === null) return;
      // The pre-gesture value, recorded the first time this path moves (spec §4.1). It is
      // read from the store, which no longer moves during a gesture — so it is still the
      // pre-gesture value however many samples the gesture has already sent.
      if (!gestureOrigins.has(parsed.canonicalPath)) gestureOrigins.set(parsed.canonicalPath, current);
      const clamped = clamp(value, parsed.range[0], parsed.range[1]);
      publishTransient(parsed.canonicalPath, clamped);
      // spec §7.8: a gesture made while recording also writes automation. The tap is here
      // rather than in each mode because Q-Link, XYFX and every on-screen knob and fader
      // reach the graph through this one action. The range comes from the parse that
      // already clamped the value — the recorder scales its epsilon by it.
      recordParamGesture(path, clamped, 'move', parsed.range);
    },

    commit: (path, value) => {
      // Settle FIRST, whatever happens below (issue #27). Replacing a slot's effect inside
      // the §10.3 idle window makes an insert address stop resolving, and an early return
      // would leave the overlay answering for it forever — so the next relative encoder turn
      // would step from an abandoned value and a later undo would revert to one the
      // parameter never held.
      const settlePath = canonicalPathOf(path);
      if (settlePath !== null) {
        settleTransient(settlePath);
        gestureOrigins.delete(settlePath);
      }
      const channels = get().channels;
      const parsed = resolvePath(channels, path);
      if (parsed === null) return;
      const current = readScalar(channels, parsed);
      if (current === null) return;
      const origin = gestureOrigins.get(parsed.canonicalPath) ?? current;
      gestureOrigins.delete(parsed.canonicalPath);
      const clamped = clamp(value, parsed.range[0], parsed.range[1]);
      // Publish the committed value explicitly (issue #27). It is not always where the
      // gesture left off — XYFX's release-return commits where the axes RESTED — and the
      // store diff below cannot correct that, because the store never moved during the
      // gesture and so has no change to apply. Settled again: a publish writes the overlay.
      publishTransient(parsed.canonicalPath, clamped);
      settleTransient(parsed.canonicalPath);
      const write = (v: number) =>
        set((state) => ({
          channels: {
            ...state.channels,
            [parsed.channelId]: writeScalar(state.channels[parsed.channelId]!, parsed.field, v),
          },
        }));
      // One commit = one undo entry (revert to the pre-gesture origin). The gesture's
      // many transient updates already coalesced into this single commit (spec §3.3),
      // so no stack-level coalesceKey is used here — two separate drags stay distinct.
      // The released value closes the recorded pass on this lane (spec §7.8) — BEFORE the
      // parameter's own commit, never after. The pass coalesces its points under one key,
      // and the unkeyed commit below closes that run; sealing afterwards would leave the
      // closing point stranded as a third undo entry (spec §3.3).
      recordParamGesture(path, clamped, 'end', parsed.range);
      commit({
        label: 'Set mixer level',
        apply: () => write(clamped),
        revert: () => write(origin),
        dirtyKeys: [mixerChannelDirtyKey(parsed.channelId)],
      });
    },

    setMute: (channelId, mute) => {
      const prev = get().channels[channelId];
      if (prev === undefined || prev.mute === mute) return;
      const write = (value: boolean) =>
        set((state) => ({
          channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, mute: value } },
        }));
      commit({
        label: mute ? 'Mute channel' : 'Unmute channel',
        apply: () => write(mute),
        revert: () => write(prev.mute),
        dirtyKeys: [mixerChannelDirtyKey(channelId)],
      });
    },

    setSolo: (channelId, solo) => {
      const prev = get().channels[channelId];
      if (prev === undefined || prev.solo === solo) return;
      const write = (value: boolean) =>
        set((state) => ({
          channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, solo: value } },
        }));
      commit({
        label: solo ? 'Solo channel' : 'Unsolo channel',
        apply: () => write(solo),
        revert: () => write(prev.solo),
        dirtyKeys: [mixerChannelDirtyKey(channelId)],
      });
    },

    addInsert: (channelId, effectType) => {
      const prev = get().channels[channelId];
      if (prev === undefined) return;
      const slot: InsertSlotState = { ...createEmptyInsertSlot(), effectType, enabled: true };
      const write = (inserts: InsertSlotState[]) =>
        set((state) => ({
          channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, inserts } },
        }));
      commit({
        label: 'Add insert',
        apply: () => write([...prev.inserts, slot]),
        revert: () => write(prev.inserts),
        dirtyKeys: [mixerChannelDirtyKey(channelId)],
      });
    },

    replaceInsert: (channelId, slotId, effectType) => {
      const prev = get().channels[channelId];
      if (prev === undefined) return;
      const target = prev.inserts.find((slot) => slot.id === slotId);
      if (target === undefined || target.effectType === effectType) return;
      const write = (inserts: InsertSlotState[]) =>
        set((state) => ({
          channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, inserts } },
        }));
      // The slot keeps its id — the id is the slot's handle (React key, the id callers pass
      // back to remove/bypass), and a new one would read as a remove-then-add. Nothing in the
      // audio graph or the §7.8 addresses depends on it: the graph rebuilds the whole serial
      // chain from slot state on any `inserts` identity change, and insert addresses key off
      // slot *index*, so the replaced effect's DSP node is built fresh and Q-Link stays bound.
      const replaced = prev.inserts.map((slot) =>
        slot.id === slotId
          ? {
              ...slot,
              effectType,
              // Params start empty, exactly as `addInsert` leaves a fresh slot: each effect owns
              // its own parameter set (spec §5.7), so the outgoing values have no meaning here —
              // and a name two effects happen to share would import the old effect's taste unseen.
              params: {},
              // Bypass belongs to the slot's place in the chain, not to the effect, so a slot the
              // user muted stays muted. Filling a previously empty slot is an add in disguise and
              // comes up enabled, or picking an effect there would do nothing audible.
              enabled: slot.effectType === null ? true : slot.enabled,
            }
          : slot,
      );
      commit({
        label: 'Replace insert',
        apply: () => write(replaced),
        revert: () => write(prev.inserts),
        dirtyKeys: [mixerChannelDirtyKey(channelId)],
      });
    },

    removeInsert: (channelId, slotId) => {
      const prev = get().channels[channelId];
      if (prev === undefined) return;
      const write = (inserts: InsertSlotState[]) =>
        set((state) => ({
          channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, inserts } },
        }));
      commit({
        label: 'Remove insert',
        apply: () => write(prev.inserts.filter((slot) => slot.id !== slotId)),
        revert: () => write(prev.inserts),
        dirtyKeys: [mixerChannelDirtyKey(channelId)],
      });
    },

    setInsertEnabled: (channelId, slotId, enabled) => {
      const prev = get().channels[channelId];
      if (prev === undefined) return;
      const write = (inserts: InsertSlotState[]) =>
        set((state) => ({
          channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, inserts } },
        }));
      const toggled = prev.inserts.map((slot) => (slot.id === slotId ? { ...slot, enabled } : slot));
      commit({
        label: enabled ? 'Enable insert' : 'Bypass insert',
        apply: () => write(toggled),
        revert: () => write(prev.inserts),
        dirtyKeys: [mixerChannelDirtyKey(channelId)],
      });
    },
  })),
);
