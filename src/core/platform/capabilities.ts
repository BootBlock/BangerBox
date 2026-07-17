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

export interface CapabilityReport {
  readonly hard: Readonly<HardCapabilities>;
  readonly soft: Readonly<SoftCapabilities>;
  /** True when every hard requirement is present. */
  readonly hardSupported: boolean;
  /** Human-readable labels for each missing hard requirement (blocking screen copy). */
  readonly missingHard: readonly string[];
}

/** User-facing labels for the blocking screen — explains exactly what is missing. */
export const HARD_CAPABILITY_LABELS: Readonly<Record<keyof HardCapabilities, string>> = Object.freeze({
  crossOriginIsolated: 'Cross-origin isolation (COOP/COEP response headers)',
  sharedArrayBuffer: 'SharedArrayBuffer shared memory',
  audioWorklet: 'AudioWorklet real-time audio processing',
  opfs: 'Origin Private File System storage',
  webAssembly: 'WebAssembly',
  atomics: 'Atomics thread synchronisation',
});

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
export function evaluateCapabilities(hard: HardCapabilities, soft: SoftCapabilities): CapabilityReport {
  const missingHard = (Object.keys(HARD_CAPABILITY_LABELS) as (keyof HardCapabilities)[])
    .filter((key) => !hard[key])
    .map((key) => HARD_CAPABILITY_LABELS[key]);

  return Object.freeze({
    hard: Object.freeze({ ...hard }),
    soft: Object.freeze({ ...soft }),
    hardSupported: missingHard.length === 0,
    missingHard: Object.freeze(missingHard),
  });
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
 * store hydration or audio code (see src/main.tsx).
 */
// STUB(phase-2): freeze the report into useUIStore.capabilities once the store exists.
export function detectCapabilities(): CapabilityReport {
  cachedReport ??= evaluateCapabilities(probeHard(), probeSoft());
  return cachedReport;
}
