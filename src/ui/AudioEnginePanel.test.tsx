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
import { resetTransientChannel } from '@/store/transientChannel';
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

/**
 * §10.3's "UI reacts concurrently", for the one fader that is always on screen (issue #27).
 *
 * A project-mode Q-Link encoder is bound to the master level by default, and an XYFX axis can
 * be too. Since a turn's values now reach the graph through the §4.1 transient channel rather
 * than the store, a fader without `livePath` sits still while the audio and the meter move —
 * which is what the Mixer's five controls got the prop to prevent, and this one had missed.
 */
describe('AudioEnginePanel master fader tracks a gesture it is not driving (issue #27)', () => {
  afterEach(() => {
    resetTransientChannel();
  });

  it('follows a Q-Link turn of mixer.master.level as it happens', () => {
    render(<AudioEnginePanel />);
    const fader = screen.getByRole('slider', { name: 'Master level' });
    expect(fader.getAttribute('aria-valuenow')).toBe('1');

    // Exactly what the §10.3 runtime does mid-turn, through the real store action.
    useMixerStore.getState().setTransient('mixer.master.level', 0.4);
    expect(fader.getAttribute('aria-valuenow')).toBe('0.4');
  });
});
