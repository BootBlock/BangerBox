/**
 * Content-addressed sample sharing (spec §9.1, §9.8 de-duplication) — the pure planning half,
 * tested without OPFS or a database. What matters here is that identical BYTES collapse onto
 * one stored copy and that every reference following the collapsed id is rewritten with it:
 * a plan that dedupes the row but leaves a pad pointing at the discarded id is silent breakage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '@/core/storage/repositories';
import { contentHash, planSharedSamples } from './sampleSharing';
import type { ProjectSnapshot } from './mpcweb';

const PROJECT = 'project-id';

const getGlobalByPath = vi.fn();
const repos = { samples: { getGlobalByPath } } as unknown as Repositories;

beforeEach(() => {
  vi.clearAllMocks();
  getGlobalByPath.mockResolvedValue(undefined);
});

function sampleRow(id: string, name: string) {
  return {
    id,
    project_id: PROJECT,
    name,
    opfs_path: `/projects/${PROJECT}/samples/${id}.wav`,
    frames: 100,
    sample_rate: 48_000,
    channels: 1,
    root_note: 60,
    created_at: 0,
  };
}

/** A snapshot whose single program payload references each sample id, as a real pad layer does. */
function snapshotWith(ids: readonly string[]): ProjectSnapshot {
  return {
    version: 1,
    project: {
      id: PROJECT,
      name: 'Pack',
      created_at: 0,
      modified_at: 0,
      sample_rate: 48_000,
      bit_depth: '16',
      bpm_default: 120,
      insert_limit: 4,
      payload: '{}',
    },
    sequences: [],
    tracks: [],
    midiEvents: [],
    automation: [],
    programs: [
      {
        id: 'prog-1',
        project_id: PROJECT,
        name: 'Kit',
        type: 'drum',
        payload: JSON.stringify({ pads: ids.map((id) => ({ layers: [{ sampleId: id }] })) }),
      },
    ],
    samples: ids.map((id, index) => sampleRow(id, `Sound ${index}`)),
    songEntries: [],
  };
}

const bytes = (fill: number, length = 32) => new Uint8Array(length).fill(fill);

describe('contentHash', () => {
  it('is a stable 64-char hex digest of the bytes', async () => {
    expect(await contentHash(bytes(1))).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentHash(bytes(1))).toBe(await contentHash(bytes(1)));
  });

  it('differs for different bytes', async () => {
    expect(await contentHash(bytes(1))).not.toBe(await contentHash(bytes(2)));
  });
});

describe('planSharedSamples (spec §9.8)', () => {
  it('writes each distinct sample once, addressed by its content hash', async () => {
    const snapshot = snapshotWith(['s1', 's2']);
    const plan = await planSharedSamples(
      snapshot,
      new Map([
        ['s1', bytes(1)],
        ['s2', bytes(2)],
      ]),
      repos,
    );

    expect(plan.writes).toHaveLength(2);
    expect(plan.reusedCount).toBe(0);
    expect(plan.writes[0]!.opfs_path).toBe(`/global_library/${await contentHash(bytes(1))}.wav`);
  });

  it('collapses two samples carrying identical bytes onto one stored copy', async () => {
    // The kit-and-its-demo case, within a single pack: same audio, two rows.
    const snapshot = snapshotWith(['s1', 's2']);
    const plan = await planSharedSamples(
      snapshot,
      new Map([
        ['s1', bytes(7)],
        ['s2', bytes(7)],
      ]),
      repos,
    );

    expect(plan.writes).toHaveLength(1);
    expect(plan.reusedCount).toBe(1);
    // The discarded id must not survive anywhere — the pad that used it now points at the kept
    // one, or it would reference a sample that was never stored.
    const payload = plan.snapshot.programs[0]!.payload;
    expect(payload).not.toContain('s2');
    expect([...payload.matchAll(/s1/g)]).toHaveLength(2);
  });

  it('reuses an already-installed sample and writes nothing for it', async () => {
    const hash = await contentHash(bytes(3));
    getGlobalByPath.mockImplementation((path: string) =>
      Promise.resolve(path === `/global_library/${hash}.wav` ? { id: 'installed-id' } : undefined),
    );

    const plan = await planSharedSamples(snapshotWith(['s1']), new Map([['s1', bytes(3)]]), repos);

    expect(plan.writes).toHaveLength(0);
    expect(plan.reusedCount).toBe(1);
    // The program now points at the copy already on disk, not at this pack's own id.
    expect(plan.snapshot.programs[0]!.payload).toContain('installed-id');
  });

  it('empties the snapshot’s sample rows — they are global now, not the project’s', async () => {
    const plan = await planSharedSamples(snapshotWith(['s1']), new Map([['s1', bytes(1)]]), repos);
    // Left in place they would be re-inserted as project-scoped rows by `restoreSnapshot`,
    // duplicating the global row and re-creating the very duplication this removes.
    expect(plan.snapshot.samples).toEqual([]);
  });

  it('rejects a pack missing audio for a row rather than installing a dangling reference', async () => {
    await expect(planSharedSamples(snapshotWith(['s1']), new Map(), repos)).rejects.toThrow(/missing audio/i);
  });
});
