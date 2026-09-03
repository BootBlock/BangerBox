/**
 * The §9.5 bounces reach the user (issue #104).
 *
 * Three of the four §9.5 paths rendered a WAV correctly, encoded it correctly, wrote it to
 * `/projects/{id}/bounces/` — and stopped. That directory is OPFS: no part of the UI browses
 * it, no file manager can open it, and a `.mpcweb` export packs the project rather than its
 * bounces. So the file was write-only storage that also counted against the §9.7 headroom,
 * while the toast reported success. §3.4 forbids a dead control; one that claims to have
 * worked is worse.
 *
 * These assert the step that was missing — the read-back and the download — rather than the
 * render, which was never the defect.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bounceActiveSequence = vi.fn();
const resampleSequenceToSample = vi.fn();
const bounceSong = vi.fn();
const readFile = vi.fn();
const downloadBlob = vi.fn();
const refreshSamples = vi.fn();

vi.mock('@/core/audio/bounceService', () => ({
  bounceActiveSequence: (name: string, ctx: unknown) => bounceActiveSequence(name, ctx),
  bounceSong: (name: string, ctx: unknown) => bounceSong(name, ctx),
  bounceTrack: vi.fn(),
  resampleSequenceToSample: (name: string, ctx: unknown) => resampleSequenceToSample(name, ctx),
}));

vi.mock('@/core/platform/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/platform/download')>();
  return { ...actual, downloadBlob: (blob: Blob, filename: string) => downloadBlob(blob, filename) };
});

vi.mock('@/core/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/project')>();
  return {
    ...actual,
    getActiveRepositories: () => ({ samples: { tagsFor: vi.fn().mockResolvedValue([]) } }),
    getAudioEngine: () => null,
    projectService: { exportMpcweb: vi.fn(), importMpcweb: vi.fn() },
  };
});

vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return { ...actual, readFile: (path: string) => readFile(path), deleteFile: vi.fn() };
});

vi.mock('../sample-edit/sampleContext', () => ({
  auditionSample: vi.fn(),
  refreshSamples: () => refreshSamples(),
  reloadSampleList: () => Promise.resolve(),
  sampleEditContext: () => ({}),
}));

vi.mock('./FolderTree', () => ({ FolderTree: () => null }));
vi.mock('./FactorySection', () => ({ FactorySection: () => null }));
vi.mock('./SampleWaveformThumb', () => ({ SampleWaveformThumb: () => null }));

const { BrowserPanel } = await import('./BrowserPanel');
const { SongMode } = await import('../song/SongMode');
const { useBrowserStore, useProjectStore, useSequenceStore, useTransportStore, useUIStore } =
  await import('@/store');

const BOUNCED = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'audio/wav' });

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue(BOUNCED);
  refreshSamples.mockResolvedValue(undefined);
  bounceActiveSequence.mockResolvedValue('/projects/project-a/bounces/bounce.wav');
  bounceSong.mockResolvedValue('/projects/project-a/bounces/song.wav');
  useProjectStore.setState({ projectId: 'project-a', projectName: 'My Track' });
  useUIStore.setState({ toasts: [] });
  useBrowserStore.setState({
    samples: [],
    samplesError: null,
    currentPath: '/projects/project-a/samples',
    textFilter: '',
    tagFilter: [],
    favourites: [],
  });
});

describe('bounce song (spec §9.5, issue #104)', () => {
  beforeEach(() => {
    useSequenceStore.setState({
      sequences: {
        seq1: {
          id: 'seq1',
          projectId: 'project-a',
          position: 0,
          name: 'Sequence 1',
          lengthBars: 2,
          timeSig: { numerator: 4, denominator: 4 },
          tempo: null,
          swingAmount: 50,
          swingDivision: 16,
        },
      },
      songEntries: [{ id: 'e1', position: 0, sequenceId: 'seq1', repeats: 1 }],
    });
    useTransportStore.setState({ bpm: 120 });
  });

  it('reads the rendered file back and hands it to the user', async () => {
    const user = userEvent.setup();
    render(<SongMode />);
    await user.click(screen.getByTestId('song-bounce'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(readFile).toHaveBeenCalledWith('/projects/project-a/bounces/song.wav');
    expect(downloadBlob.mock.calls[0]![0]).toBe(BOUNCED);
    expect(downloadBlob.mock.calls[0]![1]).toBe('My-Track-song.wav');
  });

  it('does not claim success when the render failed', async () => {
    bounceSong.mockRejectedValue(new Error('The song playlist is empty.'));
    const user = userEvent.setup();
    render(<SongMode />);
    await user.click(screen.getByTestId('song-bounce'));

    await waitFor(() => expect(useUIStore.getState().toasts.map((toast) => toast.tone)).toContain('error'));
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe('resample to pad (spec §9.5, issue #104)', () => {
  it('creates the sample and opens the target chooser on it', async () => {
    // §9.5 names this resample-to-PAD. It had no caller at all, so it sat in the
    // `check:orphans` allowlist; landing in the library and stopping there would still leave
    // the last step of the named feature for the user to find on their own.
    resampleSequenceToSample.mockResolvedValue({
      id: 'sample-new',
      project_id: 'project-a',
      name: 'My-Track-resample',
      opfs_path: '/projects/project-a/samples/sample-new.wav',
      frames: 48_000,
      sample_rate: 48_000,
      channels: 2,
      root_note: 60,
      created_at: 0,
    });
    const user = userEvent.setup();
    render(<BrowserPanel />);
    await user.click(screen.getByTestId('resample-to-pad'));

    await waitFor(() => expect(resampleSequenceToSample).toHaveBeenCalledTimes(1));
    expect(resampleSequenceToSample.mock.calls[0]![0]).toBe('My-Track-resample');
    // The library listing is reloaded, or the new sample would not appear until a mode switch.
    await waitFor(() => expect(refreshSamples).toHaveBeenCalled());
    // The chooser is open ON THE NEW SAMPLE — that is what turns a library row into a pad.
    expect(await screen.findByRole('dialog')).toHaveTextContent(/My-Track-resample/);
  });

  it('reports a failure rather than opening an empty chooser', async () => {
    resampleSequenceToSample.mockRejectedValue(new Error('No active sequence to bounce.'));
    const user = userEvent.setup();
    render(<BrowserPanel />);
    await user.click(screen.getByTestId('resample-to-pad'));

    await waitFor(() =>
      expect(
        useUIStore
          .getState()
          .toasts.map((toast) => toast.message)
          .join(' '),
      ).toMatch(/No active sequence/),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('bounce sequence keeps its download (spec §9.5)', () => {
  it('still reads the file back — the one path that always did', async () => {
    const user = userEvent.setup();
    render(<BrowserPanel />);
    await user.click(screen.getByTestId('bounce-sequence'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadBlob.mock.calls[0]![1]).toBe('My-Track-bounce.wav');
  });
});

/**
 * A long operation says what IT is doing (issue #54, review of that work).
 *
 * One shared `busy` flag gated every control correctly and labelled them all wrongly: a
 * bounce relabelled the import pickers "Importing…" and marked them `aria-disabled`, which is
 * the opposite of the missing-progress problem the issue is about.
 */
describe('the running operation names itself (issue #54)', () => {
  it('relabels the bounce, and leaves the import pickers saying what they are', async () => {
    let release: (path: string) => void = () => {};
    bounceActiveSequence.mockImplementation(
      () => new Promise((resolve) => (release = resolve as (path: string) => void)),
    );

    const user = userEvent.setup();
    render(<BrowserPanel />);
    await user.click(screen.getByTestId('bounce-sequence'));

    expect(screen.getByTestId('bounce-sequence')).toHaveTextContent('Bouncing…');
    expect(screen.getByText('Import .mpcweb…')).toBeInTheDocument();
    expect(screen.queryByText('Importing…')).not.toBeInTheDocument();
    // Still gated, which was always right — just not relabelled.
    expect(screen.getByTestId('project-import')).toBeDisabled();

    release('/projects/project-a/bounces/bounce.wav');
    await waitFor(() => expect(screen.getByTestId('bounce-sequence')).toHaveTextContent('Bounce sequence'));
    await waitFor(() => expect(screen.getByTestId('project-import')).toBeEnabled());
  });
});
