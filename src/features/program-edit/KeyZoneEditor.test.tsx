import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeygroupZone } from '@/core/project/schemas';
import { KeyZoneEditor } from './KeyZoneEditor';

/**
 * The canvas is 750 CSS px wide across all 128 notes, which puts each of the 75 white keys on a
 * 10 px column and makes every coordinate below a note the test can name. jsdom draws nothing —
 * the pixels are `keyZoneLayout.test.ts`'s job; this file tests behaviour.
 */
const WIDTH = 750;
const HEIGHT = 100;
/** Middle of the lane strip (the top 42 % of the canvas) for zone 0. */
const LANE_Y = 5;
/** Somewhere in the drawn keyboard, below the lanes and the coverage ribbon. */
const KEYBOARD_Y = 70;

const zone = (over: Partial<KeygroupZone> = {}): KeygroupZone => ({
  sampleId: 'sample-1',
  rootNote: 60,
  lowNote: 60,
  highNote: 72,
  lowVelocity: 0,
  highVelocity: 127,
  tuneCents: 0,
  gainDb: 0,
  ...over,
});

class StubObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubObserver);
  vi.stubGlobal('IntersectionObserver', StubObserver);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: WIDTH,
    bottom: HEIGHT,
    width: WIDTH,
    height: HEIGHT,
    toJSON: () => ({}),
  });
  HTMLCanvasElement.prototype.setPointerCapture = () => {};
  HTMLCanvasElement.prototype.releasePointerCapture = () => {};
  HTMLCanvasElement.prototype.hasPointerCapture = () => false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** One whole gesture: press, some moves, release. */
function drag(canvas: HTMLElement, fromX: number, y: number, toXs: number[]) {
  fireEvent.pointerDown(canvas, { clientX: fromX, clientY: y, pointerId: 1 });
  for (const x of toXs) fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: toXs.at(-1) ?? fromX, clientY: y, pointerId: 1 });
}

describe('KeyZoneEditor (spec §8.5.5)', () => {
  it('describes the zones in note names for a screen reader (spec §8.2)', () => {
    render(<KeyZoneEditor zones={[zone()]} onChange={() => {}} />);
    const canvas = screen.getByTestId('key-zone-editor');
    expect(canvas).toHaveAttribute('role', 'img');
    const label = canvas.getAttribute('aria-label')!;
    expect(label).toContain('C4 to C5');
    expect(label).toContain('root C4');
    expect(label).toContain('No zone covers');
    expect(label).not.toContain('72');
  });

  it('says so when the program has no zones', () => {
    render(<KeyZoneEditor zones={[]} onChange={() => {}} />);
    expect(screen.getByTestId('key-zone-editor')).toHaveAttribute('aria-label', 'Key zone map: no zones.');
  });

  it('does not scroll the page under a touch drag (spec §8.2)', () => {
    render(<KeyZoneEditor zones={[zone()]} onChange={() => {}} />);
    expect(screen.getByTestId('key-zone-editor').className).toContain('touch-none');
  });

  it('drags the low edge and commits exactly once on release (spec §3.3)', () => {
    const onChange = vi.fn();
    render(<KeyZoneEditor zones={[zone()]} onChange={onChange} />);
    // x = 350 is the left edge of C4; 310 is F3.
    drag(screen.getByTestId('key-zone-editor'), 350, LANE_Y, [330, 320, 310]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual([expect.objectContaining({ lowNote: 53, highNote: 72 })]);
  });

  it('drags the high edge', () => {
    const onChange = vi.fn();
    render(<KeyZoneEditor zones={[zone()]} onChange={onChange} />);
    // x = 430 is the right edge of C5; 455 lands on E5.
    drag(screen.getByTestId('key-zone-editor'), 430, LANE_Y, [455]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0][0].lowNote).toBe(60);
    expect(onChange.mock.calls[0]![0][0].highNote).toBeGreaterThan(72);
  });

  it('clamps rather than inverting when a drag crosses the far edge', () => {
    const onChange = vi.fn();
    render(<KeyZoneEditor zones={[zone()]} onChange={onChange} />);
    drag(screen.getByTestId('key-zone-editor'), 350, LANE_Y, [500]);

    const committed = onChange.mock.calls[0]![0][0];
    expect(committed.lowNote).toBe(72);
    expect(committed.highNote).toBe(72);
  });

  it('moves the whole zone when the body is dragged', () => {
    const onChange = vi.fn();
    render(<KeyZoneEditor zones={[zone()]} onChange={onChange} />);
    // 395 is inside G4, 405 inside A4 — a two-semitone slide, both edges following.
    drag(screen.getByTestId('key-zone-editor'), 395, LANE_Y, [405]);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual([expect.objectContaining({ lowNote: 62, highNote: 74 })]);
  });

  it('leaves the other zones and the dragged zone’s other fields untouched', () => {
    const onChange = vi.fn();
    const zones = [zone(), zone({ lowNote: 80, highNote: 90, rootNote: 84, sampleId: 'sample-2' })];
    render(<KeyZoneEditor zones={zones} onChange={onChange} />);
    drag(screen.getByTestId('key-zone-editor'), 395, LANE_Y, [405]);

    const committed = onChange.mock.calls[0]![0];
    expect(committed[1]).toEqual(zones[1]);
    expect(committed[0].rootNote).toBe(60);
    expect(committed[0].sampleId).toBe('sample-1');
  });

  it('selects a zone by pressing a key it plays, without committing an edit', () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(<KeyZoneEditor zones={[zone()]} onChange={onChange} onSelect={onSelect} />);
    const canvas = screen.getByTestId('key-zone-editor');
    fireEvent.pointerDown(canvas, { clientX: 395, clientY: KEYBOARD_Y, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 395, clientY: KEYBOARD_Y, pointerId: 1 });

    expect(onSelect).toHaveBeenCalledWith(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a press on a key no zone plays', () => {
    const onSelect = vi.fn();
    render(<KeyZoneEditor zones={[zone()]} onChange={() => {}} onSelect={onSelect} />);
    fireEvent.pointerDown(screen.getByTestId('key-zone-editor'), {
      clientX: 5,
      clientY: KEYBOARD_Y,
      pointerId: 1,
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
