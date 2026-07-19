import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useProgramStore } from '@/store';
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
