// The v1 factory kits (spec §9.8 "Content": three kits, ~40 samples — 808-flavoured,
// 909-flavoured and acoustic-ish). Every voice is pure synthesis (§9.8 "Provenance").
//
// Each sample declares its own `build(rng)`; the PRNG is seeded from the sample's name
// (`./prng.mjs`), so sounds are independent and a rebuild is byte-identical (§9.8 "Build").
// "Flavoured" and "-ish" are deliberate: these evoke the character of classic machines
// without reproducing any recording of one.
import { bandPass, delay, finalise, highPass, lowPass, metallic, mix, noise, tone, sweepSine } from './synth.mjs';

/** Inharmonic square-bank ratios — the metallic source shared by hats and cymbals. */
const HAT_RATIOS = [1, 1.4471, 1.6170, 1.9265, 2.5028, 2.6637];
const CYMBAL_RATIOS = [1, 1.3211, 1.5473, 1.8391, 2.1017, 2.4813, 2.9127, 3.3541];

/** A closed/open hat pair from one metallic bank, differing only in decay. */
function hat(seconds, rng, { baseHz = 320, hp = 7_000, curve = 1.6 } = {}) {
  const body = metallic({ seconds, baseHz, ratios: HAT_RATIOS, curve });
  // A touch of noise stops the square bank sounding like a static chord.
  const air = noise({ seconds, rng, curve: curve * 1.2 });
  return finalise(highPass(mix([body, 0.85], [air, 0.25]), hp));
}

function cymbal(seconds, rng, { baseHz = 240, hp = 4_200 } = {}) {
  const body = metallic({ seconds, baseHz, ratios: CYMBAL_RATIOS, curve: 0.55 });
  const wash = noise({ seconds, rng, curve: 0.5 });
  return finalise(highPass(mix([body, 0.6], [wash, 0.5]), hp));
}

/** A tom: pitch-swept sine body with a little noise attack. */
function tom(seconds, rng, hz) {
  const body = sweepSine({ seconds, startHz: hz * 1.6, endHz: hz, sweepTime: seconds * 0.25, curve: 1.1 });
  const attack = noise({ seconds: 0.01, rng, curve: 3 });
  return finalise(mix([body, 1], [lowPass(attack, 3_000), 0.25]));
}

/**
 * A clap: several short noise bursts staggered a few milliseconds apart, then a longer
 * decaying tail. The stagger is what produces the characteristic "flam" rather than a
 * single dry noise hit.
 */
function clap(seconds, rng, { centreHz = 1_200, q = 1.1 } = {}) {
  const burst = () => bandPass(noise({ seconds: 0.012, rng, curve: 3 }), centreHz, q);
  const tail = bandPass(noise({ seconds, rng, curve: 1.1 }), centreHz, q * 0.8);
  return finalise(
    mix(
      [burst(), 0.9],
      [delay(burst(), 0.009), 0.85],
      [delay(burst(), 0.018), 0.8],
      [delay(tail, 0.026), 0.7],
    ),
  );
}

// --- 808-flavoured -------------------------------------------------------------------

