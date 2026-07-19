import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@/core/project/schemas';
import { useSequenceStore, useTransportStore } from '@/store';
import { GridMode } from './GridMode';

const track = (id: string, position: number) => ({
  id,
  sequenceId: 'seq1',
  programId: null,
  position,
  name: `Track ${position + 1}`,
  type: 'drum' as const,
  muted: false,
  soloed: false,
});

const point = (ownerId: string, targetPath: string, value: number): AutomationPoint => ({
  id: `${ownerId}-${targetPath}-${value}`,
  scope: 'track',
  ownerId,
  targetPath,
  tick: 0,
  value,
  curve: 'linear',
});

/**
 * Two tracks with a lane each, plus a sequence-scoped lane. The filter under test has to
 * separate all three — the old `key.includes(':')` clause admitted every one of them.
 */
function seed() {
  useSequenceStore.setState({
    tracks: { t1: track('t1', 0), t2: track('t2', 1) },
    events: { t1: [], t2: [] },
    automation: {
      'track:t1:volume': [point('t1', 'volume', 0.4)],
      'track:t1:pan': [point('t1', 'pan', -1)],
      'track:t2:volume': [point('t2', 'volume', 0.9)],
      'sequence:seq1:tempo': [{ ...point('seq1', 'tempo', 120), scope: 'sequence' }],
    },
  });
  useTransportStore.setState({ activeSequenceId: 'seq1' });
}

describe('GridMode automation lane selector (spec §8.5.2, §7.8)', () => {
  beforeEach(seed);
  afterEach(() => {
    useSequenceStore.setState({ tracks: {}, events: {}, automation: {} });
    useTransportStore.setState({ activeSequenceId: null });
  });

  it("offers only the selected track's own lanes", () => {
    render(<GridMode />);
    const select = screen.getByLabelText('Automation lane');
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    // Track 1 is selected by default: its two lanes, and neither track 2's nor the
    // sequence's.
    expect(options).toEqual(['None', 'pan', 'volume']);
  });

  it('follows the track selector', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.selectOptions(screen.getByLabelText('Track to edit'), 't2');
    const options = within(screen.getByLabelText('Automation lane'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['None', 'volume']);
  });

  it('describes the chosen lane in text, since the canvas is aria-hidden (spec §8.2)', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    expect(screen.queryByTestId('grid-automation-summary')).toBeNull();

    await user.selectOptions(screen.getByLabelText('Automation lane'), 'track:t1:volume');
    expect(screen.getByTestId('grid-automation-summary')).toHaveTextContent('1 point, flat at 0.4');
  });

  /**
   * Switching track used to leave the previous track's key selected. Resolving it would
   * draw one track's automation over another's notes, so it falls back to None.
   */
  it('drops a lane the newly selected track does not own', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.selectOptions(screen.getByLabelText('Automation lane'), 'track:t1:pan');
    expect(screen.getByTestId('grid-automation-summary')).toHaveTextContent('flat at -1');

    await user.selectOptions(screen.getByLabelText('Track to edit'), 't2');
    expect(screen.getByLabelText<HTMLSelectElement>('Automation lane').value).toBe('');
    expect(screen.queryByTestId('grid-automation-summary')).toBeNull();
  });

  it('says so rather than offering an empty list when the track has no lanes', async () => {
    useSequenceStore.setState({ automation: {} });
    render(<GridMode />);
    const select = screen.getByLabelText<HTMLSelectElement>('Automation lane');
    expect(select.disabled).toBe(true);
    expect(select.textContent).toBe('No lanes');
  });
});
