// Pack assembly (spec §9.8 "Content (v1)"): three kits and three demo projects.
//
// A KIT pack ships its program and samples plus one short demonstration sequence. The
// sequence is deliberate: a kit MERGE discards sequences, tracks and song entries (§9.8),
// and shipping one proves that discard actually happens rather than merely being asserted —
// while still giving the pack something to play if it is opened directly.
//
// A DEMO pack is a complete project: sequences, tracks, events, automation and, for the
// song demo, a song-mode arrangement (§7.9). Samples are duplicated per demo project, which
// §9.8 accepts for v1 (`/global_library/` de-duplication is deferred).
import { createRng, derivedId, hashSeed } from './prng.mjs';
import { KITS } from './kits.mjs';
import {
  buildChannelStrip,
  buildDrumProgram,
  buildProjectRow,
  renderSamples,
  STEP_TICKS,
} from './snapshot.mjs';

/** Per-sample PRNG factory: seeded from the sample's own name (see `./prng.mjs`). */
function rngFactory(packId) {
  return (name) => createRng(hashSeed(`${packId}:${name}`));
}

/**
 * Expand a step map (`{ 'Closed Hat': [[step, velocity], …] }`) into `midi_events` rows.
 * Steps are 16ths at 960 PPQN (spec §7.2); a drum event's `note` IS the pad index (§9.3).
 */
function eventsFromSteps(packId, trackId, padIndexByName, stepMap, { durationSteps = 1 } = {}) {
  const events = [];
  for (const [padName, hits] of Object.entries(stepMap)) {
    const padIndex = padIndexByName.get(padName);
    if (padIndex === undefined) throw new Error(`Pattern references unknown pad "${padName}"`);
    for (const [step, velocity] of hits) {
      events.push({
        id: derivedId(`${packId}:${trackId}:${padName}:${step}`),
        track_id: trackId,
        tick_start: step * STEP_TICKS,
        duration_ticks: durationSteps * STEP_TICKS,
        note: padIndex,
        velocity,
        extra: null,
      });
    }
  }
  // Sorted by tick then note so the row order — and therefore the archive bytes — is stable.
  return events.sort((a, b) => a.tick_start - b.tick_start || a.note - b.note);
}

function buildSequenceRow(packId, projectId, position, name, { lengthBars, tempo = null, swing = 50 }) {
  return {
    id: derivedId(`${packId}:sequence:${name}`),
    project_id: projectId,
    position,
    name,
    length_bars: lengthBars,
    time_sig_numerator: 4,
    time_sig_denominator: 4,
    tempo,
    swing_amount: swing,
    swing_division: 16,
  };
}

function buildTrackRow(packId, sequenceId, programId, name, strip) {
  return {
    id: derivedId(`${packId}:track:${name}:${sequenceId}`),
    sequence_id: sequenceId,
    program_id: programId,
    position: 0,
    name,
    type: 'drum',
    mixer: JSON.stringify(strip),
  };
}

/** Empty snapshot scaffolding so every pack builder returns the same shape. */
function emptySnapshot(project) {
  return {
    version: 1,
    project,
    sequences: [],
    tracks: [],
    midiEvents: [],
    automation: [],
    programs: [],
    samples: [],
    songEntries: [],
  };
}

// --- Kit packs -------------------------------------------------------------------------

/** A one-bar pattern that plays a handful of a kit's pads, by pad index. */
const KIT_DEMO_STEPS = { 0: [[0, 118], [8, 104]], 2: [[4, 112], [12, 112]] };

function buildKitPack(kit, appVersion) {
  const packId = kit.id;
  const projectId = derivedId(`${packId}:project`);
  const { rows: sampleRows, wavs, resolved } = renderSamples(packId, projectId, kit.samples, rngFactory(packId));

  const program = buildDrumProgram(packId, kit.title, resolved);
  const sequence = buildSequenceRow(packId, projectId, 0, 'Kit Demo', { lengthBars: 1 });
  const strip = buildChannelStrip(packId, 'track:kit', {});
  const track = buildTrackRow(packId, sequence.id, program.id, 'Drums', strip);

  // Reference pads by index here — kits differ in their sound lists, and the first, third
  // and fifth pads are a kick/snare/hat in all three.
  const padIndexByName = new Map(resolved.map((sample, index) => [String(index), index]));
  const events = eventsFromSteps(packId, track.id, padIndexByName, KIT_DEMO_STEPS);

  const snapshot = emptySnapshot(buildProjectRow(projectId, kit.title));
  snapshot.programs = [{ id: program.id, project_id: projectId, name: program.name, type: 'drum', payload: JSON.stringify(program) }];
  snapshot.samples = sampleRows;
  snapshot.sequences = [sequence];
  snapshot.tracks = [track];
  snapshot.midiEvents = events;

  return {
    entry: { id: packId, title: kit.title, kind: 'kit', file: `${packId}.mpcweb`, description: kit.description },
    snapshot,
    wavs,
    appVersion,
  };
}

