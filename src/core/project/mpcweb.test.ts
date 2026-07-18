import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  parseManifest,
  parseSnapshot,
  remapSnapshot,
  serialiseSnapshot,
  type ProjectSnapshot,
} from './mpcweb';
import { packMpcweb, unpackMpcweb } from './mpcwebZip';

const projectId = 'proj-0000';
const seqId = 'seq-1111';
const trackId = 'trk-2222';
const programId = 'prog-3333';
const sampleId = 'smp-4444';

/** A small but referentially-complete snapshot exercising every cross-reference (spec §9.6). */
function fixtureSnapshot(): ProjectSnapshot {
  return {
    version: 1,
    project: {
      id: projectId,
      name: 'Demo',
      created_at: 1,
      modified_at: 2,
      sample_rate: 48_000,
      bit_depth: '24',
      bpm_default: 120,
      insert_limit: 4,
      payload: '{}',
    },
    sequences: [
      {
        id: seqId,
        project_id: projectId,
        position: 0,
        name: 'Seq 1',
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
        id: trackId,
        sequence_id: seqId,
        program_id: programId,
        position: 0,
        name: 'Track 1',
        type: 'drum',
        mixer: JSON.stringify({ id: `track:${trackId}`, level: 1 }),
      },
    ],
    midiEvents: [
      {
        id: 'evt-1',
        track_id: trackId,
        tick_start: 0,
        duration_ticks: 240,
        note: 36,
        velocity: 100,
        extra: null,
      },
    ],
    automation: [
      {
        id: 'aut-1',
        scope: 'track',
        owner_id: trackId,
        target_path: `mixer.track:${trackId}.level`,
        tick: 0,
        value: 0.8,
        curve: 'linear',
      },
    ],
    programs: [
      {
        id: programId,
        project_id: projectId,
        name: 'Kit',
        type: 'drum',
        payload: JSON.stringify({ id: programId, type: 'drum', pads: [{ layers: [{ sampleId }] }] }),
      },
    ],
    samples: [
      {
        id: sampleId,
        project_id: projectId,
        name: 'kick',
        opfs_path: `/projects/${projectId}/samples/${sampleId}.wav`,
        frames: 1000,
        sample_rate: 48_000,
        channels: 1,
        root_note: 60,
        created_at: 3,
      },
    ],
    songEntries: [{ id: 'song-1', project_id: projectId, position: 0, sequence_id: seqId, repeats: 1 }],
  };
}

describe('mpcweb snapshot — serialise/parse round-trip (spec §9.6, §11.1)', () => {
  it('round-trips a snapshot through JSON and Zod unchanged', () => {
    const snapshot = fixtureSnapshot();
    expect(parseSnapshot(serialiseSnapshot(snapshot))).toEqual(snapshot);
  });

  it('rejects a malformed snapshot', () => {
    expect(() => parseSnapshot('{"version":1}')).toThrow();
  });

  it('rejects a manifest from an unknown future format version', () => {
    const manifest = { ...buildManifest({ id: projectId, name: 'Demo' }, '1.0.0'), formatVersion: 99 };
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow(/newer version/i);
  });
});

describe('mpcweb remap — collision-free UUIDs (spec §9.6)', () => {
  it('rewrites every id and every reference consistently', () => {
    const original = fixtureSnapshot();
    const { snapshot, projectId: newProjectId, sampleIdMap } = remapSnapshot(original);

    // Fresh project id, no longer the original.
    expect(newProjectId).not.toBe(projectId);
    expect(snapshot.project.id).toBe(newProjectId);

    // Foreign keys follow the remap.
    const seq = snapshot.sequences[0]!;
    const track = snapshot.tracks[0]!;
    expect(seq.project_id).toBe(newProjectId);
    expect(track.sequence_id).toBe(seq.id);
    expect(track.program_id).toBe(snapshot.programs[0]!.id);
    expect(snapshot.midiEvents[0]!.track_id).toBe(track.id);
    expect(snapshot.automation[0]!.owner_id).toBe(track.id);

    // Ids embedded in strings are rewritten too (mixer JSON, target paths, payloads, paths).
    expect(track.mixer).toContain(`track:${track.id}`);
    expect(snapshot.automation[0]!.target_path).toBe(`mixer.track:${track.id}.level`);
    const newSampleId = sampleIdMap.get(sampleId)!;
    expect(snapshot.samples[0]!.id).toBe(newSampleId);
    expect(snapshot.samples[0]!.opfs_path).toBe(`/projects/${newProjectId}/samples/${newSampleId}.wav`);
    expect(snapshot.programs[0]!.payload).toContain(newSampleId);
    expect(snapshot.programs[0]!.payload).toContain(snapshot.programs[0]!.id);
  });
});

describe('mpcweb zip — pack/unpack round-trip (spec §9.6, §11.1)', () => {
  it('packs a snapshot + samples and unpacks them byte-identical', () => {
    const snapshot = fixtureSnapshot();
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
    const packed = packMpcweb({ snapshot, appVersion: '1.2.3', samples: [{ sampleId, bytes }] });

    const unpacked = unpackMpcweb(packed);
    expect(unpacked.manifest.appVersion).toBe('1.2.3');
    expect(unpacked.manifest.projectId).toBe(projectId);
    expect(unpacked.snapshot).toEqual(snapshot);
    expect(Array.from(unpacked.samples.get(sampleId)!)).toEqual(Array.from(bytes));
  });
});