const KIT_808 = [
  {
    name: 'Kick',
    tags: ['kick', '808'],
    build: (rng) => {
      // The 808 kick is a long, barely-swept sine — the sweep is short and the tail is
      // where all the character lives.
      const body = sweepSine({ seconds: 0.9, startHz: 115, endHz: 47, sweepTime: 0.045, curve: 0.75 });
      const click = lowPass(noise({ seconds: 0.006, rng, curve: 4 }), 5_000);
      return finalise(mix([body, 1], [click, 0.18]));
    },
  },
  {
    name: 'Sub Kick',
    tags: ['kick', 'sub', '808'],
    build: () => finalise(sweepSine({ seconds: 1.2, startHz: 80, endHz: 38, sweepTime: 0.06, curve: 0.55 })),
  },
  {
    name: 'Snare',
    tags: ['snare', '808'],
    build: (rng) => {
      const body = mix([tone({ seconds: 0.16, hz: 186, curve: 1.4 }), 1], [tone({ seconds: 0.13, hz: 331, curve: 1.6 }), 0.6]);
      const snares = highPass(noise({ seconds: 0.25, rng, curve: 1.5 }), 1_400);
      return finalise(mix([body, 0.75], [snares, 0.7]));
    },
  },
  {
    name: 'Rim',
    tags: ['rim', 'perc', '808'],
    build: (rng) =>
      finalise(mix([tone({ seconds: 0.05, hz: 1_700, curve: 3 }), 0.8], [bandPass(noise({ seconds: 0.05, rng, curve: 3.5 }), 2_400, 2), 0.6])),
  },
  { name: 'Clap', tags: ['clap', '808'], build: (rng) => clap(0.5, rng) },
  { name: 'Closed Hat', tags: ['hat', 'closed', '808'], build: (rng) => hat(0.06, rng, { curve: 2.4 }) },
  { name: 'Open Hat', tags: ['hat', 'open', '808'], build: (rng) => hat(0.5, rng, { curve: 0.9 }) },
  { name: 'Cymbal', tags: ['cymbal', '808'], build: (rng) => cymbal(1.5, rng, { baseHz: 300 }) },
  { name: 'Low Tom', tags: ['tom', '808'], build: (rng) => tom(0.5, rng, 90) },
  { name: 'Mid Tom', tags: ['tom', '808'], build: (rng) => tom(0.45, rng, 140) },
  { name: 'High Tom', tags: ['tom', '808'], build: (rng) => tom(0.4, rng, 200) },
  {
    name: 'Cowbell',
    tags: ['perc', 'cowbell', '808'],
    build: () => {
      // Two detuned squares a fifth-ish apart — the 808 cowbell in one line.
      const a = metallic({ seconds: 0.4, baseHz: 540, ratios: [1], curve: 1.3 });
      const b = metallic({ seconds: 0.4, baseHz: 800, ratios: [1], curve: 1.3 });
      return finalise(bandPass(mix([a, 0.6], [b, 0.6]), 2_200, 0.8));
    },
  },
  { name: 'Clave', tags: ['perc', 'clave', '808'], build: () => finalise(tone({ seconds: 0.08, hz: 2_500, curve: 3 })) },
  {
    name: 'Maracas',
    tags: ['perc', 'shaker', '808'],
    build: (rng) => finalise(highPass(noise({ seconds: 0.12, rng, attack: 0.002, curve: 3 }), 6_000)),
  },
];

// --- 909-flavoured -------------------------------------------------------------------

const KIT_909 = [
  {
    name: 'Kick',
    tags: ['kick', '909'],
    build: (rng) => {
      // Punchier than the 808: wider, faster sweep and a pronounced click.
      const body = sweepSine({ seconds: 0.5, startHz: 240, endHz: 52, sweepTime: 0.03, curve: 1.2 });
      const click = highPass(noise({ seconds: 0.008, rng, curve: 4 }), 1_200);
      return finalise(mix([body, 1], [click, 0.3]));
    },
  },
  {
    name: 'Snare',
    tags: ['snare', '909'],
    build: (rng) => {
      const body = mix([tone({ seconds: 0.12, hz: 200, curve: 1.8 }), 1], [tone({ seconds: 0.1, hz: 296, curve: 2 }), 0.5]);
      const snares = highPass(noise({ seconds: 0.25, rng, curve: 1.8 }), 2_000);
      return finalise(mix([body, 0.6], [snares, 0.9]));
    },
  },
  {
    name: 'Rim',
    tags: ['rim', 'perc', '909'],
    build: (rng) => finalise(bandPass(mix([tone({ seconds: 0.04, hz: 1_900, curve: 3.5 }), 0.9], [noise({ seconds: 0.04, rng, curve: 4 }), 0.5]), 3_000, 2.2)),
  },
  { name: 'Clap', tags: ['clap', '909'], build: (rng) => clap(0.45, rng, { centreHz: 1_450, q: 1.3 }) },
  { name: 'Closed Hat', tags: ['hat', 'closed', '909'], build: (rng) => hat(0.05, rng, { baseHz: 370, hp: 8_000, curve: 2.6 }) },
  { name: 'Open Hat', tags: ['hat', 'open', '909'], build: (rng) => hat(0.4, rng, { baseHz: 370, hp: 8_000, curve: 1 }) },
  { name: 'Crash', tags: ['cymbal', 'crash', '909'], build: (rng) => cymbal(1.6, rng, { baseHz: 260, hp: 3_800 }) },
  { name: 'Ride', tags: ['cymbal', 'ride', '909'], build: (rng) => cymbal(1.4, rng, { baseHz: 420, hp: 5_500 }) },
  { name: 'Low Tom', tags: ['tom', '909'], build: (rng) => tom(0.45, rng, 100) },
  { name: 'Mid Tom', tags: ['tom', '909'], build: (rng) => tom(0.4, rng, 155) },
  { name: 'High Tom', tags: ['tom', '909'], build: (rng) => tom(0.35, rng, 225) },
  {
    name: 'Shaker',
    tags: ['perc', 'shaker', '909'],
    build: (rng) => finalise(highPass(noise({ seconds: 0.12, rng, attack: 0.004, curve: 2.6 }), 7_000)),
  },
  {
    name: 'Perc',
    tags: ['perc', '909'],
    build: (rng) => finalise(bandPass(mix([tone({ seconds: 0.2, hz: 620, curve: 2 }), 0.8], [noise({ seconds: 0.1, rng, curve: 3 }), 0.3]), 1_500, 1.6)),
  },
];

