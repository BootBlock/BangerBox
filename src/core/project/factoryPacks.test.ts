/**
 * Factory build verification (spec §9.8).
 *
 * The load-bearing test here is DETERMINISM: §9.8 requires byte-identical output across
 * rebuilds, and that is proven by building twice and comparing bytes — never asserted.
 *
 * The rest guard the seam between `scripts/build-factory.mjs` (plain ESM, which mirrors the
 * §6/§9.3 shapes by hand because Node's type stripping cannot resolve the app's
 * extensionless imports) and the real runtime readers. Every archive is unpacked with the
 * REAL `unpackMpcweb` and validated with the REAL schemas, so the mirror cannot drift
 * silently from the code that consumes it.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-ESM build script, deliberately untyped (spec §9.8 build artefact tooling).
import { buildFactory } from '../../../scripts/build-factory.mjs';
import { parseFactoryCatalogue } from './factoryCatalogue';
import { unpackMpcweb } from './mpcwebZip';
import { programSchema } from './schemas';
import { decodeWav } from '@/core/audio/wav';

const APP_VERSION = '0.1.0';

interface BuiltArchive {
  file: string;
  bytes: Uint8Array;
}
interface BuiltFactory {
  catalogue: unknown;
  archives: BuiltArchive[];
  catalogueJson: string;
}

/** Spec §9.8: total shipped payload stays under 8 MB. */
const PAYLOAD_LIMIT_BYTES = 8 * 1024 * 1024;

const built = buildFactory(APP_VERSION) as BuiltFactory;

describe('factory build determinism (spec §9.8)', () => {
  it('produces byte-identical archives across two consecutive builds', () => {
    const second = buildFactory(APP_VERSION) as BuiltFactory;

    expect(second.archives.map((a) => a.file)).toEqual(built.archives.map((a) => a.file));
    for (const [index, archive] of built.archives.entries()) {
      const other = second.archives[index]!;
      // Compare the actual bytes, not a length or a hash of a summary — a fixed zip mtime,
      // a seeded PRNG and pinned timestamps are exactly what this is checking.
      expect(Array.from(other.bytes), `${archive.file} differs between builds`).toEqual(
        Array.from(archive.bytes),
      );
    }
  });

  it('produces an identical catalogue across two consecutive builds', () => {
    const second = buildFactory(APP_VERSION) as BuiltFactory;
    expect(second.catalogueJson).toBe(built.catalogueJson);
  });
});

describe('factory catalogue (spec §9.8)', () => {
  it('validates against the runtime catalogue schema', () => {
    const packs = parseFactoryCatalogue(JSON.parse(built.catalogueJson));
    expect(packs).toHaveLength(built.archives.length);
  });

  it('ships three kits and three demo projects', () => {
    const packs = parseFactoryCatalogue(JSON.parse(built.catalogueJson));
    expect(packs.filter((pack) => pack.kind === 'kit')).toHaveLength(3);
    expect(packs.filter((pack) => pack.kind === 'demo')).toHaveLength(3);
  });

  it('lists a file for every built archive, with matching sizes', () => {
    const packs = parseFactoryCatalogue(JSON.parse(built.catalogueJson));
    for (const pack of packs) {
      const archive = built.archives.find((entry) => entry.file === pack.file);
      expect(archive, `catalogue lists ${pack.file} but no archive was built`).toBeDefined();
      expect(pack.bytes).toBe(archive!.bytes.byteLength);
    }
  });

  it('keeps the total shipped payload under 8 MB', () => {
    const total = built.archives.reduce((sum, archive) => sum + archive.bytes.byteLength, 0);
    expect(total).toBeLessThan(PAYLOAD_LIMIT_BYTES);
  });
});

