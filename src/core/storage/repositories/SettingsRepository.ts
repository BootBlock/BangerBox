/**
 * App-settings key/value persistence (spec §9.3 `app_settings` — e.g. per-mode
 * Q-Link bindings, spec §10.3).
 */
import { BaseRepository } from './base';

export class SettingsRepository extends BaseRepository {
  async get(key: string): Promise<string | undefined> {
    const row = await this.driver.queryOne<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = ?;',
      [key],
    );
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.driver.execute(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
      [key, value],
    );
  }

  async remove(key: string): Promise<void> {
    await this.driver.execute('DELETE FROM app_settings WHERE key = ?;', [key]);
  }
}
