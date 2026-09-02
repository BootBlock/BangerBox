/**
 * The master fader records automation while the transport is capturing (spec §7.8).
 *
 * Regression: this fader addressed the mixer store by the legacy bare `master.level`. The
 * store still moves the parameter for that form, so the fader looked entirely healthy —
 * but the §7.8 registry does not parse it, so the recorder refused every sample and the
 * one always-mounted fader in the app captured nothing.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayheadReading } from '@/core/sequencer';
import { createDefaultChannelStrip } from '@/core/project/schemas';
import { useMixerStore, useSequenceStore, useTransportStore } from '@/store';
import { resetAutomationRecording, setAutomationClock } from '@/store/automationRecord';
import { AudioEnginePanel } from './AudioEnginePanel';

const LANE = 'sequence:seq1:mixer.master.level';

beforeEach(() => {
  const reading: PlayheadReading = {
    currentTick: 0,
    isPlaying: true,
    isRecording: true,
    isCapturing: true,
    generation: 2,
  };
  setAutomationClock(() => reading);
  resetAutomationRecording();
  useMixerStore.getState().setChannels({ master: createDefaultChannelStrip('master') });
  useSequenceStore.setState({ automation: {} });
  useTransportStore.setState({ activeSequenceId: 'seq1' });
});

afterEach(() => {
  setAutomationClock(null);
  useMixerStore.getState().setChannels({});
  useSequenceStore.setState({ automation: {} });
  useTransportStore.setState({ activeSequenceId: null });
});

describe('AudioEnginePanel master fader (spec §7.8)', () => {
  it('records a point when moved while the transport is capturing', async () => {
    const user = userEvent.setup();
    render(<AudioEnginePanel />);

    const fader = screen.getByRole('slider', { name: 'Master level' });
    fader.focus();
    await user.keyboard('{ArrowDown}');

    expect(useSequenceStore.getState().automation[LANE]).toHaveLength(1);
    // The gesture still moved the parameter — capture is additive, never a replacement.
    expect(useMixerStore.getState().channels.master!.level).toBeLessThan(1);
  });
});
