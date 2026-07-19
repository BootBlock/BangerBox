import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VelocityLayer } from '@/core/project/schemas';
import {
  VELOCITY_MAX,
  VelocityRangeBar,
  applyRangeDrag,
  boundaryX,
  describeCoverage,
  edgeHandleXs,
  rangeAtVelocity,
  velocityCoverage,
  xToVelocity,
} from './VelocityRangeBar';

/** Lane width used throughout so one CSS pixel is exactly one velocity step. */
const LANE_WIDTH = 128;

function layer(velocityStart: number, velocityEnd: number, sampleId = 'sample'): VelocityLayer {
  return {
    sampleId,
    velocityStart,
    velocityEnd,
    tuneSemitones: 0,
    tuneCents: 0,
    gainDb: 0,
    startFrame: 0,
    endFrame: 0,
    reverse: false,
  };
}

describe('velocity lane maths (spec §8.5.5)', () => {
  it('maps the whole 0..127 axis across the lane inclusively', () => {
    expect(boundaryX(0, LANE_WIDTH)).toBe(0);
    expect(boundaryX(128, LANE_WIDTH)).toBe(LANE_WIDTH);
    // A single-velocity layer still has width — its cell, not a zero-width line.
    expect(boundaryX(64, LANE_WIDTH)).toBeLessThan(boundaryX(65, LANE_WIDTH));
    expect(xToVelocity(0, LANE_WIDTH)).toBe(0);
    expect(xToVelocity(100.7, LANE_WIDTH)).toBe(100);
    expect(xToVelocity(LANE_WIDTH * 2, LANE_WIDTH)).toBe(VELOCITY_MAX);
    expect(xToVelocity(-40, LANE_WIDTH)).toBe(0);
  });

  it('exposes both edges of every layer as handles, start first', () => {
    const handles = edgeHandleXs([{ velocityStart: 0, velocityEnd: 63 }], LANE_WIDTH);
    expect(handles).toEqual([0, 64]);
  });

  it('grabs the last-drawn layer where two overlap', () => {
    const ranges = [
      { velocityStart: 0, velocityEnd: 80 },
      { velocityStart: 60, velocityEnd: 127 },
    ];
    expect(rangeAtVelocity(ranges, 70)).toBe(1);
    expect(rangeAtVelocity(ranges, 10)).toBe(0);
    expect(rangeAtVelocity([{ velocityStart: 0, velocityEnd: 10 }], 40)).toBe(-1);
  });

  it('clamps an edge against its partner instead of inverting the range', () => {
    const origin = { velocityStart: 40, velocityEnd: 80 };
    expect(applyRangeDrag(origin, 'start', 120)).toEqual({ velocityStart: 80, velocityEnd: 80 });
    expect(applyRangeDrag(origin, 'end', 0)).toEqual({ velocityStart: 40, velocityEnd: 40 });
    expect(applyRangeDrag(origin, 'start', -20)).toEqual({ velocityStart: 0, velocityEnd: 80 });
    expect(applyRangeDrag(origin, 'end', 999)).toEqual({ velocityStart: 40, velocityEnd: 127 });
  });

  it('moves a whole range without resizing it, stopping at the ends of the lane', () => {
    const origin = { velocityStart: 40, velocityEnd: 80 };
    expect(applyRangeDrag(origin, 'body', 50, 10)).toEqual({ velocityStart: 40, velocityEnd: 80 });
    expect(applyRangeDrag(origin, 'body', 60, 10)).toEqual({ velocityStart: 50, velocityEnd: 90 });
    expect(applyRangeDrag(origin, 'body', 127, 0)).toEqual({ velocityStart: 87, velocityEnd: 127 });
    expect(applyRangeDrag(origin, 'body', 0, 20)).toEqual({ velocityStart: 0, velocityEnd: 40 });
  });

  it('reports gaps and overlaps as velocity runs', () => {
    const coverage = velocityCoverage([
      { velocityStart: 0, velocityEnd: 70 },
      { velocityStart: 60, velocityEnd: 100 },
    ]);
    expect(coverage.overlaps).toEqual([{ start: 60, end: 70 }]);
    expect(coverage.gaps).toEqual([{ start: 101, end: 127 }]);
    expect(coverage.counts[65]).toBe(2);

    const full = velocityCoverage([{ velocityStart: 0, velocityEnd: 127 }]);
    expect(full.gaps).toEqual([]);
    expect(full.overlaps).toEqual([]);
  });

  it('describes the layers, overlaps and gaps in words (spec §8.2)', () => {
    const ranges = [
      { velocityStart: 0, velocityEnd: 70 },
      { velocityStart: 60, velocityEnd: 127 },
    ];
    const text = describeCoverage(ranges, velocityCoverage(ranges));
    expect(text).toContain('layer 1 covers 0 to 70');
    expect(text).toContain('overlap at 60 to 70');
    expect(text).not.toContain('no layer at');
    expect(describeCoverage([], velocityCoverage([]))).toBe('No velocity layers.');
  });
});

