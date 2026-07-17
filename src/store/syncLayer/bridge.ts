/**
 * The sync-layer graph bridge (spec §4.3). The sync layer is the ONLY code allowed to
 * touch the audio graph in response to state (spec §3.1); it does so through this
 * interface. Phase 2 ships the skeleton — subscribers registered and diffing — against
 * a no-op bridge; Phase 3 implements the bridge over the real audio graph (spec §5),
 * applying `AudioParam` ramps and forwarding transport changes to the scheduler worker.
 */
export interface SyncBridge {
  setChannelLevel: (channelId: string, level: number) => void;
  setChannelPan: (channelId: string, pan: number) => void;
  setChannelMute: (channelId: string, mute: boolean) => void;
  setChannelSolo: (channelId: string, solo: boolean) => void;

  setTransportPlaying: (isPlaying: boolean) => void;
  setTransportRecording: (isRecording: boolean) => void;
  setBpm: (bpm: number) => void;

  onActiveProgramChanged: (programId: string | null) => void;
  onQLinkModeChanged: (mode: string) => void;
}

export type Unsubscribe = () => void;

/** No-op bridge used until Phase 3 wires the real graph (spec §4.3). */
export const noopBridge: SyncBridge = {
  setChannelLevel: () => {},
  setChannelPan: () => {},
  setChannelMute: () => {},
  setChannelSolo: () => {},
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
