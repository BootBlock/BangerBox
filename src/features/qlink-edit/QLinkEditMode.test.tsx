/**
 * Q-Link Edit surface — spec §8.5.11. Every control here must be wired end to end
 * (spec §3.4 forbids dead controls) and operable/labelled (spec §3.5 lens 1), including
 * the §10.4 connection surface and the Windows pairing helper.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultChannelStrip,
  createDefaultDrumProgram,
  createDefaultPad,
} from '@/core/project/schemas';
import { useHardwareStore, useMixerStore, useProgramStore, useUIStore } from '@/store';
import { QLinkEditMode } from './QLinkEditMode';

function seed(bluetooth = true) {
  useMixerStore.getState().setChannels({ master: createDefaultChannelStrip('master') });
  useHardwareStore.setState({
    qLinkBindings: [],
    ccMappings: {},
    connectionState: 'idle',
    bleDeviceName: null,
    bleDeviceConnected: false,
    qLinkMode: 'screen',
  });
  useUIStore.setState({
    capabilities: {
      hard: {
        crossOriginIsolated: true,
        sharedArrayBuffer: true,
        audioWorklet: true,
        opfs: true,
        webAssembly: true,
        atomics: true,
      },
      soft: { bluetooth, microphone: true, persistentStorage: true, wakeLock: true },
      hardSupported: true,
      missingHard: [],
    },
  });
}

describe('QLinkEditMode (spec §8.5.11)', () => {
  beforeEach(() => seed());

  it('shows the connection state and offers a connect action (spec §10.4)', () => {
    render(<QLinkEditMode />);
    expect(screen.getByTestId('qlink-connection')).toHaveTextContent('Not connected');
    expect(screen.getByTestId('qlink-connect')).toBeEnabled();
  });

  it('reflects the reconnecting state (spec §10.4 lifecycle)', () => {
    useHardwareStore.getState().setConnectionState('reconnecting');
    render(<QLinkEditMode />);
    expect(screen.getByTestId('qlink-connection')).toHaveTextContent('Reconnecting');
  });

  it('shows the connected device name', () => {
    useHardwareStore.getState().setConnectionState('connected');
    useHardwareStore.getState().setDevice('ESP32 Pad Controller', true);
    render(<QLinkEditMode />);
    expect(screen.getByTestId('qlink-device')).toHaveTextContent('ESP32 Pad Controller');
  });

  it('carries the Windows pairing helper (spec §10.4)', () => {
    render(<QLinkEditMode />);
    expect(screen.getByTestId('qlink-pairing-help')).toHaveTextContent(/Windows Settings/i);
  });

  it('disables connecting and explains why when Web Bluetooth is missing (spec §2.1)', () => {
    seed(false);
    render(<QLinkEditMode />);
    expect(screen.getByTestId('qlink-connect')).toBeDisabled();
    expect(screen.getByTestId('qlink-no-bluetooth')).toBeInTheDocument();
  });

  it('binds a parameter to an encoder through the store (spec §10.3)', async () => {
    const user = userEvent.setup();
    render(<QLinkEditMode />);
    await user.selectOptions(screen.getByTestId('qlink-param-0'), 'mixer.master.level');
    const bindings = useHardwareStore.getState().qLinkBindings;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ encoderIndex: 0, targetParameterPath: 'mixer.master.level' });
  });

  it('seeds a new binding from the default CC block rather than the encoder index', async () => {
    const user = userEvent.setup();
    render(<QLinkEditMode />);
    await user.selectOptions(screen.getByTestId('qlink-param-1'), 'mixer.master.level');
    expect(useHardwareStore.getState().qLinkBindings[0]!.cc).toBe(71);
  });

  it('shows the CC each encoder listens on', async () => {
    const user = userEvent.setup();
    render(<QLinkEditMode />);
    await user.selectOptions(screen.getByTestId('qlink-param-0'), 'mixer.master.level');
    expect(screen.getByTestId('qlink-cc-0')).toHaveTextContent('70');
  });

  it('clears a binding', async () => {
    const user = userEvent.setup();
    render(<QLinkEditMode />);
    await user.selectOptions(screen.getByTestId('qlink-param-0'), 'mixer.master.level');
    await user.click(screen.getByRole('button', { name: 'Clear binding for encoder 1' }));
    expect(useHardwareStore.getState().qLinkBindings).toHaveLength(0);
  });

  it('switches the Q-Link mode (spec §10.3 four modes)', async () => {
    const user = userEvent.setup();
    render(<QLinkEditMode />);
    await user.click(screen.getByRole('radio', { name: 'Pad' }));
    expect(useHardwareStore.getState().qLinkMode).toBe('pad');
  });

  it('arms the learn flow for an encoder (spec §8.5.11)', async () => {
    const user = userEvent.setup();
    render(<QLinkEditMode />);
    await user.click(screen.getByTestId('qlink-learn-0'));
    expect(screen.getByRole('status')).toHaveTextContent(/Learning encoder Q1/i);
  });

  it('offers the global transport macros in the picker (spec §10.3 project mode)', async () => {
    const user = userEvent.setup();
    render(<QLinkEditMode />);
    await user.selectOptions(screen.getByTestId('qlink-param-0'), 'transport.swing');
    expect(useHardwareStore.getState().qLinkBindings[0]).toMatchObject({
      targetParameterPath: 'transport.swing',
      minValue: 50,
      maxValue: 75,
    });
  });

  it('offers the selected pad’s sound-design leaves (spec §10.3 pad mode)', async () => {
    useProgramStore.setState({
      programs: {
        'prog-1': { ...createDefaultDrumProgram('Kit', 'prog-1'), pads: [createDefaultPad(0)] },
      },
      activeProgramId: 'prog-1',
      activePadId: 0,
    });
    const user = userEvent.setup();
    render(<QLinkEditMode />);
    await user.selectOptions(
      screen.getByTestId('qlink-param-0'),
      'program:prog-1.pad:0.filter.cutoff',
    );
    expect(useHardwareStore.getState().qLinkBindings[0]).toMatchObject({
      targetParameterPath: 'program:prog-1.pad:0.filter.cutoff',
      targetStore: 'program',
    });
  });

  it('labels every binding control for assistive technology (spec §8.2)', () => {
    render(<QLinkEditMode />);
    expect(screen.getByLabelText('Parameter for encoder 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum value for encoder 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximum value for encoder 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Curve for encoder 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Encoder mode for encoder 1')).toBeInTheDocument();
  });
});
