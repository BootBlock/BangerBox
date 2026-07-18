/**
 * MIDI message router tests — spec §10.2 input routing:
 *  - notes take the §7.6 dual path (immediate audition + worker delivery);
 *  - recorded timestamps are offset by the configurable input latency;
 *  - pitch bend reaches keygroup voices only, scaled by `pitchBendRange`;
 *  - CC never touches the graph — it goes through the Q-Link runtime into a store.
 */
import { describe, expect, it } from 'vitest';
import type { MidiMessage } from './parser';
import { createMidiRouter, type MidiRouterDeps } from './router';

/**
 * CC and pitch bend are rAF-aligned by design (spec §10.4), so the harness supplies a
 * manual frame pump and a fake clock; notes are immediate and need neither.
 */
function harness(overrides: Partial<MidiRouterDeps> = {}) {
  const notes: { note: number; velocity: number; on: boolean; timestampMs: number }[] = [];
  const bends: { programId: string; cents: number }[] = [];
  const ccs: { cc: number; value: number }[] = [];
  const frames: (() => void)[] = [];
  let clock = 0;
  const deps: MidiRouterDeps = {
    triggerLiveNote: (note, velocity, on, timestampMs) =>
      void notes.push({ note, velocity, on, timestampMs }),
    applyPitchBend: (programId, cents) => void bends.push({ programId, cents }),
    handleControlChange: (cc, value) => void ccs.push({ cc, value }),
    inputLatencyMs: () => 15,
    activeKeygroup: () => ({ programId: 'kg-1', pitchBendRange: 2 }),
    now: () => clock,
    scheduleFrame: (callback) => void frames.push(callback),
    ...overrides,
  };
  const router = createMidiRouter(deps);
  return {
    notes,
    bends,
    ccs,
    router,
    /** Run one animation frame's worth of queued throttle flushes. */
    pump(advanceMs = 0) {
      clock += advanceMs;
      frames.splice(0, frames.length).forEach((callback) => callback());
    },
  };
}

const noteOn = (note: number, velocity = 100, timestampMs = 1_000): MidiMessage => ({
  kind: 'noteOn',
  channel: 0,
  note,
  velocity,
  timestampMs,
});

const bend = (raw: number, value: number, timestampMs = 1_000): MidiMessage => ({
  kind: 'pitchBend',
  channel: 0,
  raw,
  value,
  timestampMs,
});

describe('note routing (spec §10.2, §7.6)', () => {
  it('sounds a note on', () => {
    const rig = harness();
    rig.router.route([noteOn(60)]);
    expect(rig.notes).toHaveLength(1);
    expect(rig.notes[0]).toMatchObject({ note: 60, velocity: 100, on: true });
  });

  it('routes a note off', () => {
    const rig = harness();
    rig.router.route([{ kind: 'noteOff', channel: 0, note: 60, velocity: 0, timestampMs: 1_000 }]);
    expect(rig.notes[0]).toMatchObject({ note: 60, on: false });
  });

  it('subtracts the input latency offset from the reconstructed timestamp (spec §10.2)', () => {
    const rig = harness();
    rig.router.route([noteOn(60, 100, 5_000)]);
    expect(rig.notes[0]!.timestampMs).toBe(5_000 - 15);
  });

  it('follows a change to the configured offset', () => {
    let latency = 15;
    const rig = harness({ inputLatencyMs: () => latency });
    latency = 40;
    rig.router.route([noteOn(60, 100, 5_000)]);
    expect(rig.notes[0]!.timestampMs).toBe(4_960);
  });

  it('routes every note in a multi-message packet', () => {
    const rig = harness();
    rig.router.route([noteOn(60), noteOn(64), noteOn(67)]);
    expect(rig.notes.map((entry) => entry.note)).toEqual([60, 64, 67]);
  });
});

describe('pitch bend (spec §10.2)', () => {
  it('applies bend to the active keygroup scaled by its bend range', () => {
    const rig = harness();
    rig.router.route([bend(16_383, 1)]);
    rig.pump();
    // Full bend up, ±2 semitones ⇒ +200 cents.
    expect(rig.bends[0]).toEqual({ programId: 'kg-1', cents: 200 });
  });

  it('applies a downward bend', () => {
    const rig = harness();
    rig.router.route([bend(0, -1)]);
    rig.pump();
    expect(rig.bends[0]!.cents).toBeCloseTo(-200, 6);
  });

  it('honours a wider bend range', () => {
    const rig = harness({ activeKeygroup: () => ({ programId: 'kg-1', pitchBendRange: 12 }) });
    rig.router.route([bend(16_383, 1)]);
    rig.pump();
    expect(rig.bends[0]!.cents).toBeCloseTo(1_200, 6);
  });

  it('centres to zero cents', () => {
    const rig = harness();
    rig.router.route([bend(8_192, 0)]);
    rig.pump();
    expect(rig.bends[0]!.cents).toBe(0);
  });

  it('ignores pitch bend when no keygroup program is active (drums, spec §10.2)', () => {
    const rig = harness({ activeKeygroup: () => null });
    rig.router.route([bend(16_383, 1)]);
    rig.pump();
    expect(rig.bends).toEqual([]);
  });
});

describe('control change (spec §10.2, §10.4)', () => {
  it('passes a CC to the Q-Link runtime rather than the graph', () => {
    const rig = harness();
    rig.router.route([{ kind: 'controlChange', channel: 0, controller: 74, value: 96, timestampMs: 1_000 }]);
    rig.pump();
    expect(rig.ccs).toEqual([{ cc: 74, value: 96 }]);
  });

  it('coalesces a noisy CC burst (spec §10.4 throttling)', () => {
    const now = 0;
    const frames: (() => void)[] = [];
    const ccs: { cc: number; value: number }[] = [];
    const router = createMidiRouter({
      triggerLiveNote: () => {},
      applyPitchBend: () => {},
      handleControlChange: (cc, value) => void ccs.push({ cc, value }),
      inputLatencyMs: () => 0,
      activeKeygroup: () => null,
      now: () => now,
      scheduleFrame: (callback) => void frames.push(callback),
    });
    for (const value of [10, 20, 30, 40]) {
      router.route([{ kind: 'controlChange', channel: 0, controller: 74, value, timestampMs: 0 }]);
    }
    frames.splice(0).forEach((callback) => callback());
    expect(ccs).toEqual([{ cc: 74, value: 40 }]);
  });

  it('does not throttle notes — every hit must sound (spec §7.6)', () => {
    const rig = harness();
    for (let index = 0; index < 20; index++) rig.router.route([noteOn(36 + index, 100, index)]);
    expect(rig.notes).toHaveLength(20);
  });

  it('drops pending state on reset (spec §10.4 reconnect)', () => {
    const rig = harness();
    expect(() => rig.router.reset()).not.toThrow();
  });
});