describe('factory archives round-trip through the real reader (spec §9.6, §9.8)', () => {
  it.each(built.archives.map((archive) => [archive.file, archive] as const))(
    '%s unpacks and validates',
    (_file, archive) => {
      const { manifest, snapshot, samples } = unpackMpcweb(archive.bytes);

      expect(manifest.format).toBe('mpcweb');
      expect(manifest.appVersion).toBe(APP_VERSION);
      // Pinned, not wall-clock (spec §9.8 determinism).
      expect(manifest.exportedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(snapshot.project.created_at).toBe(snapshot.project.modified_at);

      // Every sample row has its bytes in the archive, and vice versa — no orphans.
      expect(new Set(samples.keys())).toEqual(new Set(snapshot.samples.map((row) => row.id)));
      expect(snapshot.samples.length).toBeGreaterThan(0);
    },
  );

  it.each(built.archives.map((archive) => [archive.file, archive] as const))(
    '%s carries §6-valid program payloads',
    (_file, archive) => {
      const { snapshot } = unpackMpcweb(archive.bytes);
      expect(snapshot.programs.length).toBeGreaterThan(0);
      for (const row of snapshot.programs) {
        // The real §6 schema — this is what catches drift in the build script's mirror.
        const program = programSchema.parse(JSON.parse(row.payload));
        expect(program.id).toBe(row.id);
        if (program.type !== 'drum') throw new Error('factory packs ship drum programs in v1');
        expect(program.pads.length).toBeGreaterThan(0);
        // Every pad layer must reference a sample the pack actually ships.
        const shipped = new Set(snapshot.samples.map((sampleRow) => sampleRow.id));
        for (const pad of program.pads) {
          for (const layer of pad.layers) expect(shipped.has(layer.sampleId)).toBe(true);
        }
      }
    },
  );

  it.each(built.archives.map((archive) => [archive.file, archive] as const))(
    '%s ships 48 kHz mono 16-bit WAV samples',
    (_file, archive) => {
      const { snapshot, samples } = unpackMpcweb(archive.bytes);
      for (const row of snapshot.samples) {
        const decoded = decodeWav(samples.get(row.id)!);
        expect(decoded.sampleRate).toBe(48_000); // spec §9.8
        expect(decoded.bitDepth).toBe('16');
        expect(decoded.channels).toHaveLength(1);
        // The row's frame count must match the file, or the editor draws the wrong length.
        expect(decoded.channels[0]!.length).toBe(row.frames);
      }
    },
  );

  it.each(built.archives.map((archive) => [archive.file, archive] as const))(
    '%s contains audible, click-free audio',
    (_file, archive) => {
      const { snapshot, samples } = unpackMpcweb(archive.bytes);
      for (const row of snapshot.samples) {
        const [channel] = decodeWav(samples.get(row.id)!).channels;
        let peak = 0;
        for (const value of channel!) peak = Math.max(peak, Math.abs(value));
        // Synthesis that silently produced nothing would otherwise ship as a dead pad.
        expect(peak, `${row.name} is silent`).toBeGreaterThan(0.5);
        // `finalise` fades every sample to zero so retriggers do not click.
        expect(Math.abs(channel![channel!.length - 1]!), `${row.name} does not end at zero`).toBeLessThan(
          0.01,
        );
      }
    },
  );
});

describe('factory content shape (spec §9.8 "Content (v1)")', () => {
  it('ships around 40 kit samples across the three kits', () => {
    const kitFiles = ['kit-808.mpcweb', 'kit-909.mpcweb', 'kit-acoustic.mpcweb'];
    const total = kitFiles.reduce((sum, file) => {
      const archive = built.archives.find((entry) => entry.file === file)!;
      return sum + unpackMpcweb(archive.bytes).snapshot.samples.length;
    }, 0);
    expect(total).toBe(40);
  });

  it('gives kit packs a sequence and track, so the merge discard is a real behaviour', () => {
    // If kit packs shipped no arrangement, "a kit merge discards sequences/tracks/song"
    // would be vacuously true and the install test would prove nothing (spec §9.8).
    for (const file of ['kit-808.mpcweb', 'kit-909.mpcweb', 'kit-acoustic.mpcweb']) {
      const archive = built.archives.find((entry) => entry.file === file)!;
      const { snapshot } = unpackMpcweb(archive.bytes);
      expect(snapshot.sequences.length).toBeGreaterThan(0);
      expect(snapshot.tracks.length).toBeGreaterThan(0);
      expect(snapshot.midiEvents.length).toBeGreaterThan(0);
    }
  });

  it('gives the song demo several sequences arranged in song mode (spec §7.9)', () => {
    const archive = built.archives.find((entry) => entry.file === 'demo-song.mpcweb')!;
    const { snapshot } = unpackMpcweb(archive.bytes);
    expect(snapshot.sequences.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.songEntries.length).toBe(snapshot.sequences.length);
    // Song entries must be contiguous from 0 so playback order is unambiguous (§7.9).
    expect(snapshot.songEntries.map((entry) => entry.position).sort((a, b) => a - b)).toEqual(
      snapshot.sequences.map((_unused, index) => index),
    );
  });

  it('gives the house demo mixer automation and an automated filter insert (spec §9.8)', () => {
    const archive = built.archives.find((entry) => entry.file === 'demo-house.mpcweb')!;
    const { snapshot } = unpackMpcweb(archive.bytes);
    const paths = new Set(snapshot.automation.map((point) => point.target_path));
    expect([...paths].some((path) => path.startsWith('mixer.') && path.endsWith('.level'))).toBe(true);
    expect([...paths].some((path) => path.startsWith('insert:') && path.endsWith('.cutoff'))).toBe(true);
  });
});
