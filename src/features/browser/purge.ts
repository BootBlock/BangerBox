/**
 * "Purge unused samples" — deciding what is unused (spec §8.5.7).
 *
 * Split out of `BrowserPanel` because this is the destructive half: it names the files the
 * panel then deletes, so the rule deserves testing on its own rather than through a rendered
 * component.
 *
 * The rule turns on WHERE the sample lives (spec §9.1). A project-scoped sample is used if the
 * owning project's programs reference it. A global-library sample is shared — factory content
 * de-duplicates into it (§9.8), so one stored sound may be played by a kit in one project and a
 * demo in another — and is used if ANY program in the database references it. Asking the
 * project-scoped question about a shared sample deletes audio another project is still playing.
 */
import type { Repositories, SampleRow } from '@/core/storage/repositories';

export type LibraryScope = 'project' | 'global';

/**
 * The programs a sample in `scope` must be judged against (spec §8.5.7).
 *
 * The global set is fetched unpaged (`allPayloads`), deliberately: a payload missed past a page
 * boundary reads as "nothing references this" and the sample is deleted.
 */
async function referencePayloads(
  repos: Repositories,
  scope: LibraryScope,
  projectId: string,
): Promise<string[]> {
  if (scope === 'global') return repos.programs.allPayloads();
  // No open project means no programs to ask about, and `listByProject('')` answers with an
  // empty set rather than an error — which reads as "nothing references anything" and would
  // mark the whole library for deletion. The reference set is unknowable here, so refuse
  // rather than guess (spec §8.5.7: fail safe, delete nothing).
  if (projectId === '') throw new Error('No project is open, so no sample can be judged unused.');
  const programs = await repos.programs.listByProject(projectId);
  return programs.rows.map((program) => program.payload);
}

/**
 * Which of `samples` no relevant program references, and may therefore be deleted (spec §8.5.7).
 *
 * Ids are matched against the raw payload text — a sample id is a 36-char UUID, so a substring
 * hit is a genuine reference wherever it appears (pad layer, or any future payload field), and
 * matching the serialised form means a new reference site cannot quietly fall outside the check.
 */
export async function findUnusedSamples(
  samples: readonly SampleRow[],
  repos: Repositories,
  scope: LibraryScope,
  projectId: string,
): Promise<SampleRow[]> {
  const payloads = await referencePayloads(repos, scope, projectId);
  return samples.filter((sample) => !payloads.some((payload) => payload.includes(sample.id)));
}
