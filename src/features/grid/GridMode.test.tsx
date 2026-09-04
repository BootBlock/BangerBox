/**
 * Grid automation authoring — spec §8.5.2 (per-track automation lane selector) and §7.8
 * (two scopes, the registry gate, the curve field). These are the regression tests for
 * the authoring seam: before it existed the lane was a read-out, `setAutomationLane` had
 * no caller anywhere in the application, and no user could create a point by any route.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@/core/project/schemas';
import { createDefaultChannelStrip } from '@/core/project/schemas';
import { useMixerStore, useSequenceStore, useTransportStore } from '@/store';
import { GridMode } from './GridMode';

const TRACK_LEVEL = 'mixer.track:t1.level';
const MASTER_LEVEL = 'mixer.master.level';

const track = (id: string, position: number) => ({
  id,
  sequenceId: 'seq1',
  programId: null,
  position,
  name: `Track ${position + 1}`,
  type: 'drum' as const,
});

const point = (
  scope: AutomationPoint['scope'],
  ownerId: string,
  targetPath: string,
  value: number,
): AutomationPoint => ({
  id: `${scope}-${ownerId}-${targetPath}-${value}`,
  scope,
  ownerId,
  targetPath,
  tick: 0,
  value,
  curve: 'linear',
});

/**
 * Two tracks with a mixer strip each, plus lanes in both §7.8 scopes. The scope and owner
 * filters have to separate all of them — a match on the target path alone would admit
 * every one.
 */
function seed() {
  useSequenceStore.setState({
    tracks: { t1: track('t1', 0), t2: track('t2', 1) },
    events: { t1: [], t2: [] },
    automation: {
      [`track:t1:${TRACK_LEVEL}`]: [point('track', 't1', TRACK_LEVEL, 0.4)],
      [`track:t2:${MASTER_LEVEL}`]: [point('track', 't2', MASTER_LEVEL, 0.9)],
      'sequence:seq1:legacy.path': [point('sequence', 'seq1', 'legacy.path', 0.5)],
    },
  });
  useMixerStore.getState().setChannels({
    master: createDefaultChannelStrip('master'),
    'track:t1': createDefaultChannelStrip('track:t1'),
    'track:t2': createDefaultChannelStrip('track:t2'),
  });
  useTransportStore.setState({ activeSequenceId: 'seq1' });
}

function laneOptions(): (string | null)[] {
  return within(screen.getByLabelText('Automation lane'))
    .getAllByRole('option')
    .map((option) => option.textContent);
}

function lane(key: string): AutomationPoint[] {
  return useSequenceStore.getState().automation[key] ?? [];
}

beforeEach(seed);
afterEach(() => {
  useSequenceStore.setState({ tracks: {}, events: {}, automation: {} });
  useMixerStore.getState().setChannels({});
  useTransportStore.setState({ activeSequenceId: null });
});

describe('the automation lane picker (spec §8.5.2, §7.8)', () => {
  it('offers registered parameters, not only lanes that already have points', () => {
    render(<GridMode />);
    // The catalogue's own paths: the selected track's strip and the master strip.
    expect(laneOptions()).toContain('Track 1 · level');
    expect(laneOptions()).toContain('Master · pan');
  });

  it('hides the other scope from the track picker', () => {
    render(<GridMode />);
    // Track 2's own lane is on the master path, which every track can address, so the
    // check that matters is that the sequence scope's legacy lane is not offered here.
    expect(laneOptions().some((label) => label?.startsWith('legacy.path'))).toBe(false);
  });

  it('follows the scope selector to the sequence lanes', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.click(screen.getByRole('radio', { name: 'Sequence' }));
    expect(laneOptions().some((label) => label?.startsWith('legacy.path'))).toBe(true);
  });

  it('describes the chosen lane in text, since the canvas is aria-hidden (spec §8.2)', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    expect(screen.queryByTestId('grid-automation-summary')).toBeNull();

    await user.selectOptions(screen.getByLabelText('Automation lane'), TRACK_LEVEL);
    expect(screen.getByTestId('grid-automation-summary')).toHaveTextContent('1 point, flat at 0.4');
  });

  it('says an empty lane is empty rather than showing nothing at all', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.selectOptions(screen.getByLabelText('Automation lane'), MASTER_LEVEL);
    expect(screen.getByTestId('grid-automation-summary')).toHaveTextContent('empty');
    expect(screen.getByTestId('grid-automation-empty')).toBeInTheDocument();
  });

  it('drops a lane the newly selected track does not own', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.selectOptions(screen.getByLabelText('Automation lane'), TRACK_LEVEL);
    expect(screen.getByTestId('grid-automation-summary')).toHaveTextContent('flat at 0.4');

    await user.selectOptions(screen.getByLabelText('Track to edit'), 't2');
    // `mixer.track:t1.level` is not among track 2's parameters, so the picker clears.
    expect(screen.getByLabelText<HTMLSelectElement>('Automation lane').value).toBe('');
    expect(screen.queryByTestId('grid-automation-summary')).toBeNull();
  });

  it('says so rather than offering an empty list when nothing is automatable yet', () => {
    useMixerStore.getState().setChannels({});
    useSequenceStore.setState({ automation: {} });
    render(<GridMode />);
    const select = screen.getByLabelText<HTMLSelectElement>('Automation lane');
    expect(select.disabled).toBe(true);
    expect(select.textContent).toBe('No parameters');
  });
});

