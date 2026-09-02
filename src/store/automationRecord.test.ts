/**
 * Automation capture from live gestures — spec §7.8. These are the regression tests for
 * the seam itself: before it existed nothing in the application called
 * `setAutomationLane`, so a recorded Q-Link or XYFX move produced no point at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayheadReading } from '@/core/sequencer';
import { AUTOMATION_MIN_TICK_SPACING } from '@/core/constants';
import { createDefaultChannelStrip, createDefaultPad } from '@/core/project/schemas';
import { useMixerStore } from './useMixerStore';
import { useProgramStore } from './useProgramStore';
import { clearUndoHistory, useUndoStore } from './undo';
import { useSequenceStore } from './useSequenceStore';
import { useTransportStore } from './useTransportStore';
import { recordParamGesture, resetAutomationRecording, setAutomationClock } from './automationRecord';

const PATH = 'mixer.master.level';
const LANE = `sequence:seq1:${PATH}`;

let reading: PlayheadReading;

function lane() {
  return useSequenceStore.getState().automation[LANE] ?? [];
}

beforeEach(() => {
  reading = { currentTick: 0, isPlaying: true, isRecording: true, isCapturing: true, generation: 2 };
  setAutomationClock(() => reading);
  resetAutomationRecording();
  clearUndoHistory();
  useSequenceStore.setState({ automation: {} });
  useTransportStore.setState({ activeSequenceId: 'seq1' });
});

afterEach(() => {
  setAutomationClock(null);
  useTransportStore.setState({ activeSequenceId: null });
});

describe('recordParamGesture (spec §7.8)', () => {
  it('writes nothing when no engine has published a playhead', () => {
    setAutomationClock(null);
    recordParamGesture(PATH, 0.5, 'move');
    expect(lane()).toEqual([]);
  });

  it('writes nothing while the transport is not capturing', () => {
    reading = { ...reading, isCapturing: false };
    recordParamGesture(PATH, 0.5, 'move');
    expect(lane()).toEqual([]);
  });

  it('writes nothing during the count-in, when recording but not yet capturing', () => {
    reading = { ...reading, isRecording: true, isCapturing: false };
    recordParamGesture(PATH, 0.5, 'move');
    expect(lane()).toEqual([]);
  });

  it('writes a sequence-scoped point at the playhead, owned by the active sequence', () => {
    reading = { ...reading, currentTick: 480 };
    recordParamGesture(PATH, 0.5, 'move');
    expect(lane()).toEqual([
      expect.objectContaining({
        scope: 'sequence',
        ownerId: 'seq1',
        targetPath: PATH,
        tick: 480,
        value: 0.5,
        curve: 'linear',
      }),
    ]);
  });

  it('thins by the minimum tick spacing (spec §7.8)', () => {
    recordParamGesture(PATH, 0.1, 'move');
    reading = { ...reading, currentTick: AUTOMATION_MIN_TICK_SPACING - 1 };
    recordParamGesture(PATH, 0.9, 'move');
    expect(lane()).toHaveLength(1);

    reading = { ...reading, currentTick: AUTOMATION_MIN_TICK_SPACING };
    recordParamGesture(PATH, 0.9, 'move');
    expect(lane()).toHaveLength(2);
  });

  it('thins by the value epsilon, scaled to the target range (spec §7.8)', () => {
    recordParamGesture(PATH, 0.5, 'move');
    reading = { ...reading, currentTick: 960 };
    // Level runs 0..1.2, so the epsilon is 0.005 × 1.2 = 0.006.
    recordParamGesture(PATH, 0.5005, 'move');
    expect(lane()).toHaveLength(1);

    reading = { ...reading, currentTick: 1920 };
    recordParamGesture(PATH, 0.52, 'move');
    expect(lane()).toHaveLength(2);
  });

  it('overwrites the span the pass sweeps rather than interleaving two takes', () => {
    // A first take leaves points across the bar.
    useSequenceStore.getState().setAutomationLane('sequence', 'seq1', PATH, [
      { id: 'a', scope: 'sequence', ownerId: 'seq1', targetPath: PATH, tick: 0, value: 0.1, curve: 'linear' },
      {
        id: 'b',
        scope: 'sequence',
        ownerId: 'seq1',
        targetPath: PATH,
        tick: 240,
        value: 0.2,
        curve: 'linear',
      },
      {
        id: 'c',
        scope: 'sequence',
        ownerId: 'seq1',
        targetPath: PATH,
        tick: 480,
        value: 0.3,
        curve: 'linear',
      },
    ]);

    reading = { ...reading, currentTick: 120 };
    recordParamGesture(PATH, 0.8, 'move');
    reading = { ...reading, currentTick: 600 };
    recordParamGesture(PATH, 0.9, 'move');

    // 240 and 480 fell inside the swept span and are gone; tick 0 predates the pass.
    expect(lane().map((point) => point.tick)).toEqual([0, 120, 600]);
  });

  it('records nothing for an unregistered address (spec §7.8 gate)', () => {
    recordParamGesture('mixer.master.wobble', 0.5, 'move');
    expect(useSequenceStore.getState().automation).toEqual({});
  });

  it('records nothing when no sequence is active to own the lane', () => {
    useTransportStore.setState({ activeSequenceId: null });
    recordParamGesture(PATH, 0.5, 'move');
    expect(useSequenceStore.getState().automation).toEqual({});
  });

  it("writes the gesture's released value on the commit phase", () => {
    recordParamGesture(PATH, 0.5, 'move');
    reading = { ...reading, currentTick: 1000 };
    recordParamGesture(PATH, 0.77, 'end');
    expect(lane().map((point) => point.value)).toEqual([0.5, 0.77]);
  });

  it('folds one recorded gesture into a single undo entry (spec §3.3)', () => {
    const before = useUndoStore.getState().undoDepth;
    recordParamGesture(PATH, 0.1, 'move');
    reading = { ...reading, currentTick: 480 };
    recordParamGesture(PATH, 0.4, 'move');
    reading = { ...reading, currentTick: 960 };
    recordParamGesture(PATH, 0.8, 'end');
    expect(useUndoStore.getState().undoDepth - before).toBe(1);

    useUndoStore.getState().undo();
    expect(lane()).toEqual([]);
  });

  it('opens a fresh sweep when the loop wraps behind the last sample', () => {
    reading = { ...reading, currentTick: 900 };
    recordParamGesture(PATH, 0.2, 'move');
    reading = { ...reading, currentTick: 0 };
    recordParamGesture(PATH, 0.9, 'move');
    // The wrapped sample is accepted, and it replaces only its own tick.
    expect(lane().map((point) => point.tick)).toEqual([0, 900]);
  });

  it('forgets its passes when the transport stops', () => {
    recordParamGesture(PATH, 0.2, 'move');
    resetAutomationRecording();
    // Tick 0 again: a live pass would refuse it for running backwards, a fresh one takes it.
    recordParamGesture(PATH, 0.9, 'move');
    expect(lane().map((point) => point.value)).toEqual([0.9]);
  });
});

/**
 * The tap itself (spec §7.8). Q-Link (`qlinkRuntime`), XYFX and every on-screen knob and
 * fader dispatch through these two actions, so a lane appearing here is the proof that a
 * gesture from any of them is captured. Before this seam, `setAutomationLane` had no
 * caller in the application and every one of those gestures wrote nothing.
 */
