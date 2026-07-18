/**
 * Program-parameter diff — spec §4.3 ("the sync layer is idempotent and diff-based: it
 * compares previous/next selector values and touches only what changed").
 */
import { describe, expect, it } from 'vitest';
import { createDefaultDrumProgram, createDefaultPad, type Program } from '@/core/project/schemas';
import { changedPadLeaves } from './programParams';

const PROGRAM_ID = 'prog-1';

function programWith(pads: ReturnType<typeof createDefaultPad>[]): Record<string, Program> {
  return { [PROGRAM_ID]: { ...createDefaultDrumProgram('Kit', PROGRAM_ID), pads } };
}

const basePad = () => createDefaultPad(0);

describe('changedPadLeaves (spec §4.3)', () => {
  it('emits nothing when the program map is unchanged', () => {
    const map = programWith([basePad()]);
    expect(changedPadLeaves(map, map)).toEqual([]);
  });

  it('emits nothing when a pad object is untouched by reference', () => {
    const pad = basePad();
    expect(changedPadLeaves(programWith([pad]), programWith([pad]))).toEqual([]);
  });

  it('emits the changed filter cutoff as a registry address', () => {
    const pad = basePad();
    const changed = { ...pad, filter: { ...pad.filter, cutoff: 4_000 } };
    expect(changedPadLeaves(programWith([pad]), programWith([changed]))).toEqual([
      { targetPath: `program:${PROGRAM_ID}.pad:0.filter.cutoff`, value: 4_000 },
    ]);
  });

  it('emits pad tune from the layers', () => {
    const pad = { ...basePad(), layers: [{ ...basePad().layers[0]!, tuneSemitones: 0 }] };
    const changed = { ...pad, layers: [{ ...pad.layers[0]!, tuneSemitones: 5 }] };
    expect(changedPadLeaves(programWith([pad]), programWith([changed]))).toEqual([
      { targetPath: `program:${PROGRAM_ID}.pad:0.pitch`, value: 5 },
    ]);
  });

  it('does not emit amp or pan — the pad’s mixer channel owns those', () => {
    const pad = basePad();
    const changed = { ...pad, mixer: { ...pad.mixer, level: 0.5, pan: -0.5 } };
    expect(changedPadLeaves(programWith([pad]), programWith([changed]))).toEqual([]);
  });

  it('does not emit envelope times — an AHDSR applies at note-on (spec §6)', () => {
    const pad = basePad();
    const changed = {
      ...pad,
      envelopes: { ...pad.envelopes, amp: { ...pad.envelopes.amp, attack: 500 } },
    };
    expect(changedPadLeaves(programWith([pad]), programWith([changed]))).toEqual([]);
  });

  it('touches only the pad that changed', () => {
    const first = createDefaultPad(0);
    const second = createDefaultPad(1);
    const changed = { ...second, filter: { ...second.filter, cutoff: 900 } };
    const changes = changedPadLeaves(programWith([first, second]), programWith([first, changed]));
    expect(changes).toEqual([{ targetPath: `program:${PROGRAM_ID}.pad:1.filter.cutoff`, value: 900 }]);
  });

  it('ignores a newly added pad — it has no previous value to move from', () => {
    const first = createDefaultPad(0);
    expect(changedPadLeaves(programWith([first]), programWith([first, createDefaultPad(1)]))).toEqual([]);
  });

  it('ignores a program that is absent from the previous map', () => {
    expect(changedPadLeaves({}, programWith([basePad()]))).toEqual([]);
  });

  it('ignores a removed program', () => {
    expect(changedPadLeaves(programWith([basePad()]), {})).toEqual([]);
  });
});
