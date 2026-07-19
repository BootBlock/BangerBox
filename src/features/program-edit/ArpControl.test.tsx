import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTransportStore } from '@/store';
import { ArpControl } from './ArpControl';

/** The arp defaults, restored around each case so one test cannot arm the next. */
const DEFAULTS = {
  arpEnabled: false,
  arpConfig: { mode: 'up', octaves: 1, gate: 0.5, division: { value: 16, triplet: false } },
} as const;

describe('ArpControl (spec §7.3, §8.5.5)', () => {
  beforeEach(() => useTransportStore.setState(DEFAULTS));
  afterEach(() => useTransportStore.setState(DEFAULTS));

  it('commits its settings to the transport store rather than local state (spec §1.3 #16)', async () => {
    const user = userEvent.setup();
    render(<ArpControl />);

    await user.click(screen.getByLabelText('Enabled'));
    await user.selectOptions(screen.getByLabelText('Mode'), 'upDown');
    await user.selectOptions(screen.getByLabelText('Division'), '16t');

    const state = useTransportStore.getState();
    expect(state.arpEnabled).toBe(true);
    expect(state.arpConfig.mode).toBe('upDown');
    expect(state.arpConfig.division).toEqual({ value: 16, triplet: true });
  });

  /**
   * The bug in issue #55: `AppShell` mounts only the active mode, so leaving Program Edit
   * unmounts this control. With the settings in component state the remount pushed
   * `enabled: false` and switched the arp off with no message.
   */
  it('keeps the arp armed across an unmount, as leaving the mode causes', async () => {
    const user = userEvent.setup();
    const view = render(<ArpControl />);
    await user.click(screen.getByLabelText('Enabled'));
    await user.selectOptions(screen.getByLabelText('Mode'), 'random');

    view.unmount();
    expect(useTransportStore.getState().arpEnabled).toBe(true);

    render(<ArpControl />);
    expect(screen.getByLabelText<HTMLInputElement>('Enabled').checked).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Mode').value).toBe('random');
    expect(useTransportStore.getState().arpEnabled).toBe(true);
  });

  it('clamps values to the §7.3 ranges', () => {
    useTransportStore.getState().setArpConfig({ octaves: 9, gate: 0 });
    expect(useTransportStore.getState().arpConfig.octaves).toBe(4);
    expect(useTransportStore.getState().arpConfig.gate).toBe(0.05);
  });
});
