/**
 * Q-Link binding persistence — spec §10.3 ("Bindings persist per mode in `app_settings`").
 *
 * Writing already happens through the ordinary autosave path: a binding edit commits with a
 * `settings:qlink:<mode>` dirty key and the flush serialises the store's bindings (spec
 * §4.4). This module is the read side and the mode-switch swap, so a Q-Link mode change
 * loads that mode's saved encoders — or clears them, which lets the mode's defaults apply
 * (spec §10.3).
 *
 * Stored payloads are Zod-validated on read (spec §1.3 #11): `app_settings` is durable data
 * that an older build (or a hand-edited database) may have written, so a bad row is dropped
 * rather than allowed to corrupt the store.
 */
import { z } from 'zod';
import { qLinkBindingSchema, type QLinkMode } from '@/core/project/schemas';
import { useHardwareStore } from '@/store';

/** `app_settings` key for a mode's bindings — the same key the autosave flush writes. */
export function qLinkSettingsKey(mode: QLinkMode): string {
  return `qlink:${mode}`;
}

const storedBindingsSchema = z.array(qLinkBindingSchema);

/** The read surface this module needs — the `SettingsRepository` satisfies it (spec §9.2). */
export interface SettingsReader {
  get: (key: string) => Promise<string | undefined>;
}

/**
 * Load the bindings saved for `mode` into the hardware store, replacing whatever the
 * previous mode had. An absent, unparseable, or invalid row leaves the store empty, which
 * is what makes {@link defaultBindingsForMode} apply (spec §10.3).
 */
export async function loadBindingsForMode(mode: QLinkMode, settings: SettingsReader): Promise<void> {
  let bindings: unknown = [];
  try {
    const raw = await settings.get(qLinkSettingsKey(mode));
    bindings = raw === undefined ? [] : JSON.parse(raw);
  } catch {
    // Unreadable row (bad JSON, storage error) — fall back to the mode's defaults.
    bindings = [];
  }
  const parsed = storedBindingsSchema.safeParse(bindings);
  useHardwareStore.getState().setBindings(parsed.success ? parsed.data : []);
}
