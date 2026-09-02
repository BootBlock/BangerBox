import { describe, expect, it } from 'vitest';
import { createDefaultChannelStrip, createEmptyInsertSlot } from '@/core/project/schemas';
import type { ChannelStrip, DrumProgram } from '@/core/project/schemas';
import { isAutomatable } from './registry';
import { channelAutomatableParams, programAutomatableParams } from './catalogue';

function stripWithInsert(id: string): ChannelStrip {
  const base = createDefaultChannelStrip(id);
  return {
    ...base,
    inserts: [{ ...createEmptyInsertSlot(), effectType: 'delay', enabled: true }, createEmptyInsertSlot()],
  };
}

describe('channelAutomatableParams (spec §7.8)', () => {
  it('offers level, pan and all four sends, in that order', () => {
    const params = channelAutomatableParams('master', createDefaultChannelStrip('master'), 'Master');
    expect(params.map((p) => p.path)).toEqual([
      'mixer.master.level',
      'mixer.master.pan',
      'mixer.master.sendLevels.0',
      'mixer.master.sendLevels.1',
      'mixer.master.sendLevels.2',
      'mixer.master.sendLevels.3',
    ]);
  });

  it('offers only paths the registry accepts', () => {
    const params = channelAutomatableParams('track:t1', stripWithInsert('track:t1'), 'Drums');
    expect(params.every((p) => isAutomatable(p.path))).toBe(true);
  });

  it('addresses a filled insert slot 1-based and skips the empty one (spec §3.4)', () => {
    const params = channelAutomatableParams('track:t1', stripWithInsert('track:t1'), 'Drums');
    const inserts = params.filter((p) => p.path.startsWith('insert:'));
    expect(inserts.map((p) => p.path)).toEqual([
      'insert:track:t1:slot1.time',
      'insert:track:t1:slot1.feedback',
      'insert:track:t1:slot1.tone',
      'insert:track:t1:slot1.mix',
    ]);
  });

  it('names the channel by its display name, never its raw id', () => {
    const params = channelAutomatableParams('track:t1', createDefaultChannelStrip('track:t1'), 'Drums');
    expect(params[0]!.label).toBe('Drums · level');
  });
});

describe('programAutomatableParams (spec §6, §7.8)', () => {
  const program = {
    id: 'prog1',
    name: 'Kit',
    type: 'drum',
    pads: [
      { padIndex: 1, name: 'Snare' },
      { padIndex: 0, name: 'Kick' },
    ],
  } as unknown as DrumProgram;

  it('lists pads in index order and offers every registered leaf', () => {
    const params = programAutomatableParams(program);
    expect(params[0]!.path).toBe('program:prog1.pad:0.filter.cutoff');
    expect(params[0]!.label).toBe('Kick · filter.cutoff');
    expect(params.every((p) => isAutomatable(p.path))).toBe(true);
    // Seven registered §7.8 leaves per pad, two pads.
    expect(params).toHaveLength(14);
  });

  it('offers nothing for a keygroup program, which has no pad index to address', () => {
    expect(programAutomatableParams({ ...program, type: 'keygroup' } as never)).toEqual([]);
  });
});
