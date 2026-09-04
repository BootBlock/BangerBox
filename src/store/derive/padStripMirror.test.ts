/**
 * The pad mixer-strip mirror (spec §4.2, §6, §8.5.6 — issue #133): the §6 payload and the
 * §4.2 `pad:` strips derived from each other, in both directions.
 *
 * The publish half matters as much as the write-back: without it a freshly loaded project
 * has no pad strip at all, so `useMixerStore.commit` returns before it writes and every
 * control on §8.5.6's Pads tab is inert. The write-back half is issue #133 as filed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelLevelPath, channelPanPath, channelSendPath } from '@/core/audio/params/registry';
import {
  createDefaultDrumProgram,
  createDefaultKeygroupProgram,
  createDefaultPad,
  type DrumProgram,
  type Pad,
} from '@/core/project/schemas';
import { clearUndoHistory, useUndoStore } from '../undo';
import { useMixerStore } from '../useMixerStore';
import { useProgramStore } from '../useProgramStore';
import { subscribePadStripMirror } from './padStripMirror';

const PROGRAM_ID = 'prog-1';
const PAD_CHANNEL = `pad:${PROGRAM_ID}:0`;

let dispose: (() => void) | null = null;

/** A one-pad drum program in the store, active, with the mixer holding no pad strip yet. */
function openProgram(pads: Pad[] = [createDefaultPad(0)]): DrumProgram {
  const program: DrumProgram = { ...createDefaultDrumProgram('Kit', PROGRAM_ID), pads };
  useProgramStore.getState().setPrograms({ [program.id]: program });
  useProgramStore.getState().setActiveProgram(program.id);
  useMixerStore.getState().setChannels({});
  return program;
}

/** The pad as the §6 payload holds it right now. */
function storedPad(padIndex = 0): Pad {
  const program = useProgramStore.getState().programs[PROGRAM_ID];
  if (program?.type !== 'drum') throw new Error('the fixture program is gone');
  const pad = program.pads.find((candidate) => candidate.padIndex === padIndex);
  if (pad === undefined) throw new Error(`pad ${padIndex} is not assigned`);
  return pad;
}

