/**
 * Startup capability gate — spec §2.1. Feature-detects the hard requirements (missing
 * ⇒ styled blocking screen, nothing else loads) and the soft requirements (missing ⇒
 * feature hidden/disabled with an explanatory tooltip). Executed exactly once; the
 * report is deeply frozen.
 */

/** Hard requirements — all must be present for the app to load (spec §2.1). */
export interface HardCapabilities {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  audioWorklet: boolean;
  opfs: boolean;
  webAssembly: boolean;
  atomics: boolean;
}

/** Soft requirements — missing features are hidden/disabled, the app still runs. */
export interface SoftCapabilities {
  bluetooth: boolean;
  microphone: boolean;
  persistentStorage: boolean;
  wakeLock: boolean;
}

/**
 * Which browser engine we are on. Used for the §1.3 #15 unsupported-browser warning and
 * to tailor the blocking screen's advice — telling a Firefox user to "check their
 * COOP/COEP headers" is useless, telling them the engine is untested is not.
 */
export type BrowserEngine = 'chromium' | 'firefox' | 'safari' | 'unknown';

export interface BrowserInfo {
  readonly engine: BrowserEngine;
  /** Display name for the warning copy — "Firefox", "Safari", "your browser". */
  readonly name: string;
  /** True only for the Chromium baseline the app is built and tested against. */
  readonly supported: boolean;
}

/**
 * Everything the UI needs to explain ONE missing requirement in plain English. The
 * blocking screen must say exactly what is wrong and what to do about it, per item —
 * a single blanket "your browser is unsupported" leaves the user with no next step.
 */
export interface CapabilityDetail {
  /** Plain-English name — what the user loses, not what the API is called. */
  readonly title: string;
  /** What this actually does for them, in non-technical terms. */
  readonly what: string;
  /** The most likely reason it is missing, and the concrete thing to try. */
  readonly fix: string;
  /** The API name, shown small — the string to quote in a bug report. */
  readonly technical: string;
}

export interface CapabilityReport {
  readonly hard: Readonly<HardCapabilities>;
  readonly soft: Readonly<SoftCapabilities>;
  /** True when every hard requirement is present. */
  readonly hardSupported: boolean;
  /** Human-readable labels for each missing hard requirement (blocking screen copy). */
  readonly missingHard: readonly string[];
  /** Full per-item explanation of each missing hard requirement (blocking screen). */
  readonly missingHardDetails: readonly CapabilityDetail[];
  /** The detected browser engine (spec §1.3 #15). */
  readonly browser: BrowserInfo;
}

/**
 * Per-requirement copy for the blocking screen — spec §2.1. Each entry names the missing
 * capability in the user's terms, says what it costs them, and gives the one thing most
 * likely to fix it. Deliberately specific: the screen must never reduce to a blanket
 * "unsupported browser" that leaves the reader with nowhere to go.
 */
export const HARD_CAPABILITY_DETAILS: Readonly<Record<keyof HardCapabilities, CapabilityDetail>> =
  Object.freeze({
    crossOriginIsolated: Object.freeze({
      title: 'Secure isolated mode',
      what: 'Lets BangerBox use fast shared memory for audio. Without it the audio engine cannot start at all.',
      fix: 'This one usually fixes itself — reload the page. BangerBox turns isolation on itself the first time you visit, and that takes one extra reload. If it keeps coming back, a browser extension (an ad blocker or privacy tool) is most likely stripping the headers: try a private window with extensions off.',
      technical: 'crossOriginIsolated — COOP/COEP response headers',
    }),
    sharedArrayBuffer: Object.freeze({
      title: 'Shared memory',
      what: 'How the audio engine passes sound between threads without stuttering.',
      fix: 'Almost always a knock-on effect of the item above rather than a separate fault — browsers switch shared memory off until the page is isolated. Fix isolation and this returns with it.',
      technical: 'SharedArrayBuffer',
    }),
    audioWorklet: Object.freeze({
      title: 'Real-time audio processing',
      what: 'The part of the browser that generates sound on a dedicated audio thread. This is the core of the whole app.',
      fix: 'Your browser is too old, or audio is disabled in its settings. Update to the latest Microsoft Edge or Google Chrome.',
      technical: 'AudioWorkletNode / AudioContext',
    }),
    opfs: Object.freeze({
      title: 'Private file storage',
      what: 'Where your projects, samples and recordings are saved on this device. BangerBox stores everything locally and never uploads it.',
      fix: 'Private/incognito windows block this storage, and so does blocking site data for this site. Open BangerBox in a normal window and allow site data.',
      technical: 'navigator.storage.getDirectory (Origin Private File System)',
    }),
    webAssembly: Object.freeze({
      title: 'WebAssembly',
      what: 'Runs the audio and database engines at native speed.',
      fix: 'Every current browser supports this, so it is normally switched off deliberately — by enterprise/group policy, hardened security settings, or an extension. Check with whoever manages this device, or try a personal profile.',
      technical: 'WebAssembly.instantiate',
    }),
    atomics: Object.freeze({
      title: 'Thread synchronisation',
      what: 'Keeps the audio thread and the interface in step so playback stays in time.',
      fix: 'Missing alongside shared memory, and fixed by the same thing — restore isolation, or update your browser.',
      technical: 'Atomics',
    }),
  });

