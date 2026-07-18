// Snapshot + archive assembly for the factory build (spec §9.8).
//
// Produces exactly the §9.6 `.mpcweb` layout — `manifest.json`, `project.json`,
// `samples/<sampleId>.wav` — so packs install through the UNCHANGED user-import pipeline
// (spec §9.8 "Delivery format": no new format, no new pipeline, no new dependency).
//
// The archive is written here rather than by importing `mpcwebZip.ts`, because that module
// imports its neighbours extensionlessly (TypeScript bundler resolution) and Node's type
// stripping cannot resolve those specifiers. `factoryPacks.test.ts` therefore unpacks every
// built archive with the REAL `unpackMpcweb` and validates it with the REAL schemas, so this
// layout cannot silently drift from the reader that consumes it.
import { zipSync } from 'fflate';
import { encodeWav } from '../../src/core/audio/wav.ts';
import { derivedId } from './prng.mjs';
import { SAMPLE_RATE } from './synth.mjs';

/** Interchange format version this build emits (mirrors `MPCWEB_FORMAT_VERSION`, §9.6). */
export const FORMAT_VERSION = 1;

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

// --- §6 program payload construction --------------------------------------------------
// Mirrors `createDefaultPad` / `createDefaultDrumProgram` in `src/core/project/schemas/`.
// `factoryPacks.test.ts` validates every emitted payload against the real `programSchema`,
// which is what keeps this mirror honest.

function envelope(overrides = {}) {
  return { attack: 1, hold: 0, decay: 60, sustain: 0.8, release: 120, curve: 'exponential', ...overrides };
}

function flatEnvelope() {
  return envelope({ attack: 0, decay: 0, sustain: 1, release: 0, curve: 'linear' });
}

function lfo() {
  return { rate: 1, sync: 'free', shape: 'sine', phaseOffset: 0, retrigger: true };
}

function insertSlots(packId, owner, slots = []) {
  return Array.from({ length: 4 }, (_unused, index) => ({
    id: derivedId(`${packId}:${owner}:insert:${index}`),
    effectType: slots[index]?.effectType ?? null,
    enabled: slots[index]?.enabled ?? false,
    params: slots[index]?.params ?? {},
  }));
}

/** A pad carrying one full-velocity layer of `sampleId` (spec §6). */
function buildPad(packId, programId, padIndex, sample) {
  return {
    padIndex,
    name: sample.name,
    chokeGroup: sample.chokeGroup ?? 0,
    playbackMode: sample.playbackMode ?? 'oneShot',
    warp: false,
    layers: [
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
    ],
    envelopes: { amp: envelope({ attack: 0, decay: 0, sustain: 1, release: 8 }), pitch: flatEnvelope(), filter: flatEnvelope() },
    pitchEnvSemitones: 0,
    filter: { type: 'off', cutoff: 20_000, resonance: 0.7, envDepth: 0 },
    lfos: [lfo(), lfo()],
    modMatrix: [],
    mixer: { level: 1, pan: 0, sendLevels: [0, 0, 0, 0] },
    inserts: insertSlots(packId, `${programId}:pad:${padIndex}`),
  };
}

/** A drum program whose pads are the given samples, in order from pad 0 (spec §6). */
export function buildDrumProgram(packId, name, samples) {
  const id = derivedId(`${packId}:program:${name}`);
  return {
    id,
    name,
    type: 'drum',
    pads: samples.map((sample, index) => buildPad(packId, id, index, sample)),
  };
}

/** A mixer channel strip (spec §4.2 `ChannelStrip`), optionally carrying insert slots. */
export function buildChannelStrip(packId, channelId, { level = 1, pan = 0, slots = [] } = {}) {
  return {
    id: channelId,
    level,
    pan,
    mute: false,
    solo: false,
    sendLevels: [0, 0, 0, 0],
    inserts: insertSlots(packId, channelId, slots),
  };
}

// --- Sample synthesis + rows -----------------------------------------------------------

/**
 * Render one kit's samples to WAV bytes and their `samples` rows (spec §9.3). `opfs_path`
 * follows §9.1 for the pack's own project id; the install path rewrites it (§9.8).
 */
export function renderSamples(packId, projectId, definitions, rngFor) {
  const rows = [];
  const wavs = new Map();
  const resolved = [];

  for (const definition of definitions) {
    const id = derivedId(`${packId}:sample:${definition.name}`);
    const channel = definition.build(rngFor(definition.name));
    const bytes = encodeWav([channel], SAMPLE_RATE, BIT_DEPTH);
    wavs.set(id, bytes);
    rows.push({
      id,
      project_id: projectId,
      name: definition.name,
      opfs_path: `/projects/${projectId}/samples/${id}.wav`,
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
 * Zip a snapshot + WAVs into `.mpcweb` bytes in the §9.6 layout.
 *
 * `mtime` is pinned for every entry: zip local headers embed a DOS timestamp, so the
 * default (now) would change the archive bytes on every rebuild (spec §9.8 "fixed zip entry
 * mtimes"). Object key insertion order is deterministic here, which fixes entry order too.
 */
export function packArchive({ snapshot, appVersion, wavs }) {
  const manifest = {
    format: 'mpcweb',
    formatVersion: FORMAT_VERSION,
    appVersion,
    projectId: snapshot.project.id,
    projectName: snapshot.project.name,
    exportedAt: FACTORY_EPOCH_ISO,
  };

  const entries = {
    'manifest.json': encodeText(JSON.stringify(manifest)),
    'project.json': encodeText(JSON.stringify(snapshot)),
  };
  // Sorted so entry order never depends on Map iteration incidentals.
  for (const id of [...wavs.keys()].sort()) entries[`samples/${id}.wav`] = wavs.get(id);

  return zipSync(entries, { level: 6, mtime: FACTORY_EPOCH_MS });
}

function encodeText(text) {
  return new TextEncoder().encode(text);
}
