/**
 * Engine constants registry — spec §2.6. All timing/behaviour constants live here,
 * never as magic numbers at call sites. Values are binding (naming freeze, §13.6).
 */

/** Sequencer resolution in pulses per quarter note — spec §1.3 #17. */
export const PPQN = 960;

/** Scheduler lookahead window in milliseconds — spec §7.1.4. */
export const LOOKAHEAD_MS = 100;

/** Worker scheduling wake interval in milliseconds — spec §7.1.4. */
export const SCHEDULER_INTERVAL_MS = 25;

/** Main→worker clock model refresh interval in milliseconds — spec §7.1.2. */
export const CLOCK_SYNC_INTERVAL_MS = 250;

/** Fade applied to a stolen voice in milliseconds — spec §5.4. */
export const VOICE_STEAL_FADE_MS = 5;

/** Fade applied to choked pads in milliseconds — spec §5.4. */
export const CHOKE_FADE_MS = 20;

/** Dezipper ramp for live parameter changes in milliseconds — spec §4.3. */
export const PARAM_RAMP_MS = 10;

/** Global voice pool size — spec §5.4. */
export const MAX_VOICES = 64;

/** Write-behind autosave debounce in milliseconds — spec §4.4. */
export const AUTOSAVE_DEBOUNCE_MS = 2000;

/** Minimum interval between applied CC updates per controller, milliseconds — spec §10.4. */
export const CC_THROTTLE_MS = 16;

/** Undo stack depth — spec §4.5. */
export const UNDO_LIMIT = 100;

/**
 * Storage quota hard-stop ratio — spec §9.7: refuse any write that would push
 * origin usage beyond this fraction of the browser quota.
 */
export const QUOTA_HARD_STOP_RATIO = 0.9;
