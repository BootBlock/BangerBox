import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultLfo, type LfoConfig } from '@/core/project/schemas';
import { LfoEditor } from './LfoEditor';

/** Controlled harness — the component never holds its own state (spec §3.4). */
function Harness({ onCommit }: { onCommit?: (lfos: [LfoConfig, LfoConfig]) => void }) {
  const [lfos, setLfos] = useState<[LfoConfig, LfoConfig]>([createDefaultLfo(), createDefaultLfo()]);
  return (
    <LfoEditor
      lfos={lfos}
      onChange={(next) => {
        setLfos(next);
        onCommit?.(next);
      }}
    />
  );
}

describe('LfoEditor (spec §8.5.5, §6)', () => {
  it('renders both LFOs as separately named regions (spec §8.2)', () => {
    render(<Harness />);
    expect(screen.getByRole('region', { name: 'LFO 1' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'LFO 2' })).toBeInTheDocument();
  });

  it('commits every LfoConfig field', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    const rate = screen.getByLabelText('LFO 1 rate (Hz)');
    await user.clear(rate);
    await user.type(rate, '4.5');
    expect(onCommit.mock.lastCall?.[0][0].rate).toBe(4.5);

    await user.selectOptions(screen.getByLabelText('LFO 1 sync'), '1/8');
    expect(onCommit.mock.lastCall?.[0][0].sync).toBe('1/8');

    await user.selectOptions(screen.getByLabelText('LFO 1 shape'), 'sampleHold');
    expect(onCommit.mock.lastCall?.[0][0].shape).toBe('sampleHold');

    const phase = screen.getByLabelText('LFO 1 phase offset');
    await user.clear(phase);
    await user.type(phase, '0.25');
    expect(onCommit.mock.lastCall?.[0][0].phaseOffset).toBe(0.25);

    await user.click(screen.getByLabelText('LFO 1 retrigger'));
    expect(onCommit.mock.lastCall?.[0][0].retrigger).toBe(false);
  });

  it('keeps the two LFOs independent', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.selectOptions(screen.getByLabelText('LFO 2 shape'), 'square');
    const [first, second] = onCommit.mock.lastCall![0];
    expect(second.shape).toBe('square');
    expect(first.shape).toBe('sine');

    const rate = screen.getByLabelText('LFO 2 rate (Hz)');
    await user.clear(rate);
    await user.type(rate, '7');
    const committed = onCommit.mock.lastCall![0];
    expect(committed[1].rate).toBe(7);
    expect(committed[0].rate).toBe(createDefaultLfo().rate);
  });

  it('leaves the rate editable when synced, and says why (engine ignores sync today)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const rate = screen.getByLabelText('LFO 1 rate (Hz)');

    expect(screen.queryByRole('list', { name: 'LFO 1 engine notes' })).not.toBeInTheDocument();
    expect(rate).toBeEnabled();

    await user.selectOptions(screen.getByLabelText('LFO 1 sync'), '1/16');
    const notes = screen.getByRole('list', { name: 'LFO 1 engine notes' });
    expect(notes).toHaveTextContent(/Tempo sync is saved but not yet applied/);
    // Sync is stored but unapplied, so the Hz rate is still the audible one — it stays live.
    expect(rate).toBeEnabled();
    await user.clear(rate);
    await user.type(rate, '3');
    expect(screen.getByLabelText('LFO 1 rate (Hz)')).toHaveValue(3);

    // The note belongs to the LFO that is synced, not to both.
    expect(screen.queryByRole('list', { name: 'LFO 2 engine notes' })).not.toBeInTheDocument();
  });

  it('flags the approximated shapes rather than pretending they are exact', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText('LFO 2 shape'), 'drift');
    expect(screen.getByRole('list', { name: 'LFO 2 engine notes' })).toHaveTextContent(
      /Drift is approximated by a sine wave/,
    );
  });
});