// --- Demo packs ------------------------------------------------------------------------

/** Pad names shared by the demo patterns; each demo maps them onto its own kit's pads. */
function padIndexMap(resolved) {
  return new Map(resolved.map((sample, index) => [sample.name, index]));
}

/** Every 16th-note step in `bars`, useful for hat patterns. */
function everyNth(bars, n, velocity, offset = 0) {
  const hits = [];
  for (let step = offset; step < bars * 16; step += n) hits.push([step, velocity]);
  return hits;
}

/** A four-bar boom-bap loop: swung 16ths, laid-back kick placement (spec §9.8). */
function buildBoomBapDemo(appVersion) {
  const packId = 'demo-boom-bap';
  const kit = KITS.find((entry) => entry.id === 'kit-acoustic');
  const projectId = derivedId(`${packId}:project`);
  const { rows: sampleRows, wavs, resolved } = renderSamples(packId, projectId, kit.samples, rngFactory(packId));

  const program = buildDrumProgram(packId, 'Boom Bap Kit', resolved);
  const sequence = buildSequenceRow(packId, projectId, 0, 'Boom Bap', { lengthBars: 4, tempo: 88, swing: 58 });
  const strip = buildChannelStrip(packId, 'track:drums', {});
  const track = buildTrackRow(packId, sequence.id, program.id, 'Drums', strip);

  const bars = [0, 16, 32, 48];
  const kick = [];
  const snare = [];
  for (const bar of bars) {
    kick.push([bar + 0, 122], [bar + 10, 96]);
    snare.push([bar + 4, 118], [bar + 12, 114]);
  }
  // A ghost kick and an extra snare in the last bar so the loop does not feel mechanical.
  kick.push([56, 84]);
  snare.push([62, 72]);

  const events = eventsFromSteps(packId, track.id, padIndexMap(resolved), {
    Kick: kick,
    Snare: snare,
    'Closed Hat': everyNth(4, 2, 88),
    'Open Hat': [[14, 96], [30, 96], [46, 96], [62, 90]],
    Ride: [[0, 70], [32, 70]],
  });

  const snapshot = emptySnapshot(buildProjectRow(projectId, 'Boom Bap Demo', { bpm: 88 }));
  snapshot.programs = [{ id: program.id, project_id: projectId, name: program.name, type: 'drum', payload: JSON.stringify(program) }];
  snapshot.samples = sampleRows;
  snapshot.sequences = [sequence];
  snapshot.tracks = [track];
  snapshot.midiEvents = events;

  return {
    entry: {
      id: packId,
      title: 'Boom Bap Demo',
      kind: 'demo',
      file: `${packId}.mpcweb`,
      description: 'A four-bar swung boom-bap loop at 88 BPM on the acoustic kit.',
    },
    snapshot,
    wavs,
    appVersion,
  };
}

/**
 * A house track exercising mixer automation and a filter sweep (spec §9.8).
 *
 * The sweep is a `filter` insert on the drum track, automated across the four bars. It is
 * reachable from a Q-Link encoder by the §10.3 `screen` mechanism — opening the insert's
 * panel publishes its parameters to the focus registry, which maps the encoders to Cutoff.
 * Q-Link BINDINGS themselves live in `app_settings` (§10.3), which is outside the §9.6
 * snapshot, so a pack cannot ship one; shipping the automated insert is what makes the
 * parameter exist and be grabbable. See the §14 entry for this decision.
 */
