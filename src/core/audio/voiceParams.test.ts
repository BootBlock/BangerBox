/**
 * Per-voice program-parameter application (spec §6/§7.8) — the maths that turns a
 * registered `program:<id>.pad:<idx>.<param>` value into the per-voice node change.
 * Pure and node-free, so it is unit-testable without a Web Audio context (spec §11.3).
 */
import { describe, expect, it } from 'vitest';
import { isPerVoiceTarget, padKeyFor, programParamChange } from './voiceParams';

describe('padKeyFor (spec §5.4 pad key)', () => {
  it('builds the voice-pool pad key from a program id and pad index', () => {
    expect(padKeyFor('prog-1', 3)).toBe('prog-1:3');
  });
});

describe('programParamChange (spec §7.8 program-scope leaves)', () => {
  it('maps filter.cutoff to an absolute filter frequency', () => {
    const change = programParamChange('filter.cutoff', 2000);
    expect(change).toEqual({ target: 'filterFrequency', value: 2000 });
  });

  it('maps filter.resonance to filter Q', () => {
    expect(programParamChange('filter.resonance', 4)).toEqual({ target: 'filterQ', value: 4 });
  });

  it('maps pitch (semitones) to source detune in cents', () => {
    expect(programParamChange('pitch', 2)).toEqual({ target: 'detune', value: 200 });
    expect(programParamChange('pitch', -1.5)).toEqual({ target: 'detune', value: -150 });
  });

  it('routes amp and pan to the pad channel, not the voice', () => {
    // These are channel-strip concerns; applying them per voice would double-apply them
    // against the pad channel the voices already feed.
    expect(programParamChange('amp', 0.5)).toEqual({ target: 'channelLevel', value: 0.5 });
    expect(programParamChange('pan', -0.25)).toEqual({ target: 'channelPan', value: -0.25 });
  });

  it('maps the two §6 amp-envelope TIMES to the voice they shape (issue #143)', () => {
    // Both were registered, offered by the §8.5.2 lane selector and named among §10.3's
    // pad-mode defaults, and this function mapped neither — so a lane on either was inert
    // live and rendered as nothing at all.
    expect(programParamChange('amp.attack', 200)).toEqual({ target: 'ampAttack', value: 200 });
    expect(programParamChange('amp.release', 40)).toEqual({ target: 'ampRelease', value: 40 });
  });

  it('returns null for an unregistered leaf', () => {
    expect(programParamChange('wobble', 1)).toBeNull();
  });
});

describe('isPerVoiceTarget (spec §6, §7.8)', () => {
  it('counts an amp-envelope time as the voice’s, not the pad channel’s', () => {
    // An envelope time shapes the contour the voice's own amp gain carries (spec §6); the
    // pad channel below it holds only the §4.2 level and pan.
    expect(isPerVoiceTarget('ampAttack')).toBe(true);
    expect(isPerVoiceTarget('ampRelease')).toBe(true);
    expect(isPerVoiceTarget('channelLevel')).toBe(false);
  });
});
