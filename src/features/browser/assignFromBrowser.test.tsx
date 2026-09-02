/**
 * Assigning from a Browser row — spec §8.5.7.
 *
 * The row's Assign control used to arm `dragDropPayload` and raise a toast telling the user
 * to "open Program Edit and choose a pad", where no affordance existed to receive them
 * (issue #37). It now opens the target chooser, and the drag still arms the payload for the
 * Program Edit drop targets.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tagsFor = vi.fn();
const getActiveRepositories = vi.fn();

vi.mock('@/core/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/project')>();
  return {
    ...actual,
    getActiveRepositories: () => getActiveRepositories(),
    getAudioEngine: () => null,
    projectService: { exportMpcweb: vi.fn(), importMpcweb: vi.fn() },
  };
});

vi.mock('../sample-edit/sampleContext', () => ({
  auditionSample: vi.fn(),
  refreshSamples: () => Promise.resolve(),
  reloadSampleList: () => Promise.resolve(),
  sampleEditContext: () => ({}),
}));

vi.mock('./FolderTree', () => ({ FolderTree: () => null }));
vi.mock('./FactorySection', () => ({ FactorySection: () => null }));
vi.mock('./SampleWaveformThumb', () => ({ SampleWaveformThumb: () => null }));

const { BrowserPanel } = await import('./BrowserPanel');
const { useBrowserStore, useProgramStore, useProjectStore, useUIStore } = await import('@/store');
const { createDefaultDrumProgram } = await import('@/core/project/schemas');

const KICK = {
  id: 'sample-kick',
  project_id: 'project-a',
  name: 'Kick.wav',
  opfs_path: '/projects/project-a/samples/sample-kick.wav',
  frames: 4_800,
  sample_rate: 48_000,
  channels: 1 as const,
  root_note: 60,
  created_at: 0,
};

const DRUM_ID = 'drum-1';

beforeEach(() => {
  vi.clearAllMocks();
  tagsFor.mockResolvedValue([]);
  getActiveRepositories.mockReturnValue({ samples: { tagsFor } });
  useProjectStore.setState({ projectId: 'project-a' });
  useUIStore.setState({ dragDropPayload: null, toasts: [], activeMode: 'browser' });
  useProgramStore.getState().setPrograms({ [DRUM_ID]: createDefaultDrumProgram('Kit', DRUM_ID) });
  useProgramStore.getState().setActiveProgram(DRUM_ID);
  useBrowserStore.setState({
    samples: [KICK],
    samplesError: null,
    currentPath: '/projects/project-a/samples',
    textFilter: '',
    tagFilter: [],
    favourites: [],
  });
});

describe('Assign from a Browser row (spec §8.5.7)', () => {
  it('opens the target chooser and assigns to the chosen pad', async () => {
    const user = userEvent.setup();
    render(<BrowserPanel />);

    await user.click(screen.getByTestId(`browser-assign-${KICK.id}`));
    await user.click(await screen.findByTestId('assign-pad-2'));

    await waitFor(() => {
      const program = useProgramStore.getState().programs[DRUM_ID]!;
      expect(program.type === 'drum' && program.pads[0]).toMatchObject({ padIndex: 2 });
      expect(program.type === 'drum' && program.pads[0]?.layers[0]?.sampleId).toBe(KICK.id);
    });
    // The chooser closes on success, so the user is not left dismissing a dialog by hand.
    // `waitFor` because Modal exits through AnimatePresence rather than unmounting at once.
    await waitFor(() => {
      expect(screen.queryByTestId('assign-target-dialog')).toBeNull();
    });
  });

  it('arms dragDropPayload on a drag, for the Program Edit drop targets', () => {
    render(<BrowserPanel />);

    // A real dragstart carries a DataTransfer; happy-dom's bare Event does not, so one is
    // supplied here. The handler writes to it so an engine that aborts a data-less drag
    // still starts one.
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    screen.getByTestId(`browser-assign-${KICK.id}`).dispatchEvent(event);

    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', KICK.name);
    expect(useUIStore.getState().dragDropPayload).toEqual({
      sampleId: KICK.id,
      name: KICK.name,
      rootNote: KICK.root_note,
    });
  });

  it('arms the sample and opens Program Edit when the user chooses the pad grid', async () => {
    const user = userEvent.setup();
    render(<BrowserPanel />);

    await user.click(screen.getByTestId(`browser-assign-${KICK.id}`));
    await user.click(await screen.findByTestId('assign-arm-for-grid'));

    // This is the only route by which `dragDropPayload` is reachable: Browser and Program Edit
    // are separate §8.5 modes, so a pointer drag between them can never happen.
    expect(useUIStore.getState().dragDropPayload).toEqual({
      sampleId: KICK.id,
      name: KICK.name,
      rootNote: KICK.root_note,
    });
    expect(useUIStore.getState().activeMode).toBe('program-edit');
    // Nothing is assigned yet — the user still chooses the pad.
    const program = useProgramStore.getState().programs[DRUM_ID]!;
    expect(program.type === 'drum' && program.pads).toHaveLength(0);
  });

  it('names the control for what it does, rather than for a drag touch cannot perform', () => {
    render(<BrowserPanel />);
    expect(screen.getByRole('button', { name: `Assign ${KICK.name} to a pad or zone` })).toBeVisible();
  });
});
