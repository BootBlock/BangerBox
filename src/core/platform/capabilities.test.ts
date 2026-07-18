import { describe, expect, it } from 'vitest';
import {
  detectCapabilities,
  evaluateCapabilities,
  HARD_CAPABILITY_DETAILS,
  HARD_CAPABILITY_LABELS,
  type HardCapabilities,
  type SoftCapabilities,
} from './capabilities';

const allHard: HardCapabilities = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  audioWorklet: true,
  opfs: true,
  webAssembly: true,
  atomics: true,
};

const allSoft: SoftCapabilities = {
  bluetooth: true,
  microphone: true,
  persistentStorage: true,
  wakeLock: true,
};

describe('evaluateCapabilities (spec §2.1)', () => {
  it('reports hardSupported with nothing missing when every hard requirement is present', () => {
    const report = evaluateCapabilities(allHard, allSoft);
    expect(report.hardSupported).toBe(true);
    expect(report.missingHard).toEqual([]);
  });

  it('reports each missing hard requirement with its human-readable label', () => {
    const report = evaluateCapabilities({ ...allHard, sharedArrayBuffer: false, opfs: false }, allSoft);
    expect(report.hardSupported).toBe(false);
    expect(report.missingHard).toContain(HARD_CAPABILITY_LABELS.sharedArrayBuffer);
    expect(report.missingHard).toContain(HARD_CAPABILITY_LABELS.opfs);
    expect(report.missingHard).toHaveLength(2);
  });

  it('missing soft requirements never block the app', () => {
    const report = evaluateCapabilities(allHard, {
      bluetooth: false,
      microphone: false,
      persistentStorage: false,
      wakeLock: false,
    });
    expect(report.hardSupported).toBe(true);
    expect(report.soft.bluetooth).toBe(false);
  });

  it('returns a deeply frozen report (results are frozen — spec §2.1)', () => {
    const report = evaluateCapabilities(allHard, allSoft);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.hard)).toBe(true);
    expect(Object.isFrozen(report.soft)).toBe(true);
    expect(Object.isFrozen(report.missingHard)).toBe(true);
    expect(Object.isFrozen(report.missingHardDetails)).toBe(true);
    expect(Object.isFrozen(report.browser)).toBe(true);
  });

  it('pairs every missing requirement with its own explanation and remedy', () => {
    const report = evaluateCapabilities({ ...allHard, opfs: false, atomics: false }, allSoft);
    expect(report.missingHardDetails).toHaveLength(2);
    // Not a blanket message: each entry must carry its own actionable copy.
    for (const detail of report.missingHardDetails) {
      expect(detail.title).toBeTruthy();
      expect(detail.what).toBeTruthy();
      expect(detail.fix).toBeTruthy();
      expect(detail.technical).toBeTruthy();
    }
    expect(report.missingHardDetails.map((d) => d.title)).toEqual([
      HARD_CAPABILITY_DETAILS.opfs.title,
      HARD_CAPABILITY_DETAILS.atomics.title,
    ]);
  });

  it('labels stay in lockstep with the details they are derived from', () => {
    for (const key of Object.keys(HARD_CAPABILITY_DETAILS) as (keyof typeof HARD_CAPABILITY_DETAILS)[]) {
      expect(HARD_CAPABILITY_LABELS[key]).toBe(HARD_CAPABILITY_DETAILS[key].technical);
    }
  });
});

describe('detectCapabilities (spec §2.1)', () => {
  it('executes exactly once — repeat calls return the identical frozen report', () => {
    const first = detectCapabilities();
    const second = detectCapabilities();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
