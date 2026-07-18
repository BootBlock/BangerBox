/**
 * Canonical parameter bounds (spec §4.2, §6, §7). Declared once and shared by both
 * the Zod schemas (reject out-of-range payloads at the load/import boundary) and the
 * store action clamps (coerce live input into range — spec §4.1), so a value can
 * never mean one thing to validation and another to a setter.
 *
 * Each bound is `readonly [min, max]`. Naming/values are binding (spec §13.6).
 */
export type Range = readonly [min: number, max: number];

// --- Mixer channel strip (spec §4.2 ChannelStrip) --------------------------------
/** Fader law input; perceptual mapping to dB is the mixer's concern (spec §8.5.6). */
export const LEVEL_RANGE: Range = [0, 1.2];
export const PAN_RANGE: Range = [-1, 1];
export const SEND_LEVEL_RANGE: Range = [0, 1];

// --- Transport (spec §4.2 TransportState) ----------------------------------------
export const BPM_RANGE: Range = [20, 300];
/** Classic MPC swing, per cent (spec §7.4). */
export const SWING_RANGE: Range = [50, 75];
export const METRONOME_LEVEL_RANGE: Range = [0, 1];
export const LOOP_TICK_MIN = 0;

// --- Sequence / time signature (spec §7.2, §9.3) ---------------------------------
export const LENGTH_BARS_RANGE: Range = [1, 999];
export const TIME_SIG_NUMERATOR_RANGE: Range = [1, 16];
/** Denominator is one of 2/4/8/16 (spec §7.2). */
export const TIME_SIG_DENOMINATORS = [2, 4, 8, 16] as const;

// --- MIDI event (spec §9.3 midi_events) ------------------------------------------
export const NOTE_RANGE: Range = [0, 127];
export const VELOCITY_RANGE: Range = [1, 127];
export const TICK_MIN = 0;
export const DURATION_TICKS_MIN = 1; // spec §7.7: min duration 1 tick

// --- Pad / layer sound design (spec §6) ------------------------------------------
export const PAD_INDEX_RANGE: Range = [0, 127];
export const CHOKE_GROUP_RANGE: Range = [0, 16];
export const TUNE_SEMITONES_RANGE: Range = [-36, 36];
export const TUNE_CENTS_RANGE: Range = [-100, 100];
export const GAIN_DB_RANGE: Range = [-24, 24];
export const PITCH_ENV_SEMITONES_RANGE: Range = [-36, 36];
export const FILTER_CUTOFF_RANGE: Range = [20, 20_000];
export const FILTER_RESONANCE_RANGE: Range = [0.1, 20];
export const FILTER_ENV_DEPTH_RANGE: Range = [-1, 1];
export const MOD_AMOUNT_RANGE: Range = [-1, 1];
export const LFO_PHASE_RANGE: Range = [0, 1];
export const LFO_RATE_RANGE: Range = [0.01, 100];
export const ENVELOPE_LEVEL_RANGE: Range = [0, 1];
export const ENVELOPE_TIME_MS_MIN = 0;
/**
 * Bounded envelope time for *control surfaces* that need a travel span — the Q-Link
 * amp attack/release encoders (spec §10.3). Stored envelopes are only floored at
 * {@link ENVELOPE_TIME_MS_MIN}; this bound constrains what a knob can dial, not what a
 * payload may contain.
 */
export const ENVELOPE_TIME_MS_RANGE: Range = [ENVELOPE_TIME_MS_MIN, 10_000];
/** Default cap 4, configurable to 8 (spec §1.3.1, §6). The schema enforces the hard cap. */
export const MAX_VELOCITY_LAYERS = 8;
/** Validated mod-matrix route cap (spec §6). */
export const MAX_MOD_ROUTES = 32;

// --- Keygroup (spec §6 KeygroupProgram) ------------------------------------------
export const POLYPHONY_RANGE: Range = [1, 32];
export const GLIDE_MS_MIN = 0;
export const PITCH_BEND_RANGE_SEMITONES: Range = [1, 12];
export const ROOT_NOTE_RANGE: Range = [0, 127];

// --- Q-Link (spec §10.3) ---------------------------------------------------------
export const ENCODER_INDEX_RANGE: Range = [0, 15];
export const CC_RANGE: Range = [0, 127];

// --- Insert slots (spec §4.2, §1.3.1) --------------------------------------------
export const GLOBAL_INSERT_LIMIT_RANGE: Range = [1, 8];
