import { describe, expect, it } from 'vitest';
import type { ModRoute } from '@/core/project/schemas';
import { evaluateModMatrix, MOD_SOURCE_POLARITY, routesForSource, type ModSourceValues } from './modMatrix';

type Sources = ModSourceValues;

const ZERO: Sources = {
  lfo1: 0,
  lfo2: 0,
  ampEnv: 0,
  pitchEnv: 0,
  filterEnv: 0,
  velocity: 0,
  random: 0,
  noteNumber: 0,
};

describe('evaluateModMatrix (spec §6)', () => {
  it('scales a source by the route amount into its target', () => {
    const routes: ModRoute[] = [{ source: 'lfo1', target: 'pitch', amount: 0.5 }];
    const result = evaluateModMatrix(routes, { ...ZERO, lfo1: 1 });
    expect(result.get('pitch')).toBe(0.5);
  });

  it('sums multiple routes that land on the same target', () => {
    const routes: ModRoute[] = [
      { source: 'lfo1', target: 'filterCutoff', amount: 0.5 },
      { source: 'filterEnv', target: 'filterCutoff', amount: 0.5 },
    ];
    const result = evaluateModMatrix(routes, { ...ZERO, lfo1: 1, filterEnv: 0.6 });
    expect(result.get('filterCutoff')).toBeCloseTo(0.8); // 0.5 + 0.3
  });

  it('keeps distinct targets separate', () => {
    const routes: ModRoute[] = [
      { source: 'velocity', target: 'amp', amount: 1 },
      { source: 'noteNumber', target: 'pitch', amount: -1 },
    ];
    const result = evaluateModMatrix(routes, { ...ZERO, velocity: 0.8, noteNumber: 0.25 });
    expect(result.get('amp')).toBeCloseTo(0.8);
    expect(result.get('pitch')).toBeCloseTo(-0.25);
  });

  it('honours a bipolar source swinging negative', () => {
    const routes: ModRoute[] = [{ source: 'lfo2', target: 'pan', amount: 1 }];
    expect(evaluateModMatrix(routes, { ...ZERO, lfo2: -1 }).get('pan')).toBe(-1);
  });

  it('omits targets whose contribution is exactly zero', () => {
    const routes: ModRoute[] = [{ source: 'lfo1', target: 'pitch', amount: 0.5 }];
    expect(evaluateModMatrix(routes, ZERO).has('pitch')).toBe(false);
  });

  it('supports insert-parameter target addresses', () => {
    const routes: ModRoute[] = [{ source: 'lfo1', target: 'insert2:cutoff', amount: 1 }];
    expect(evaluateModMatrix(routes, { ...ZERO, lfo1: 0.5 }).get('insert2:cutoff')).toBe(0.5);
  });

  it('returns an empty map for no routes', () => {
    expect(evaluateModMatrix([], { ...ZERO, lfo1: 1 }).size).toBe(0);
  });
});

describe('routesForSource (spec §6)', () => {
  const routes: ModRoute[] = [
    { source: 'lfo1', target: 'pitch', amount: 0.5 },
    { source: 'lfo2', target: 'filterCutoff', amount: 0.5 },
    { source: 'lfo1', target: 'pan', amount: 0.5 },
  ];
  it('filters to the given source', () => {
    expect(routesForSource(routes, 'lfo1')).toHaveLength(2);
    expect(routesForSource(routes, 'lfo2')).toHaveLength(1);
    expect(routesForSource(routes, 'velocity')).toHaveLength(0);
  });
});

describe('MOD_SOURCE_POLARITY (spec §6)', () => {
  it('marks LFOs and random bipolar, the rest unipolar', () => {
    expect(MOD_SOURCE_POLARITY.lfo1).toBe('bipolar');
    expect(MOD_SOURCE_POLARITY.random).toBe('bipolar');
    expect(MOD_SOURCE_POLARITY.velocity).toBe('unipolar');
    expect(MOD_SOURCE_POLARITY.ampEnv).toBe('unipolar');
  });
});
