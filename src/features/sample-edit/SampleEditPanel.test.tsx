import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SampleRow } from '@/core/storage/repositories';
import { useBrowserStore, useSequenceStore, useUIStore } from '@/store';

// The panel is exercised for its groove target, not its audio: the peak pyramid and the
// bake itself are stubbed so the test needs neither OPFS nor an audio engine.
vi.mock('@/core/audio/peakPyramidCache', () => ({
  getPeakPyramid: vi.fn(async () => ({ frames: 48_000, levels: [] })),
}));
const bake = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/core/audio/grooveService', () => ({ extractAndBakeGroove: bake }));
vi.mock('./sampleContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sampleContext')>()),
  refreshSamples: vi.fn(async () => undefined),
  reloadSampleList: vi.fn(async () => undefined),
  sampleEditContext: vi.fn(() => ({})),
}));

import { SampleEditPanel } from './SampleEditPanel';

const sample: SampleRow = {
  id: 's1',
  project_id: 'p1',
  name: 'loop.wav',
  opfs_path: '/samples/loop.wav',
  frames: 48_000,
  sample_rate: 48_000,
  channels: 2,
  root_note: 60,
  created_at: 0,
};

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

describe('SampleEditPanel groove bake (spec §7.5, §8.5.4)', () => {
  beforeEach(() => {
    bake.mockClear();
    useBrowserStore.setState({ samples: [sample], samplesError: null });
    useSequenceStore.setState({ tracks: { t1: track('t1', 0), t2: track('t2', 1) } });
  });
  afterEach(() => {
    useBrowserStore.setState({ samples: [], samplesError: null });
    useSequenceStore.setState({ tracks: {} });
  });

  /** Select the sample, which is what reveals the editing tools. */
  async function open(user: ReturnType<typeof userEvent.setup>) {
    render(<SampleEditPanel />);
    await user.click(screen.getByRole('button', { name: /loop\.wav/ }));
  }

  it('lets the user choose the track the groove is baked into', async () => {
    const user = userEvent.setup();
    await open(user);

    const picker = await screen.findByLabelText('Track to bake the groove into');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Track 1', 'Track 2']);

    await user.selectOptions(picker, 't2');
    await user.click(screen.getByTestId('sample-groove'));
    expect(bake).toHaveBeenCalledWith(sample, 't2', expect.any(Number));
  });

  /**
   * The bug in issue #55: the bake took `Object.values(tracks)[0]` and reported a generic
   * "Groove bake complete.", so there was no way to tell where the groove had landed.
   */
  it('names the target track in the result message', async () => {
    const user = userEvent.setup();
    await open(user);
    await user.click(await screen.findByTestId('sample-groove'));
    await vi.waitFor(() => {
      const messages = useUIStore.getState().toasts.map((toast) => toast.message);
      expect(messages).toContain('Groove bake to Track 1 complete.');
    });
  });

  it('disables the bake when there is no track to bake into', async () => {
    useSequenceStore.setState({ tracks: {} });
    const user = userEvent.setup();
    await open(user);
    expect(await screen.findByTestId('sample-groove')).toBeDisabled();
  });
});
