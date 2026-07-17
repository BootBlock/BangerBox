import { describe, expect, it } from 'vitest';
import { mixdownToStereo } from './sampleImport';

describe('mixdownToStereo — spec §9.4 step 3', () => {
  it('passes mono and stereo through unchanged (copied)', () => {
    const mono = [Float32Array.from([1, 2, 3])];
    const out = mixdownToStereo(mono);
    expect(out.length).toBe(1);
    expect(Array.from(out[0]!)).toEqual([1, 2, 3]);
    expect(out[0]).not.toBe(mono[0]); // a copy, not the same reference

    const stereo = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    const outStereo = mixdownToStereo(stereo);
    expect(outStereo.length).toBe(2);
  });

  it('folds >2 channels into a stereo pair without dropping any source', () => {
    // 4 channels: L sources {0.5, 0.5} → avg 0.5; R sources {1, 0} → avg 0.5.
    const quad = [
      Float32Array.from([0.5]),
      Float32Array.from([1]),
      Float32Array.from([0.5]),
      Float32Array.from([0]),
    ];
    const out = mixdownToStereo(quad);
    expect(out.length).toBe(2);
    expect(out[0]![0]).toBeCloseTo(0.5, 6); // even channels averaged
    expect(out[1]![0]).toBeCloseTo(0.5, 6); // odd channels averaged
  });
});
