/**
 * The sync-layer graph bridge (spec §4.3). The sync layer is the ONLY code allowed to
 * touch the audio graph in response to state (spec §3.1); it does so through this
 * interface. Phase 2 shipped the skeleton — subscribers registered and diffing — against
 * a no-op bridge; Phase 3 implements the bridge over the real audio graph (spec §5),
 * applying `AudioParam` ramps. Transport methods stay effectively no-op for audio until
 * the scheduler worker arrives (Phase 4, spec §7.1.3).
 */
import type { InsertSlotState } from '@/core/project/schemas';

export interface SyncBridge {
  setChannelLevel: (channelId: string, level: number) => void;
  setChannelPan: (channelId: string, pan: number) => void;
  setChannelMute: (channelId: string, mute: boolean) => void;
  setChannelSolo: (channelId: string, solo: boolean) => void;
  /** One send tap level 0..1 to return `index` (spec §4.2 sendLevels). */
  setChannelSend: (channelId: string, index: number, level: number) => void;
  /** Rebuild a channel's serial insert chain from its slot state (spec §5.7). */
  setChannelInserts: (channelId: string, inserts: readonly InsertSlotState[]) => void;

  setTransportPlaying: (isPlaying: boolean) => void;
  setTransportRecording: (isRecording: boolean) => void;
  setBpm: (bpm: number) => void;

  onActiveProgramChanged: (programId: string | null) => void;
  onQLinkModeChanged: (mode: string) => void;
}

export type Unsubscribe = () => void;

/** No-op bridge used before the audio engine starts (spec §4.3). */
export const noopBridge: SyncBridge = {
  setChannelLevel: () => {},
  setChannelPan: () => {},
  setChannelMute: () => {},
  setChannelSolo: () => {},
  setChannelSend: () => {},
  setChannelInserts: () => {},
  setTransportPlaying: () => {},
  setTransportRecording: () => {},
  setBpm: () => {},
  onActiveProgramChanged: () => {},
  onQLinkModeChanged: () => {},
};

/** Combine several unsubscribers into one (idempotent). */
export function combineUnsubscribers(unsubs: readonly Unsubscribe[]): Unsubscribe {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const unsub of unsubs) unsub();
  };
}
