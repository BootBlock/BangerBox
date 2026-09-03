import { describe, expect, it } from 'vitest';
import * as constants from './constants';

// Drift guard: the engine constants registry is binding (spec §2.6, naming freeze
// §13.6). Any change here must be a deliberate spec §14 changelog entry.
describe('engine constants registry (spec §2.6)', () => {
  it('carries exactly the binding values', () => {
    expect(constants.PPQN).toBe(960);
    expect(constants.LOOKAHEAD_MS).toBe(100);
    expect(constants.SCHEDULER_INTERVAL_MS).toBe(25);
    expect(constants.CLOCK_SYNC_INTERVAL_MS).toBe(250);
    expect(constants.VOICE_STEAL_FADE_MS).toBe(5);
    expect(constants.CHOKE_FADE_MS).toBe(20);
    expect(constants.DECLICK_FADE_MS).toBe(3);
    expect(constants.PARAM_RAMP_MS).toBe(10);
    expect(constants.MAX_VOICES).toBe(64);
    expect(constants.AUTOSAVE_DEBOUNCE_MS).toBe(2000);
    expect(constants.CC_THROTTLE_MS).toBe(16);
    expect(constants.UNDO_LIMIT).toBe(100);
    // Storage quota hard-stop (spec §9.7) — added to the registry in Phase 1
    // because §2.6 mandates all behaviour constants live here.
    expect(constants.QUOTA_HARD_STOP_RATIO).toBe(0.9);
    // Automation capture thinning (spec §7.8) — see §14 2026-09-02 (ah).
    expect(constants.AUTOMATION_MIN_TICK_SPACING).toBe(120);
    expect(constants.AUTOMATION_VALUE_EPSILON).toBe(0.005);
    // Storage recoverable-failure policy (spec §9.2) — see §14 2026-09-03 (aj), issue #98.
    expect(constants.STORAGE_RETRY_ATTEMPTS).toBe(3);
    expect(constants.STORAGE_RETRY_BASE_DELAY_MS).toBe(25);
    // Bounded `.mpcweb` decompression (spec §9.6, §9.7) — issue #26.
    expect(constants.MPCWEB_MAX_ENTRIES).toBe(4096);
    expect(constants.MPCWEB_MAX_ENTRY_BYTES).toBe(256 * 1024 * 1024);
    expect(constants.MPCWEB_MAX_TOTAL_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('exports no constants beyond the §2.6 registry (naming freeze)', () => {
    expect(Object.keys(constants).sort()).toEqual(
      [
        'PPQN',
        'LOOKAHEAD_MS',
        'SCHEDULER_INTERVAL_MS',
        'CLOCK_SYNC_INTERVAL_MS',
        'VOICE_STEAL_FADE_MS',
        'CHOKE_FADE_MS',
        'DECLICK_FADE_MS', // spec §5.4, changelog 2026-07-18 (t)
        'PARAM_RAMP_MS',
        'MAX_VOICES',
        'AUTOSAVE_DEBOUNCE_MS',
        'CC_THROTTLE_MS',
        'UNDO_LIMIT',
        'QUOTA_HARD_STOP_RATIO', // spec §9.7
        'AUTOMATION_MIN_TICK_SPACING', // spec §7.8, changelog 2026-09-02 (ah)
        'AUTOMATION_VALUE_EPSILON', // spec §7.8, changelog 2026-09-02 (ah)
        'STORAGE_RETRY_ATTEMPTS', // spec §9.2, changelog 2026-09-03 (aj)
        'STORAGE_RETRY_BASE_DELAY_MS', // spec §9.2, changelog 2026-09-03 (aj)
        'MPCWEB_MAX_ENTRIES', // spec §9.6/§9.7, changelog 2026-09-03 (aj)
        'MPCWEB_MAX_ENTRY_BYTES', // spec §9.6/§9.7, changelog 2026-09-03 (aj)
        'MPCWEB_MAX_TOTAL_BYTES', // spec §9.6/§9.7, changelog 2026-09-03 (aj)
      ].sort(),
    );
  });
});
