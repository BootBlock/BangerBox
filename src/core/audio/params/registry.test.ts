import { describe, expect, it } from 'vitest';
import { LEVEL_RANGE, PAN_RANGE, SEND_LEVEL_RANGE } from '@/core/project/schemas';
import {
  channelLevelPath,
  channelPanPath,
  channelSendPath,
  insertParamPath,
  isAutomatable,
  parseParamTarget,
  targetRange,
} from './registry';

describe('canonical builders (spec §7.8)', () => {
  it('round-trip through parseParamTarget', () => {
    expect(parseParamTarget(channelLevelPath('track:t1'))).toEqual({
      kind: 'channelLevel',
      channelId: 'track:t1',
    });
    expect(parseParamTarget(channelPanPath('master'))).toEqual({
      kind: 'channelPan',
      channelId: 'master',
    });
    expect(parseParamTarget(channelSendPath('pad:prog:0', 2))).toEqual({
      kind: 'channelSend',
      channelId: 'pad:prog:0',
      sendIndex: 2,
    });
    expect(parseParamTarget(insertParamPath('track:t1', 2, 'mix'))).toEqual({
      kind: 'insertParam',
      channelId: 'track:t1',
      slot: 2,
      param: 'mix',
    });
  });

  it('matches the exact canonical strings from the spec examples', () => {
    expect(channelLevelPath('track:t1')).toBe('mixer.track:t1.level');
    expect(channelSendPath('pad:prog:0', 2)).toBe('mixer.pad:prog:0.sendLevels.2');
    expect(insertParamPath('track:t1', 2, 'mix')).toBe('insert:track:t1:slot2.mix');
  });
});

describe('parseParamTarget rejects unregistered / malformed paths (spec §7.8)', () => {
  it('returns null for non-addresses', () => {
    expect(parseParamTarget('nonsense')).toBeNull();
    expect(parseParamTarget('mixer.track:t1.frequency')).toBeNull(); // unknown param
    expect(parseParamTarget('program:p1.pad:0.filter.cutoff')).toBeNull(); // Phase 5
    expect(isAutomatable('mixer.master.level')).toBe(true);
    expect(isAutomatable('bogus')).toBe(false);
  });

  it('rejects an out-of-range send index', () => {
    expect(parseParamTarget('mixer.master.sendLevels.4')).toBeNull();
    expect(parseParamTarget('mixer.master.sendLevels.0')).not.toBeNull();
  });

  it('parses a channel id that itself contains colons', () => {
    expect(parseParamTarget('mixer.pad:kit:15.level')).toEqual({
      kind: 'channelLevel',
      channelId: 'pad:kit:15',
    });
    expect(parseParamTarget('insert:pad:kit:15:slot1.cutoff')).toEqual({
      kind: 'insertParam',
      channelId: 'pad:kit:15',
      slot: 1,
      param: 'cutoff',
    });
  });
});

describe('targetRange (spec §7.8)', () => {
  it('returns the mixer ranges', () => {
    expect(targetRange({ kind: 'channelLevel', channelId: 'master' })).toBe(LEVEL_RANGE);
    expect(targetRange({ kind: 'channelPan', channelId: 'master' })).toBe(PAN_RANGE);
    expect(targetRange({ kind: 'channelSend', channelId: 'master', sendIndex: 0 })).toBe(
      SEND_LEVEL_RANGE,
    );
  });

  it('resolves insert-param ranges by effect, and mix for any effect', () => {
    const target = { kind: 'insertParam', channelId: 'track:t', slot: 1, param: 'cutoff' } as const;
    expect(targetRange(target, 'filter')).toEqual([20, 20_000]);
    expect(targetRange(target)).toBeNull(); // no effect type → unknown
    const mix = { kind: 'insertParam', channelId: 'track:t', slot: 1, param: 'mix' } as const;
    expect(targetRange(mix)).toEqual([0, 1]);
  });
});
