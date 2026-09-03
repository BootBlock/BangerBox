import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useProgramStore, useUIStore } from '@/store';
import { ProgramEditPanel } from './ProgramEditPanel';

describe('ProgramEditPanel (spec §8.5.5)', () => {
  beforeEach(() => {
    useProgramStore.setState({ programs: {}, activeProgramId: null, activePadId: null });
  });
  afterEach(() => {
    useProgramStore.setState({ programs: {}, activeProgramId: null, activePadId: null });
  });

  it('creates a drum program and makes it active', async () => {
    const user = userEvent.setup();
    render(<ProgramEditPanel />);
    await user.click(screen.getByRole('button', { name: 'Add drum' }));
    const programs = Object.values(useProgramStore.getState().programs);
    expect(programs).toHaveLength(1);
    expect(programs[0]?.type).toBe('drum');
    expect(useProgramStore.getState().activeProgramId).toBe(programs[0]?.id);
  });

  it('creates and edits a pad through the store (spec §6, §4.5)', async () => {
    const user = userEvent.setup();
    render(<ProgramEditPanel />);
    await user.click(screen.getByRole('button', { name: 'Add drum' }));

    // Tapping an empty pad creates and selects it.
    await user.click(screen.getByRole('button', { name: 'Pad 1 (empty)' }));
    const programId = useProgramStore.getState().activeProgramId!;
    const program = useProgramStore.getState().programs[programId]!;
    expect(program.type === 'drum' && program.pads).toHaveLength(1);

    // Editing the choke group commits to the store.
    const settings = screen.getByRole('region', { name: 'Pad settings' });
    const choke = within(settings).getByLabelText('Choke group');
    await user.clear(choke);
    await user.type(choke, '3');
    const updated = useProgramStore.getState().programs[programId]!;
    expect(updated.type === 'drum' && updated.pads[0]?.chokeGroup).toBe(3);
  });

  it('creates a keygroup program and edits its polyphony (spec §6)', async () => {
    const user = userEvent.setup();
    render(<ProgramEditPanel />);
    await user.click(screen.getByRole('button', { name: 'Add keygroup' }));
    const programId = useProgramStore.getState().activeProgramId!;

    const poly = screen.getByLabelText('Polyphony');
    await user.clear(poly);
    await user.type(poly, '8');
    const program = useProgramStore.getState().programs[programId]!;
    expect(program.type === 'keygroup' && program.polyphony).toBe(8);
  });
});

/**
 * Destructive edits get a confirmation (spec §8.1, issue #54).
 *
 * The rule is recorded on `ConfirmDialog`: an action that destroys a container whose contents
 * are not on screen is gated; one whose whole subject is the row it sits on is not, and says
 * instead that it can be undone. Both of the coarse Program Edit actions used to fire on the
 * first tap with no confirmation, no toast and no sign that undo would bring anything back.
 */
describe('destructive confirmations (spec §8.1, issue #54)', () => {
  beforeEach(() => {
    useProgramStore.setState({ programs: {}, activeProgramId: null, activePadId: null });
    useUIStore.setState({ toasts: [] });
  });

  async function seedProgramWithPad(user: ReturnType<typeof userEvent.setup>) {
    render(<ProgramEditPanel />);
    await user.click(screen.getByRole('button', { name: 'Add drum' }));
    await user.click(screen.getByRole('button', { name: 'Pad 1 (empty)' }));
    return useProgramStore.getState().activeProgramId!;
  }

  it('does not delete the program on the first tap', async () => {
    const user = userEvent.setup();
    const programId = await seedProgramWithPad(user);
    await user.click(screen.getByTestId('program-delete'));
    expect(useProgramStore.getState().programs[programId]).toBeDefined();
    expect(screen.getByTestId('program-delete-confirm')).toBeInTheDocument();
  });

  it('names what the program holds, which the button cannot show', async () => {
    const user = userEvent.setup();
    await seedProgramWithPad(user);
    await user.click(screen.getByTestId('program-delete'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/assigned pad/);
    expect(dialog).toHaveTextContent(/Undo \(Ctrl\+Z\)/);
  });

  it('deletes only once confirmed, and says the deletion is recoverable', async () => {
    const user = userEvent.setup();
    const programId = await seedProgramWithPad(user);
    await user.click(screen.getByTestId('program-delete'));
    await user.click(screen.getByTestId('program-delete-confirm-confirm'));
    expect(useProgramStore.getState().programs[programId]).toBeUndefined();
    expect(
      useUIStore
        .getState()
        .toasts.map((toast) => toast.message)
        .join(' '),
    ).toMatch(/Ctrl\+Z/);
  });

  it('leaves the program alone when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    const programId = await seedProgramWithPad(user);
    await user.click(screen.getByTestId('program-delete'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useProgramStore.getState().programs[programId]).toBeDefined();
    // `Modal` unmounts through `AnimatePresence`, so the panel outlives the click by an
    // exit transition — the assertion is that it goes, not that it goes synchronously.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not clear the pad on the first tap either', async () => {
    const user = userEvent.setup();
    const programId = await seedProgramWithPad(user);
    await user.click(screen.getByTestId('pad-clear'));
    const program = useProgramStore.getState().programs[programId]!;
    expect(program.type === 'drum' && program.pads).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveTextContent(/sample layer/);
  });

  it('clears the pad once confirmed', async () => {
    const user = userEvent.setup();
    const programId = await seedProgramWithPad(user);
    await user.click(screen.getByTestId('pad-clear'));
    await user.click(screen.getByTestId('pad-clear-confirm-confirm'));
    const program = useProgramStore.getState().programs[programId]!;
    expect(program.type === 'drum' && program.pads).toHaveLength(0);
    expect(
      useUIStore
        .getState()
        .toasts.map((toast) => toast.message)
        .join(' '),
    ).toMatch(/Ctrl\+Z/);
  });

  it('removes a mod route with NO confirmation, and says undo will bring it back', async () => {
    // Deliberately ungated: the whole subject of the button is the row it sits in, and a
    // dialog on every row would make the matrix unusable on a touch device (issue #54).
    const user = userEvent.setup();
    const programId = await seedProgramWithPad(user);
    await user.click(screen.getByRole('button', { name: 'Add route' }));
    await user.click(screen.getByRole('button', { name: 'Remove route 1' }));
    const program = useProgramStore.getState().programs[programId]!;
    expect(program.type === 'drum' && program.pads[0]!.modMatrix).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      useUIStore
        .getState()
        .toasts.map((toast) => toast.message)
        .join(' '),
    ).toMatch(/Ctrl\+Z/);
  });
});
