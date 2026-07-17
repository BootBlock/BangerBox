import { describe, expect, it } from 'vitest';
import type { MidiEvent } from '@/core/project/schemas';
import {
  parseSchedulerRequest,
  parseSchedulerResponse,
  SCHEDULER_PROTOCOL_VERSION,
  type SchedulerRequest,
  type SchedulerResponse,
} from './messages';

const event: MidiEvent = {
  id: 'n1',
  tickStart: 0,
  durationTicks: 120,
  note: 36,
  velocity: 100,
  extra: null,
};

describe('protocol version (spec §7.1.3)', () => {
  it('is pinned', () => {
    expect(SCHEDULER_PROTOCOL_VERSION).toBe(1);
  });
});

describe('parseSchedulerRequest (spec §7.1.3, §1.3 #11)', () => {
  it('accepts every documented request kind', () => {
    const requests: SchedulerRequest[] = [
      { kind: 'init', playheadSab: new SharedArrayBuffer(32) },
      { kind: 'clockSync', contextTime: 1.2, performanceTime: 1200 },
      { kind: 'transport', isPlaying: true, isRecording: false, startTick: 0 },
      { kind: 'tempo', bpm: 128 },
      { kind: 'swing', amount: 58, division: 16 },
      { kind: 'loop', enabled: true, startTick: 0, endTick: 3840 },
      { kind: 'eventsDiff', trackId: 't1', upserts: [event], deletes: ['x'] },
      { kind: 'automationDiff', scope: 'track', ownerId: 't1', targetPath: 'mixer.track:t1.level', points: [] },
      { kind: 'songSequence', orderedSequenceIds: ['a', 'a', 'b'] },
      {
        kind: 'sequenceMeta',
        sequences: { a: { lengthBars: 2, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
        projectBpm: 120,
        activeSequenceId: 'a',
        playbackMode: 'sequence',
      },
      { kind: 'liveNote', note: 36, velocity: 100, on: true, timestamp: 123, trackId: 't1' },
      { kind: 'noteRepeat', enabled: true, division: { value: 16, triplet: false } },
      { kind: 'metronome', enabled: true, countInBars: 1 },
    ];
    for (const request of requests) {
      expect(parseSchedulerRequest(request), request.kind).toEqual(request);
    }
  });

  it('rejects malformed or unknown requests', () => {
    expect(parseSchedulerRequest({ kind: 'bogus' })).toBeNull();
    expect(parseSchedulerRequest({ kind: 'tempo' })).toBeNull(); // missing bpm
    expect(parseSchedulerRequest({ kind: 'swing', amount: 60, division: 4 })).toBeNull(); // bad division
    expect(parseSchedulerRequest(null)).toBeNull();
  });
});

describe('parseSchedulerResponse (spec §7.1.3, §1.3 #11)', () => {
  it('accepts every documented response kind', () => {
    const responses: SchedulerResponse[] = [
      {
        kind: 'scheduleBatch',
        events: [
          { kind: 'noteOn', when: 1.0, tick: 0, trackId: 't1', note: 36, velocity: 100, durationSec: 0.25 },
          { kind: 'click', when: 1.0, tick: 0, accented: true },
          { kind: 'automationRamp', when: 1.0, tick: 0, target: 'mixer.master.level', value: 0.8, rampEnd: 1.1 },
        ],
      },
      { kind: 'recorded', trackId: 't1', events: [event] },
      { kind: 'loopWrapped', tick: 3840 },
      { kind: 'songAdvanced', entryIndex: 2 },
    ];
    for (const response of responses) {
      expect(parseSchedulerResponse(response), response.kind).toEqual(response);
    }
  });

  it('rejects malformed responses', () => {
    expect(parseSchedulerResponse({ kind: 'scheduleBatch' })).toBeNull();
    expect(parseSchedulerResponse({ kind: 'loopWrapped', tick: 'x' })).toBeNull();
  });
});
