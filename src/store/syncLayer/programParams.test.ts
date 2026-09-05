/**
 * Program-parameter diff — spec §4.3 ("the sync layer is idempotent and diff-based: it
 * compares previous/next selector values and touches only what changed").
 */
import { describe, expect, it, vi } from 'vitest';
import { createDefaultDrumProgram, createDefaultPad, type Program } from '@/core/project/schemas';
import { useProgramStore } from '../useProgramStore';
import { noopBridge } from './bridge';
import { changedPadLeaves, subscribeProgramParamSync } from './programParams';

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

  it('emits the two §6 amp-envelope times, for the notes already in the lookahead (#143)', () => {
    // An AHDSR applies at note-on (spec §6), so this cannot re-shape a hit already sounding —
    // but a note scheduled up to `LOOKAHEAD_MS` ahead has been built and has not started, and
    // the pool re-lays exactly those. Nothing emitted them at all before issue #143.
    const pad = basePad();
    const changed = {
      ...pad,
      envelopes: { ...pad.envelopes, amp: { ...pad.envelopes.amp, attack: 500, release: 40 } },
    };
    expect(changedPadLeaves(programWith([pad]), programWith([changed]))).toEqual([
      { targetPath: `program:${PROGRAM_ID}.pad:0.amp.attack`, value: 500 },
      { targetPath: `program:${PROGRAM_ID}.pad:0.amp.release`, value: 40 },
    ]);
  });

  it('emits nothing for a §6 envelope field no §7.8 leaf addresses', () => {
    // `hold`, `decay`, `sustain` and `curve` are §6 fields with no registered address, so a
    // change to one has no §7.8 path to travel and reaches the next voice through the payload.
    const pad = basePad();
    const changed = {
      ...pad,
      envelopes: { ...pad.envelopes, amp: { ...pad.envelopes.amp, decay: 500, sustain: 0.2 } },
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

describe('subscribeProgramParamSync (spec §3.2, §4.3)', () => {
  it('tells the graph which programs have LEFT the store', () => {
    const onProgramRemoved = vi.fn();
    const dispose = subscribeProgramParamSync({ ...noopBridge, onProgramRemoved });
    try {
      // A §7.8 pad lane outlives the voices that borrow it, so a program the store no longer
      // holds — a project loaded over the top of the one open, or a deleted program — leaves
      // nodes nothing else can free (issue #138).
      useProgramStore.getState().setPrograms(programWith([basePad()]));
      expect(onProgramRemoved).not.toHaveBeenCalled();
      useProgramStore.getState().setPrograms({});
      expect(onProgramRemoved).toHaveBeenCalledWith(PROGRAM_ID);
    } finally {
      dispose();
      useProgramStore.getState().setPrograms({});
    }
  });
});
