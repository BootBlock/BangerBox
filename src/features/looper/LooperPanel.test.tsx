/**
 * Looper record-source gate — spec §8.5.8 (resample master / mic) over §2.1 (a missing soft
 * capability is disabled and explained, never silently absent). The capture path itself is
 * covered by `core/audio/looper.test.ts`; what is asserted here is the gate the panel puts in
 * front of it, and that the mic choice reaches the Looper rather than being cosmetic (§3.4).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/store';
import { LooperPanel } from './LooperPanel';

const setSource = vi.fn(() => Promise.resolve());

vi.mock('@/core/project', () => ({
  getAudioEngine: () => ({
    createLooper: () => ({
      source: 'master',
      setSource,
      destroy: () => {},
      startRecording: () => {},
      stopRecording: () => Promise.resolve(false),
      clear: () => {},
      hasTake: false,
    }),
  }),
}));

function seed(microphone: boolean) {
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
      soft: { bluetooth: true, microphone, persistentStorage: true, wakeLock: true },
      hardSupported: true,
      missingHard: [],
      missingHardDetails: [],
      browser: { engine: 'chromium', name: 'your browser', supported: true },
    },
  });
}

const micOption = () => screen.getByRole('radio', { name: 'Mic' });

afterEach(() => setSource.mockClear());

describe('LooperPanel record source (spec §8.5.8, §2.1)', () => {
  it('offers the mic source and points the Looper at it when chosen', async () => {
    seed(true);
    render(<LooperPanel />);
    expect(micOption()).toBeEnabled();

    await userEvent.click(micOption());

    // §3.4: the control must reach the audio path, not just repaint itself.
    expect(setSource).toHaveBeenCalledWith('microphone');
    expect(screen.getByTestId('looper-source-help')).toHaveTextContent('Record the microphone');
  });

  it('disables the mic source and says why when the browser cannot capture (spec §2.1)', () => {
    seed(false);
    render(<LooperPanel />);

    expect(micOption()).toBeDisabled();
    expect(micOption()).toHaveAttribute('title', 'This browser cannot capture microphone input.');
    // The tooltip is unreachable by touch and keyboard, so the reason is on the page as well.
    expect(screen.getByTestId('looper-no-mic')).toBeInTheDocument();
  });

  it('keeps the master meter off the mic source, which has no meter slot', async () => {
    seed(true);
    render(<LooperPanel />);
    expect(screen.queryByTestId('looper-mic-note')).not.toBeInTheDocument();

    await userEvent.click(micOption());

    expect(screen.getByTestId('looper-mic-note')).toBeInTheDocument();
  });
});
