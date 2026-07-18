/**
 * Factory content catalogue (spec §9.8) — the Zod schema for `public/factory/index.json`,
 * the manifest of shipped `.mpcweb` packs the Browser-mode Factory section lists.
 *
 * Pure and dependency-free beyond Zod (spec §2.5) so the schema is unit-testable against
 * accept/reject fixtures (§11.1) and so `scripts/build-factory.mjs` and the runtime agree
 * on one shape. Packs themselves are ordinary `.mpcweb` archives (§9.6) — this catalogue
 * adds no second format.
 */
import { z } from 'zod';

/** Install behaviour of a pack (spec §9.8 "Install modes"). */
export const factoryPackKindSchema = z.enum(['kit', 'demo']);
export type FactoryPackKind = z.infer<typeof factoryPackKindSchema>;

/**
 * One catalogue entry (spec §9.8: `{ id, title, kind, file, bytes, description }`).
 *
 * `bytes` is the on-disk size of the `.mpcweb` file — it drives the size shown in the
 * Browser list, NOT the §9.7 storage gate. That gate needs the *uncompressed* sample
 * payload, which is measured from the unpacked archive in memory before any OPFS write
 * (spec §9.8 "Storage"), so no size claim in this file can be trusted into a write.
 */
export const factoryPackSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: factoryPackKindSchema,
  /** Filename relative to `/factory/`; a bare name, never a path (path traversal guard). */
  file: z.string().regex(/^[A-Za-z0-9._-]+\.mpcweb$/, 'Pack file must be a bare .mpcweb filename'),
  bytes: z.number().int().nonnegative(),
  description: z.string(),
});
export type FactoryPack = z.infer<typeof factoryPackSchema>;

/**
 * The catalogue is a bare array of entries — §9.8 specifies the per-pack shape and no
 * wrapper object, so none is invented (spec §13.6 naming freeze). Pack ids must be unique
 * because the UI keys on them and installs are addressed by id.
 */
export const factoryCatalogueSchema = z
  .array(factoryPackSchema)
  .refine(
    (packs) => new Set(packs.map((pack) => pack.id)).size === packs.length,
    'Factory catalogue contains duplicate pack ids',
  );
export type FactoryCatalogue = z.infer<typeof factoryCatalogueSchema>;

/** Parse and validate a fetched `index.json` body (spec §9.8). */
export function parseFactoryCatalogue(json: unknown): FactoryCatalogue {
  return factoryCatalogueSchema.parse(json);
}
