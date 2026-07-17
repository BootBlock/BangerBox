/**
 * Migration v1 — the binding v1 DDL, carried verbatim from spec §9.3.
 *
 * Never edit this migration once shipped: schema corrections ship as new,
 * higher-versioned migrations (spec §9.2).
 */
import type { Migration } from './migration';

export const initialSchema: Migration = {
  version: 1,
  name: 'initial-schema',
  statements: [
    // spec §9.3 — projects
    {
      sql: `CREATE TABLE projects (
  id            TEXT PRIMARY KEY,             -- crypto.randomUUID()
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,             -- Unix ms
  modified_at   INTEGER NOT NULL,
  sample_rate   INTEGER NOT NULL DEFAULT 48000,
  bit_depth     TEXT    NOT NULL DEFAULT '24' CHECK (bit_depth IN ('16','24','32f')),
  bpm_default   REAL    NOT NULL DEFAULT 120.0,
  insert_limit  INTEGER NOT NULL DEFAULT 4,
  payload       TEXT    NOT NULL DEFAULT '{}'  -- Zod-validated project extras (master strip, groove templates)
);`,
    },
    // spec §9.3 — sequences
    {
      sql: `CREATE TABLE sequences (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position              INTEGER NOT NULL,
  name                  TEXT NOT NULL,
  length_bars           INTEGER NOT NULL DEFAULT 2,
  time_sig_numerator    INTEGER NOT NULL DEFAULT 4,
  time_sig_denominator  INTEGER NOT NULL DEFAULT 4,
  tempo                 REAL,                  -- NULL = project bpm_default
  swing_amount          REAL    NOT NULL DEFAULT 50,
  swing_division        INTEGER NOT NULL DEFAULT 16
);`,
    },
    { sql: 'CREATE INDEX idx_sequences_project ON sequences(project_id, position);' },
    // spec §9.3 — programs
    {
      sql: `CREATE TABLE programs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('drum','keygroup')),
  payload     TEXT NOT NULL                    -- DrumProgram | KeygroupProgram JSON (§6)
);`,
    },
    // spec §9.3 — tracks
    {
      sql: `CREATE TABLE tracks (
  id           TEXT PRIMARY KEY,
  sequence_id  TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  program_id   TEXT REFERENCES programs(id) ON DELETE SET NULL,
  position     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('drum','keygroup','audio')),
  mixer        TEXT NOT NULL DEFAULT '{}'      -- ChannelStrip JSON (§4.2)
);`,
    },
    { sql: 'CREATE INDEX idx_tracks_sequence ON tracks(sequence_id, position);' },
    // spec §9.3 — midi_events
    {
      sql: `CREATE TABLE midi_events (
  id             TEXT PRIMARY KEY,
  track_id       TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  tick_start     INTEGER NOT NULL,             -- 960 PPQN
  duration_ticks INTEGER NOT NULL,
  note           INTEGER NOT NULL,             -- 0..127 (drum: pad index)
  velocity       INTEGER NOT NULL,             -- 1..127
  extra          TEXT                          -- reserved JSON (probability, provenance)
);`,
    },
    { sql: 'CREATE INDEX idx_midi_events_lookup ON midi_events(track_id, tick_start);' },
    // spec §9.3 — automation_points
    {
      sql: `CREATE TABLE automation_points (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('sequence','track')),
  owner_id    TEXT NOT NULL,
  target_path TEXT NOT NULL,                   -- §7.8 registry address
  tick        INTEGER NOT NULL,
  value       REAL NOT NULL,
  curve       TEXT NOT NULL DEFAULT 'linear' CHECK (curve IN ('step','linear','exp'))
);`,
    },
    { sql: 'CREATE INDEX idx_automation_lookup ON automation_points(owner_id, target_path, tick);' },
    // spec §9.3 — samples
    {
      sql: `CREATE TABLE samples (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global library
  name         TEXT NOT NULL,
  opfs_path    TEXT NOT NULL UNIQUE,
  frames       INTEGER NOT NULL,
  sample_rate  INTEGER NOT NULL,
  channels     INTEGER NOT NULL CHECK (channels IN (1,2)),
  root_note    INTEGER NOT NULL DEFAULT 60,
  created_at   INTEGER NOT NULL
);`,
    },
    // spec §9.3 — sample_tags
    {
      sql: `CREATE TABLE sample_tags (
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (sample_id, tag)
);`,
    },
    { sql: 'CREATE INDEX idx_sample_tags_tag ON sample_tags(tag);' },
    // spec §9.3 — song_entries
    {
      sql: `CREATE TABLE song_entries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  repeats     INTEGER NOT NULL DEFAULT 1
);`,
    },
    { sql: 'CREATE INDEX idx_song_entries ON song_entries(project_id, position);' },
    // spec §9.3 — app_settings
    { sql: 'CREATE TABLE app_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );' },
  ],
};
