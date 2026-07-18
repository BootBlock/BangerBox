/**
 * Node module-resolution hook for the factory generator (spec §9.8).
 *
 * The generator builds real `.mpcweb` archives, so it should use the app's own §6 schema
 * factories, §9.6 packer and §9.4 WAV encoder — a second copy of any of them drifts silently
 * and ships malformed packs. Node 25 strips TypeScript types natively (§1.3 #2), but it will
 * not resolve the two things the app's source relies on Vite for: the `@/` alias (§2.3.6) and
 * extensionless relative imports (`./primitives`).
 *
 * This hook supplies exactly those two rules and nothing else. It is build-time only and
 * never reaches the browser, where Vite continues to do the resolving; the Vitest suite also
 * goes through Vite, so tests importing the generator need no hook.
 *
 * Only modules free of runtime randomness may be imported this way — see the determinism
 * note in `snapshot.mjs`.
 */
const SRC = new URL('../../src/', import.meta.url);

export async function resolve(specifier, context, next) {
  const spec = specifier.startsWith('@/') ? new URL(specifier.slice(2), SRC).href : specifier;
  try {
    return await next(spec, context);
  } catch (error) {
    // Extensionless: try the file, then the directory's index (both Vite defaults).
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await next(spec + suffix, context);
      } catch {
        // Try the next candidate; the original error is thrown if none resolve.
      }
    }
    throw error;
  }
}
