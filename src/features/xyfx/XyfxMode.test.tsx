/**
 * XYFX mode — spec §8.5.10 latch semantics, exercised through the keyboard. §8.2 requires
 * keyboard operation equivalent to pointer operation, so the Latch toggle must change what
 * a keyboard gesture does; §3.4 forbids controls that are inert for a whole input modality.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultChannelStrip } from '@/core/project/schemas';
import { useMixerStore } from '@/store';
import { XyfxMode } from './XyfxMode';

/** The X axis defaults to the first assignable parameter — master level. */
function masterLevel(): number {
  return useMixerStore.getState().channels.master!.level;
}

beforeEach(() => {
  useMixerStore.getState().setChannels({ master: createDefaultChannelStrip('master') });
});

describe('XyfxMode latch, keyboard', () => {
  it('returns the axis to its resting value when the gesture ends with latch off', async () => {
    const user = userEvent.setup();
    render(<XyfxMode />);
    const resting = masterLevel();

    const xAxis = screen.getAllByRole('slider')[0]!;
    xAxis.focus();
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');

    // Mid-gesture the axis has actually moved — the keys are not inert.
    expect(masterLevel()).toBeGreaterThan(resting);

    // Tabbing to the other axis stays inside the same gesture — one gesture spans the
    // surface, as a drag across both axes does.
    await user.tab();
    expect(masterLevel()).toBeGreaterThan(resting);

    // Releasing (focus leaves the axis sliders entirely) returns it to rest.
    await user.tab();
    expect(masterLevel()).toBeCloseTo(resting, 6);
  });

  it('holds the released value when latch is on', async () => {
    const user = userEvent.setup();
    render(<XyfxMode />);
    const resting = masterLevel();

    await user.click(screen.getByTestId('xyfx-latch'));

    const xAxis = screen.getAllByRole('slider')[0]!;
    xAxis.focus();
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    const moved = masterLevel();
    await user.tab();
    await user.tab();

    expect(moved).toBeGreaterThan(resting);
    expect(masterLevel()).toBeCloseTo(moved, 6);
  });

  it('releases on Escape without needing focus to move', async () => {
    const user = userEvent.setup();
    render(<XyfxMode />);
    const resting = masterLevel();

    const xAxis = screen.getAllByRole('slider')[0]!;
    xAxis.focus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    await user.keyboard('{Escape}');

    expect(masterLevel()).toBeCloseTo(resting, 6);
    expect(xAxis).toHaveFocus();
  });
});
