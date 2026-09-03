/**
 * Q-Link runtime tests — spec §10.3's execution flow, end to end through the real stores:
 * "CC in → look up binding for current mode → scale into [min,max] per curve → dispatch to
 * the target store action (transient during turn, commit on 250 ms idle) → sync layer
 * updates the node". Spec §10.2 also forbids the MIDI listener touching the graph
 * directly, so nothing here asserts against an AudioNode.
 *
 * A turning encoder is a §3.3 continuous value, so mid-turn it lives on the §4.1 transient
 * channel and NOT in the store (issue #27) — {@link masterLevel} therefore reads the channel
 * first and the store second, which together are what the §4.3 sync layer would apply. The
 * idle commit is what moves the store, and {@link settle} is how a test reaches it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelLevelPath, programParamPath, transportParamPath } from '@/core/audio/params/registry';
import {
  createDefaultChannelStrip,
  createDefaultDrumProgram,
  createDefaultPad,
  type QLinkBinding,
} from '@/core/project/schemas';
import { useHardwareStore, useMixerStore, useProgramStore, useTransportStore, useUIStore } from '@/store';
import { useUndoStore } from '@/store/undo/useUndoStore';
import { readTransientValue, resetTransientChannel } from '@/store/transientChannel';
import { QLINK_COMMIT_IDLE_MS, createQLinkRuntime } from './qlinkRuntime';

const PROGRAM_ID = 'prog-1';
const PAD_INDEX = 0;

function seed() {
  vi.useFakeTimers();
  resetTransientChannel();
  useUndoStore.getState().clearHistory();
  useMixerStore.getState().setChannels({ master: createDefaultChannelStrip('master') });
  useProgramStore.getState().setPrograms({
    [PROGRAM_ID]: { ...createDefaultDrumProgram('Kit', PROGRAM_ID), pads: [createDefaultPad(PAD_INDEX)] },
  });
  useProgramStore.getState().setActiveProgram(PROGRAM_ID);
  useProgramStore.getState().setActivePad(PAD_INDEX);
  useUIStore.getState().setFocusedControlParams([]);
  useHardwareStore.getState().setQLinkMode('project');
  useHardwareStore.getState().setBindings([]);
  useTransportStore.getState().setSwing(50);
}

function binding(patch: Partial<QLinkBinding> = {}): QLinkBinding {
  return {
    encoderIndex: 0,
    cc: 70,
    targetStore: 'mixer',
    targetParameterPath: channelLevelPath('master'),
    minValue: 0,
    maxValue: 1,
    curve: 'linear',
    mode: 'absolute',
    ...patch,
  };
}

/** Where the master fader is right now: the in-flight gesture's value, else the store's. */
const masterLevel = () =>
  readTransientValue(channelLevelPath('master')) ?? useMixerStore.getState().channels.master!.level;
/** What the store holds — which a turn must NOT move until the §10.3 idle commit. */
const storedMasterLevel = () => useMixerStore.getState().channels.master!.level;
/** The pad's filter cutoff, mid-turn or committed, read the same way. */
const padCutoff = () => {
  const path = programParamPath(PROGRAM_ID, PAD_INDEX, 'filter.cutoff');
  const live = readTransientValue(path);
  if (live !== undefined) return live;
  const program = useProgramStore.getState().programs[PROGRAM_ID]!;
  if (program.type !== 'drum') throw new Error('expected drum');
  return program.pads[0]!.filter.cutoff;
};
/** Let the §10.3 idle window elapse, so the turn commits into the stores. */
const settle = () => vi.advanceTimersByTime(QLINK_COMMIT_IDLE_MS);

