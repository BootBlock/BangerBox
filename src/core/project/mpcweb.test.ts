import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  buildManifest,
  parseManifest,
  parseSnapshot,
  remapSnapshot,
  serialiseSnapshot,
  type ProjectSnapshot,
} from './mpcweb';
import { packMpcweb, unpackMpcweb } from './mpcwebZip';

// UUID-shaped, because `remapSnapshot` rewrites ids by substring and now asserts that
// shape before it does (issue #99). Section 1.3.1 makes every id a `crypto.randomUUID()`
// in any case, so nothing real is excluded.
const projectId = '00000000-0000-4000-8000-000000000001';
const seqId = '00000000-0000-4000-8000-000000000002';
const trackId = '00000000-0000-4000-8000-000000000003';
const programId = '00000000-0000-4000-8000-000000000004';
const sampleId = '00000000-0000-4000-8000-000000000005';
const eventId = '00000000-0000-4000-8000-000000000006';
const automationId = '00000000-0000-4000-8000-000000000007';
const songEntryId = '00000000-0000-4000-8000-000000000008';

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
        id: eventId,
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
        id: automationId,
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
    songEntries: [{ id: songEntryId, project_id: projectId, position: 0, sequence_id: seqId, repeats: 1 }],
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
  it('rejects a snapshot that reuses one id for two rows (issue #77)', () => {
    const original = fixtureSnapshot();
    // Two sequences sharing an id would map onto a single new id and collide on the primary
    // key part-way through restore, leaving rows already written.
    original.sequences.push({ ...original.sequences[0]!, name: 'Copy' });
    expect(() => remapSnapshot(original)).toThrow(/reuses the same id/i);
  });

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

  it('round-trips a sample of zero length', () => {
    const snapshot = fixtureSnapshot();
    const packed = packMpcweb({
      snapshot,
      appVersion: '1.2.3',
      samples: [{ sampleId, bytes: new Uint8Array(0) }],
    });
    expect(unpackMpcweb(packed).samples.get(sampleId)).toEqual(new Uint8Array(0));
  });
});

// Issue #99: three layers each assumed a different one was checking, so an archive missing
// half its audio imported with no error and the user found out by pressing play.
describe('mpcweb import — a damaged archive fails loudly (spec §9.6)', () => {
  it('refuses an archive whose snapshot declares a sample the archive does not carry', () => {
    const snapshot = fixtureSnapshot();
    const packed = packMpcweb({ snapshot, appVersion: '1.2.3', samples: [] });
    expect(() => unpackMpcweb(packed)).toThrow(/damaged/i);
  });

  it('names the missing audio, so the message is actionable', () => {
    const snapshot = fixtureSnapshot();
    const packed = packMpcweb({ snapshot, appVersion: '1.2.3', samples: [] });
    expect(() => unpackMpcweb(packed)).toThrow(/kick/);
  });

  it('accepts an archive carrying audio no row references, which harms nothing', () => {
    const snapshot = fixtureSnapshot();
    const spare = '00000000-0000-4000-8000-0000000000ff';
    const packed = packMpcweb({
      snapshot,
      appVersion: '1.2.3',
      samples: [
        { sampleId, bytes: new Uint8Array([1]) },
        { sampleId: spare, bytes: new Uint8Array([2]) },
      ],
    });
    expect(() => unpackMpcweb(packed)).not.toThrow();
  });

  it('rejects a project.json from an unknown snapshot version', () => {
    // Only the manifest was version-gated; the snapshot's own `version` was parsed and then
    // ignored, so one claiming v999 was accepted (issue #99).
    const snapshot = { ...fixtureSnapshot(), version: 999 };
    expect(() => parseSnapshot(JSON.stringify(snapshot))).toThrow(/version/i);
  });

  it('rejects an id that is not the UUID the substring rewrite relies on', () => {
    const snapshot = fixtureSnapshot();
    snapshot.project = { ...snapshot.project, id: 'a' };
    expect(() => remapSnapshot(snapshot)).toThrow(/corrupt|identifier/i);
  });
});

// Issue #26: `unzipSync` inflated with no cap on entry count, per-entry size or running
// total, so a ~1 MB archive of compressible data could reach gigabytes inside the pack
// worker before the section 9.7 headroom check ever ran.
describe('mpcweb import — bounded decompression (spec §9.6, §9.7)', () => {
  /** A well-formed archive whose one sample entry inflates to `size` compressible bytes. */
  function bombArchive(size: number): Uint8Array {
    const snapshot = fixtureSnapshot();
    return zipSync(
      {
        'manifest.json': strToU8(JSON.stringify(buildManifest({ id: projectId, name: 'Demo' }, '1.0.0'))),
        'project.json': strToU8(serialiseSnapshot(snapshot)),
        ['samples/' + sampleId + '.wav']: new Uint8Array(size),
      },
      { level: 9 },
    );
  }

  const budget = { maxEntries: 16, maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 20 };

  it('refuses an entry that inflates past the per-entry ceiling', () => {
    expect(() => unpackMpcweb(bombArchive(64 * 1024), { ...budget, maxEntryBytes: 1024 })).toThrow(
      /too large/i,
    );
  });

  it('refuses an archive that inflates past the running total', () => {
    expect(() => unpackMpcweb(bombArchive(64 * 1024), { ...budget, maxTotalBytes: 1024 })).toThrow(
      /too large/i,
    );
  });

  it('refuses an archive with more entries than the cap allows', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < 12; index++) entries['samples/pad-' + index + '.wav'] = new Uint8Array([1]);
    expect(() => unpackMpcweb(zipSync(entries), { ...budget, maxEntries: 4 })).toThrow(/too many/i);
  });

  it('stops before holding the bytes, not after', () => {
    // 4 MiB under a 1 KiB ceiling: the refusal must arrive without the 4 MiB ever being
    // assembled, which is the whole point of checking while unpacking.
    expect(() => unpackMpcweb(bombArchive(4 * 1024 * 1024), { ...budget, maxEntryBytes: 1024 })).toThrow(
      /too large/i,
    );
  });

  it('lets a legitimate archive through the default budget untouched', () => {
    const snapshot = fixtureSnapshot();
    const bytes = new Uint8Array(256).fill(7);
    const packed = packMpcweb({ snapshot, appVersion: '1.2.3', samples: [{ sampleId, bytes }] });
    expect(unpackMpcweb(packed).samples.get(sampleId)).toEqual(bytes);
  });

  it('reports a malformed archive as unreadable rather than leaking a zip internal', () => {
    expect(() => unpackMpcweb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/could not be read/i);
  });
});
