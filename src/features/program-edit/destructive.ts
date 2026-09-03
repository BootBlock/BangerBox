/**
 * Counting what a Program Edit deletion actually takes (spec §6, issue #54).
 *
 * A confirmation that says "this cannot be undone" and nothing else is ceremony: the user
 * already knows what they pressed, and the question they cannot answer is *how much is in
 * there*. A program's pads and a pad's layers are one panel away from the button that
 * deletes them, so the dialog counts them.
 *
 * Pure and separate from the components so the wording is testable without rendering a
 * program editor (spec §2.5), and so the two dialogs cannot describe the same model in two
 * different vocabularies.
 */
import type { Pad, Program } from '@/core/project/schemas';

/** `n thing` / `n things`, with the count spelled out for one — en-GB, no i18n (§1.4). */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Join clauses as "a, b and c" — the en-GB list form the UI copy uses throughout. */
function listOf(parts: readonly string[]): string {
  if (parts.length === 0) return 'nothing';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

/** Mod routes on a pad or at program scope (spec §6 `modMatrix`). */
function routeCount(program: Program): number {
  if (program.type === 'keygroup') return program.modMatrix.length;
  return program.pads.reduce((sum, pad) => sum + pad.modMatrix.length, 0);
}

/**
 * What deleting `program` destroys, in the user's terms (spec §6).
 *
 * Sounding parts first — pads or zones, then the samples behind them — because that is what
 * a musician recognises the program by. The samples themselves survive in the library
 * (§8.5.7 is what deletes those), so this counts the assignments, not the audio.
 */
export function describeProgramContents(program: Program): string {
  const parts: string[] = [];
  if (program.type === 'drum') {
    const pads = program.pads.filter((pad) => pad.layers.length > 0);
    parts.push(count(pads.length, 'assigned pad'));
    const layers = pads.reduce((sum, pad) => sum + pad.layers.length, 0);
    if (layers > 0) parts.push(count(layers, 'sample assignment'));
  } else {
    parts.push(count(program.zones.length, 'keygroup zone'));
  }
  const routes = routeCount(program);
  if (routes > 0) parts.push(count(routes, 'mod-matrix route'));
  return `${listOf(parts)}, with their envelopes, filter and LFO settings`;
}

/** What clearing `pad` destroys (spec §6). The audio itself stays in the library (§8.5.7). */
export function describePadContents(pad: Pad): string {
  const parts = [count(pad.layers.length, 'sample layer')];
  if (pad.modMatrix.length > 0) parts.push(count(pad.modMatrix.length, 'mod-matrix route'));
  return `${listOf(parts)}, with this pad's envelopes, filter, LFOs, choke group and mixer settings`;
}