describe('CC dispatch (spec §10.3)', () => {
  beforeEach(seed);

  it('scales an incoming CC into a mixer store value', () => {
    useHardwareStore.getState().setBindings([binding()]);
    createQLinkRuntime().handleControlChange(70, 127);
    expect(masterLevel()).toBeCloseTo(1, 6);
  });

  it('ignores a CC with no binding in the active mode', () => {
    useHardwareStore.getState().setBindings([binding({ cc: 70 })]);
    createQLinkRuntime().handleControlChange(99, 127);
    expect(readTransientValue(channelLevelPath('master'))).toBeUndefined();
    expect(storedMasterLevel()).toBe(1);
  });

  it('streams transient updates without touching the undo stack mid-turn', () => {
    useHardwareStore.getState().setBindings([binding()]);
    const runtime = createQLinkRuntime();
    for (const value of [10, 20, 30]) runtime.handleControlChange(70, value);
    expect(useUndoStore.getState().undoDepth).toBe(0);
    expect(masterLevel()).toBeCloseTo(30 / 127, 6);
  });

  it('commits one undo entry after the encoder is idle (spec §10.3 250 ms)', () => {
    useHardwareStore.getState().setBindings([binding()]);
    const runtime = createQLinkRuntime();
    for (const value of [10, 20, 30]) runtime.handleControlChange(70, value);
    settle();
    expect(useUndoStore.getState().undoDepth).toBe(1);
    expect(storedMasterLevel()).toBeCloseTo(30 / 127, 6);
  });

  /**
   * Issue #27 and spec §3.3: sixty CC frames a second used to be sixty store writes, each
   * replacing the `channels` map's identity and re-rendering every consumer of it — including
   * Q-Link Edit, whose encoder `<select>` lists rebuild from that map, in the very mode the
   * user is in while turning the encoder that drives them.
   */
  it('moves no store, and so re-renders nothing, until the idle commit (issue #27)', () => {
    useHardwareStore.getState().setBindings([binding()]);
    const runtime = createQLinkRuntime();
    let notifications = 0;
    const stop = useMixerStore.subscribe(
      (state) => state.channels,
      () => {
        notifications += 1;
      },
    );
    for (let frame = 0; frame < 60; frame += 1) runtime.handleControlChange(70, frame);
    expect(notifications).toBe(0);
    expect(storedMasterLevel()).toBe(1);
    settle();
    expect(notifications).toBe(1);
    stop();
  });

  it('does not commit while the encoder is still turning', () => {
    useHardwareStore.getState().setBindings([binding()]);
    const runtime = createQLinkRuntime();
    runtime.handleControlChange(70, 10);
    vi.advanceTimersByTime(QLINK_COMMIT_IDLE_MS - 10);
    runtime.handleControlChange(70, 20);
    vi.advanceTimersByTime(QLINK_COMMIT_IDLE_MS - 10);
    expect(useUndoStore.getState().undoDepth).toBe(0);
    vi.advanceTimersByTime(20);
    expect(useUndoStore.getState().undoDepth).toBe(1);
  });

  it('drives a program parameter through the program store', () => {
    useHardwareStore.getState().setQLinkMode('pad');
    useHardwareStore.getState().setBindings([
      binding({
        targetStore: 'program',
        targetParameterPath: programParamPath(PROGRAM_ID, PAD_INDEX, 'filter.cutoff'),
        minValue: 20,
        maxValue: 20_000,
        curve: 'log',
      }),
    ]);
    createQLinkRuntime().handleControlChange(70, 127);
    expect(padCutoff()).toBeCloseTo(20_000, 0);
  });

  it('drives global swing through the transport store', () => {
    useHardwareStore.getState().setBindings([
      binding({
        targetStore: 'transport',
        targetParameterPath: transportParamPath('swing'),
        minValue: 50,
        maxValue: 75,
      }),
    ]);
    createQLinkRuntime().handleControlChange(70, 127);
    expect(useTransportStore.getState().swingAmount).toBeCloseTo(75, 6);
  });

  it('moves a relative encoder from the current value', () => {
    useHardwareStore.getState().setBindings([binding({ mode: 'relative' })]);
    const runtime = createQLinkRuntime();
    const before = masterLevel();
    runtime.handleControlChange(70, 127); // two’s complement −1
    expect(masterLevel()).toBeLessThan(before);
  });

  /**
   * A relative encoder steps from where the parameter is NOW. Once the store stops moving
   * mid-turn (issue #27), that reading has to come from the §4.1 transient channel — reading
   * the store instead would make every frame of a turn step once from the same origin, so a
   * hundred frames of a downward turn would move by one increment in total.
   */
  it('keeps stepping a relative encoder across a whole turn', () => {
    useHardwareStore.getState().setBindings([binding({ mode: 'relative' })]);
    const runtime = createQLinkRuntime();
    const readings: number[] = [];
    for (let frame = 0; frame < 5; frame += 1) {
      runtime.handleControlChange(70, 127); // two’s complement −1, five times
      readings.push(masterLevel());
    }
    // Strictly decreasing: each frame stepped from the previous frame's value.
    for (let index = 1; index < readings.length; index += 1) {
      expect(readings[index]!).toBeLessThan(readings[index - 1]!);
    }
    settle();
    expect(storedMasterLevel()).toBeCloseTo(readings.at(-1)!, 6);
  });

  it('ignores a binding whose parameter path is not registered', () => {
    useHardwareStore.getState().setBindings([binding({ targetParameterPath: 'mixer.master.bogus' })]);
    createQLinkRuntime().handleControlChange(70, 127);
    expect(readTransientValue(channelLevelPath('master'))).toBeUndefined();
    expect(storedMasterLevel()).toBe(1);
  });
});