/** Short labels, derived from the details above so the two can never drift apart. */
export const HARD_CAPABILITY_LABELS: Readonly<Record<keyof HardCapabilities, string>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(HARD_CAPABILITY_DETAILS) as (keyof HardCapabilities)[]).map((key) => [
      key,
      HARD_CAPABILITY_DETAILS[key].technical,
    ]),
  ) as Record<keyof HardCapabilities, string>,
);

export const SOFT_CAPABILITY_LABELS: Readonly<Record<keyof SoftCapabilities, string>> = Object.freeze({
  bluetooth: 'Web Bluetooth (BLE-MIDI hardware)',
  microphone: 'Microphone input (Looper source)',
  persistentStorage: 'Persistent storage grant',
  wakeLock: 'Screen wake lock',
});

/**
 * Pure evaluation of probed capability booleans into a frozen report. Kept separate
 * from the environment probes so it is trivially unit-testable (spec §2.5 pure-logic
 * rule).
 */
const CHROMIUM_BROWSER: BrowserInfo = Object.freeze({
  engine: 'chromium',
  name: 'your browser',
  supported: true,
});

export function evaluateCapabilities(
  hard: HardCapabilities,
  soft: SoftCapabilities,
  browser: BrowserInfo = CHROMIUM_BROWSER,
): CapabilityReport {
  const missingKeys = (Object.keys(HARD_CAPABILITY_DETAILS) as (keyof HardCapabilities)[]).filter(
    (key) => !hard[key],
  );

  return Object.freeze({
    hard: Object.freeze({ ...hard }),
    soft: Object.freeze({ ...soft }),
    hardSupported: missingKeys.length === 0,
    missingHard: Object.freeze(missingKeys.map((key) => HARD_CAPABILITY_LABELS[key])),
    missingHardDetails: Object.freeze(missingKeys.map((key) => HARD_CAPABILITY_DETAILS[key])),
    browser: Object.freeze({ ...browser }),
  });
}

/**
 * Identify the browser engine (spec §1.3 #15). UA sniffing, deliberately — this drives a
 * non-blocking warning and the wording of advice, never a capability decision. What the
 * app can actually DO is always decided by the feature probes above, so a mis-detection
 * here costs a slightly-off message, never access to the app.
 *
 * Order matters: Edge and Chrome both claim "Safari" in their UA string, and Chromium
 * browsers claim "Chrome", so the negative checks have to come last.
 */
export function detectBrowser(userAgent: string = navigator.userAgent): BrowserInfo {
  const ua = userAgent.toLowerCase();
  if (ua.includes('firefox/') || ua.includes('fxios')) {
    return Object.freeze({ engine: 'firefox' as const, name: 'Firefox', supported: false });
  }
  if (ua.includes('chrome/') || ua.includes('chromium/') || ua.includes('edg/')) {
    return CHROMIUM_BROWSER;
  }
  if (ua.includes('safari/')) {
    return Object.freeze({ engine: 'safari' as const, name: 'Safari', supported: false });
  }
  return Object.freeze({ engine: 'unknown' as const, name: 'This browser', supported: false });
}

/** Probe the hard requirements from the live environment (spec §2.1). */
function probeHard(): HardCapabilities {
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    audioWorklet: typeof AudioWorkletNode === 'function' && typeof AudioContext === 'function',
    opfs: typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
    webAssembly: typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function',
    atomics: typeof Atomics === 'object',
  };
}

/** Probe the soft requirements from the live environment (spec §2.1). */
function probeSoft(): SoftCapabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    bluetooth: !!nav && 'bluetooth' in nav,
    microphone: typeof nav?.mediaDevices?.getUserMedia === 'function',
    persistentStorage: typeof nav?.storage?.persist === 'function',
    wakeLock: !!nav && 'wakeLock' in nav,
  };
}

let cachedReport: CapabilityReport | null = null;

/**
 * Detect capabilities exactly once and freeze the result — spec §2.1. Runs before any
 * store hydration or audio code, then is frozen into `useUIStore.capabilities` in
 * `src/main.tsx` so every consumer reads one source (spec §2.1).
 */
export function detectCapabilities(): CapabilityReport {
  cachedReport ??= evaluateCapabilities(
    probeHard(),
    probeSoft(),
    typeof navigator !== 'undefined' ? detectBrowser(navigator.userAgent) : CHROMIUM_BROWSER,
  );
  return cachedReport;
}
