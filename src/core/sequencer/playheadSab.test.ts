import { describe, expect, it } from 'vitest';
import { createPlayheadSab, PlayheadReader, PlayheadWriter } from './playheadSab';

describe('playhead SAB (spec §7.1.4)', () => {
  it('round-trips the current tick and transport flags', () => {
    const sab = createPlayheadSab();
    const writer = new PlayheadWriter(sab);
    const reader = new PlayheadReader(sab);

    writer.write(1234.5, true, false);
    let reading = reader.read();
    expect(reading.currentTick).toBeCloseTo(1234.5, 9);
    expect(reading.isPlaying).toBe(true);
    expect(reading.isRecording).toBe(false);

    writer.write(0, false, true);
    reading = reader.read();
    expect(reading.currentTick).toBe(0);
    expect(reading.isPlaying).toBe(false);
    expect(reading.isRecording).toBe(true);
  });

  it('leaves the generation even (no write in progress) after a write', () => {
    const sab = createPlayheadSab();
    const writer = new PlayheadWriter(sab);
    const reader = new PlayheadReader(sab);
    writer.write(10, true, true);
    writer.write(20, true, true);
    expect(reader.read().generation % 2).toBe(0);
    expect(reader.read().currentTick).toBe(20);
  });

  it('reports a clean zeroed reading before the first write', () => {
    const reading = new PlayheadReader(createPlayheadSab()).read();
    expect(reading).toMatchObject({ currentTick: 0, isPlaying: false, isRecording: false });
  });
});
