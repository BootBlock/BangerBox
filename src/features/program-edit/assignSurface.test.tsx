/**
 * The Program Edit assignment surfaces — spec §8.5.7, §8.5.5, §8.2.
 *
 * Program Edit had no affordance that put a sample on a pad, and the Browser's Enter/Space
 * path told the user to come here and choose one (issue #37). These cover the three routes
 * that now exist, each with a keyboard-only path: the sample picker, the armed-payload
 * banner, and the drop target on the pad grid.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listByProject = vi.fn();
const listGlobal = vi.fn();
const getActiveRepositories = vi.fn();

vi.mock('@/core/project', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/project')>();
  return { ...actual, getActiveRepositories: () => getActiveRepositories(), getAudioEngine: () => null };
});

vi.mock('../sample-edit/sampleContext', () => ({
  auditionSample: vi.fn(),
  refreshSamples: () => Promise.resolve(),
  reloadSampleList: () => Promise.resolve(),
  sampleEditContext: () => ({}),
}));

const { ProgramEditPanel } = await import('./ProgramEditPanel');
const { useProgramStore, useProjectStore, useUIStore } = await import('@/store');
const { createDefaultDrumProgram, createDefaultKeygroupProgram } = await import('@/core/project/schemas');

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

function seedDrumProgram() {
  useProgramStore.getState().setPrograms({ [DRUM_ID]: createDefaultDrumProgram('Kit', DRUM_ID) });
  useProgramStore.getState().setActiveProgram(DRUM_ID);
  useProgramStore.getState().setActivePad(null);
}

function padsOf(id: string) {
  const program = useProgramStore.getState().programs[id]!;
  if (program.type !== 'drum') throw new Error('expected a drum program');
  return program.pads;
}

beforeEach(() => {
  vi.clearAllMocks();
  listByProject.mockResolvedValue({ rows: [KICK] });
  listGlobal.mockResolvedValue({ rows: [] });
  getActiveRepositories.mockReturnValue({ samples: { listByProject, listGlobal } });
  useProjectStore.setState({ projectId: 'project-a' });
  useUIStore.setState({ dragDropPayload: null, toasts: [] });
  seedDrumProgram();
});

describe('Assigning a sample to a pad from Program Edit (spec §8.5.5)', () => {
  it('adds a velocity layer through the picker, by keyboard alone', async () => {
    const user = userEvent.setup();
    render(<ProgramEditPanel />);

    // Select pad 1, then open the picker and choose a sample — all with Enter presses.
    await user.click(screen.getByRole('button', { name: 'Pad 1 (empty)' }));
    await user.click(screen.getByTestId('layer-add'));
    const assign = await screen.findByTestId(`sample-picker-assign-${KICK.id}`);
    assign.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(padsOf(DRUM_ID)[0]?.layers).toEqual([
        expect.objectContaining({ sampleId: KICK.id, velocityStart: 0, velocityEnd: 127 }),
      ]);
    });
  });

  it('reports the assignment, so it is legible when focus is on the picker', async () => {
    const user = userEvent.setup();
    render(<ProgramEditPanel />);
    await user.click(screen.getByRole('button', { name: 'Pad 1 (empty)' }));
    await user.click(screen.getByTestId('layer-add'));
    await user.click(await screen.findByTestId(`sample-picker-assign-${KICK.id}`));

    await waitFor(() => {
      expect(useUIStore.getState().toasts.at(-1)?.message).toContain('Kick.wav');
    });
  });

  it('closes the velocity band when a layer is removed, so the pad stays audible', async () => {
    const user = userEvent.setup();
    useProgramStore.getState().addPadLayer(DRUM_ID, 0, 'soft');
    useProgramStore.getState().addPadLayer(DRUM_ID, 0, 'hard');
    useProgramStore.getState().setActivePad(0);
    render(<ProgramEditPanel />);

    await user.click(screen.getByRole('button', { name: 'Remove layer 2' }));

    // Removing through the store rather than by filtering the array: a plain filter left
    // velocities 64..127 answered by nothing, and the pad silent above half velocity.
    expect(padsOf(DRUM_ID)[0]?.layers).toEqual([
      expect.objectContaining({ sampleId: 'soft', velocityStart: 0, velocityEnd: 127 }),
    ]);
  });

  it('says a padless pad makes no sound, and names the way out (spec §3.4)', async () => {
    const user = userEvent.setup();
    render(<ProgramEditPanel />);
    await user.click(screen.getByRole('button', { name: 'Pad 1 (empty)' }));

    expect(screen.getByTestId('layers-empty')).toHaveTextContent(/makes no sound/);
    expect(screen.getByTestId('layers-empty')).toHaveTextContent(/Add a sample/);
  });
});

describe('Consuming dragDropPayload (spec §8.5.7)', () => {
  it('assigns the armed sample to the pad the user presses, then disarms', async () => {
    const user = userEvent.setup();
    useUIStore
      .getState()
      .setDragDropPayload({ sampleId: KICK.id, name: KICK.name, rootNote: KICK.root_note });
    render(<ProgramEditPanel />);

    // The grid says what pressing a pad will now do, which is the only signal a screen
    // reader gets — the banner is deliberately not a second live region (spec §8.2).
    const pad = screen.getByRole('button', { name: 'Assign to pad 3 (empty)' });
    await user.click(pad);

    expect(padsOf(DRUM_ID).find((candidate) => candidate.padIndex === 2)?.layers[0]?.sampleId).toBe(KICK.id);
    expect(useUIStore.getState().dragDropPayload).toBeNull();
  });

  it('shows the armed banner and lets the user cancel without assigning', async () => {
    const user = userEvent.setup();
    useUIStore
      .getState()
      .setDragDropPayload({ sampleId: KICK.id, name: KICK.name, rootNote: KICK.root_note });
    render(<ProgramEditPanel />);

    expect(screen.getByTestId('pad-assign-armed')).toHaveTextContent('Kick.wav');
    await user.click(screen.getByTestId('pad-assign-cancel'));

    expect(useUIStore.getState().dragDropPayload).toBeNull();
    expect(padsOf(DRUM_ID)).toHaveLength(0);
  });

  it('takes a drop on a pad', () => {
    useUIStore
      .getState()
      .setDragDropPayload({ sampleId: KICK.id, name: KICK.name, rootNote: KICK.root_note });
    render(<ProgramEditPanel />);

    const pad = screen.getByTestId('program-pad-5');
    // A drop only reaches a target that accepted the dragover, so both are exercised.
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    pad.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    pad.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));

    expect(padsOf(DRUM_ID).find((candidate) => candidate.padIndex === 5)?.layers[0]?.sampleId).toBe(KICK.id);
  });

  it('leaves the pad alone when nothing is armed', async () => {
    const user = userEvent.setup();
    render(<ProgramEditPanel />);

    await user.click(screen.getByRole('button', { name: 'Pad 3 (empty)' }));

    expect(padsOf(DRUM_ID).find((candidate) => candidate.padIndex === 2)?.layers).toEqual([]);
    expect(screen.queryByTestId('pad-assign-armed')).toBeNull();
  });
});

describe('Assigning a sample as a keygroup zone (spec §8.5.5)', () => {
  beforeEach(() => {
    useProgramStore.getState().setPrograms({ 'keys-1': createDefaultKeygroupProgram('Piano', 'keys-1') });
    useProgramStore.getState().setActiveProgram('keys-1');
  });

  it('adds a zone through the picker', async () => {
    const user = userEvent.setup();
    render(<ProgramEditPanel />);

    await user.click(screen.getByTestId('zone-add'));
    await user.click(await screen.findByTestId(`sample-picker-assign-${KICK.id}`));

    await waitFor(() => {
      const program = useProgramStore.getState().programs['keys-1']!;
      expect(program.type === 'keygroup' && program.zones).toEqual([
        expect.objectContaining({ sampleId: KICK.id, rootNote: 60, lowNote: 0, highNote: 127 }),
      ]);
    });
  });

  it('takes the armed sample from the banner', async () => {
    const user = userEvent.setup();
    useUIStore
      .getState()
      .setDragDropPayload({ sampleId: KICK.id, name: KICK.name, rootNote: KICK.root_note });
    render(<ProgramEditPanel />);

    await user.click(screen.getByTestId('zone-assign-armed-confirm'));

    const program = useProgramStore.getState().programs['keys-1']!;
    expect(program.type === 'keygroup' && program.zones).toHaveLength(1);
    expect(useUIStore.getState().dragDropPayload).toBeNull();
  });

  it('roots an armed sample at its own pitch, not at an assumed middle C', async () => {
    const user = userEvent.setup();
    // A kick's unity pitch is well below middle C; rooting it at 60 sounds two octaves out.
    useUIStore.getState().setDragDropPayload({ sampleId: KICK.id, name: KICK.name, rootNote: 36 });
    render(<ProgramEditPanel />);

    await user.click(screen.getByTestId('zone-assign-armed-confirm'));

    const program = useProgramStore.getState().programs['keys-1']!;
    expect(program.type === 'keygroup' && program.zones[0]?.rootNote).toBe(36);
  });

  it('removes a zone', async () => {
    const user = userEvent.setup();
    useProgramStore.getState().addKeygroupZone('keys-1', 'sample-a');
    render(<ProgramEditPanel />);

    await user.click(screen.getByTestId('zone-remove-0'));

    const program = useProgramStore.getState().programs['keys-1']!;
    expect(program.type === 'keygroup' && program.zones).toHaveLength(0);
  });

  it('says a zoneless program makes no sound (spec §3.4)', () => {
    render(<ProgramEditPanel />);
    const zones = screen.getByRole('region', { name: 'Key zones' });
    expect(within(zones).getByTestId('zones-empty')).toHaveTextContent(/makes no sound/);
  });
});
