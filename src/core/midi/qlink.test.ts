/**
 * Q-Link binding resolution and encoder scaling — spec §10.3: "CC in → look up binding for
 * current mode → scale into [min,max] per curve". Pure, so the whole mapping is testable
 * without a transport or a store.
 */
import { describe, expect, it } from 'vitest';
import type { QLinkBinding } from '@/core/project/schemas';
import {
  bindingForCc,
  defaultBindingsForMode,
  nextValueForCc,
  relativeIncrement,
  scaleCcToValue,
} from './qlink';

function binding(patch: Partial<QLinkBinding> = {}): QLinkBinding {
  return {
    encoderIndex: 0,
    cc: 74,
    targetStore: 'mixer',
    targetParameterPath: 'mixer.master.level',
    minValue: 0,
    maxValue: 1,
    curve: 'linear',
    mode: 'absolute',
    ...patch,
  };
}

describe('binding lookup (spec §10.3)', () => {
  it('finds the binding for an incoming CC number', () => {
    const bindings = [binding({ cc: 74 }), binding({ encoderIndex: 1, cc: 75 })];
    expect(bindingForCc(bindings, 75)?.encoderIndex).toBe(1);
  });

  it('returns undefined for an unbound CC', () => {
    expect(bindingForCc([binding({ cc: 74 })], 99)).toBeUndefined();
  });

  it('prefers the lowest encoder when two bindings share a CC', () => {
    const bindings = [binding({ encoderIndex: 3, cc: 74 }), binding({ encoderIndex: 1, cc: 74 })];
    expect(bindingForCc(bindings, 74)?.encoderIndex).toBe(1);
  });
});

describe('absolute scaling (spec §10.3)', () => {
  it('maps the CC extremes onto the binding bounds', () => {
    const b = binding({ minValue: -1, maxValue: 1 });
    expect(scaleCcToValue(0, b)).toBeCloseTo(-1, 6);
    expect(scaleCcToValue(127, b)).toBeCloseTo(1, 6);
  });

  it('maps the CC midpoint to the linear midpoint', () => {
    expect(scaleCcToValue(64, binding({ minValue: 0, maxValue: 127 }))).toBeCloseTo(64, 6);
  });

  it('honours a logarithmic curve', () => {
    const b = binding({ minValue: 20, maxValue: 20_000, curve: 'log' });
    expect(scaleCcToValue(0, b)).toBeCloseTo(20, 6);
    expect(scaleCcToValue(127, b)).toBeCloseTo(20_000, 3);
    // Halfway along a log taper is the geometric mean, not the arithmetic one.
    expect(scaleCcToValue(63.5, b)).toBeCloseTo(Math.sqrt(20 * 20_000), 3);
  });

  it('degrades a log curve to linear when the range touches zero', () => {
    const b = binding({ minValue: 0, maxValue: 100, curve: 'log' });
    expect(scaleCcToValue(64, b)).toBeCloseTo((64 / 127) * 100, 6);
  });

  it('clamps out-of-range CC input', () => {
    const b = binding({ minValue: 0, maxValue: 1 });
    expect(scaleCcToValue(-5, b)).toBe(0);
    expect(scaleCcToValue(999, b)).toBe(1);
  });

  it('handles an inverted binding range', () => {
    const b = binding({ minValue: 1, maxValue: 0 });
    expect(scaleCcToValue(0, b)).toBeCloseTo(1, 6);
    expect(scaleCcToValue(127, b)).toBeCloseTo(0, 6);
  });
});

describe('relative (two’s-complement) encoders (spec §10.3)', () => {
  it('reads small values as positive increments', () => {
    expect(relativeIncrement(1)).toBe(1);
    expect(relativeIncrement(3)).toBe(3);
    expect(relativeIncrement(63)).toBe(63);
  });

  it('reads high values as negative increments', () => {
    expect(relativeIncrement(127)).toBe(-1);
    expect(relativeIncrement(125)).toBe(-3);
    expect(relativeIncrement(64)).toBe(-64);
  });

  it('treats zero as no movement', () => {
    expect(relativeIncrement(0)).toBe(0);
  });

  it('moves the current value up and down from where it is', () => {
    const b = binding({ minValue: 0, maxValue: 127, mode: 'relative' });
    const up = nextValueForCc(64, 1, b);
    expect(up).toBeGreaterThan(64);
    const down = nextValueForCc(64, 127, b);
    expect(down).toBeLessThan(64);
  });

  it('clamps a relative move at the bounds rather than wrapping', () => {
    const b = binding({ minValue: 0, maxValue: 1, mode: 'relative' });
    expect(nextValueForCc(1, 63, b)).toBe(1);
    expect(nextValueForCc(0, 65, b)).toBe(0);
  });

  it('steps a relative encoder through the curve, not the raw range', () => {
    const b = binding({ minValue: 20, maxValue: 20_000, curve: 'log', mode: 'relative' });
    // One detent near the bottom of a log taper moves far fewer Hz than near the top.
    const lowStep = nextValueForCc(20, 1, b) - 20;
    const highStep = nextValueForCc(10_000, 1, b) - 10_000;
    expect(highStep).toBeGreaterThan(lowStep);
  });

  it('ignores the current value in absolute mode', () => {
    const b = binding({ minValue: 0, maxValue: 1, mode: 'absolute' });
    expect(nextValueForCc(0.9, 0, b)).toBe(0);
  });
});

describe('per-mode default bindings (spec §10.3)', () => {
  const context = { programId: 'prog-1', padIndex: 3 };

  it('gives pad mode pitch, filter cutoff, amp attack and amp release', () => {
    const bindings = defaultBindingsForMode('pad', context);
    expect(bindings.map((b) => b.targetParameterPath)).toEqual([
      'program:prog-1.pad:3.pitch',
      'program:prog-1.pad:3.filter.cutoff',
      'program:prog-1.pad:3.amp.attack',
      'program:prog-1.pad:3.amp.release',
    ]);
    expect(bindings.every((b) => b.targetStore === 'program')).toBe(true);
  });

  it('gives project mode the global macros', () => {
    const paths = defaultBindingsForMode('project', context).map((b) => b.targetParameterPath);
    expect(paths).toContain('mixer.master.level');
  });

  it('assigns encoder indices and CCs in order from the first encoder', () => {
    const bindings = defaultBindingsForMode('pad', context);
    expect(bindings.map((b) => b.encoderIndex)).toEqual([0, 1, 2, 3]);
  });

  it('seeds every default binding with its registry range', () => {
    for (const b of defaultBindingsForMode('pad', context)) {
      expect(b.maxValue).toBeGreaterThan(b.minValue);
    }
  });

  it('returns no defaults for pad mode without a selected pad', () => {
    expect(defaultBindingsForMode('pad', { programId: null, padIndex: null })).toEqual([]);
  });

  it('returns no defaults for screen mode — the focus registry supplies them', () => {
    expect(defaultBindingsForMode('screen', context)).toEqual([]);
  });

  it('gives program mode the active program’s macros', () => {
    const paths = defaultBindingsForMode('program', context).map((b) => b.targetParameterPath);
    expect(paths.every((path) => path.startsWith('program:prog-1.'))).toBe(true);
    expect(paths.length).toBeGreaterThan(0);
  });
});
