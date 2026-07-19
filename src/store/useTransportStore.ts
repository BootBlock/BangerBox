/**
 * useTransportStore — runtime transport & playback control (spec §4.2). Transport
 * actions are live performance state, never undoable and never autosaved (spec §4.5);
 * the scheduler worker is driven from here through the transport sync
 * subscriber (spec §4.3). The playhead tick lives in the scheduler SAB, not here —
 * this store keeps only a coarse bar:beat readout for accessible text (spec §4.2).
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { clamp, clampInt } from '@/core/math';
import { BPM_RANGE, LOOP_TICK_MIN, METRONOME_LEVEL_RANGE, SWING_RANGE } from '@/core/project/schemas';
import type { ArpConfig } from '@/core/sequencer';

export type RecordMode = 'overdub' | 'replace';
export type PlaybackMode = 'sequence' | 'song';
export type SwingDivision = 8 | 16;
export type CountInBars = 0 | 1 | 2;

export interface CoarsePosition {
  readonly bar: number;
  readonly beat: number;
}

interface TransportState {
  isPlaying: boolean;
  isRecording: boolean;
  countInBars: CountInBars;
  metronomeEnabled: boolean;
  metronomeLevel: number; // 0..1
  recordMode: RecordMode;
  playbackMode: PlaybackMode;
  activeSequenceId: string | null;
  bpm: number; // effective tempo (follows the active sequence, spec §7.9)
  swingAmount: number; // 50..75 (%)
  swingDivision: SwingDivision;
  loopEnabled: boolean;
  loopStartTick: number; // 960 PPQN
  loopEndTick: number;
  coarsePosition: CoarsePosition;
  /**
   * Arpeggiator on/off and its settings (spec §7.3). Live performance state, so it lives
   * here beside swing and the metronome rather than in the mode that edits it: the arp
   * keeps running while the user is in Grid or Pad Perform, and its settings have to
   * outlive Program Edit being unmounted (issue #55).
   */
  arpEnabled: boolean;
  arpConfig: ArpConfig;

  play: () => void;
  stop: () => void;
  /** Toggle record-arm; recording begins after the count-in on play (spec §7.7). */
  setRecording: (armed: boolean) => void;
  setBpm: (bpm: number) => void;
  setSwing: (amount: number, division?: SwingDivision) => void;
  setLoop: (loop: { enabled?: boolean; startTick?: number; endTick?: number }) => void;
  setMetronomeEnabled: (enabled: boolean) => void;
  setMetronomeLevel: (level: number) => void;
  setCountInBars: (bars: CountInBars) => void;
  setRecordMode: (mode: RecordMode) => void;
  setPlaybackMode: (mode: PlaybackMode) => void;
  setActiveSequenceId: (id: string | null) => void;
  setCoarsePosition: (position: CoarsePosition) => void;
  setArpEnabled: (enabled: boolean) => void;
  /** Patch the arp settings; omitted fields keep their current value (spec §7.3). */
  setArpConfig: (config: Partial<ArpConfig>) => void;
}

/** Spec §7.3 defaults: a 1/16 up-arp at half gate over a single octave. */
const DEFAULT_ARP_CONFIG: ArpConfig = {
  mode: 'up',
  octaves: 1,
  gate: 0.5,
  division: { value: 16, triplet: false },
};

export const useTransportStore = create<TransportState>()(
  subscribeWithSelector((set) => ({
    isPlaying: false,
    isRecording: false,
    countInBars: 0,
    metronomeEnabled: false,
    metronomeLevel: 0.8,
    recordMode: 'overdub',
    playbackMode: 'sequence',
    activeSequenceId: null,
    bpm: 120,
    swingAmount: 50,
    swingDivision: 16,
    loopEnabled: false,
    loopStartTick: 0,
    loopEndTick: 0,
    coarsePosition: { bar: 1, beat: 1 },
    arpEnabled: false,
    arpConfig: DEFAULT_ARP_CONFIG,

    play: () => set({ isPlaying: true }),
    // Stopping also disarms recording and returns the readout to the top (spec §4.2).
    stop: () => set({ isPlaying: false, isRecording: false, coarsePosition: { bar: 1, beat: 1 } }),
    setRecording: (armed) => set({ isRecording: armed }),

    setBpm: (bpm) => set({ bpm: clamp(bpm, BPM_RANGE[0], BPM_RANGE[1]) }),
    setSwing: (amount, division) =>
      set((state) => ({
        swingAmount: clamp(amount, SWING_RANGE[0], SWING_RANGE[1]),
        swingDivision: division ?? state.swingDivision,
      })),
    setLoop: (loop) =>
      set((state) => {
        const startTick = Math.max(LOOP_TICK_MIN, Math.floor(loop.startTick ?? state.loopStartTick));
        const endTick = Math.max(startTick, Math.floor(loop.endTick ?? state.loopEndTick));
        return {
          loopEnabled: loop.enabled ?? state.loopEnabled,
          loopStartTick: startTick,
          loopEndTick: endTick,
        };
      }),
    setMetronomeEnabled: (enabled) => set({ metronomeEnabled: enabled }),
    setMetronomeLevel: (level) =>
      set({ metronomeLevel: clamp(level, METRONOME_LEVEL_RANGE[0], METRONOME_LEVEL_RANGE[1]) }),
    setCountInBars: (bars) => set({ countInBars: bars }),
    setRecordMode: (recordMode) => set({ recordMode }),
    setPlaybackMode: (playbackMode) => set({ playbackMode }),
    setActiveSequenceId: (activeSequenceId) => set({ activeSequenceId }),
    setArpEnabled: (arpEnabled) => set({ arpEnabled }),
    // Clamped to the §7.3 ranges here rather than at the control, so a value arriving from
    // anywhere — a Q-Link, a restored session — is as safe as one typed into the field.
    setArpConfig: (config) =>
      set((state) => ({
        arpConfig: {
          ...state.arpConfig,
          ...config,
          ...(config.octaves !== undefined ? { octaves: clampInt(config.octaves, 1, 4) } : {}),
          ...(config.gate !== undefined ? { gate: clamp(config.gate, 0.05, 1) } : {}),
        },
      })),
    setCoarsePosition: (coarsePosition) =>
      set({
        coarsePosition: {
          bar: clampInt(coarsePosition.bar, 1, 9999),
          beat: clampInt(coarsePosition.beat, 1, 16),
        },
      }),
  })),
);