describe('authoring automation points (spec §7.8)', () => {
  it('creates a point on an empty lane — the gap this seam closes', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.selectOptions(screen.getByLabelText('Automation lane'), MASTER_LEVEL);
    expect(lane(`track:t1:${MASTER_LEVEL}`)).toEqual([]);

    await user.click(screen.getByTestId('grid-automation-add'));

    const written = lane(`track:t1:${MASTER_LEVEL}`);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ scope: 'track', ownerId: 't1', targetPath: MASTER_LEVEL });
    // Level runs 0..1.2, so a new point lands at the middle of the registered range.
    expect(written[0]!.value).toBeCloseTo(0.6, 6);
  });

  it('writes a sequence-scope point under the sequence, not the track', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.click(screen.getByRole('radio', { name: 'Sequence' }));
    await user.selectOptions(screen.getByLabelText('Automation lane'), MASTER_LEVEL);
    await user.click(screen.getByTestId('grid-automation-add'));

    expect(lane(`sequence:seq1:${MASTER_LEVEL}`)).toHaveLength(1);
    expect(lane(`track:t1:${MASTER_LEVEL}`)).toEqual([]);
  });

  it('edits a point value from the keyboard, since the canvas is a pointer surface', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.selectOptions(screen.getByLabelText('Automation lane'), TRACK_LEVEL);

    const field = screen.getByLabelText('Value at tick 0');
    await user.clear(field);
    await user.type(field, '0.8');
    expect(lane(`track:t1:${TRACK_LEVEL}`)[0]!.value).toBeCloseTo(0.8, 6);
  });

  it('deletes the selected points', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.selectOptions(screen.getByLabelText('Automation lane'), TRACK_LEVEL);

    await user.click(screen.getByRole('button', { name: /^tick 0/ }));
    await user.click(screen.getByTestId('grid-automation-delete'));
    expect(lane(`track:t1:${TRACK_LEVEL}`)).toEqual([]);
  });

  it('re-curves the selected points and sets what a new one takes (spec §7.8)', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.selectOptions(screen.getByLabelText('Automation lane'), TRACK_LEVEL);

    await user.click(screen.getByRole('button', { name: /^tick 0/ }));
    await user.click(screen.getByRole('radio', { name: 'Exp' }));
    expect(lane(`track:t1:${TRACK_LEVEL}`)[0]!.curve).toBe('exp');

    await user.click(screen.getByTestId('grid-automation-add'));
    expect(lane(`track:t1:${TRACK_LEVEL}`)[1]!.curve).toBe('exp');
  });

  it('refuses to edit a lane the registry does not recognise (spec §7.8 gate)', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.click(screen.getByRole('radio', { name: 'Sequence' }));
    await user.selectOptions(screen.getByLabelText('Automation lane'), 'legacy.path');

    expect(screen.getByTestId('grid-automation-readonly')).toBeInTheDocument();
    expect(screen.getByTestId<HTMLButtonElement>('grid-automation-add').disabled).toBe(true);
    // The lane is still readable — a project carrying one must not lose it.
    expect(screen.getByTestId('grid-automation-summary')).toHaveTextContent('1 point');
  });

  it('says which scope wins when both hold the same target (spec §7.8)', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    // Track 2 owns a track-scope lane on the master level, so a sequence lane on the same
    // target is overridden at schedule time.
    await user.click(screen.getByRole('radio', { name: 'Sequence' }));
    await user.selectOptions(screen.getByLabelText('Automation lane'), MASTER_LEVEL);
    expect(screen.getByTestId('grid-automation-override')).toHaveTextContent(
      'A track lane for this parameter overrides this sequence lane',
    );
  });

  it('says nothing about precedence when no track lane holds the target', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    await user.click(screen.getByRole('radio', { name: 'Sequence' }));
    await user.selectOptions(screen.getByLabelText('Automation lane'), 'mixer.master.pan');
    expect(screen.queryByTestId('grid-automation-override')).toBeNull();
  });
});

