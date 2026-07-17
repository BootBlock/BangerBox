/**
 * Domain schema barrel (spec §6, §4.2, §7, §10.3). One import site for the Zod
 * schemas, inferred domain types, range constants and default factories used by the
 * stores (spec §4) and the hydration layer (spec §4.4).
 */
export * from './ranges';
export * from './primitives';
export * from './mixer';
export * from './program';
export * from './sequence';
export * from './hardware';
export * from './projectPayload';
