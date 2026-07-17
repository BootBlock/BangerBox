import { describe, expect, it } from 'vitest';
import { createFakeAudioContext, liveNodeCount } from '@/test/mocks/audioContext';
import { Metronome, renderClickWaveform } from './metronome';
import { PreviewChannel } from './preview';

describe('metronome click waveform (spec §5.9)', () => {
  it('renders a finite decaying burst sized to the click duration', () => {
    const data = renderClickWaveform(48_000, 1_000, 40);
    expect(data.length).toBe(Math.floor((48_000 * 40) / 1000));
    // Starts near zero (sine), swells, then decays close to zero by the end.
    expect(Math.abs(data[data.length - 1]!)).toBeLessThan(0.05);
    const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.5);
  });
});

describe('metronome (spec §5.9)', () => {
  it('routes its level gain into the monitor bus and sounds clicks', () => {
    const { context, fake } = createFakeAudioContext();
    const monitor = context.createGain();
    const metronome = new Metronome(context, monitor);
    metronome.click(0, true); // accented beat 1
    metronome.click(0.5, false);
    // Two buffer sources created for the two clicks.
    expect(fake.nodes.filter((n) => n.nodeType === 'bufferSource')).toHaveLength(2);
    metronome.destroy();
  });
});

describe('preview channel (spec §5.9)', () => {
  it('auditions a buffer and replaces the previous preview', () => {
    const { context, fake } = createFakeAudioContext();
    const monitor = context.createGain();
    const preview = new PreviewChannel(context, monitor);
    const buffer = context.createBuffer(1, 1000, 48_000);
    preview.play(buffer, 0);
    const firstSource = fake.nodes.find((n) => n.nodeType === 'bufferSource') as unknown as {
      stopped: boolean;
    };
    preview.play(buffer, 1); // cuts the first
    expect(firstSource.stopped).toBe(true);
    preview.destroy();
    expect(liveNodeCount(fake)).toBe(0);
  });
});
