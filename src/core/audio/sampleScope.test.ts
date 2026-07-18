/**
 * Sample write scope (spec §9.1 layout, §9.3 `project_id`). A global import must land in
 * `/global_library/` with a NULL `project_id`; a project import must not. Getting this
 * backwards would file a shared sample inside a project directory, where deleting that
 * project would take it with it — so both destinations are pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeFileStreamed = vi.fn(() => Promise.resolve());

vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return {
    ...actual,
    writeFileStreamed: (path: string, bytes: Uint8Array) => writeFileStreamed(path, bytes),
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
      this.#listener?.({ data: { id: request.id, ok: true, bytes: new Uint8Array(0) } } as MessageEvent),
    );
  }
}

const { saveChannelsAsSample } = await import('./sampleImport');
const { GLOBAL_LIBRARY_ROOT, projectSamplesRoot } = await import('@/core/storage/opfs');

const created: { project_id: string | null; opfs_path: string }[] = [];

function context(scope?: 'project' | 'global') {
  return {
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
    projectBitDepth: 16,
    scope,
  } as unknown as Parameters<typeof saveChannelsAsSample>[4];
}

beforeEach(() => {
  created.length = 0;
  writeFileStreamed.mockClear();
  vi.stubGlobal('Worker', EchoWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveChannelsAsSample scope (spec §9.3)', () => {
  it('writes a global sample under /global_library with a NULL project_id', async () => {
    await saveChannelsAsSample([new Float32Array(4)], 48000, 'Shared snare', [], context('global'));
    expect(created[0]!.project_id).toBeNull();
    expect(created[0]!.opfs_path.startsWith(`${GLOBAL_LIBRARY_ROOT}/`)).toBe(true);
    expect(writeFileStreamed.mock.calls[0]![0]).toBe(created[0]!.opfs_path);
  });

  it('writes into the project directory when the scope is omitted', async () => {
    await saveChannelsAsSample([new Float32Array(4)], 48000, 'Kick', [], context());
    expect(created[0]!.project_id).toBe('p1');
    expect(created[0]!.opfs_path.startsWith(`${projectSamplesRoot('p1')}/`)).toBe(true);
  });
});
