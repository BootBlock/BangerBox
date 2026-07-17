import { describe, expect, it } from 'vitest';
import { computeEffectiveMutes } from './solo';

const strip = (mute = false, solo = false) => ({ mute, solo });

describe('solo-in-place computed mutes (spec §5.2)', () => {
  it('respects explicit mutes when nothing is soloed', () => {
    const result = computeEffectiveMutes({
      'track:1': strip(true),
      'track:2': strip(false),
      master: strip(false),
    });
    expect(result['track:1']).toBe(true);
    expect(result['track:2']).toBe(false);
    expect(result.master).toBe(false);
  });

  it('mutes every non-soloed pad/track while any is soloed', () => {
    const result = computeEffectiveMutes({
      'track:1': strip(false, true),
      'track:2': strip(false, false),
      'pad:p:0': strip(false, false),
    });
    expect(result['track:1']).toBe(false); // soloed → audible
    expect(result['track:2']).toBe(true); // not soloed → muted
    expect(result['pad:p:0']).toBe(true);
  });

  it('keeps master and returns audible so soloed sends still reach reverb', () => {
    const result = computeEffectiveMutes({
      'track:1': strip(false, true),
      master: strip(false, false),
      'return:0': strip(false, false),
    });
    expect(result.master).toBe(false);
    expect(result['return:0']).toBe(false);
  });

  it('still honours an explicit mute on a soloed channel', () => {
    const result = computeEffectiveMutes({ 'track:1': strip(true, true), 'track:2': strip(false, false) });
    expect(result['track:1']).toBe(true); // muted wins even though soloed
    expect(result['track:2']).toBe(true);
  });
});
