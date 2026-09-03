/**
 * Stem bounce from the Mixer's track strip (spec §9.5, issue #104).
 *
 * `bounceTrack` was a complete, tested §9.5 path with **no caller anywhere in the
 * repository** — it sat in the `check:orphans` allowlist for exactly that reason. It belongs
 * on the track strip because a stem is what that strip is: post-insert, pre-master (§8.5.6).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bounceTrack = vi.fn();
const readFile = vi.fn();
const downloadBlob = vi.fn();

vi.mock('@/core/audio/bounceService', () => ({
  bounceActiveSequence: vi.fn(),
  bounceSong: vi.fn(),
  bounceTrack: (trackId: string, name: string, ctx: unknown) => bounceTrack(trackId, name, ctx),
  resampleSequenceToSample: vi.fn(),
}));

vi.mock('@/core/platform/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/platform/download')>();
  return { ...actual, downloadBlob: (blob: Blob, filename: string) => downloadBlob(blob, filename) };
});

vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return { ...actual, readFile: (path: string) => readFile(path) };
});

vi.mock('../sample-edit/sampleContext', () => ({ sampleEditContext: () => ({}) }));
vi.mock('@/core/project/session', () => ({ getAudioEngine: () => null }));
// The meter canvas reaches for the engine's SAB registry the moment it mounts.
vi.mock('@/ui/primitives/MeterCanvas', () => ({ MeterCanvas: () => null }));

const { MixerMode } = await import('./MixerMode');
const { useMixerStore, useProjectStore, useSequenceStore, useTransportStore, useUIStore } =
  await import('@/store');
const { createDefaultChannelStrip } = await import('@/core/project/schemas');

const TRACK = {
  id: 't1',
  sequenceId: 'seq1',
  programId: null,
  position: 0,
  name: 'Drums',
  type: 'drum' as const,
};

const STEM = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'audio/wav' });

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue(STEM);
  bounceTrack.mockResolvedValue('/projects/project-a/bounces/stem-t1.wav');
  useProjectStore.setState({ projectId: 'project-a', projectName: 'My Track' });
  useUIStore.setState({ toasts: [] });
  useTransportStore.setState({ activeSequenceId: 'seq1' });
  useSequenceStore.setState({ tracks: { t1: TRACK }, events: { t1: [] }, automation: {} });
  useMixerStore.getState().setChannels({ 'track:t1': createDefaultChannelStrip('track:t1') });
});

describe('bounce stem (spec §9.5, issue #104)', () => {
  it('renders the track and hands the WAV to the user', async () => {
    const user = userEvent.setup();
    render(<MixerMode />);
    await user.click(screen.getByTestId('mixer-bounce-track:t1'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    // The track id, not the channel id: `bounceTrack` addresses the §9.3 tracks row.
    expect(bounceTrack.mock.calls[0]![0]).toBe('t1');
    expect(readFile).toHaveBeenCalledWith('/projects/project-a/bounces/stem-t1.wav');
    expect(downloadBlob.mock.calls[0]![1]).toBe('My-Track-Drums.wav');
  });

  it('offers no stem on a strip that is not a track', async () => {
    // A pad, a return and the master are not §9.5 stems: "bounce selected TRACK" is what the
    // spec names, and the pre-master point only means anything for a track group.
    const user = userEvent.setup();
    render(<MixerMode />);
    await user.click(screen.getByRole('radio', { name: 'Master' }));
    expect(await screen.findByTestId('mixer-strip-master')).toBeInTheDocument();
    expect(screen.queryByTestId('mixer-bounce-master')).not.toBeInTheDocument();
  });

  it('reports a failure rather than a silent nothing', async () => {
    bounceTrack.mockRejectedValue(new Error('No active sequence to bounce.'));
    const user = userEvent.setup();
    render(<MixerMode />);
    await user.click(screen.getByTestId('mixer-bounce-track:t1'));

    await waitFor(() =>
      expect(
        useUIStore
          .getState()
          .toasts.map((toast) => toast.message)
          .join(' '),
      ).toMatch(/No active sequence/),
    );
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
