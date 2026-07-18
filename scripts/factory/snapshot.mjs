// Snapshot + archive assembly for the factory build (spec §9.8).
//
// Produces exactly the §9.6 `.mpcweb` layout so packs install through the UNCHANGED
// user-import pipeline (spec §9.8 "Delivery format": no new format, no new pipeline, no new
// dependency).
//
// This module imports the app's OWN §6 schema factories, §9.6 packer, §9.4 WAV encoder and
// §9.1 path helper, resolved by `./resolve-hook.mjs`. Nothing here reimplements them: a
// second definition of a pad or of the archive layout drifts silently, and a test that
// catches drift after the fact is weaker than not having two definitions at all.
//
// DETERMINISM CAVEAT (spec §9.8 requires byte-identical rebuilds). Some app factories mint
// ids with `crypto.randomUUID()` — `createDefaultPad` and `createDefaultChannelStrip` both
// do, for their insert slots. Calling them is still correct, and still the right way to pick
// up future §6 fields automatically, but every id they generate MUST then be re-stamped from
// the seeded derivation below. `factoryPacks.test.ts` builds twice and compares bytes, so a
// missed re-stamp fails the suite rather than shipping irreproducible archives.
import { createDefaultDrumProgram, createDefaultPad } from '@/core/project/schemas/program';
import { createDefaultChannelStrip } from '@/core/project/schemas/mixer';
import { packMpcweb } from '@/core/project/mpcwebZip';
import { encodeWav } from '@/core/audio/wav';
import { samplePath } from '@/core/storage/opfs';
import { derivedId } from './prng.mjs';
import { SAMPLE_RATE } from './synth.mjs';

/**
 * Every timestamp the build emits, pinned (spec §9.8 "Build": a pinned `exportedAt` /
 * `created_at` / `modified_at`). A wall-clock value would change the bytes on every
 * rebuild, defeating determinism. 2026-01-01T00:00:00Z, chosen only for being fixed.
 */
export const FACTORY_EPOCH_MS = 1_767_225_600_000;
export const FACTORY_EPOCH_ISO = new Date(FACTORY_EPOCH_MS).toISOString();

/** Sequencer resolution (spec §2.6 `PPQN`) and the 16th-note step the patterns are written on. */
export const PPQN = 960;
export const STEP_TICKS = PPQN / 4;

/** Storage depth of shipped samples (spec §9.8: 48 kHz mono 16-bit). */
const BIT_DEPTH = '16';

/**
 * Replace every `crypto.randomUUID()` insert-slot id with one derived from `owner`, so the
 * payload is reproducible. See the determinism caveat at the top of this file.
 */
function restampInsertIds(slots, owner) {
  return slots.map((slot, index) => ({ ...slot, id: derivedId(`${owner}:insert:${index}`) }));
}

/** A pad carrying one full-velocity layer of `sample`, built from the app's §6 factory. */
function buildPad(packId, programId, padIndex, sample) {
  const pad = createDefaultPad(padIndex, sample.name);
  pad.playbackMode = sample.playbackMode ?? 'oneShot';
  pad.chokeGroup = sample.chokeGroup ?? 0;
  // A one-shot drum hit should ring out rather than be shaped by the default sustain curve.
  pad.envelopes.amp = { ...pad.envelopes.amp, attack: 0, decay: 0, sustain: 1, release: 8 };
  pad.layers = [
    {
      sampleId: sample.id,
      velocityStart: 0,
      velocityEnd: 127,
      tuneSemitones: 0,
      tuneCents: 0,
      gainDb: 0,
      startFrame: 0,
      endFrame: 0,
      reverse: false,
    },
  ];
  pad.inserts = restampInsertIds(pad.inserts, `${packId}:${programId}:pad:${padIndex}`);
  return pad;
}

/** A drum program whose pads are the given samples, in order from pad 0 (spec §6). */
export function buildDrumProgram(packId, name, samples) {
  const id = derivedId(`${packId}:program:${name}`);
  const program = createDefaultDrumProgram(name, id);
  program.pads = samples.map((sample, index) => buildPad(packId, id, index, sample));
  return program;
}

/** A mixer channel strip (spec §4.2 `ChannelStrip`), optionally carrying insert slots. */
export function buildChannelStrip(packId, channelId, { level = 1, pan = 0, slots = [] } = {}) {
  const strip = createDefaultChannelStrip(channelId);
  strip.level = level;
  strip.pan = pan;
  strip.inserts = restampInsertIds(strip.inserts, `${packId}:${channelId}`).map((slot, index) => ({
    ...slot,
    effectType: slots[index]?.effectType ?? slot.effectType,
    enabled: slots[index]?.enabled ?? slot.enabled,
    params: slots[index]?.params ?? slot.params,
  }));
  return strip;
}

// --- Sample synthesis + rows -----------------------------------------------------------

/**
 * Render one kit's samples to WAV bytes and their `samples` rows (spec §9.3). `opfs_path`
 * comes from the app's own §9.1 helper so it cannot drift; the install path rewrites it (§9.8).
 *
 * `sourceId` names the KIT the sounds belong to, which is not always the pack shipping them:
 * a demo plays a kit it does not define. Both the sample id and the PRNG seed derive from it,
 * so a demo renders byte-identical audio to the kit pack it draws on — which is what lets the
 * install path recognise the two as the same sample and store it once (spec §9.1, §9.8).
 * Seeding from the pack instead would produce a different noise realisation of the same sound
 * and defeat de-duplication silently, since only bytes are compared.
 */
export function renderSamples(sourceId, projectId, definitions, rngFor) {
  const rows = [];
  const wavs = new Map();
  const resolved = [];

  for (const definition of definitions) {
    const id = derivedId(`${sourceId}:sample:${definition.name}`);
    const channel = definition.build(rngFor(definition.name));
    const bytes = encodeWav([channel], SAMPLE_RATE, BIT_DEPTH);
    wavs.set(id, bytes);
    rows.push({
      id,
      project_id: projectId,
      name: definition.name,
      opfs_path: samplePath(projectId, id),
      frames: channel.length,
      sample_rate: SAMPLE_RATE,
      channels: 1,
      root_note: 60,
      created_at: FACTORY_EPOCH_MS,
    });
    resolved.push({ ...definition, id });
  }

  return { rows, wavs, resolved };
}

/** The `projects` row for a pack (spec §9.3), with both timestamps pinned (§9.8). */
export function buildProjectRow(projectId, name, { bpm = 120 } = {}) {
  return {
    id: projectId,
    name,
    created_at: FACTORY_EPOCH_MS,
    modified_at: FACTORY_EPOCH_MS,
    sample_rate: SAMPLE_RATE,
    bit_depth: BIT_DEPTH,
    bpm_default: bpm,
    insert_limit: 4,
    payload: '{}',
  };
}

/**
 * Zip a snapshot + WAVs into `.mpcweb` bytes via the app's own §9.6 packer.
 *
 * `exportedAt` is pinned, which pins both the manifest timestamp and every zip entry mtime
 * (spec §9.8). Samples are sorted so entry order never depends on Map iteration incidentals.
 */
export function packArchive({ snapshot, appVersion, wavs }) {
  const samples = [...wavs.keys()].sort().map((sampleId) => ({ sampleId, bytes: wavs.get(sampleId) }));
  return packMpcweb({ snapshot, appVersion, samples, exportedAt: FACTORY_EPOCH_ISO });
}