beforeEach(() => {
  clearUndoHistory();
  useMixerStore.getState().setChannels({});
  useProgramStore.getState().setPrograms({});
  useProgramStore.getState().setActiveProgram(null);
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('publishing the active program’s pads (spec §6 → §4.2)', () => {
  it('publishes a strip per assigned pad on registration', () => {
    openProgram();
    dispose = subscribePadStripMirror();
    expect(Object.keys(useMixerStore.getState().channels)).toEqual([PAD_CHANNEL]);
  });

  it('publishes strips for a program hydrated AFTER registration', () => {
    // §4.4 hydration writes `setPrograms` before `setChannels`, and reloading the project
    // already open re-selects the same `activeProgramId` — which a selector does not report
    // as a change. Both are why the mixer map is watched as well.
    dispose = subscribePadStripMirror();
    openProgram();
    useMixerStore.getState().setChannels({});
    expect(Object.keys(useMixerStore.getState().channels)).toEqual([PAD_CHANNEL]);
  });

  it('publishes a strip for a pad assigned while its program is already active', () => {
    openProgram();
    dispose = subscribePadStripMirror();
    useProgramStore.getState().upsertPad(PROGRAM_ID, createDefaultPad(5));
    expect(Object.keys(useMixerStore.getState().channels).sort()).toEqual([
      PAD_CHANNEL,
      `pad:${PROGRAM_ID}:5`,
    ]);
  });

  it('never clobbers a strip already in the store', () => {
    openProgram();
    dispose = subscribePadStripMirror();
    useMixerStore.getState().commit(channelLevelPath(PAD_CHANNEL), 0.4);
    useProgramStore.getState().setActiveProgram(null);
    useProgramStore.getState().setActiveProgram(PROGRAM_ID);
    expect(useMixerStore.getState().channels[PAD_CHANNEL]?.level).toBe(0.4);
  });

  it('publishes nothing for a keygroup program — its mixer is program-scope (spec §6)', () => {
    const keygroup = createDefaultKeygroupProgram('Pad', PROGRAM_ID);
    useProgramStore.getState().setPrograms({ [keygroup.id]: keygroup });
    useProgramStore.getState().setActiveProgram(keygroup.id);
    dispose = subscribePadStripMirror();
    expect(useMixerStore.getState().channels).toEqual({});
  });
});

describe('writing a strip edit back into the pad (spec §4.2 → §6, issue #133)', () => {
  beforeEach(() => {
    openProgram();
    dispose = subscribePadStripMirror();
  });

  it('writes a committed level into the §6 payload', () => {
    useMixerStore.getState().commit(channelLevelPath(PAD_CHANNEL), 0.4);
    expect(storedPad().mixer.level).toBe(0.4);
  });

  it('writes a committed pan into the §6 payload', () => {
    useMixerStore.getState().commit(channelPanPath(PAD_CHANNEL), -0.5);
    expect(storedPad().mixer.pan).toBe(-0.5);
  });

  it('writes a committed send into the §6 payload', () => {
    useMixerStore.getState().commit(channelSendPath(PAD_CHANNEL, 1), 0.6);
    expect(storedPad().mixer.sendLevels).toEqual([0, 0.6, 0, 0]);
  });

  it('writes an added insert into the §6 payload', () => {
    useMixerStore.getState().addInsert(PAD_CHANNEL, 'delay');
    const slots = storedPad().inserts;
    expect(slots.at(-1)).toMatchObject({ effectType: 'delay', enabled: true });
    // The §5.7 defaults the store completes on the way in reach the payload with the slot
    // (issue #131), so what the project sounds like no longer depends on the build.
    expect(slots.at(-1)!.params.time).toBe(350);
  });

  it('leaves ONE undo entry, and one press restores both stores', () => {
    useMixerStore.getState().commit(channelLevelPath(PAD_CHANNEL), 0.4);
    expect(storedPad().mixer.level).toBe(0.4);
    // The write-back records no entry of its own: the mixer commit's revert closure restores
    // the strip and the mirror follows it out again, so one fader move is one Ctrl+Z. A
    // second entry here would undo the payload while the strip stayed where the gesture left
    // it, which is the two stores disagreeing — the state §3.4 forbids.
    expect(useUndoStore.getState().undoDepth).toBe(1);
    useUndoStore.getState().undo();
    expect(storedPad().mixer.level).toBe(1);
    expect(useMixerStore.getState().channels[PAD_CHANNEL]?.level).toBe(1);
  });

  it('leaves a field the strip did not move at the pad’s own value', () => {
    // `program:<id>.pad:<idx>.amp` and `mixer.pad:<id>:<idx>.level` are two §7.8 addresses
    // for one value, and only one of them republishes into the other's store. A mirror that
    // copied whole strips would revert this amp edit on the next unrelated touch of the pan.
    useProgramStore.getState().commitPadParam(`program:${PROGRAM_ID}.pad:0.amp`, 0.25);
    useMixerStore.getState().commit(channelPanPath(PAD_CHANNEL), -0.5);
    expect(storedPad().mixer).toMatchObject({ level: 0.25, pan: -0.5 });
  });

  it('writes nothing for mute or solo — §6 Pad.mixer defines neither', () => {
    const before = storedPad();
    useMixerStore.getState().setMute(PAD_CHANNEL, true);
    useMixerStore.getState().setSolo(PAD_CHANNEL, true);
    expect(storedPad()).toBe(before);
  });

  it('writes nothing for a track strip', () => {
    const before = useProgramStore.getState().programs;
    useMixerStore.getState().upsertChannel({
      ...useMixerStore.getState().channels[PAD_CHANNEL]!,
      id: 'track:t-1',
    });
    useMixerStore.getState().commit(channelLevelPath('track:t-1'), 0.4);
    expect(useProgramStore.getState().programs).toBe(before);
  });

  it('drops an edit addressing a program that has gone', () => {
    useProgramStore.getState().setPrograms({});
    expect(() => useMixerStore.getState().commit(channelLevelPath(PAD_CHANNEL), 0.4)).not.toThrow();
  });

  it('stops writing once disposed (spec §3.5 lens 5)', () => {
    dispose?.();
    dispose = null;
    useMixerStore.getState().commit(channelLevelPath(PAD_CHANNEL), 0.4);
    expect(storedPad().mixer.level).toBe(1);
  });
});
