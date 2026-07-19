import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AhdsrEnvelope } from '@/core/project/schemas';
import { EnvelopeGraph } from './EnvelopeGraph';
import { envelopeJoints, envelopeScale } from './envelopeGraphMaths';

const ENVELOPE: AhdsrEnvelope = {
  attack: 10,
  hold: 0,
  decay: 200,
  sustain: 0.6,
  release: 300,
  curve: 'exponential',
};

/** Must match `PADDING_PX` in the component — the inset the joints are drawn at. */
const PADDING = 8;
const CANVAS_WIDTH = 400;
const CANVAS_HEIGHT = 120;

/** Where each joint lands in element-local pixels, at the size the rect is mocked to. */
function jointXs(envelope: AhdsrEnvelope): number[] {
  const scale = envelopeScale(envelope, CANVAS_WIDTH - PADDING * 2);
  return envelopeJoints(envelope, scale, CANVAS_HEIGHT - PADDING * 2).map((p) => PADDING + p.x);
}

/** The y a given sustain level is drawn at, so a horizontal drag can leave the level alone. */
function sustainY(level: number): number {
  return PADDING + (CANVAS_HEIGHT - PADDING * 2) * (1 - level);
}

describe('EnvelopeGraph (spec §8.5.5)', () => {
  beforeEach(() => {
    // happy-dom lays nothing out and implements no pointer capture; the canvas needs a real
    // size for the drag maths and the capture calls must not throw.
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: CANVAS_WIDTH,
      bottom: CANVAS_HEIGHT,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect);
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => false;
  });

  const drag = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const canvas = screen.getByTestId('envelope-graph');
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: from.x, clientY: from.y });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: to.x, clientY: to.y });
  };

  it('describes the whole envelope on the canvas and beside it (spec §8.2)', () => {
    render(<EnvelopeGraph envelope={ENVELOPE} onChange={() => {}} label="Amp envelope" />);
    const canvas = screen.getByRole('img', { name: /Amp envelope/ });
    expect(canvas.getAttribute('aria-label')).toContain('decay 200 ms');
    expect(canvas.getAttribute('aria-label')).toContain('sustain 60%');
    expect(screen.getByTestId('envelope-graph-readout')).toHaveTextContent('R 300 ms');
  });

  it('does not scroll the page under a touch drag (spec §8.5.5 tablet use)', () => {
    render(<EnvelopeGraph envelope={ENVELOPE} onChange={() => {}} />);
    expect(screen.getByTestId('envelope-graph').className).toContain('touch-none');
  });

  it('commits a dragged time exactly once, on release (spec §3.3)', () => {
    const onChange = vi.fn();
    render(<EnvelopeGraph envelope={ENVELOPE} onChange={onChange} />);
    const xs = jointXs(ENVELOPE);
    const y = sustainY(ENVELOPE.sustain);

    const canvas = screen.getByTestId('envelope-graph');
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: xs[3]!, clientY: y });
    // Several moves — the undo stack must see one entry for the gesture, not one per frame.
    for (const x of [xs[3]! + 20, xs[3]! + 40, xs[3]! + 60]) {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y });
    }
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: xs[3]! + 60, clientY: y });

    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0]![0] as AhdsrEnvelope;
    expect(committed.decay).toBeGreaterThan(ENVELOPE.decay);
    // A horizontal drag on the sustain corner must not shift the level it was already at.
    expect(committed.sustain).toBeCloseTo(ENVELOPE.sustain, 1);
    expect(committed.attack).toBe(ENVELOPE.attack);
    expect(committed.release).toBe(ENVELOPE.release);
  });

  it('sets the sustain level from a vertical drag on the sustain corner', () => {
    const onChange = vi.fn();
    render(<EnvelopeGraph envelope={ENVELOPE} onChange={onChange} />);
    const xs = jointXs(ENVELOPE);
    drag({ x: xs[3]!, y: sustainY(ENVELOPE.sustain) }, { x: xs[3]!, y: sustainY(0.25) });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0]![0] as AhdsrEnvelope).sustain).toBeCloseTo(0.25, 2);
  });

  it('shortens the release when its handle is dragged inward', () => {
    const onChange = vi.fn();
    render(<EnvelopeGraph envelope={ENVELOPE} onChange={onChange} />);
    const xs = jointXs(ENVELOPE);
    drag({ x: xs[5]!, y: CANVAS_HEIGHT - PADDING }, { x: xs[4]! + 40, y: CANVAS_HEIGHT - PADDING });

    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0]![0] as AhdsrEnvelope;
    expect(committed.release).toBeLessThan(ENVELOPE.release);
    expect(committed.decay).toBe(ENVELOPE.decay);
  });

  it('grabs the hold handle rather than the attack peak beside it', () => {
    const onChange = vi.fn();
    render(<EnvelopeGraph envelope={ENVELOPE} onChange={onChange} />);
    const xs = jointXs(ENVELOPE);
    drag({ x: xs[2]!, y: PADDING }, { x: xs[2]! + 50, y: PADDING });

    const committed = onChange.mock.calls[0]![0] as AhdsrEnvelope;
    expect(committed.hold).toBeGreaterThan(0);
    expect(committed.attack).toBe(ENVELOPE.attack);
  });

  it('ignores a press that lands on no handle', () => {
    const onChange = vi.fn();
    render(<EnvelopeGraph envelope={ENVELOPE} onChange={onChange} />);
    const xs = jointXs(ENVELOPE);
    // Midway along the sustain plateau — a long way from any joint.
    drag({ x: (xs[3]! + xs[4]!) / 2, y: sustainY(ENVELOPE.sustain) }, { x: 300, y: 60 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