// --- Acoustic-ish --------------------------------------------------------------------

const KIT_ACOUSTIC = [
  {
    name: 'Kick',
    tags: ['kick', 'acoustic'],
    build: (rng) => {
      // More beater and shell noise than the machine kicks, and a shorter tail.
      const body = sweepSine({ seconds: 0.6, startHz: 150, endHz: 55, sweepTime: 0.05, curve: 1.4 });
      const beater = lowPass(noise({ seconds: 0.02, rng, curve: 3 }), 2_500);
      const shell = bandPass(noise({ seconds: 0.12, rng, curve: 2.4 }), 220, 1.2);
      return finalise(mix([body, 1], [beater, 0.3], [shell, 0.2]));
    },
  },
  {
    name: 'Snare',
    tags: ['snare', 'acoustic'],
    build: (rng) => {
      const head = mix([tone({ seconds: 0.14, hz: 180, curve: 1.6 }), 1], [tone({ seconds: 0.12, hz: 270, curve: 1.8 }), 0.7]);
      const wires = highPass(noise({ seconds: 0.35, rng, curve: 1.3 }), 1_800);
      const room = bandPass(noise({ seconds: 0.35, rng, curve: 0.9 }), 600, 0.8);
      return finalise(mix([head, 0.6], [wires, 0.8], [room, 0.15]));
    },
  },
  {
    name: 'Side Stick',
    tags: ['rim', 'perc', 'acoustic'],
    build: (rng) => finalise(bandPass(mix([tone({ seconds: 0.06, hz: 1_150, curve: 3 }), 0.9], [noise({ seconds: 0.05, rng, curve: 4 }), 0.5]), 1_800, 1.8)),
  },
  { name: 'Closed Hat', tags: ['hat', 'closed', 'acoustic'], build: (rng) => hat(0.07, rng, { baseHz: 410, hp: 6_500, curve: 2.2 }) },
  { name: 'Open Hat', tags: ['hat', 'open', 'acoustic'], build: (rng) => hat(0.45, rng, { baseHz: 410, hp: 6_500, curve: 0.85 }) },
  { name: 'Ride', tags: ['cymbal', 'ride', 'acoustic'], build: (rng) => cymbal(1.5, rng, { baseHz: 460, hp: 5_000 }) },
  { name: 'Crash', tags: ['cymbal', 'crash', 'acoustic'], build: (rng) => cymbal(1.8, rng, { baseHz: 230, hp: 3_500 }) },
  { name: 'Floor Tom', tags: ['tom', 'acoustic'], build: (rng) => tom(0.6, rng, 82) },
  { name: 'Mid Tom', tags: ['tom', 'acoustic'], build: (rng) => tom(0.5, rng, 125) },
  { name: 'High Tom', tags: ['tom', 'acoustic'], build: (rng) => tom(0.4, rng, 185) },
  {
    name: 'Tambourine',
    tags: ['perc', 'tambourine', 'acoustic'],
    build: (rng) => {
      const jingles = metallic({ seconds: 0.4, baseHz: 780, ratios: CYMBAL_RATIOS, curve: 1.8 });
      const shake = noise({ seconds: 0.4, rng, curve: 2.2 });
      return finalise(highPass(mix([jingles, 0.5], [shake, 0.6]), 5_500));
    },
  },
  {
    name: 'Shaker',
    tags: ['perc', 'shaker', 'acoustic'],
    build: (rng) => finalise(highPass(noise({ seconds: 0.15, rng, attack: 0.006, curve: 2.2 }), 6_200)),
  },
  {
    name: 'Woodblock',
    tags: ['perc', 'woodblock', 'acoustic'],
    build: () => finalise(mix([tone({ seconds: 0.1, hz: 1_180, curve: 2.6 }), 1], [tone({ seconds: 0.06, hz: 2_360, curve: 3.4 }), 0.3])),
  },
];

/** The shipped kits (spec §9.8 "Content (v1)"). */
export const KITS = [
  {
    id: 'kit-808',
    title: '808 Kit',
    description: 'Deep swept sub kicks, metallic hats and the familiar cowbell — 808-flavoured, fully synthesised.',
    samples: KIT_808,
  },
  {
    id: 'kit-909',
    title: '909 Kit',
    description: 'Punchy click-forward kicks, noisy snares and bright cymbals — 909-flavoured, fully synthesised.',
    samples: KIT_909,
  },
  {
    id: 'kit-acoustic',
    title: 'Acoustic Kit',
    description: 'Shell-and-wire drums with room character and a full cymbal set — acoustic-ish, fully synthesised.',
    samples: KIT_ACOUSTIC,
  },
];