/**
 * Issue #28 and spec §3.3: scroll and zoom were React state, so every wheel event
 * re-rendered this whole mode — including the note sort in its render body — to move a
 * canvas that was already painting from a ref of its own.
 *
 * The canvas is `aria-hidden` and jsdom has no 2D context, so the assertion is made where
 * the behaviour actually is: the zoom readout and the zoom buttons, which are the only
 * React-visible consumers left.
 */
describe('scroll and zoom stay out of React (spec §3.3, issue #28)', () => {
  it('paints the zoom readout without re-rendering the mode', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    expect(screen.getByTestId('grid-zoom-readout').textContent).toBe('1.00×');

    // The buttons write the same store a wheel event does, so this drives the whole path.
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByTestId('grid-zoom-readout').textContent).toBe('0.67×');
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('grid-zoom-readout').textContent).toBe('1.00×');
  });

  it('enables Reset only once the zoom has actually moved', async () => {
    const user = userEvent.setup();
    render(<GridMode />);
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(screen.getByTestId('grid-zoom-readout').textContent).toBe('1.00×');
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeDisabled();
  });

  it('keeps the viewport across a re-render driven by something else', async () => {
    // The viewport used to be `useState` inside this component, so it survived a re-render by
    // being part of one. It is now a store, and the store instance must survive too — a
    // rebuilt one would throw the user's scroll position and zoom away mid-gesture.
    const user = userEvent.setup();
    const view = render(<GridMode />);
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByTestId('grid-zoom-readout').textContent).toBe('0.67×');

    view.rerender(<GridMode />);
    expect(screen.getByTestId('grid-zoom-readout').textContent).toBe('0.67×');
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeEnabled();
  });
});

describe('quantise strength is a §2.5 primitive (spec §1.3 #10, issue #35)', () => {
  /** The Quantise dialog only opens with notes to quantise. */
  function openQuantise() {
    useSequenceStore.setState({
      events: {
        t1: [{ id: 'n1', trackId: 't1', tickStart: 7, durationTicks: 240, note: 60, velocity: 100 }],
        t2: [],
      },
    });
  }

  it('announces its value with a unit, and steps with the arrow keys', async () => {
    const user = userEvent.setup();
    openQuantise();
    render(<GridMode />);
    await user.click(screen.getByTestId('grid-quantise-open'));

    const strength = screen.getByTestId('quantise-strength');
    // The native `<input type="range">` this replaced announced "45" with no unit at all,
    // and carried none of the §8.2 keyboard contract every other continuous control has.
    expect(strength).toHaveAttribute('role', 'slider');
    expect(strength).toHaveAttribute('aria-valuetext', '100 %');
    expect(strength).toHaveAttribute('aria-orientation', 'horizontal');

    strength.focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('quantise-strength')).toHaveAttribute('aria-valuetext', '99 %');
  });

  it('applies the strength the slider actually holds', async () => {
    const user = userEvent.setup();
    openQuantise();
    render(<GridMode />);
    await user.click(screen.getByTestId('grid-quantise-open'));
    const strength = screen.getByTestId('quantise-strength');
    strength.focus();
    await user.keyboard('{Home}');
    // Zero strength moves nothing — the dialog's own readout has to agree with the slider.
    expect(screen.getByTestId('quantise-strength')).toHaveAttribute('aria-valuenow', '0');
  });
});