describe('the transient/commit tap (spec §4.1, §7.8)', () => {
  beforeEach(() => {
    useMixerStore.getState().setChannels({ master: createDefaultChannelStrip('master') });
  });

  it('captures a mixer gesture made while recording', () => {
    useMixerStore.getState().setTransient(PATH, 0.4);
    reading = { ...reading, currentTick: 480 };
    useMixerStore.getState().commit(PATH, 0.7);
    expect(lane().map((point) => [point.tick, point.value])).toEqual([
      [0, 0.4],
      [480, 0.7],
    ]);
  });

  it('captures nothing from the same gesture when the transport is not recording', () => {
    reading = { ...reading, isCapturing: false };
    useMixerStore.getState().setTransient(PATH, 0.4);
    useMixerStore.getState().commit(PATH, 0.7);
    expect(useSequenceStore.getState().automation).toEqual({});
    // The gesture still moved the parameter — capture is additive, never a replacement.
    expect(useMixerStore.getState().channels.master!.level).toBeCloseTo(0.7, 6);
  });

  it('captures a pad-scope program gesture, which §10.3 binds by default', () => {
    const programId = 'prog1';
    const padPath = `program:${programId}.pad:0.filter.cutoff`;
    useProgramStore.getState().setPrograms({
      [programId]: {
        id: programId,
        name: 'Kit',
        type: 'drum',
        pads: [createDefaultPad(0)],
      },
    });
    useProgramStore.getState().setPadParamTransient(padPath, 1200);
    expect(useSequenceStore.getState().automation[`sequence:seq1:${padPath}`]).toEqual([
      expect.objectContaining({ targetPath: padPath, tick: 0, value: 1200 }),
    ]);
    useProgramStore.getState().setPrograms({});
  });
});
