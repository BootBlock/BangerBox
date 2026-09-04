/**
 * What the Mixer's continuous controls SAY (spec §8.2 — "`aria-valuetext` (human units —
 * '−6.0 dB', '1.2 kHz')"), issue #35.
 *
 * Pan and the four sends announced the raw stored number: "−0.3" for a pan, "0.35" for a
 * send. Neither is a unit, and the pan one is worse than useless — the sign is the only
 * thing that says which side of the image the sound is on, and a number does not say it.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/core/audio/bounceService', () => ({
  bounceActiveSequence: vi.fn(),
  bounceSong: vi.fn(),
  bounceTrack: vi.fn(),
  resampleSequenceToSample: vi.fn(),
}));
vi.mock('../sample-edit/sampleContext', () => ({ sampleEditContext: () => ({}) }));
vi.mock('@/core/project/session', () => ({ getAudioEngine: () => null }));
// The meter canvas reaches for the engine's SAB registry the moment it mounts.
vi.mock('@/ui/primitives/MeterCanvas', () => ({ MeterCanvas: () => null }));

const { MixerMode } = await import('./MixerMode');
const { useMixerStore, useSequenceStore, useTransportStore } = await import('@/store');
const { createDefaultChannelStrip } = await import('@/core/project/schemas');

const TRACK = {
  id: 't1',
  sequenceId: 'seq1',
  programId: null,
  position: 0,
  name: 'Drums',
  type: 'drum' as const,
};

function setStrip(overrides: { level?: number; pan?: number; sendLevels?: number[] }): void {
  const base = createDefaultChannelStrip('track:t1');
  useMixerStore.getState().setChannels({
    'track:t1': {
      ...base,
      level: overrides.level ?? base.level,
      pan: overrides.pan ?? base.pan,
      sendLevels: (overrides.sendLevels ?? base.sendLevels) as typeof base.sendLevels,
    },
  });
}

beforeEach(() => {
  useTransportStore.setState({ activeSequenceId: 'seq1' });
  useSequenceStore.setState({ tracks: { t1: TRACK }, events: { t1: [] }, automation: {} });
  setStrip({});
});

describe('Mixer strip aria-valuetext (spec §8.2, issue #35)', () => {
  it('announces pan as a side and an amount, never a signed fraction', () => {
    setStrip({ pan: -0.3 });
    render(<MixerMode />);
    expect(screen.getByRole('slider', { name: 'Pan, Drums' })).toHaveAttribute('aria-valuetext', 'L 30');
  });

  it('announces dead centre as centre', () => {
    setStrip({ pan: 0 });
    render(<MixerMode />);
    expect(screen.getByRole('slider', { name: 'Pan, Drums' })).toHaveAttribute('aria-valuetext', 'Centre');
  });

  it('announces a send as a percentage rather than a bare 0..1 number', () => {
    setStrip({ sendLevels: [0.35, 0, 0, 0] });
    render(<MixerMode />);
    expect(screen.getByRole('slider', { name: 'Send 1, Drums' })).toHaveAttribute('aria-valuetext', '35 %');
  });

  it('names each send by its strip, so four strips do not present four "Send 1"s', () => {
    render(<MixerMode />);
    const names = screen.getAllByRole('slider').map((slider) => slider.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('still announces the fader in dB, now through the shared fader-level domain', () => {
    setStrip({ level: 1 });
    render(<MixerMode />);
    expect(screen.getByRole('slider', { name: 'Drums level' })).toHaveAttribute('aria-valuetext', '0.0 dB');
  });
});
