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
import { parseParamTarget, targetRange } from '@/core/audio/params/registry';
import { commit } from './commit';
import { useProjectStore } from './useProjectStore';

interface MixerState {
  channels: Record<string, ChannelStrip>;

  /** Replace every strip on project load (spec §4.4). */
  setChannels: (channels: Record<string, ChannelStrip>) => void;
  /** Upsert one strip (hydration / channel creation). */
  upsertChannel: (strip: ChannelStrip) => void;

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
}

const SEND_PATH = /\.sendLevels\.([0-3])$/;

/**
 * Parse a parameter address into the strip field it addresses.
 *
 * The canonical grammar is the §7.8 registry's (`mixer.<channelId>.level`,
 * `insert:<channelId>:slot<N>.<param>`), and it is parsed by the registry itself so the
 * grammar has exactly one owner (spec §13.6 naming freeze). The bare `<channelId>.<field>`
 * form is also accepted: it predates the registry and is still used where the channel is
 * already in hand. Insert ranges depend on the effect in the slot, so the strip is needed
 * to resolve them (spec §5.7).
 */
function parseMixerPath(path: string, strip: ChannelStrip | undefined): ParsedPath | null {
  const target = parseParamTarget(path);
  if (target !== null) {
    switch (target.kind) {
      case 'channelLevel':
        return { channelId: target.channelId, field: { kind: 'level' }, range: LEVEL_RANGE };
      case 'channelPan':
        return { channelId: target.channelId, field: { kind: 'pan' }, range: PAN_RANGE };
      case 'channelSend':
        return {
          channelId: target.channelId,
          field: { kind: 'send', index: target.sendIndex as 0 | 1 | 2 | 3 },
          range: SEND_LEVEL_RANGE,
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
    return {
      channelId: path.slice(0, send.index),
      field: { kind: 'send', index: Number(send[1]) as 0 | 1 | 2 | 3 },
      range: SEND_LEVEL_RANGE,
    };
  }
  if (path.endsWith('.level')) {
    return { channelId: path.slice(0, -6), field: { kind: 'level' }, range: LEVEL_RANGE };
  }
  if (path.endsWith('.pan')) {
    return { channelId: path.slice(0, -4), field: { kind: 'pan' }, range: PAN_RANGE };
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

    setTransient: (path, value) => {
      const channels = get().channels;
      const parsed = resolvePath(channels, path);
      if (parsed === null) return;
      const current = readScalar(channels, parsed);
      if (current === null) return;
      // Record the pre-gesture value the first time this path moves (spec §4.1).
      if (!gestureOrigins.has(path)) gestureOrigins.set(path, current);
      const clamped = clamp(value, parsed.range[0], parsed.range[1]);
      set((state) => ({
        channels: {
          ...state.channels,
          [parsed.channelId]: writeScalar(state.channels[parsed.channelId]!, parsed.field, clamped),
        },
      }));
    },

    commit: (path, value) => {
      const channels = get().channels;
      const parsed = resolvePath(channels, path);
      if (parsed === null) return;
      const current = readScalar(channels, parsed);
      if (current === null) return;
      const origin = gestureOrigins.get(path) ?? current;
      gestureOrigins.delete(path);
      const clamped = clamp(value, parsed.range[0], parsed.range[1]);
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
