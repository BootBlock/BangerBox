// Deterministic randomness for the factory build (spec §9.8 "Build": output MUST be
// byte-deterministic across rebuilds, so every noise source is a SEEDED PRNG and every id
// is derived, never drawn from `crypto.randomUUID()`).
//
// This is the one sanctioned departure from §1.3.1 "UUIDs via crypto.randomUUID()": that
// rule governs the running application, where ids must be globally unique. Here the ids are
// build artefacts that the install path remaps wholesale (§9.6) before they ever reach a
// database, and a random id would make the archive bytes differ on every rebuild — which is
// precisely what §9.8 forbids. See the §14 entry for this phase.

/** mulberry32 — a small, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a over a string. Seeding each sample's PRNG from its own name (rather than from one
 * shared stream) keeps sounds independent: adding or reordering a sample cannot change the
 * bytes of any other, so a content change produces a minimal artefact diff.
 */
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A UUID-shaped identifier derived deterministically from `key`. The install path remaps
 * every id anyway (§9.6), so these need only be well-formed, stable and distinct within a
 * pack — not globally unique.
 */
export function derivedId(key) {
  const rng = createRng(hashSeed(key));
  const hex = [];
  for (let i = 0; i < 32; i++) hex.push(Math.floor(rng() * 16).toString(16));
  const raw = hex.join('');
  // Stamp the version (4) and variant (8) nibbles so the value is a syntactically valid
  // UUIDv4 — anything reading it as one gets a conforming string.
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    `4${raw.slice(13, 16)}`,
    `8${raw.slice(17, 20)}`,
    raw.slice(20, 32),
  ].join('-');
}
