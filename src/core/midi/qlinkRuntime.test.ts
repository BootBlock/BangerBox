/**
 * Q-Link runtime tests — spec §10.3's execution flow, end to end through the real stores:
 * "CC in → look up binding for current mode → scale into [min,max] per curve → dispatch to
 * the target store action (transient during turn, commit on 250 ms idle) → sync layer
 * updates the node". Spec §10.2 also forbids the MIDI listener touching the graph
 * directly, so every assertion here is about *store* state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  channelLevelPath,
  programParamPath,
  transportParamPath,
} from '@/core/audio/params/registry';
import {
  createDefaultChannelStrip,
  createDefaultDrumProgram,
  createDefaultPad,
  type QLinkBinding,
} from '@/core/project/schemas';
import {
  useHardwareStore,
  useMixerStore,
  useProgramStore,
  useTransportStore,
  useUIStore,
} from '@/store';
import { useUndoStore } from '@/store/undo/useUndoStore';
import { QLINK_COMMIT_IDLE_MS, createQLinkRuntime } from './qlinkRuntime';

const PROGRAM_ID = 'prog-1';
const PAD_INDEX = 0;

function seed() {
  vi.useFakeTimers();
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

const masterLevel = () => useMixerStore.getState().channels.master!.level;

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
    expect(masterLevel()).toBe(1);
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
    vi.advanceTimersByTime(QLINK_COMMIT_IDLE_MS);
    expect(useUndoStore.getState().undoDepth).toBe(1);
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
    const program = useProgramStore.getState().programs[PROGRAM_ID]!;
    if (program.type !== 'drum') throw new Error('expected drum');
    expect(program.pads[0]!.filter.cutoff).toBeCloseTo(20_000, 0);
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

  it('ignores a binding whose parameter path is not registered', () => {
    useHardwareStore.getState().setBindings([binding({ targetParameterPath: 'mixer.master.bogus' })]);
    createQLinkRuntime().handleControlChange(70, 127);
    expect(masterLevel()).toBe(1);
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
    const program = useProgramStore.getState().programs[PROGRAM_ID]!;
    if (program.type !== 'drum') throw new Error('expected drum');
    expect(program.pads[0]!.filter.cutoff).toBeGreaterThan(10_000);
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
    expect(masterLevel()).toBe(1);
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
