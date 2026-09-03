/**
 * `livePath` — a control showing a gesture it is not driving (spec §10.3, §3.3, issue #27).
 *
 * §10.3's execution flow ends "sync layer updates the node → UI reacts concurrently": a
 * Q-Link encoder turn has to move the on-screen knob as it turns, not at the 250 ms idle
 * commit. Since the turn's values reach the graph through the §4.1 transient channel and
 * deliberately never touch React state, §3.3 names the only way that is allowed to happen —
 * "direct ref style writes". These pin that it does happen, and that it costs no render.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishTransient, resetTransientChannel } from '@/store/transientChannel';
import { Fader } from './Fader';
import { Knob } from './Knob';

const PATH = 'mixer.master.level';

afterEach(() => {
  resetTransientChannel();
});

describe('a control tracks a gesture it is not driving', () => {
  it('repaints a Knob when its address moves under it', () => {
    render(<Knob label="Cutoff" value={0.2} range={[0, 1]} livePath={PATH} onCommit={vi.fn()} />);
    const knob = screen.getByRole('slider');
    expect(knob.getAttribute('aria-valuenow')).toBe('0.2');

    publishTransient(PATH, 0.8);
    expect(knob.getAttribute('aria-valuenow')).toBe('0.8');
  });

  it('repaints a Fader the same way', () => {
    render(<Fader label="Level" value={0.2} range={[0, 1]} livePath={PATH} onCommit={vi.fn()} />);
    const fader = screen.getByRole('slider');
    publishTransient(PATH, 0.9);
    expect(fader.getAttribute('aria-valuenow')).toBe('0.9');
  });

  it('ignores a publish on another address', () => {
    render(<Knob label="Cutoff" value={0.2} range={[0, 1]} livePath={PATH} onCommit={vi.fn()} />);
    publishTransient('mixer.track:1.level', 0.8);
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('0.2');
  });

  it('paints nothing at all without a livePath, which is what makes the prop opt-in', () => {
    render(<Knob label="Cutoff" value={0.2} range={[0, 1]} onCommit={vi.fn()} />);
    publishTransient(PATH, 0.8);
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('0.2');
  });

  it('does not re-render — the paint is a ref write (spec §3.3)', () => {
    // The whole point: a control that re-rendered per CC frame would be the very cost
    // issue #27 removed, moved from the mode down into the control.
    let renders = 0;
    function Counted() {
      renders += 1;
      return <Knob label="Cutoff" value={0.2} range={[0, 1]} livePath={PATH} onCommit={vi.fn()} />;
    }
    render(<Counted />);
    const before = renders;
    for (let frame = 0; frame < 60; frame += 1) publishTransient(PATH, frame / 60);
    expect(renders).toBe(before);
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe(String(59 / 60));
  });
});
