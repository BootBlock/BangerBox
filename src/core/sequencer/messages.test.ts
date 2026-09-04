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
    expect(SCHEDULER_PROTOCOL_VERSION).toBe(2);
  });
});

describe('parseSchedulerRequest (spec §7.1.3, §1.3 #11)', () => {
  it('accepts every documented request kind', () => {
    const requests: SchedulerRequest[] = [
      {
        kind: 'init',
        playheadSab: new SharedArrayBuffer(32),
        protocolVersion: SCHEDULER_PROTOCOL_VERSION,
      },
      { kind: 'clockSync', contextTime: 1.2, performanceTime: 1200 },
      { kind: 'transport', isPlaying: true, isRecording: false, startTick: 0 },
      { kind: 'tempo', bpm: 128 },
      { kind: 'swing', amount: 58, division: 16 },
      { kind: 'loop', enabled: true, startTick: 0, endTick: 3840 },
      { kind: 'eventsDiff', trackId: 't1', sequenceId: 's1', upserts: [event], deletes: ['x'] },
      {
        kind: 'automationDiff',
        scope: 'track',
        ownerId: 't1',
        targetPath: 'mixer.track:t1.level',
        points: [],
      },
      {
        kind: 'songSequence',
        orderedEntries: [
          { sequenceId: 'a', repeats: 2 },
          { sequenceId: 'b', repeats: 1 },
        ],
      },
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
      { kind: 'liveErase', trackId: 't1', note: 36, active: true },
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

describe('the guard is no looser than the store it mirrors (spec §1.3 #11, issue #96)', () => {
  it('bounds a tempo to the §4.2 BPM range', () => {
    // Measured with the guard bypassed: a negative bpm makes `beatSeconds` negative and the
    // metronome loop emits WINDOW_GUARD (4096) clicks on every wake, for ever.
    expect(parseSchedulerRequest({ kind: 'tempo', bpm: -1 })).toBeNull();
    expect(parseSchedulerRequest({ kind: 'tempo', bpm: 0 })).toBeNull();
    expect(parseSchedulerRequest({ kind: 'tempo', bpm: 1000 })).toBeNull();
    expect(parseSchedulerRequest({ kind: 'tempo', bpm: Number.NaN })).toBeNull();
    expect(parseSchedulerRequest({ kind: 'tempo', bpm: 20 })).not.toBeNull();
    expect(parseSchedulerRequest({ kind: 'tempo', bpm: 300 })).not.toBeNull();
  });

  it('bounds a swing amount to the §7.4 50–75 % range', () => {
    // At 100 % a 1/16 is shifted a whole subdivision onto the next grid line.
    expect(parseSchedulerRequest({ kind: 'swing', amount: 100, division: 16 })).toBeNull();
    expect(parseSchedulerRequest({ kind: 'swing', amount: 49, division: 16 })).toBeNull();
    expect(parseSchedulerRequest({ kind: 'swing', amount: 75, division: 8 })).not.toBeNull();
  });

  it('bounds the sequence metadata tempi', () => {
    const meta = (tempo: number | null, projectBpm = 120) => ({
      kind: 'sequenceMeta',
      sequences: { a: { lengthBars: 2, timeSigNumerator: 4, timeSigDenominator: 4, tempo } },
      projectBpm,
      activeSequenceId: 'a',
      playbackMode: 'sequence',
    });
    expect(parseSchedulerRequest(meta(0))).toBeNull();
    expect(parseSchedulerRequest(meta(5000))).toBeNull();
    expect(parseSchedulerRequest(meta(null, -60))).toBeNull();
    expect(parseSchedulerRequest(meta(null))).not.toBeNull();
    expect(parseSchedulerRequest(meta(90))).not.toBeNull();
  });

  it('refuses an id carrying the separator its composite keys are built with', () => {
    // The scheduler keys three maps `${trackId}:${note}` and its automation lanes
    // `${scope}:${ownerId}:${targetPath}`, and §7.8 target paths contain colons of their
    // own. The split arithmetic is sound only because an id never carries one, which
    // §1.3.1 guarantees by making every id a `crypto.randomUUID()`. This is the one place
    // that is checked, so nothing downstream has to restate it.
    expect(
      parseSchedulerRequest({
        kind: 'eventsDiff',
        trackId: 'track:1',
        sequenceId: 's1',
        upserts: [],
        deletes: [],
      }),
    ).toBeNull();
    expect(
      parseSchedulerRequest({
        kind: 'automationDiff',
        scope: 'track',
        ownerId: 'owner:1',
        targetPath: 'mixer.track:t1.level',
        points: [],
      }),
    ).toBeNull();
    expect(parseSchedulerRequest({ kind: 'liveErase', trackId: 'a:b', note: 36, active: true })).toBeNull();
    expect(
      parseSchedulerRequest({ kind: 'songSequence', orderedEntries: [{ sequenceId: 'b:c', repeats: 1 }] }),
    ).toBeNull();
    // The target path itself is exempt — §7.8 addresses are built from colons.
    expect(
      parseSchedulerRequest({
        kind: 'automationDiff',
        scope: 'track',
        ownerId: 't1',
        targetPath: 'insert:track:t1:slot2.mix',
        points: [],
      }),
    ).not.toBeNull();
  });
});

describe('the init handshake carries the protocol version (spec §7.1.3, issue #96)', () => {
  it('keeps the version on the message rather than dropping it', () => {
    const request = parseSchedulerRequest({
      kind: 'init',
      playheadSab: new SharedArrayBuffer(32),
      protocolVersion: SCHEDULER_PROTOCOL_VERSION,
    });
    expect(request).not.toBeNull();
    expect(request).toHaveProperty('protocolVersion', SCHEDULER_PROTOCOL_VERSION);
  });

  it('lets a handshake with no version through, so the skew is reported and not dropped', () => {
    // The version exists to NAME a skew. Requiring it would have the guard drop the very
    // handshake it is meant to name, leaving the SAB uninstalled, the transport dead and
    // nothing said — the outcome the check was added to prevent. `applySchedulerRequest`
    // reports the missing version instead (see schedulerWire.test.ts).
    const request = parseSchedulerRequest({ kind: 'init', playheadSab: new SharedArrayBuffer(32) });
    expect(request?.kind).toBe('init');
    expect(request && request.kind === 'init' ? request.protocolVersion : 'absent').toBeUndefined();
  });

  it('survives a version it cannot read at all, for the same reason', () => {
    const request = parseSchedulerRequest({
      kind: 'init',
      playheadSab: new SharedArrayBuffer(32),
      protocolVersion: 'two',
    });
    expect(request).not.toBeNull();
    expect(request).toHaveProperty('protocolVersion', undefined);
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
          {
            kind: 'automationRamp',
            when: 1.0,
            tick: 0,
            target: 'mixer.master.level',
            value: 0.8,
            rampEnd: 1.1,
          },
        ],
      },
      { kind: 'recorded', trackId: 't1', events: [event] },
      { kind: 'erased', trackId: 't1', eventIds: ['n1'] },
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
