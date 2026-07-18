/**
 * Store action tests (spec §4, §12 Phase 2 exit) — clamping (spec §4.1), the
 * transient/commit channel and gesture coalescing (spec §4.1, §3.3), undoability
 * (spec §4.5), and dirty-marking for autosave (spec §4.4, observed via a registered
 * fake queue).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AutosaveQueue } from '@/core/project/autosave';
import { registerAutosave, unregisterAutosave } from '@/core/project/dirty';
import {
  createDefaultChannelStrip,
  createDefaultDrumProgram,
  createDefaultPad,
  createDefaultSequence,
} from '@/core/project/schemas';
import { clearUndoHistory, useUndoStore } from './undo';
import { useTransportStore } from './useTransportStore';
import { useProjectStore } from './useProjectStore';
import { useSequenceStore } from './useSequenceStore';
import { useProgramStore } from './useProgramStore';
import { useMixerStore } from './useMixerStore';
import { useUIStore } from './useUIStore';
import { useHardwareStore } from './useHardwareStore';
import { useBrowserStore } from './useBrowserStore';

let queue: AutosaveQueue;
let dirty: MockInstance<(key: string) => void>;
let onDirty: ReturnType<typeof vi.fn>;

function resetStores(): void {
  useMixerStore.getState().setChannels({});
  useSequenceStore.getState().hydrate({
    sequences: {},
    tracks: {},
    events: {},
    automation: {},
    songEntries: [],
  });
  useProgramStore.getState().setPrograms({});
  useProgramStore.setState({ activeProgramId: null, activePadId: null });
  useHardwareStore.getState().setBindings([]);
  useProjectStore.getState().applyProject({
    projectId: 'proj-1',
    projectName: 'Test',
    sampleRate: 48_000,
    bitDepth: '24',
    globalInsertLimit: 4,
  });
}

beforeEach(() => {
  clearUndoHistory();
  resetStores();
  onDirty = vi.fn();
  queue = new AutosaveQueue({ flush: async () => {} });
  dirty = vi.spyOn(queue, 'markDirty');
  registerAutosave(queue, { onDirty });
});
afterEach(() => {
  unregisterAutosave();
  queue.dispose();
});

describe('useTransportStore clamps and toggles (spec §4.1)', () => {
  it('clamps bpm and swing into range', () => {
    useTransportStore.getState().setBpm(5000);
    expect(useTransportStore.getState().bpm).toBe(300);
    useTransportStore.getState().setBpm(1);
    expect(useTransportStore.getState().bpm).toBe(20);
    useTransportStore.getState().setSwing(90, 8);
    expect(useTransportStore.getState().swingAmount).toBe(75);
    expect(useTransportStore.getState().swingDivision).toBe(8);
  });

  it('orders loop points and stop resets the readout', () => {
    useTransportStore.getState().setLoop({ enabled: true, startTick: 960, endTick: 480 });
    expect(useTransportStore.getState().loopEndTick).toBe(960); // clamped up to start
    useTransportStore.getState().play();
    useTransportStore.getState().setRecording(true);
    useTransportStore.getState().stop();
    expect(useTransportStore.getState().isPlaying).toBe(false);
    expect(useTransportStore.getState().isRecording).toBe(false);
    expect(useTransportStore.getState().coarsePosition).toEqual({ bar: 1, beat: 1 });
  });

  it('does not create undo entries (transport is not undoable, spec §4.5)', () => {
    useTransportStore.getState().setBpm(140);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(dirty).not.toHaveBeenCalled();
  });
});

describe('useMixerStore transient/commit channel (spec §4.1, §3.3)', () => {
  beforeEach(() => {
    useMixerStore.getState().upsertChannel(createDefaultChannelStrip('track:1'));
  });

  it('transient updates move the value without undo or autosave', () => {
    useMixerStore.getState().setTransient('track:1.level', 0.5);
    expect(useMixerStore.getState().channels['track:1']!.level).toBe(0.5);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(dirty).not.toHaveBeenCalled();
  });

  it('a drag (many transient + one commit) is one undo entry back to the pre-gesture value', () => {
    // Pre-gesture value is 1 (the default strip level).
    for (const v of [0.9, 0.7, 0.55, 0.42]) useMixerStore.getState().setTransient('track:1.level', v);
    useMixerStore.getState().commit('track:1.level', 0.42);

    expect(useMixerStore.getState().channels['track:1']!.level).toBe(0.42);
    expect(useUndoStore.getState().undoDepth).toBe(1);
    expect(dirty).toHaveBeenCalledWith('track:1');
    expect(onDirty).toHaveBeenCalled();

    useUndoStore.getState().undo();
    expect(useMixerStore.getState().channels['track:1']!.level).toBe(1);
    useUndoStore.getState().redo();
    expect(useMixerStore.getState().channels['track:1']!.level).toBe(0.42);
  });

  it('two separate drags are two distinct undo entries', () => {
    useMixerStore.getState().commit('track:1.level', 0.8);
    useMixerStore.getState().commit('track:1.level', 0.3);
    expect(useUndoStore.getState().undoDepth).toBe(2);
  });

  it('clamps a committed level above the fader ceiling (spec §4.2)', () => {
    useMixerStore.getState().commit('track:1.pan', 5);
    expect(useMixerStore.getState().channels['track:1']!.pan).toBe(1);
  });

  it('mute is an undoable commit that marks the channel dirty', () => {
    useMixerStore.getState().setMute('track:1', true);
    expect(useMixerStore.getState().channels['track:1']!.mute).toBe(true);
    expect(dirty).toHaveBeenCalledWith('track:1');
    useUndoStore.getState().undo();
    expect(useMixerStore.getState().channels['track:1']!.mute).toBe(false);
  });

  it('routes pad and master strips to their owning entity dirty keys', () => {
    useMixerStore.getState().upsertChannel(createDefaultChannelStrip('pad:prog-9:3'));
    useMixerStore.getState().upsertChannel(createDefaultChannelStrip('master'));
    useMixerStore.getState().setMute('pad:prog-9:3', true);
    expect(dirty).toHaveBeenCalledWith('program:prog-9');
    useMixerStore.getState().setMute('master', true);
    expect(dirty).toHaveBeenCalledWith('project:proj-1');
  });
});

describe('useSequenceStore (spec §4.2, §4.5)', () => {
  it('adds a sequence undoably and marks it dirty', () => {
    const seq = createDefaultSequence('proj-1');
    useSequenceStore.getState().addSequence(seq);
    expect(useSequenceStore.getState().sequences[seq.id]).toEqual(seq);
    expect(dirty).toHaveBeenCalledWith(`sequence:${seq.id}`);
    useUndoStore.getState().undo();
    expect(useSequenceStore.getState().sequences[seq.id]).toBeUndefined();
  });

  it('clamps sequence length on update', () => {
    const seq = createDefaultSequence('proj-1');
    useSequenceStore.getState().addSequence(seq);
    useSequenceStore.getState().updateSequence(seq.id, { lengthBars: 100_000 });
    expect(useSequenceStore.getState().sequences[seq.id]!.lengthBars).toBe(999);
  });

  it('adds and removes events undoably, keeping tick order', () => {
    useSequenceStore.getState().addEvents('track:1', [
      { id: 'b', tickStart: 480, durationTicks: 24, note: 62, velocity: 90, extra: null },
      { id: 'a', tickStart: 0, durationTicks: 24, note: 60, velocity: 100, extra: null },
    ]);
    expect(useSequenceStore.getState().events['track:1']!.map((e) => e.id)).toEqual(['a', 'b']);
    expect(dirty).toHaveBeenCalledWith('events:track:1');
    useSequenceStore.getState().removeEvents('track:1', ['a']);
    expect(useSequenceStore.getState().events['track:1']!.map((e) => e.id)).toEqual(['b']);
    useUndoStore.getState().undo();
    expect(useSequenceStore.getState().events['track:1']!.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('collapses a coalesced drag into one undo step (spec §3.3)', () => {
    const note = (tickStart: number) => [
      { id: 'a', tickStart, durationTicks: 24, note: 60, velocity: 100, extra: null },
    ];
    useSequenceStore.getState().setTrackEvents('track:1', note(0));
    const depthBefore = useUndoStore.getState().undoDepth;

    // A drag reports many intermediate positions before the pointer is released.
    for (const tick of [120, 240, 360, 480]) {
      useSequenceStore.getState().setTrackEvents('track:1', note(tick), 'grid-move');
    }
    expect(useSequenceStore.getState().events['track:1']![0]!.tickStart).toBe(480);
    expect(useUndoStore.getState().undoDepth).toBe(depthBefore + 1);

    // One undo returns to where the note sat before the drag began, not mid-drag.
    useUndoStore.getState().undo();
    expect(useSequenceStore.getState().events['track:1']![0]!.tickStart).toBe(0);
  });

  it('starts a fresh undo entry once a gesture is sealed (spec §3.3)', () => {
    const note = (tickStart: number) => [
      { id: 'a', tickStart, durationTicks: 24, note: 60, velocity: 100, extra: null },
    ];
    useSequenceStore.getState().setTrackEvents('track:1', note(0));
    useSequenceStore.getState().setTrackEvents('track:1', note(120), 'grid-move');
    useUndoStore.getState().endGesture();
    // A second drag under the same key must not merge into the first.
    useSequenceStore.getState().setTrackEvents('track:1', note(240), 'grid-move');

    useUndoStore.getState().undo();
    expect(useSequenceStore.getState().events['track:1']![0]!.tickStart).toBe(120);
  });
});

describe('useProgramStore (spec §4.2, §6)', () => {
  it('adds a program and assigns a pad, both undoable and dirty', () => {
    const program = createDefaultDrumProgram('Kit', 'prog-1');
    useProgramStore.getState().addProgram(program);
    expect(dirty).toHaveBeenCalledWith('program:prog-1');

    useProgramStore.getState().upsertPad('prog-1', createDefaultPad(4));
    const stored = useProgramStore.getState().programs['prog-1'];
    expect(stored?.type).toBe('drum');
    if (stored?.type === 'drum') expect(stored.pads.map((p) => p.padIndex)).toEqual([4]);

    useUndoStore.getState().undo(); // undo pad assignment
    const afterUndo = useProgramStore.getState().programs['prog-1'];
    if (afterUndo?.type === 'drum') expect(afterUndo.pads).toEqual([]);
  });
});

describe('useProjectStore settings (spec §4.4)', () => {
  it('marks the project dirty and raises the unsaved hook on a settings edit', () => {
    useProjectStore.getState().setProjectName('Renamed');
    expect(useProjectStore.getState().projectName).toBe('Renamed');
    expect(dirty).toHaveBeenCalledWith('project:proj-1');
    expect(onDirty).toHaveBeenCalled();
  });

  it('clamps the global insert limit to 1..8 (spec §1.3.1)', () => {
    useProjectStore.getState().setGlobalInsertLimit(99);
    expect(useProjectStore.getState().globalInsertLimit).toBe(8);
  });
});

describe('useUIStore (spec §4.2)', () => {
  it('queues and dismisses toasts, and switches mode', () => {
    const id = useUIStore.getState().pushToast('Saved', 'success');
    expect(useUIStore.getState().toasts).toHaveLength(1);
    useUIStore.getState().dismissToast(id);
    expect(useUIStore.getState().toasts).toHaveLength(0);
    useUIStore.getState().setActiveMode('mixer');
    expect(useUIStore.getState().activeMode).toBe('mixer');
  });

  it('refreshes a repeated notice rather than queueing it again', () => {
    useUIStore.setState({ toasts: [] });
    const first = useUIStore.getState().pushToast('Autosave failed', 'error');
    const second = useUIStore.getState().pushToast('Autosave failed', 'error');
    expect(second).toBe(first);
    expect(useUIStore.getState().toasts).toHaveLength(1);
  });

  it('evicts advisory notices before errors when the queue overflows', () => {
    useUIStore.setState({ toasts: [] });
    const critical = useUIStore.getState().pushToast('Could not open your project', 'error');
    // Nine distinct advisory notices against a queue that holds eight.
    for (let i = 0; i < 9; i += 1) useUIStore.getState().pushToast(`Notice ${i}`, 'info');
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(8);
    expect(toasts.some((toast) => toast.id === critical)).toBe(true);
  });

  it('auto-dismisses advisory notices but leaves errors up until dismissed', () => {
    vi.useFakeTimers();
    try {
      useUIStore.setState({ toasts: [] });
      useUIStore.getState().pushToast('Saved', 'success');
      const error = useUIStore.getState().pushToast('Export failed', 'error');
      vi.advanceTimersByTime(30_000);
      const toasts = useUIStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.id).toBe(error);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useHardwareStore (spec §10.3, §4.5)', () => {
  it('upserts a Q-Link binding undoably, dirtying the per-mode settings key', () => {
    useHardwareStore.getState().upsertBinding({
      encoderIndex: 0,
      cc: 20,
      targetStore: 'mixer',
      targetParameterPath: 'mixer.master.level',
      minValue: 0,
      maxValue: 1,
      curve: 'linear',
      mode: 'absolute',
    });
    expect(useHardwareStore.getState().qLinkBindings).toHaveLength(1);
    expect(dirty).toHaveBeenCalledWith('settings:qlink:screen');
    useUndoStore.getState().undo();
    expect(useHardwareStore.getState().qLinkBindings).toHaveLength(0);
  });
});

describe('useBrowserStore (spec §4.2)', () => {
  it('toggles favourites', () => {
    useBrowserStore.getState().toggleFavourite('s1');
    expect(useBrowserStore.getState().favourites).toContain('s1');
    useBrowserStore.getState().toggleFavourite('s1');
    expect(useBrowserStore.getState().favourites).not.toContain('s1');
  });
});
