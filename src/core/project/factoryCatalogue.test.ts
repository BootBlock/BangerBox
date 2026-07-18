/** Factory catalogue schema (spec §9.8) — accept/reject fixtures per §11.1. */
import { describe, expect, it } from 'vitest';
import { parseFactoryCatalogue } from './factoryCatalogue';

const validPack = {
  id: 'kit-808',
  title: '808 Kit',
  kind: 'kit',
  file: 'kit-808.mpcweb',
  bytes: 123_456,
  description: 'Deep sub kicks and metallic hats.',
};

describe('factory catalogue schema (spec §9.8)', () => {
  it('accepts a well-formed catalogue', () => {
    const packs = parseFactoryCatalogue([validPack, { ...validPack, id: 'demo-a', kind: 'demo' }]);
    expect(packs).toHaveLength(2);
    expect(packs[0]!.kind).toBe('kit');
  });

  it('accepts an empty catalogue', () => {
    expect(parseFactoryCatalogue([])).toEqual([]);
  });

  it('rejects an unknown pack kind', () => {
    expect(() => parseFactoryCatalogue([{ ...validPack, kind: 'preset' }])).toThrow();
  });

  it('rejects duplicate pack ids', () => {
    expect(() => parseFactoryCatalogue([validPack, validPack])).toThrow(/duplicate pack ids/i);
  });

  it('rejects a non-array body', () => {
    expect(() => parseFactoryCatalogue({ packs: [validPack] })).toThrow();
  });

  // The catalogue is fetched from the network, so `file` is attacker-shaped input as far as
  // the fetch URL is concerned: a bare filename is the only accepted form (spec §9.8).
  it.each(['../../etc/passwd.mpcweb', '/absolute/kit.mpcweb', 'nested/kit.mpcweb', 'kit-808.zip'])(
    'rejects the unsafe pack filename %s',
    (file) => {
      expect(() => parseFactoryCatalogue([{ ...validPack, file }])).toThrow();
    },
  );

  it('rejects a negative byte count', () => {
    expect(() => parseFactoryCatalogue([{ ...validPack, bytes: -1 }])).toThrow();
  });
});
