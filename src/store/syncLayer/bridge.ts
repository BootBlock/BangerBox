/**
 * The sync-layer graph bridge (spec §4.3). The sync layer is the ONLY code allowed to
 * touch the audio graph in response to state (spec §3.1); it does so through this
 * interface. `core/audio/audioBridge` implements it over the real audio graph (spec §5),
 * applying `AudioParam` ramps; {@link noopBridge} is the inert implementation tests and
 * headless callers use.
 *
 * The transport and mode hooks are part of the interface but do nothing in the audio
 * bridge: the scheduler worker owns transport (spec §7.1.3) and `core/midi` owns Q-Link
 * mode, so those subscribers exist to keep the §4.3 surface complete, not to make sound.
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

  /**
   * Apply a registered §7.8 parameter address to the graph immediately. This is how
   * program-scope sound-design edits (a Program Edit knob, a pad-mode Q-Link encoder —
   * spec §10.3) reach the voices already sounding on that pad, since those parameters
   * live inside the voice rather than on a mixer channel (spec §6, §7.8).
   */
  applyParam: (targetPath: string, value: number) => void;
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
  applyParam: () => {},
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
