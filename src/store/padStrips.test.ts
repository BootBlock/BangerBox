/**
 * The §6 pad ↔ §4.2 channel strip mapping (spec §4.2, §6, §8.5.6), in both directions:
 * the strips the Mixer mode edits and the sync layer pushes to the graph, and the write-back
 * that keeps the §6 payload true (issue #133). Pure, so it is testable without a program
 * store or an audio context.
 */
import { describe, expect, it } from 'vitest';
import {
  createDefaultChannelStrip,
  createDefaultKeygroupProgram,
  createDefaultPad,
} from '@/core/project/schemas';
import { padStripEdit, padStripsForProgram, withStripEdit } from './padStrips';
import type { ChannelStrip, DrumProgram, Pad } from '@/core/project/schemas';

function drumProgram(padIndices: number[]): DrumProgram {
  return {
    id: 'prog-1',
    name: 'Kit',
    type: 'drum',
    pads: padIndices.map((padIndex) => createDefaultPad(padIndex)),
  };
}

describe('padStripsForProgram (spec §4.2 channel ids)', () => {
  it('builds one strip per assigned pad, keyed by the canonical channel id', () => {
    const strips = padStripsForProgram(drumProgram([0, 5]));
    expect(strips.map((strip) => strip.id)).toEqual(['pad:prog-1:0', 'pad:prog-1:5']);
  });

  it('carries the pad’s §6 mixer values onto the strip', () => {
    const program = drumProgram([0]);
    const pad = program.pads[0]!;
    const customised: DrumProgram = {
      ...program,
      pads: [{ ...pad, mixer: { level: 0.7, pan: -0.4, sendLevels: [0.1, 0.2, 0.3, 0.4] } }],
    };
    const [strip] = padStripsForProgram(customised);
    expect(strip).toMatchObject({
      level: 0.7,
      pan: -0.4,
      sendLevels: [0.1, 0.2, 0.3, 0.4],
      mute: false,
      solo: false,
    });
  });

  it('carries the pad’s insert slots through unchanged', () => {
    const program = drumProgram([0]);
    const [strip] = padStripsForProgram(program);
    expect(strip?.inserts).toEqual(program.pads[0]!.inserts);
  });

  it('builds ONE strip for a keygroup, at the channel its voices merge into (issue #139)', () => {
    // §6 gives a keygroup one program-scope `mixer` rather than per-pad ones, and
    // `resolveKeygroupVoice` has always sounded it through `pad:<id>:0`. Publishing no
    // strip there is what left every §8.5.6 control for it inert while the values sounded.
    const keygroup = createDefaultKeygroupProgram('Bass', 'kg-1');
    const strips = padStripsForProgram(keygroup);
    expect(strips.map((strip) => strip.id)).toEqual(['pad:kg-1:0']);
  });

  it('carries the keygroup’s §6 program-scope mixer values and inserts onto that strip', () => {
    const keygroup = {
      ...createDefaultKeygroupProgram('Bass', 'kg-1'),
      mixer: { level: 0.7, pan: -0.4, sendLevels: [0.1, 0.2, 0.3, 0.4] as const },
    };
    const [strip] = padStripsForProgram(keygroup);
    expect(strip).toMatchObject({
      level: 0.7,
      pan: -0.4,
      sendLevels: [0.1, 0.2, 0.3, 0.4],
      mute: false,
      solo: false,
    });
    expect(strip?.inserts).toEqual(keygroup.inserts);
  });

  it('returns no strips for a null program', () => {
    expect(padStripsForProgram(undefined)).toEqual([]);
  });
});

describe('padStripEdit (spec §4.2 → §6, issue #133)', () => {
  // One base strip, spread into every variant, so an unrelated field keeps its identity —
  // the insert chain is diffed by identity exactly as `mixerSync` diffs it.
  const base = createDefaultChannelStrip('pad:prog-1:0');
  const strip = (over: Partial<ChannelStrip> = {}): ChannelStrip => ({ ...base, ...over });

  it('reports a moved level and nothing else', () => {
    const before = strip();
    expect(padStripEdit(strip({ level: 0.4 }), before)).toEqual({ level: 0.4 });
  });

  it('reports a moved pan and a moved send', () => {
    const before = strip();
    expect(padStripEdit(strip({ pan: -0.5 }), before)).toEqual({ pan: -0.5 });
    expect(padStripEdit(strip({ sendLevels: [0, 0.6, 0, 0] }), before)).toEqual({
      sendLevels: [0, 0.6, 0, 0],
    });
  });

  it('reports the insert chain when its array identity changes', () => {
    const before = strip();
    const inserts = before.inserts.map((slot, index) =>
      index === 0 ? { ...slot, effectType: 'delay' as const, enabled: true, params: { time: 350 } } : slot,
    );
    expect(padStripEdit(strip({ inserts }), before)?.inserts).toEqual(inserts);
  });

  it('reports NOTHING for mute or solo — §6 Pad.mixer defines neither', () => {
    const before = strip();
    expect(padStripEdit(strip({ mute: true }), before)).toBeNull();
    expect(padStripEdit(strip({ solo: true }), before)).toBeNull();
  });

  it('reports nothing for a strip that has just entered the store', () => {
    // Published by the mirror or restored by a §4.4 hydrate — an edit here would write the
    // projection straight back over the payload it was derived from.
    expect(padStripEdit(strip({ level: 0.4 }), undefined)).toBeNull();
  });

  it('reports nothing when the strip is the same object', () => {
    expect(padStripEdit(base, base)).toBeNull();
  });
});

describe('withStripEdit (spec §6 payload)', () => {
  it('writes the moved fields into the pad’s §6 mixer', () => {
    const pad = createDefaultPad(0);
    const next = withStripEdit(pad, { level: 0.4, pan: -0.5, sendLevels: [0, 0.6, 0, 0] });
    expect(next.mixer).toEqual({ level: 0.4, pan: -0.5, sendLevels: [0, 0.6, 0, 0] });
  });

  it('leaves a field the edit does not name at the pad’s own value', () => {
    // The half of the rule that keeps a §7.8 `program:….amp` edit alive: the strip that has
    // not seen it must not carry its stale level back over the pad on an unrelated touch.
    const pad = { ...createDefaultPad(0), mixer: { level: 0.25, pan: 0, sendLevels: [0, 0, 0, 0] } } as Pad;
    expect(withStripEdit(pad, { pan: -0.5 }).mixer).toEqual({
      level: 0.25,
      pan: -0.5,
      sendLevels: [0, 0, 0, 0],
    });
  });

  it('returns the SAME pad when the edit changes nothing', () => {
    const pad = createDefaultPad(0);
    expect(withStripEdit(pad, { level: pad.mixer.level })).toBe(pad);
    expect(withStripEdit(pad, {})).toBe(pad);
  });

  it('applies the same rule to a whole keygroup program (issue #139)', () => {
    // One function over both §6 shapes, because it is one rule — a keygroup carries the same
    // two members a pad does. Everything else about the program comes through untouched.
    const keygroup = createDefaultKeygroupProgram('Bass', 'kg-1');
    const next = withStripEdit(keygroup, { level: 0.4, pan: -0.5 });
    expect(next.mixer).toEqual({ level: 0.4, pan: -0.5, sendLevels: [0, 0, 0, 0] });
    expect(next.zones).toBe(keygroup.zones);
    expect(next.polyphony).toBe(keygroup.polyphony);
    expect(withStripEdit(keygroup, {})).toBe(keygroup);
  });
});
