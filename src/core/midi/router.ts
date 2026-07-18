/**
 * MIDI message router — spec §10.2. Parsed messages land here and are dispatched by kind,
 * each along the route the spec mandates:
 *
 *  - **Notes** take the §7.6 dual path — immediate audition plus worker delivery for note
 *    repeat and record capture. That path already exists as `AudioEngine.triggerLiveNote`,
 *    which is what this calls: BLE input joins the existing two legs rather than adding a
 *    third. Recording timestamps carry the §10.2 input-latency offset.
 *  - **Pitch bend** applies to the active keygroup program's sounding voices as per-voice
 *    detune, scaled by that program's `pitchBendRange` (§6). Drum programs ignore it. Like
 *    note audition this is a voice-pool path, not a store mutation (spec §10.2).
 *  - **Control Change** goes through the §10.4 throttle and then to the Q-Link runtime,
 *    which dispatches it to a *store action* — never to the graph (spec §10.2, binding).
 *
 * Dependencies are injected so the routing rules are testable without an engine or a
 * store (spec §11.3).
 */
import { createCcThrottle, type CcThrottle } from './ccThrottle';
import type { MidiMessage } from './parser';

/** Cents per semitone — `AudioBufferSourceNode.detune` is expressed in cents. */
const CENTS_PER_SEMITONE = 100;

/** The active keygroup program a bend applies to, with its §6 bend depth. */
export interface ActiveKeygroup {
  readonly programId: string;
  readonly pitchBendRange: number;
}

export interface MidiRouterDeps {
  /** The §7.6 dual path. `timestampMs` is already latency-compensated (spec §10.2). */
  readonly triggerLiveNote: (note: number, velocity: number, on: boolean, timestampMs: number) => void;
  /** Per-voice detune, in cents, for every sounding voice of the program (spec §10.2). */
  readonly applyPitchBend: (programId: string, cents: number) => void;
  /** Throttled CC delivery into the Q-Link runtime (spec §10.3). */
  readonly handleControlChange: (cc: number, value: number) => void;
  /** The §10.2 input-latency offset, read live so the setting takes effect immediately. */
  readonly inputLatencyMs: () => number;
  /** The keygroup program bend applies to, or null when a drum program is active. */
  readonly activeKeygroup: () => ActiveKeygroup | null;
  readonly now?: () => number;
  readonly scheduleFrame?: (callback: () => void) => void;
}

export interface MidiRouter {
  route: (messages: readonly MidiMessage[]) => void;
  /** Drop throttle state — used on disconnect/reconnect (spec §10.4). */
  reset: () => void;
}

/**
 * Pitch bend is coalesced through the same §10.4 throttle as CC, but its value is 14-bit,
 * where a single step is not pot dither — so the hysteresis gate is opened right up.
 */
const PITCH_BEND_KEY = -1;
const PITCH_BEND_RAW_MAX = 16_383;

export function createMidiRouter(deps: MidiRouterDeps): MidiRouter {
  const throttleOptions = {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.scheduleFrame ? { schedule: deps.scheduleFrame } : {}),
  };

  const ccThrottle: CcThrottle = createCcThrottle(
    (cc, value) => deps.handleControlChange(cc, value),
    throttleOptions,
  );

  // Bend rides its own throttle so a stream of bend messages cannot starve the CC
  // coalescing (and vice versa) — they share a value space otherwise.
  const bendThrottle: CcThrottle = createCcThrottle(
    (_key, raw) => {
      const keygroup = deps.activeKeygroup();
      if (!keygroup) return;
      // Reconstruct the normalised bend, then scale by the program's §6 bend depth.
      const normalised = raw === 8_192 ? 0 : raw > 8_192 ? (raw - 8_192) / 8_191 : (raw - 8_192) / 8_192;
      deps.applyPitchBend(keygroup.programId, normalised * keygroup.pitchBendRange * CENTS_PER_SEMITONE);
    },
    { ...throttleOptions, hysteresisSteps: 0, endpoints: [0, PITCH_BEND_RAW_MAX] },
  );

  return {
    route(messages) {
      for (const message of messages) {
        switch (message.kind) {
          case 'noteOn':
          case 'noteOff': {
            // Notes are never throttled — every hit must sound (spec §7.6, §11.5 latency).
            const timestampMs = message.timestampMs - deps.inputLatencyMs();
            deps.triggerLiveNote(message.note, message.velocity, message.kind === 'noteOn', timestampMs);
            break;
          }
          case 'pitchBend':
            // Drum programs ignore pitch bend entirely (spec §10.2); the check happens on
            // apply so a program change between message and frame is respected.
            if (deps.activeKeygroup()) bendThrottle.push(PITCH_BEND_KEY, message.raw);
            break;
          case 'controlChange':
            ccThrottle.push(message.controller, message.value);
            break;
        }
      }
    },

    reset() {
      ccThrottle.reset();
      bendThrottle.reset();
    },
  };
}
