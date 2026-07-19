/**
 * "Purge unused samples" — the confirmation gate (spec §8.5.7, §8.1).
 *
 * These tests guard the most destructive action in normal operation: it deletes audio from
 * OPFS permanently and outside the undo stack. The cases that matter are the refusals — that
 * one tap never deletes, and that an unreadable reference set deletes nothing rather than
 * treating "no answer" as "nothing is used".
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const remove = vi.fn();
const tagsFor = vi.fn();
const listByProject = vi.fn();
const allPayloads = vi.fn();
const getActiveRepositories = vi.fn();
const deleteFile = vi.fn();

vi.mock('@/core/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/project')>();
  return {
    ...actual,
    getActiveRepositories: () => getActiveRepositories(),
    getAudioEngine: () => null,
    projectService: { exportMpcweb: vi.fn(), importMpcweb: vi.fn() },
  };
});

vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return { ...actual, deleteFile: (path: string) => deleteFile(path), readFile: vi.fn() };
});

vi.mock('../sample-edit/sampleContext', () => ({
  auditionSample: vi.fn(),
  refreshSamples: () => Promise.resolve(),
  reloadSampleList: () => Promise.resolve(),
  sampleEditContext: () => ({}),
}));

// The tree and the factory listing are covered by their own suites, and both reach for
// storage the moment they render.
vi.mock('./FolderTree', () => ({ FolderTree: () => null }));
vi.mock('./FactorySection', () => ({ FactorySection: () => null }));
vi.mock('./SampleWaveformThumb', () => ({ SampleWaveformThumb: () => null }));

const { BrowserPanel } = await import('./BrowserPanel');
const { useBrowserStore, useProjectStore } = await import('@/store');

const KICK = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Kick.wav', opfs_path: '/s/kick.wav' };
const SNARE = { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Snare.wav', opfs_path: '/s/snare.wav' };

/** Open the review dialog and wait for it, the precondition for every deletion test. */
async function openPurgeDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('purge-unused'));
  return screen.findByTestId('purge-confirm-dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  tagsFor.mockResolvedValue([]);
  remove.mockResolvedValue(undefined);
  deleteFile.mockResolvedValue(undefined);
  listByProject.mockResolvedValue({ rows: [] });
  allPayloads.mockResolvedValue([]);
  getActiveRepositories.mockReturnValue({
    samples: { remove, tagsFor },
    programs: { listByProject, allPayloads },
  });
  useProjectStore.setState({ projectId: 'project-a' });
  useBrowserStore.setState({
    samples: [KICK, SNARE],
    samplesError: null,
    currentPath: '/projects/project-a/samples',
    textFilter: '',
    tagFilter: [],
    favourites: [],
  });
});

describe('Purge confirmation (spec §8.5.7, §8.1)', () => {
  it('deletes nothing on the first tap, and names what it would delete', async () => {
    const user = userEvent.setup();
    render(<BrowserPanel />);

    const dialog = await openPurgeDialog(user);

    // The whole point of the ticket: one tap used to erase the library outright.
    expect(deleteFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    const list = within(dialog).getByRole('list', { name: 'Samples to be deleted' });
    expect(within(list).getByText('Kick.wav')).toBeInTheDocument();
    expect(within(list).getByText('Snare.wav')).toBeInTheDocument();
  });

  it('deletes only after the second, explicit confirmation', async () => {
    const user = userEvent.setup();
    render(<BrowserPanel />);
    await openPurgeDialog(user);

    await user.click(screen.getByTestId('purge-confirm'));

    await waitFor(() => expect(deleteFile).toHaveBeenCalledTimes(2));
    expect(deleteFile).toHaveBeenCalledWith('/s/kick.wav');
    expect(remove).toHaveBeenCalledWith(KICK.id);
    expect(remove).toHaveBeenCalledWith(SNARE.id);
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    render(<BrowserPanel />);
    const dialog = await openPurgeDialog(user);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('purge-confirm-dialog')).not.toBeInTheDocument());
    expect(deleteFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('spares a sample the project still references', async () => {
    listByProject.mockResolvedValue({ rows: [{ payload: JSON.stringify({ sampleId: KICK.id }) }] });
    const user = userEvent.setup();
    render(<BrowserPanel />);

    const dialog = await openPurgeDialog(user);

    const list = within(dialog).getByRole('list', { name: 'Samples to be deleted' });
    expect(within(list).queryByText('Kick.wav')).not.toBeInTheDocument();
    expect(within(list).getByText('Snare.wav')).toBeInTheDocument();
  });

  it('says so, rather than opening an empty dialog, when nothing is unused', async () => {
    listByProject.mockResolvedValue({
      rows: [{ payload: JSON.stringify({ pads: [KICK.id, SNARE.id] }) }],
    });
    const user = userEvent.setup();
    render(<BrowserPanel />);

    await user.click(screen.getByTestId('purge-unused'));

    await waitFor(() => expect(listByProject).toHaveBeenCalled());
    expect(screen.queryByTestId('purge-confirm-dialog')).not.toBeInTheDocument();
  });
});

describe('Purge fail-safes (spec §8.5.7, §5.1)', () => {
  it('deletes nothing when the reference set cannot be read', async () => {
    // An unreadable program table is indistinguishable from "no program uses anything".
    listByProject.mockRejectedValue(new Error('database unreachable'));
    const user = userEvent.setup();
    render(<BrowserPanel />);

    await user.click(screen.getByTestId('purge-unused'));

    await waitFor(() => expect(listByProject).toHaveBeenCalled());
    expect(screen.queryByTestId('purge-confirm-dialog')).not.toBeInTheDocument();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('is unavailable with no project open, when nothing could judge a project sample', async () => {
    useProjectStore.setState({ projectId: '' });
    render(<BrowserPanel />);

    expect(screen.getByTestId('purge-unused')).toBeDisabled();
  });

  it('is unavailable while the sample list is in error', async () => {
    useBrowserStore.setState({ samplesError: 'query failed.' });
    render(<BrowserPanel />);

    expect(screen.getByTestId('purge-unused')).toBeDisabled();
  });
});
