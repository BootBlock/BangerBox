/**
 * Node factory & channel lifecycle — spec §5.3. Typed constructors for the mixer
 * strips of the graph topology (spec §5.2): track channels, return channels, the master
 * bus, and per-pad channels. Each returns a handle whose `destroy()` disconnects every
 * node it created and cancels scheduled params (spec §3.2) — program change, pad clear,
 * and project close all route through these destroys.
 *
 * A strip is: input → [serial insert chain] → pan → fader(level) → mute → output.
 * Post-fader send taps (spec §5.2 stages 4/7) feed the return channels; returns and the
 * master carry no sends (spec §5.2 forbids return→return feedback structurally).
 */
import { faderLevelToGain } from './params/faderLaw';
import { rampParamLinear, rampParamTarget, setParamNow } from './params/ramps';
import type { InsertHandle } from './types';

/** Number of post-fader send taps on a full channel strip (spec §1.3.1: 4 returns). */
export const SEND_COUNT = 4;

export interface ChannelHandle {
  readonly id: string;
  /** Upstream (voices, pad channels, track outputs) connect here. */
  readonly input: AudioNode;
  /** Feeds the next stage of the graph (master input, or `destination`). */
  readonly output: AudioNode;
  /** Post-fader send taps → return inputs (empty for returns and master). */
  readonly sends: readonly GainNode[];
  /** Where a metering tap attaches (post-fader) — spec §5.8. */
  readonly meterPoint: AudioNode;

  /** Fader position 0..1.2 through the perceptual law (spec §8.5.6). */
  setLevel: (level: number, when: number, dezipper?: boolean) => void;
  /** Equal-power pan −1..1 via the native `StereoPannerNode` (spec §5.2). */
  setPan: (pan: number, when: number, dezipper?: boolean) => void;
  /** Computed mute (mute OR solo-in-place suppression) — spec §5.2. */
  setMuted: (muted: boolean, when: number) => void;
  /** Send tap gain 0..1 for return index (spec §4.2 sendLevels). */
  setSendGain: (index: number, gain: number, when: number, dezipper?: boolean) => void;
  /** Replace the serial insert chain (spec §5.7); disposes the previous chain. */
  setInserts: (inserts: readonly InsertHandle[]) => void;
  /** Aggregate reported insert latency for the PDC readout (spec §5.7.3). */
  insertLatencySamples: () => number;

  destroy: () => void;
}

interface StripOptions {
  readonly id: string;
  readonly sendCount: number;
}

function createChannelStrip(context: BaseAudioContext, { id, sendCount }: StripOptions): ChannelHandle {
  const input = context.createGain();
  const insertOut = context.createGain();
  const panner = context.createStereoPanner();
  const levelGain = context.createGain();
  const muteGain = context.createGain();
  const output = context.createGain();

  const now = context.currentTime;
  setParamNow(levelGain.gain, faderLevelToGain(1), now); // unity default (spec §4.2)
  setParamNow(muteGain.gain, 1, now);

  // input → [inserts] → insertOut → pan → level → mute → output. Empty chain: direct.
  input.connect(insertOut);
  insertOut.connect(panner);
  panner.connect(levelGain);
  levelGain.connect(muteGain);
  muteGain.connect(output);

  const sends: GainNode[] = [];
  for (let i = 0; i < sendCount; i++) {
    const send = context.createGain();
    setParamNow(send.gain, 0, now); // sends start closed (spec §4.2 default)
    output.connect(send); // post-fader tap
    sends.push(send);
  }

  let inserts: readonly InsertHandle[] = [];

  const setInserts = (next: readonly InsertHandle[]): void => {
    // Detach the current chain (or the direct passthrough) from `input` and `insertOut`.
    input.disconnect();
    for (const handle of inserts) {
      handle.output.disconnect();
      handle.destroy();
    }
    inserts = next;
    if (next.length === 0) {
      input.connect(insertOut);
    } else {
      input.connect(next[0]!.input);
      for (let i = 0; i < next.length - 1; i++) next[i]!.output.connect(next[i + 1]!.input);
      next[next.length - 1]!.output.connect(insertOut);
    }
  };

  return {
    id,
    input,
    output,
    sends,
    meterPoint: output,

    setLevel: (level, when, dezipper = true) => {
      const gain = faderLevelToGain(level);
      if (dezipper) rampParamLinear(levelGain.gain, gain, when);
      else setParamNow(levelGain.gain, gain, when);
    },
    setPan: (pan, when, dezipper = true) => {
      if (dezipper) rampParamTarget(panner.pan, pan, when);
      else setParamNow(panner.pan, pan, when);
    },
    setMuted: (muted, when) => {
      // A short linear ramp to 0/1 avoids a click on mute toggles (spec §4.3).
      rampParamLinear(muteGain.gain, muted ? 0 : 1, when);
    },
    setSendGain: (index, gain, when, dezipper = true) => {
      const send = sends[index];
      if (send === undefined) return;
      if (dezipper) rampParamLinear(send.gain, gain, when);
      else setParamNow(send.gain, gain, when);
    },
    setInserts,
    insertLatencySamples: () => inserts.reduce((total, h) => total + h.latencySamples, 0),

    destroy: () => {
      setInserts([]); // disposes any live insert handles
      input.disconnect();
      insertOut.disconnect();
      panner.disconnect();
      levelGain.disconnect();
      muteGain.disconnect();
      output.disconnect();
      for (const send of sends) send.disconnect();
    },
  };
}

/** A track group channel (spec §5.2 stages 5–7): pad outputs merge in; 4 sends. */
export function createTrackChannel(context: BaseAudioContext, trackId: string): ChannelHandle {
  return createChannelStrip(context, { id: `track:${trackId}`, sendCount: SEND_COUNT });
}

/** A per-pad channel (spec §5.2 stages 3–4): voice DSP merges in; 4 sends → returns. */
export function createPadChannel(context: BaseAudioContext, channelId: string): ChannelHandle {
  return createChannelStrip(context, { id: channelId, sendCount: SEND_COUNT });
}

/** A return channel (spec §5.2): fed by sends, no sends of its own (feedback-safe). */
export function createReturnChannel(context: BaseAudioContext, index: number): ChannelHandle {
  return createChannelStrip(context, { id: `return:${index}`, sendCount: 0 });
}

/** The master bus (spec §5.2 stages 8–10): all tracks + returns merge; master inserts. */
export function createMasterBus(context: BaseAudioContext): ChannelHandle {
  return createChannelStrip(context, { id: 'master', sendCount: 0 });
}
