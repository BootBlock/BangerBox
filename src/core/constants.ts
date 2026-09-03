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

/**
 * Fade applied at the natural end of a voice in milliseconds — spec §5.4 ("never a hard
 * cut/click"). A sample whose last frame is not at zero — a chop slice, a trimmed layer,
 * a truncated one-shot — would otherwise step straight to silence and click.
 *
 * This fade is deliberately the *whole* answer for such samples: the stored audio is left
 * honest, discontinuity and all, and nothing bakes a boundary fade into the written file
 * (issue #86). Chop slices are a contiguous partition of their source, so a baked fade-out
 * would dip the level at every boundary when slices are re-sequenced back to back — the
 * workflow chopping exists for — and would then be faded a second time here on playback.
 * Bounce/export needs no separate treatment: every §9.5 variant renders through the same
 * VoicePool (see bounceService.renderSegments), so it inherits this declick already.
 */
export const DECLICK_FADE_MS = 3;

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

/**
 * Minimum tick spacing between two recorded automation points — spec §7.8 ("thinned by
 * minimum tick spacing + value epsilon"). One 1/32 note at 960 PPQN: fine enough that a
 * hand sweep reads as a curve rather than a staircase, coarse enough that a four-bar pass
 * over one lane leaves tens of points rather than thousands.
 */
export const AUTOMATION_MIN_TICK_SPACING = PPQN / 8;

/**
 * Value epsilon for recorded automation, as a FRACTION of the target's registered range —
 * spec §7.8. A fraction rather than an absolute: a lane may hold a gain in 0..1.2, a pan
 * in -1..1 or a cutoff in 20..20000 Hz, and one absolute epsilon would be meaningless at
 * one end of that spread and deaf at the other.
 */
export const AUTOMATION_VALUE_EPSILON = 0.005;

/**
 * Attempts a storage operation gets before a recoverable failure becomes the caller's
 * failure — spec §9.2 (issue #98). Bounded because an unbounded retry turns a stuck OPFS
 * lock into a hung UI, which is worse than reporting the error.
 */
export const STORAGE_RETRY_ATTEMPTS = 3;

/**
 * First backoff step between storage retries in milliseconds — spec §9.2. Each retry
 * doubles it, so the three attempts span roughly 75 ms: long enough for another handle to
 * close, short enough that a genuinely stuck write is reported rather than waited on.
 */
export const STORAGE_RETRY_BASE_DELAY_MS = 25;

/**
 * Entries a `.mpcweb` archive may contain before import refuses it — spec §9.6, §9.7
 * (issue #26). An archive holds `manifest.json`, `project.json` and one `.wav` per sample,
 * so this is generous for any real project and still bounds the entry-header work a crafted
 * file can force.
 */
export const MPCWEB_MAX_ENTRIES = 4096;

/**
 * Inflated bytes one `.mpcweb` entry may produce — spec §9.6, §9.7. A 96 kHz 32-bit stereo
 * sample runs about 768 kB per second, so 256 MiB is roughly a five-minute recording: past
 * anything the sampler is for, and far short of what a decompression bomb aims at.
 */
export const MPCWEB_MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/**
 * Inflated bytes a whole `.mpcweb` archive may produce — spec §9.6, §9.7. Counted while
 * unpacking rather than checked afterwards, because the point is to never HOLD the bytes:
 * a 1 MB archive of compressible data would otherwise reach gigabytes inside the pack
 * worker before the §9.7 headroom check ever ran (issue #26).
 */
export const MPCWEB_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