describe('mode-aware bindings (spec §10.3)', () => {
  beforeEach(seed);

  it('falls back to the mode defaults when nothing is stored', () => {
    useHardwareStore.getState().setQLinkMode('pad');
    useHardwareStore.getState().setBindings([]);
    const runtime = createQLinkRuntime();
    // Pad-mode default encoder 1 is filter cutoff, on the default CC block.
    runtime.handleControlChange(71, 127);
    expect(padCutoff()).toBeGreaterThan(10_000);
  });

  it('prefers stored bindings over the mode defaults', () => {
    useHardwareStore.getState().setQLinkMode('pad');
    useHardwareStore.getState().setBindings([binding({ cc: 71 })]); // master level on CC 71
    createQLinkRuntime().handleControlChange(71, 0);
    expect(masterLevel()).toBe(0);
  });

  it('maps screen mode onto the focused panel’s registered parameters', () => {
    useHardwareStore.getState().setQLinkMode('screen');
    useHardwareStore.getState().setBindings([]);
    useUIStore
      .getState()
      .setFocusedControlParams([{ label: 'Master level', targetParameterPath: channelLevelPath('master') }]);
    createQLinkRuntime().handleControlChange(70, 0);
    expect(masterLevel()).toBe(0);
  });

  it('does nothing in screen mode when no panel has registered parameters', () => {
    useHardwareStore.getState().setQLinkMode('screen');
    useHardwareStore.getState().setBindings([]);
    useUIStore.getState().setFocusedControlParams([]);
    createQLinkRuntime().handleControlChange(70, 0);
    expect(readTransientValue(channelLevelPath('master'))).toBeUndefined();
    expect(storedMasterLevel()).toBe(1);
  });

  it('follows a mode change without rebuilding the runtime', () => {
    const runtime = createQLinkRuntime();
    useHardwareStore.getState().setQLinkMode('screen');
    useUIStore
      .getState()
      .setFocusedControlParams([{ label: 'Master level', targetParameterPath: channelLevelPath('master') }]);
    runtime.handleControlChange(70, 0);
    expect(masterLevel()).toBe(0);
  });

  it('exposes the bindings in force for the active mode (Q-Link Edit table)', () => {
    useHardwareStore.getState().setQLinkMode('pad');
    useHardwareStore.getState().setBindings([]);
    const paths = createQLinkRuntime()
      .effectiveBindings()
      .map((entry) => entry.targetParameterPath);
    expect(paths).toContain(programParamPath(PROGRAM_ID, PAD_INDEX, 'pitch'));
  });
});
