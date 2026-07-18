/**
 * Q-Link binding persistence — spec §10.3: "Bindings persist per mode in `app_settings`".
 * Writing is the autosave path's job (a `settings:qlink:<mode>` dirty key, spec §4.4);
 * this covers the read side and the mode-switch swap, which is what makes the persistence
 * round-trip rather than one-way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QLinkBinding } from '@/core/project/schemas';
import { useHardwareStore } from '@/store';
import { qLinkSettingsKey, loadBindingsForMode } from './qlinkBindings';

function binding(patch: Partial<QLinkBinding> = {}): QLinkBinding {
  return {
    encoderIndex: 0,
    cc: 70,
    targetStore: 'mixer',
    targetParameterPath: 'mixer.master.level',
    minValue: 0,
    maxValue: 1,
    curve: 'linear',
    mode: 'absolute',
    ...patch,
  };
}

/** A settings repository stub standing in for the DB worker (spec §11.3). */
function settingsStub(rows: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => rows[key]),
    set: vi.fn(async (key: string, value: string) => void (rows[key] = value)),
    remove: vi.fn(async (key: string) => void delete rows[key]),
    rows,
  };
}

describe('binding persistence (spec §10.3)', () => {
  beforeEach(() => {
    useHardwareStore.getState().setBindings([]);
  });

  it('keys settings per Q-Link mode', () => {
    expect(qLinkSettingsKey('pad')).toBe('qlink:pad');
    expect(qLinkSettingsKey('screen')).toBe('qlink:screen');
  });

  it('loads stored bindings into the hardware store', async () => {
    const settings = settingsStub({ 'qlink:pad': JSON.stringify([binding({ cc: 77 })]) });
    await loadBindingsForMode('pad', settings);
    expect(useHardwareStore.getState().qLinkBindings).toEqual([binding({ cc: 77 })]);
  });

  it('clears the bindings when a mode has none stored, so its defaults apply', async () => {
    useHardwareStore.getState().setBindings([binding()]);
    await loadBindingsForMode('project', settingsStub());
    expect(useHardwareStore.getState().qLinkBindings).toEqual([]);
  });

  it('rejects a malformed stored payload rather than corrupting the store (spec §1.3 #11)', async () => {
    const settings = settingsStub({ 'qlink:pad': '{"not":"an array"}' });
    await loadBindingsForMode('pad', settings);
    expect(useHardwareStore.getState().qLinkBindings).toEqual([]);
  });

  it('rejects a binding that fails the schema', async () => {
    const settings = settingsStub({
      'qlink:pad': JSON.stringify([{ ...binding(), encoderIndex: 99 }]),
    });
    await loadBindingsForMode('pad', settings);
    expect(useHardwareStore.getState().qLinkBindings).toEqual([]);
  });

  it('survives unparseable JSON', async () => {
    const settings = settingsStub({ 'qlink:pad': 'not json at all' });
    await expect(loadBindingsForMode('pad', settings)).resolves.toBeUndefined();
    expect(useHardwareStore.getState().qLinkBindings).toEqual([]);
  });

  it('reads the row for the requested mode only', async () => {
    const settings = settingsStub({ 'qlink:pad': JSON.stringify([binding()]) });
    await loadBindingsForMode('project', settings);
    expect(settings.get).toHaveBeenCalledWith('qlink:project');
    expect(useHardwareStore.getState().qLinkBindings).toEqual([]);
  });
});