function buildHouseDemo(appVersion) {
  const packId = 'demo-house';
  const kit = KITS.find((entry) => entry.id === 'kit-909');
  const projectId = derivedId(`${packId}:project`);
  const { rows: sampleRows, wavs, resolved } = renderSamples(packId, projectId, kit.samples, rngFactory(packId));

  const program = buildDrumProgram(packId, 'House Kit', resolved);
  const sequence = buildSequenceRow(packId, projectId, 0, 'House Groove', { lengthBars: 4, tempo: 124 });

  const filterSlot = { effectType: 'filter', enabled: true, params: { type: 0, cutoff: 20_000, resonance: 4 } };
  const strip = buildChannelStrip(packId, 'track:house', { slots: [filterSlot] });
  const track = buildTrackRow(packId, sequence.id, program.id, 'Drums', strip);

  const events = eventsFromSteps(packId, track.id, padIndexMap(resolved), {
    Kick: everyNth(4, 4, 120),
    Clap: everyNth(4, 8, 110, 4),
    'Closed Hat': everyNth(4, 2, 84, 2),
    'Open Hat': everyNth(4, 8, 98, 6),
    Shaker: everyNth(4, 2, 62, 1),
    Ride: [[32, 74], [40, 74], [48, 74], [56, 74]],
  });

  // The sweep: cutoff opens across bars 1–3 then closes into the loop point, so the filter
  // breathes over the four-bar cycle rather than resetting abruptly.
  const cutoffPath = `insert:track:${track.id}:slot1.cutoff`;
  const sweep = [
    [0, 320],
    [16, 1_400],
    [32, 6_000],
    [48, 14_000],
    [63, 480],
  ];
  const automation = sweep.map(([step, value]) => ({
    id: derivedId(`${packId}:automation:cutoff:${step}`),
    scope: 'sequence',
    owner_id: sequence.id,
    target_path: cutoffPath,
    tick: step * STEP_TICKS,
    value,
    curve: 'exp',
  }));

  // Mixer automation (spec §9.8 "exercising mixer automation"): a level dip on the turnaround.
  const levelPath = `mixer.track:${track.id}.level`;
  for (const [step, value] of [[0, 1], [56, 0.72], [63, 1]]) {
    automation.push({
      id: derivedId(`${packId}:automation:level:${step}`),
      scope: 'sequence',
      owner_id: sequence.id,
      target_path: levelPath,
      tick: step * STEP_TICKS,
      value,
      curve: 'linear',
    });
  }

  const snapshot = emptySnapshot(buildProjectRow(projectId, 'House Demo', { bpm: 124 }));
  snapshot.programs = [{ id: program.id, project_id: projectId, name: program.name, type: 'drum', payload: JSON.stringify(program) }];
  snapshot.samples = sampleRows;
  snapshot.sequences = [sequence];
  snapshot.tracks = [track];
  snapshot.midiEvents = events;
  snapshot.automation = automation;

  return {
    entry: {
      id: packId,
      title: 'House Demo',
      kind: 'demo',
      file: `${packId}.mpcweb`,
      description: 'A 124 BPM house groove with a four-bar filter sweep and mixer automation.',
    },
    snapshot,
    wavs,
    appVersion,
  };
}

/** A song-mode arrangement of several sequences (spec §7.9, §9.8). */
function buildSongDemo(appVersion) {
  const packId = 'demo-song';
  const kit = KITS.find((entry) => entry.id === 'kit-808');
  const projectId = derivedId(`${packId}:project`);
  const { rows: sampleRows, wavs, resolved } = renderSamples(packId, projectId, kit.samples, rngFactory(packId));

  const program = buildDrumProgram(packId, 'Song Kit', resolved);
  const pads = padIndexMap(resolved);

  /** Each section is its own sequence; song entries order and repeat them (spec §7.9). */
  const sections = [
    { name: 'Intro', bars: 2, steps: { 'Closed Hat': everyNth(2, 4, 78), Clave: [[0, 96], [16, 96]] }, repeats: 2 },
    {
      name: 'Main',
      bars: 2,
      steps: {
        Kick: [[0, 122], [6, 100], [16, 122], [22, 100]],
        Clap: [[4, 112], [12, 112], [20, 112], [28, 112]],
        'Closed Hat': everyNth(2, 2, 84),
        'Open Hat': [[14, 96], [30, 96]],
      },
      repeats: 4,
    },
    {
      name: 'Break',
      bars: 2,
      steps: { Snare: everyNth(2, 4, 104), Maracas: everyNth(2, 2, 70, 1), Cowbell: [[8, 100], [24, 100]] },
      repeats: 1,
    },
    { name: 'Outro', bars: 2, steps: { Kick: [[0, 118], [16, 110]], Cymbal: [[0, 96]] }, repeats: 1 },
  ];

  const snapshot = emptySnapshot(buildProjectRow(projectId, 'Song Demo', { bpm: 102 }));
  snapshot.programs = [{ id: program.id, project_id: projectId, name: program.name, type: 'drum', payload: JSON.stringify(program) }];
  snapshot.samples = sampleRows;

  sections.forEach((section, index) => {
    const sequence = buildSequenceRow(packId, projectId, index, section.name, { lengthBars: section.bars });
    const strip = buildChannelStrip(packId, `track:${section.name}`, {});
    const track = buildTrackRow(packId, sequence.id, program.id, `${section.name} Drums`, strip);
    snapshot.sequences.push(sequence);
    snapshot.tracks.push(track);
    snapshot.midiEvents.push(...eventsFromSteps(packId, track.id, pads, section.steps));
    snapshot.songEntries.push({
      id: derivedId(`${packId}:song:${section.name}`),
      project_id: projectId,
      position: index,
      sequence_id: sequence.id,
      repeats: section.repeats,
    });
  });

  return {
    entry: {
      id: packId,
      title: 'Song Demo',
      kind: 'demo',
      file: `${packId}.mpcweb`,
      description: 'Four sequences arranged in Song mode — intro, main, break and outro at 102 BPM.',
    },
    snapshot,
    wavs,
    appVersion,
  };
}

/** Every pack the v1 factory build emits (spec §9.8 "Content (v1)"). */
export function buildAllPacks(appVersion) {
  return [
    ...KITS.map((kit) => buildKitPack(kit, appVersion)),
    buildBoomBapDemo(appVersion),
    buildHouseDemo(appVersion),
    buildSongDemo(appVersion),
  ];
}