describe('VelocityRangeBar', () => {
  beforeEach(() => {
    // happy-dom lays nothing out and implements no pointer capture; the canvas needs a real
    // width for the drag maths and the capture calls must not throw.
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: LANE_WIDTH,
      bottom: 40,
      width: LANE_WIDTH,
      height: 40,
      toJSON: () => ({}),
    } as DOMRect);
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
  });

  const drag = (from: number, to: number) => {
    const canvas = screen.getByTestId('velocity-range-bar');
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: from, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: to, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: to, clientY: 10 });
  };

  it('labels the canvas with what the layers cover (spec §8.2)', () => {
    render(<VelocityRangeBar layers={[layer(0, 63), layer(64, 127)]} onChange={() => {}} />);
    const canvas = screen.getByTestId('velocity-range-bar');
    expect(canvas.getAttribute('aria-label')).toContain('layer 2 covers 64 to 127');
    expect(screen.getByTestId('velocity-range-summary')).toHaveTextContent('layer 1 covers 0 to 63');
  });

  it('names the uncovered velocities so the gap is not only visible (spec §8.2)', () => {
    render(<VelocityRangeBar layers={[layer(0, 63), layer(100, 127)]} onChange={() => {}} />);
    expect(screen.getByTestId('velocity-range-summary')).toHaveTextContent('no layer at 64 to 99');
  });

  it('commits a resized edge exactly once, on release (spec §3.3)', () => {
    const onChange = vi.fn();
    render(<VelocityRangeBar layers={[layer(0, 63), layer(64, 127)]} onChange={onChange} />);
    // 64px is layer 1's end edge; drag it out to velocity 90.
    drag(64, 90);

    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0]![0] as VelocityLayer[];
    expect(committed[0]).toMatchObject({ velocityStart: 0, velocityEnd: 90 });
    expect(committed[1]).toMatchObject({ velocityStart: 64, velocityEnd: 127 });
  });

  it('moves a whole range when the drag starts inside it, keeping its width', () => {
    const onChange = vi.fn();
    render(<VelocityRangeBar layers={[layer(20, 40)]} onChange={onChange} />);
    drag(30, 50);

    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0]![0] as VelocityLayer[];
    expect(committed[0]).toMatchObject({ velocityStart: 40, velocityEnd: 60 });
  });

  it('selects the layer a press lands on', () => {
    const onSelect = vi.fn();
    render(
      <VelocityRangeBar layers={[layer(0, 40), layer(80, 127)]} onChange={() => {}} onSelect={onSelect} />,
    );
    drag(100, 100);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('ignores a press on velocities no layer covers', () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(<VelocityRangeBar layers={[layer(0, 40)]} onChange={onChange} onSelect={onSelect} />);
    drag(100, 110);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
