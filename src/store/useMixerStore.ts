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
  removeInsert: (channelId: string, slotId: string) => void;
  setInsertEnabled: (channelId: string, slotId: string, enabled: boolean) => void;
}

/** Pre-gesture origin per transient path — module-level so it never triggers re-renders. */
const gestureOrigins = new Map<string, number>();

type ScalarField =
  | { readonly kind: 'level' }
  | { readonly kind: 'pan' }
  | { readonly kind: 'send'; readonly index: 0 | 1 | 2 | 3 };

interface ParsedPath {
  readonly channelId: string;
  readonly field: ScalarField;
  readonly range: Range;
}

const SEND_PATH = /\.sendLevels\.([0-3])$/;

/** Parse a mixer parameter address `<channelId>.<field>` (spec §7.8 addressing style). */
function parseMixerPath(path: string): ParsedPath | null {
  const send = SEND_PATH.exec(path);
  if (send) {
    return {
      channelId: path.slice(0, send.index),
      field: { kind: 'send', index: Number(send[1]) as 0 | 1 | 2 | 3 },
      range: SEND_LEVEL_RANGE,
    };
  }
  if (path.endsWith('.level')) return { channelId: path.slice(0, -6), field: { kind: 'level' }, range: LEVEL_RANGE };
  if (path.endsWith('.pan')) return { channelId: path.slice(0, -4), field: { kind: 'pan' }, range: PAN_RANGE };
  return null;
}

/** Read the current scalar at a parsed path, or null when the channel is absent. */
function readScalar(channels: Record<string, ChannelStrip>, parsed: ParsedPath): number | null {
  const strip = channels[parsed.channelId];
  if (strip === undefined) return null;
  if (parsed.field.kind === 'level') return strip.level;
  if (parsed.field.kind === 'pan') return strip.pan;
  return strip.sendLevels[parsed.field.index] ?? null;
}

/** Return a strip with one scalar replaced (immutably). */
function writeScalar(strip: ChannelStrip, field: ScalarField, value: number): ChannelStrip {
  if (field.kind === 'level') return { ...strip, level: value };
  if (field.kind === 'pan') return { ...strip, pan: value };
  const sendLevels = [...strip.sendLevels] as ChannelStrip['sendLevels'];
  sendLevels[field.index] = value;
  return { ...strip, sendLevels };
}

/** Map a channel id to the entity whose persistence owns its strip (spec §5.2, §9.3). */
export function mixerChannelDirtyKey(channelId: string): string {
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
      const parsed = parseMixerPath(path);
      if (parsed === null) return;
      const channels = get().channels;
      const current = readScalar(channels, parsed);
      if (current === null) return;
      // Record the pre-gesture value the first time this path moves (spec §4.1).
      if (!gestureOrigins.has(path)) gestureOrigins.set(path, current);
      const clamped = clamp(value, parsed.range[0], parsed.range[1]);
      set((state) => ({
        channels: { ...state.channels, [parsed.channelId]: writeScalar(state.channels[parsed.channelId]!, parsed.field, clamped) },
      }));
    },

    commit: (path, value) => {
      const parsed = parseMixerPath(path);
      if (parsed === null) return;
      const channels = get().channels;
      const current = readScalar(channels, parsed);
      if (current === null) return;
      const origin = gestureOrigins.get(path) ?? current;
      gestureOrigins.delete(path);
      const clamped = clamp(value, parsed.range[0], parsed.range[1]);
      const write = (v: number) =>
        set((state) => ({
          channels: { ...state.channels, [parsed.channelId]: writeScalar(state.channels[parsed.channelId]!, parsed.field, v) },
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
        set((state) => ({ channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, mute: value } } }));
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
        set((state) => ({ channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, solo: value } } }));
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
        set((state) => ({ channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, inserts } } }));
      commit({
        label: 'Add insert',
        apply: () => write([...prev.inserts, slot]),
        revert: () => write(prev.inserts),
        dirtyKeys: [mixerChannelDirtyKey(channelId)],
      });
    },

    removeInsert: (channelId, slotId) => {
      const prev = get().channels[channelId];
      if (prev === undefined) return;
      const write = (inserts: InsertSlotState[]) =>
        set((state) => ({ channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, inserts } } }));
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
        set((state) => ({ channels: { ...state.channels, [channelId]: { ...state.channels[channelId]!, inserts } } }));
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
