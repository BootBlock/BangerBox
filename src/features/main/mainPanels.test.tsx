/**
 * The Main-mode CRUD panels (issue #40, spec §8.5.1).
 *
 * The issue was that these actions existed and were tested but no component reached them,
 * so these tests assert the wiring specifically: that a click on a rendered control moves
 * the store. They also cover the recent-projects list, whose repository read is the one
 * part of this surface that talks to storage.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listRecent = vi.fn();
const loadProject = vi.fn();
const newProject = vi.fn();

vi.mock('@/core/project/projectService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/project/projectService')>();
  return { ...actual, getActiveRepositories: () => ({ projects: { listRecent } }) };
});

vi.mock('@/core/project/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/project/service')>();
  return {
    ...actual,
    getProjectService: () => ({
      newProject: (name?: string) => newProject(name),
      loadProject: (id: string) => loadProject(id),
      saveNow: vi.fn(),
      exportMpcweb: vi.fn(),
      importMpcweb: vi.fn(),
    }),
  };
});

const { SequencesPanel } = await import('./SequencesPanel');
const { TracksPanel } = await import('./TracksPanel');
const { ProjectsPanel } = await import('./ProjectsPanel');
const { createDefaultDrumProgram, createDefaultSequence, createDefaultTrack } =
  await import('@/core/project/schemas');
const { useProgramStore, useProjectStore, useSequenceStore, useTransportStore } = await import('@/store');

const PROGRAM = createDefaultDrumProgram('Program 1');
const SEQUENCE = createDefaultSequence('project-1', 0, 'Sequence 1');
const TRACK = createDefaultTrack(SEQUENCE.id, PROGRAM.id, 0, 'Track 1');

beforeEach(() => {
  vi.clearAllMocks();
  listRecent.mockResolvedValue({ rows: [] });
  newProject.mockResolvedValue('project-2');
  loadProject.mockResolvedValue(undefined);

  useProjectStore.getState().applyProject({
    projectId: 'project-1',
    projectName: 'Test Project',
    sampleRate: 48_000,
    bitDepth: '24',
    globalInsertLimit: 4,
  });
  useProgramStore.getState().setPrograms({ [PROGRAM.id]: PROGRAM });
  useProgramStore.getState().setActiveProgram(PROGRAM.id);
  useSequenceStore.getState().hydrate({
    sequences: { [SEQUENCE.id]: SEQUENCE },
    tracks: { [TRACK.id]: TRACK },
    events: {},
    automation: {},
    songEntries: [],
  });
  useTransportStore.getState().setActiveSequenceId(SEQUENCE.id);
});

describe('SequencesPanel', () => {
  it('adds a sequence — the action #40 reported no component could reach', async () => {
    const user = userEvent.setup();
    render(<SequencesPanel />);
    expect(Object.keys(useSequenceStore.getState().sequences)).toHaveLength(1);

    await user.click(screen.getByTestId('main-add-sequence'));
    expect(Object.keys(useSequenceStore.getState().sequences)).toHaveLength(2);
  });

  it('renames a sequence inline on Enter', async () => {
    const user = userEvent.setup();
    render(<SequencesPanel />);

    await user.click(screen.getByRole('button', { name: 'Rename Sequence 1' }));
    const input = screen.getByTestId('main-sequence-rename-input');
    await user.clear(input);
    await user.type(input, 'Verse{Enter}');

    expect(useSequenceStore.getState().sequences[SEQUENCE.id]!.name).toBe('Verse');
  });

  it('abandons the rename on Escape', async () => {
    const user = userEvent.setup();
    render(<SequencesPanel />);

    await user.click(screen.getByRole('button', { name: 'Rename Sequence 1' }));
    await user.type(screen.getByTestId('main-sequence-rename-input'), 'Discarded{Escape}');

    expect(useSequenceStore.getState().sequences[SEQUENCE.id]!.name).toBe('Sequence 1');
  });

  it('disables Add while the boot path has yet to open a project', () => {
    useProjectStore.getState().applyProject({
      projectId: '',
      projectName: '',
      sampleRate: 48_000,
      bitDepth: '24',
      globalInsertLimit: 4,
    });
    render(<SequencesPanel />);
    expect(screen.getByTestId('main-add-sequence')).toBeDisabled();
  });

  it('disables delete while one sequence is left, and enables it once there are two', async () => {
    const user = userEvent.setup();
    render(<SequencesPanel />);
    expect(screen.getByTestId(`main-sequence-delete-${SEQUENCE.id}`)).toBeDisabled();

    await user.click(screen.getByTestId('main-add-sequence'));
    expect(screen.getByTestId(`main-sequence-delete-${SEQUENCE.id}`)).toBeEnabled();
  });
});

describe('TracksPanel', () => {
  it('adds a track to the active sequence', async () => {
    const user = userEvent.setup();
    render(<TracksPanel />);

    await user.click(screen.getByTestId('main-add-track'));
    expect(Object.keys(useSequenceStore.getState().tracks)).toHaveLength(2);
  });

  it('deletes a track, leaving the empty state that now names a reachable action', async () => {
    const user = userEvent.setup();
    render(<TracksPanel />);

    await user.click(screen.getByRole('button', { name: 'Delete Track 1' }));
    expect(useSequenceStore.getState().tracks[TRACK.id]).toBeUndefined();
    expect(screen.getByTestId('main-no-tracks')).toHaveTextContent(
      'No tracks in this sequence. Add one to play pads and edit notes.',
    );
  });

  it('repoints a track at another program from its row', async () => {
    const other = createDefaultDrumProgram('Program 2');
    useProgramStore.getState().setPrograms({ [PROGRAM.id]: PROGRAM, [other.id]: other });
    const user = userEvent.setup();
    render(<TracksPanel />);

    await user.selectOptions(screen.getByTestId(`main-track-program-${TRACK.id}`), other.id);
    expect(useSequenceStore.getState().tracks[TRACK.id]!.programId).toBe(other.id);
  });
});

describe('ProjectsPanel', () => {
  it('lists recent projects from the repository (spec §8.5.1)', async () => {
    listRecent.mockResolvedValue({
      rows: [
        { id: 'project-1', name: 'Stored Name', modified_at: 1_700_000_000_000 },
        { id: 'project-9', name: 'Older Project', modified_at: 1_600_000_000_000 },
      ],
    });
    render(<ProjectsPanel />);

    await screen.findByTestId('main-recent-project-9');
    // The open project is labelled from the store: a rename is not in storage until
    // autosave flushes, so the row would otherwise show the name just replaced.
    expect(screen.getByTestId('main-recent-project-1')).toHaveTextContent('Test Project');
  });

  it('opens a project from the recent list', async () => {
    listRecent.mockResolvedValue({
      rows: [{ id: 'project-9', name: 'Older Project', modified_at: 1_600_000_000_000 }],
    });
    const user = userEvent.setup();
    render(<ProjectsPanel />);

    await user.click(await screen.findByTestId('main-open-project-9'));
    await waitFor(() => expect(loadProject).toHaveBeenCalledWith('project-9'));
  });

  it('creates a new project with the typed name', async () => {
    const user = userEvent.setup();
    render(<ProjectsPanel />);

    await user.click(screen.getByTestId('main-new-project'));
    await user.type(screen.getByTestId('main-new-project-name'), 'Second Project');
    await user.click(screen.getByTestId('main-new-project-confirm'));

    await waitFor(() => expect(newProject).toHaveBeenCalledWith('Second Project'));
  });

  it('falls back to the service default when the name is left blank', async () => {
    const user = userEvent.setup();
    render(<ProjectsPanel />);

    await user.click(screen.getByTestId('main-new-project'));
    await user.click(screen.getByTestId('main-new-project-confirm'));

    await waitFor(() => expect(newProject).toHaveBeenCalledWith(undefined));
  });

  it('shows an empty list rather than failing the dashboard when the read throws', async () => {
    listRecent.mockRejectedValue(new Error('storage worker died'));
    render(<ProjectsPanel />);

    expect(await screen.findByText(/No projects stored yet/)).toBeInTheDocument();
  });
});
