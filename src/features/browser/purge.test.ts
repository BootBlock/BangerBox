/**
 * Purge scoping (spec §8.5.7, §9.8). These tests guard a DESTRUCTIVE decision, so the case
 * that matters most is the negative one: a global sample another project still plays must
 * never be reported as unused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories, SampleRow } from '@/core/storage/repositories';
import { findUnusedSamples } from './purge';

const PROJECT = 'project-a';

const allPayloads = vi.fn();
const listByProject = vi.fn();
const repos = { programs: { allPayloads, listByProject } } as unknown as Repositories;

beforeEach(() => {
  vi.clearAllMocks();
  allPayloads.mockResolvedValue([]);
  listByProject.mockResolvedValue({ rows: [] });
});

const sample = (id: string) => ({ id, name: id }) as SampleRow;
const payload = (...ids: string[]) => JSON.stringify({ pads: ids.map((id) => ({ sampleId: id })) });

describe('findUnusedSamples (spec §8.5.7)', () => {
  it('judges a project sample against only that project’s programs', async () => {
    listByProject.mockResolvedValue({ rows: [{ payload: payload('used') }] });

    const unused = await findUnusedSamples([sample('used'), sample('spare')], repos, 'project', PROJECT);

    expect(unused.map((row) => row.id)).toEqual(['spare']);
    expect(listByProject).toHaveBeenCalledWith(PROJECT);
    expect(allPayloads).not.toHaveBeenCalled();
  });

  it('judges a global sample against EVERY project’s programs', async () => {
    // The de-duplication case: this project does not use the sample, another project does.
    // Scoping the question to the open project would delete audio still being played (§9.8).
    listByProject.mockResolvedValue({ rows: [] });
    allPayloads.mockResolvedValue([payload('shared')]);

    const unused = await findUnusedSamples([sample('shared')], repos, 'global', PROJECT);

    expect(unused).toEqual([]);
    expect(allPayloads).toHaveBeenCalled();
    expect(listByProject).not.toHaveBeenCalled();
  });

  it('reports a global sample no project references at all', async () => {
    allPayloads.mockResolvedValue([payload('something-else')]);

    const unused = await findUnusedSamples([sample('orphan')], repos, 'global', PROJECT);

    // Without this, de-duplicated factory audio would be unreclaimable: nothing else deletes
    // a global sample, so it would hold quota forever once its last project was removed.
    expect(unused.map((row) => row.id)).toEqual(['orphan']);
  });

  it('refuses to judge project samples with no project open', async () => {
    // `listByProject('')` resolves to an empty set rather than failing, which reads as
    // "no program references anything" — every sample would be reported unused.
    await expect(findUnusedSamples([sample('kick')], repos, 'project', '')).rejects.toThrow(
      /no project is open/i,
    );
    expect(listByProject).not.toHaveBeenCalled();
  });

  it('treats a sample referenced anywhere in a payload as used', async () => {
    // Ids appear in nested pad layers, not at a fixed path — matching the serialised payload
    // keeps a future reference site from silently falling outside the check.
    allPayloads.mockResolvedValue([JSON.stringify({ deeply: { nested: { sampleId: 'buried' } } })]);

    expect(await findUnusedSamples([sample('buried')], repos, 'global', PROJECT)).toEqual([]);
  });
});
