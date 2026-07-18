/** Kit-merge transform (spec §9.8 "Install modes") — pure discard/re-parent rules. */
import { describe, expect, it } from 'vitest';
import { buildKitMerge } from './factoryMerge';
import { samplePath } from '@/core/storage/opfs';
import type { ProjectSnapshot } from './mpcweb';

const PACK_PROJECT = 'pack-project-id';
const ACTIVE_PROJECT = 'active-project-id';

function packSnapshot(): ProjectSnapshot {
  return {
    version: 1,
    project: {
      id: PACK_PROJECT,
      name: '808 Kit',
      created_at: 0,
      modified_at: 0,
      sample_rate: 48_000,
      bit_depth: '16',
      bpm_default: 120,
      insert_limit: 4,
      payload: '{}',
    },
    sequences: [
      {
        id: 'seq-1',
        project_id: PACK_PROJECT,
        position: 0,
        name: 'Kit demo pattern',
        length_bars: 2,
        time_sig_numerator: 4,
        time_sig_denominator: 4,
        tempo: null,
        swing_amount: 50,
        swing_division: 16,
      },
    ],
    tracks: [
      {
        id: 'track-1',
        sequence_id: 'seq-1',
        program_id: 'prog-1',
        position: 0,
        name: 'Drums',
        type: 'drum',
        mixer: '{}',
      },
    ],
    midiEvents: [
      {
        id: 'ev-1',
        track_id: 'track-1',
        tick_start: 0,
        duration_ticks: 96,
        note: 0,
        velocity: 100,
        extra: null,
      },
    ],
    automation: [
      {
        id: 'auto-1',
        scope: 'track',
        owner_id: 'track-1',
        target_path: 'mixer.track:track-1.level',
        tick: 0,
        value: 1,
        curve: 'linear',
      },
    ],
    programs: [
      { id: 'prog-1', project_id: PACK_PROJECT, name: '808', type: 'drum', payload: '{"id":"prog-1"}' },
    ],
    samples: [
      {
        id: 'sample-1',
        project_id: PACK_PROJECT,
        name: 'Kick',
        opfs_path: samplePath(PACK_PROJECT, 'sample-1'),
        frames: 24_000,
        sample_rate: 48_000,
        channels: 1,
        root_note: 60,
        created_at: 0,
      },
    ],
    songEntries: [{ id: 'song-1', project_id: PACK_PROJECT, position: 0, sequence_id: 'seq-1', repeats: 2 }],
  };
}

describe('buildKitMerge (spec §9.8)', () => {
  it('keeps programs and re-parents them onto the active project', () => {
    const merge = buildKitMerge(packSnapshot(), ACTIVE_PROJECT);
    expect(merge.programs).toHaveLength(1);
    expect(merge.programs[0]!.project_id).toBe(ACTIVE_PROJECT);
    // The payload is carried through untouched — it was remapped upstream (§9.6).
    expect(merge.programs[0]!.payload).toBe('{"id":"prog-1"}');
  });

  it('contributes no sample rows — they install globally instead (spec §9.1, §9.8)', () => {
    const merge = buildKitMerge(packSnapshot(), ACTIVE_PROJECT);
    // A kit's audio is content-addressed into the global library so a demo shipping the same
    // sounds shares one copy, so the merge must not also insert it under the active project.
    expect(merge).not.toHaveProperty('samples');
  });

  it('discards sequences, tracks, events, automation and song entries', () => {
    const merge = buildKitMerge(packSnapshot(), ACTIVE_PROJECT);
    // A kit contributes sound, never arrangement — the active project's own sequences,
    // tracks and song must be left entirely alone (spec §9.8).
    expect(Object.keys(merge)).toEqual(['programs']);
  });

  it('does not mutate the input snapshot', () => {
    const snapshot = packSnapshot();
    buildKitMerge(snapshot, ACTIVE_PROJECT);
    expect(snapshot.programs[0]!.project_id).toBe(PACK_PROJECT);
    expect(snapshot.samples[0]!.opfs_path).toBe(samplePath(PACK_PROJECT, 'sample-1'));
  });
});
