import { describe, expect, it } from 'vitest';
import { bouncePath, globalLibraryPath, samplePath, splitOpfsPath } from './opfs';

// Handle-level operations need real OPFS and are proven by the browser smoke
// (spec §11.4, §13.5); the pure path layer is unit-tested here.
describe('OPFS path building (spec §9.1)', () => {
  it('builds the strict §9.1 layout', () => {
    expect(samplePath('p1', 's1')).toBe('/projects/p1/samples/s1.wav');
    expect(bouncePath('p1', 'mixdown')).toBe('/projects/p1/bounces/mixdown.wav');
    expect(globalLibraryPath('s2')).toBe('/global_library/s2.wav');
  });

  it('splits canonical paths into segments', () => {
    expect(splitOpfsPath('/projects/p1/samples/s1.wav')).toEqual(['projects', 'p1', 'samples', 's1.wav']);
    expect(splitOpfsPath('global_library/s.wav')).toEqual(['global_library', 's.wav']);
  });

  it('rejects traversal and malformed paths', () => {
    expect(() => splitOpfsPath('/projects/../etc')).toThrow(/Invalid OPFS path/);
    expect(() => splitOpfsPath('//double')).toThrow(/Invalid OPFS path/);
    expect(() => splitOpfsPath('/a/./b')).toThrow(/Invalid OPFS path/);
    expect(() => splitOpfsPath('')).toThrow(/Invalid OPFS path/);
  });
});
