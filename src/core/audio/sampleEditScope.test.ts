/**
 * Destructive-edit result scope (spec §8.5.4, §9.3). A destructive tool renders a NEW sample,
 * and that sample must land where its source lives: editing a global-library sample yields a
 * global-library sample. Filing it under the active project instead would drop it out of the
 * library the user is looking at (spec §8.5.7 folder tree) and tie a shared sample's derivative
 * to whichever project happened to be open.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { encodeWav } from './wav';

const SOURCE_WAV = encodeWav([Float32Array.from([0, 0.5, -0.5, 0.25])], 48000, '16');

vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return {
    ...actual,
    readFile: () => Promise.resolve(new Blob([SOURCE_WAV])),
    writeFileStreamed: () => Promise.resolve(),
  };
});

/** A Worker stand-in that answers every encode request with empty WAV bytes. */
class EchoWorker {
  #listener: ((event: MessageEvent) => void) | null = null;
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.#listener = listener;
  }
  postMessage(request: { id: number }) {
    queueMicrotask(() =>
      this.#listener?.({
        data: { id: request.id, ok: true, bytes: new Uint8Array(0) },
      } as MessageEvent),
    );
  }
}

const { applyEditToNewSample } = await import('./sampleEditService');
const { GLOBAL_LIBRARY_ROOT, projectSamplesRoot } = await import('@/core/storage/opfs');

const created: { project_id: string | null; opfs_path: string }[] = [];

const CTX = {
  repos: {
    samples: {
      create: (row: { project_id: string | null; opfs_path: string }) => {
        created.push(row);
        return Promise.resolve(row);
      },
      setTags: () => Promise.resolve(),
    },
  },
  projectId: 'p1',
  projectBitDepth: '16',
} as unknown as Parameters<typeof applyEditToNewSample>[3];

function sourceRow(projectId: string | null) {
  return {
    id: 's1',
    project_id: projectId,
    name: 'Snare',
    opfs_path: projectId === null ? `${GLOBAL_LIBRARY_ROOT}/s1.wav` : `${projectSamplesRoot('p1')}/s1.wav`,
    frames: 4,
    sample_rate: 48000,
    channels: 1 as const,
    root_note: 60,
    created_at: 0,
  };
}

beforeEach(() => {
  created.length = 0;
  vi.stubGlobal('Worker', EchoWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('destructive edit result scope (spec §8.5.4, §9.3)', () => {
  it('keeps a global sample’s edit in the global library', async () => {
    await applyEditToNewSample(sourceRow(null), (channels) => channels, 'Normalise', CTX);
    expect(created[0]!.project_id).toBeNull();
    expect(created[0]!.opfs_path.startsWith(`${GLOBAL_LIBRARY_ROOT}/`)).toBe(true);
  });

  it("keeps a project sample's edit in the project", async () => {
    await applyEditToNewSample(sourceRow('p1'), (channels) => channels, 'Normalise', CTX);
    expect(created[0]!.project_id).toBe('p1');
    expect(created[0]!.opfs_path.startsWith(`${projectSamplesRoot('p1')}/`)).toBe(true);
  });
});
