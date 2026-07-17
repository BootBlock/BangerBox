# BangerBox — Phase Handover (after Phase 1 — Storage Foundation)

Generated at the close of Phase 1 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 1 merged to `main` (merge commit `447a459`). All §12 Phase 1 exit
criteria green inside the phase worktree before landing: 71 unit tests (repository
round-trips on the in-memory driver, migration engine, RPC bridge, multi-tab guard,
safeguards, UI seams), `test:e2e` 14/14 real-browser smoke — including the real-OPFS
project create/read round-trip, dev AND offline, plus the multi-tab guard — `lint`,
`type-check`, `verify`, `build`.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

1. Project name **BangerBox**; package `bangerbox`; "WEB-MPC" retired.
2. **npm** only; committed `package-lock.json`; Node ≥ 24 (`engines`).
3. **git** repository at project root; repo is public — no secrets, personal data, or
   real device identifiers.
4. **No Tone.js.** Bespoke 960 PPQN lookahead scheduler in a Web Worker (§7.1); audio
   graph directly on the Web Audio API; no audio-framework dependency.
5. **AssemblyScript** for WASM DSP (`asc`, `--runtime stub -O3`), behind the §5.6
   kernel seam; `vite-plugin-wasm` not required.
6. **`@sqlite.org/sqlite-wasm`**, worker-hosted, OPFS VFS. No wa-sqlite/sql.js/
   IndexedDB for primary data.
7. **Hand-rolled typed promise-based `postMessage` RPC** (no Comlink).
8. **`motion`** (import from `'motion/react'`) for animation.
9. **No router library** — 12 modes via `useUIStore.activeMode`.
10. **No component library**; bespoke primitives in `src/ui/primitives/`; icons
    **`lucide-react`** via `src/ui/icons.ts` only (registry still not created — first
    consumer creates it).
11. **Zod** for all runtime validation.
12. **fflate** (worker-side) for `.mpcweb`.
13. **Vitest** (unit, `happy-dom`) + **Playwright smoke on system Edge**
    (`channel: 'msedge'`, no browser download). Jest forbidden.
14. **Local-first hosting**: `npm run dev`/`preview` with COOP/COEP headers from the
    Vite server; GitHub Pages only if the human requests it later.
15. **Chromium ≥ 120 desktop Windows** baseline; capability gate enforces at startup.
16. **Zustand = runtime truth; SQLite = durable truth**; hydrate on load, debounced
    write-behind autosave.
17. **960 PPQN.**
18. Audio defaults: 48 000 Hz / 24-bit storage / Float32 processing /
    `latencyHint: 'interactive'`.
19. **BLE-MIDI only** for MIDI input in v1 (Web MIDI is roadmap).

## 2. Spec deviations / corrections in effect

- **§14 2026-07-17 (e) (from Phase 0, still awaiting human ratification):** worklet
  loading uses Vite's `?worker&url` import suffix (`import workletUrl from
  './x.worklet.ts?worker&url'` → `addModule(workletUrl)`) — the bare
  `new URL(...)` form inlines raw TS as a `data:` URL on Vite 8.
- **No new §2.7 corrections this phase.** All sqlite-wasm call forms were verified
  against the installed `index.d.mts` (3.53.0-build1) and match the pinned contract:
  `sqlite3InitModule()` → `new sqlite3.oo1.OpfsDb('/bangerbox.sqlite3', 'c')`,
  `selectObjects`, `db.changes(false, false)`,
  `capi.sqlite3_last_insert_rowid(db.pointer)` (bigint),
  `capi.sqlite3_js_db_export(db.pointer)`.
- **Service-worker lesson (empirical, encoded in `src/sw.ts`):** a worker's
  `self.location` comes from the **response** URL, so an `ignoreSearch` precache hit
  strips query strings — offline this removed `?vfs=opfs` from sqlite-wasm's OPFS
  async-proxy worker and broke the database. Cache hits whose URL differs from the
  request are re-wrapped in a fresh `Response` (empty `response.url` ⇒ browser falls
  back to the request URL). Never "simplify" this away.

## 3. Toolchain facts

- Installed majors: Vite 8.1.5, React 19, TypeScript 6, Tailwind 4, Zustand 5, Zod 4,
  motion 12, AssemblyScript 0.28, Vitest 4, Playwright 1.x, ESLint **9** (pinned:
  ESLint 10 conflicts with `eslint-plugin-jsx-a11y`; keep `eslint@^9` + `@eslint/js@^9`).
- `@sqlite.org/sqlite-wasm` 3.53.0-build1; types at `dist/index.d.mts`.
- `package.json` `config.phase` = **"1"** — bump each phase; `check:stubs` fails from
  phase ≥ 7 with open stubs.
- `node:sqlite` (`DatabaseSync`) powers the test-only in-memory driver on Node 25 —
  it emits an ExperimentalWarning in test output; harmless.
- Vitest: `pool: 'threads'`; excludes `**/.claude/worktrees/**`. tsconfig excludes
  `src/**/*.test.*`, `src/test/**` (which is why the Node-builtin test driver may
  live there), and `src/core/dsp/assembly/**`.
- Windows note: `git worktree remove` can fail with a locked cwd husk — remove the
  registration, then delete the directory from a fresh shell.

## 4. Established patterns (reuse, do not reinvent)

Everything from the Phase 0 handover still stands (capability gate, kernel seam,
worklet WASM transfer via `processorOptions`, `?worker&url` worklet loading, PWA
update flow, design tokens, enforcement scripts, smoke harness). New this phase:

- **Driver seam (§11.3):** `IDatabaseDriver` in `src/core/storage/driver.ts`
  (`query/queryOne/execute/transaction(statements[])/close`). Repositories depend on
  it exclusively; production injects `WorkerDatabaseDriver`, unit tests inject
  `createMemoryDriver()` from `src/test/drivers/memoryDriver.ts` (node:sqlite).
- **RPC bridge (`src/core/storage/rpc.ts`):** envelopes `{ id, request }` /
  `{ id, ok: true, result } | { id, ok: false, error: SerialisedDbError }`;
  Zod-guarded at both ends (`parseRequestEnvelope` in the worker,
  `parseResponseEnvelope` on the main thread); correlation by `crypto.randomUUID()`;
  `WorkerDatabaseDriver` takes an optional injectable `WorkerLike` for tests.
- **DB worker (`src/core/storage/db.worker.ts`):** single FIFO promise chain
  serialises every request (the §9.2 write queue); lazy boot via
  `sqliteBootstrap.ts` (`OpfsDb('/bangerbox.sqlite3', 'c')`, `PRAGMA foreign_keys =
  ON`, no fallback storage); request kinds `init | diagnostics | exportBinary |
  query | execute | transaction | close`.
- **Client (`src/core/storage/client.ts`):** module-singleton driver
  (`getDatabaseDriver()`), idempotent `bootDatabase()` (init → `runMigrations` →
  diagnostics; failed boot clears the cached promise for retry),
  `disposeDatabase()` for Safe Mode.
- **Migrations (`src/core/storage/migrations/`):** `PRAGMA user_version`-driven;
  contiguous versions from 1; each migration + its version bump runs in ONE
  transaction; `SCHEMA_TOO_NEW` refusal; v1 = `001-initial-schema.ts` carrying the
  §9.3 DDL verbatim. Never edit a shipped migration.
- **Error model (`src/core/storage/errors.ts`):** `DbError` with stable codes
  (SQLITE_* mapped from `resultCode`/`errcode`, OPFS_UNAVAILABLE, MULTI_TAB_LOCKED,
  SCHEMA_TOO_NEW, INIT_FAILED, TRANSACTION_FAILED, UNKNOWN), serialisable across the
  bridge (`toSerialised`/`fromSerialised`); British spelling throughout
  (`SerialisedDbError` — `check:lang` flags `serializ`).
- **OPFS wrapper (`src/core/storage/opfs.ts`):** canonical §9.1 path builders
  (`samplePath`, `bouncePath`, `globalLibraryPath`), `splitOpfsPath` validation (no
  traversal), `writeFileAtomic` (temp name + `move()` rename — §9.7), `readFile`,
  idempotent `deleteFile`/`deleteDirectory`, `purgeAllStorage()` (Safe Mode; dispose
  the DB first to release the SQLite lock).
- **Safeguards (`src/core/storage/safeguards.ts`):** `estimateStorage`,
  `isStoragePersisted`, `requestPersistentStorage` (first-run request at boot),
  `checkWriteHeadroom(bytes)` against `QUOTA_HARD_STOP_RATIO` (0.9, in the §2.6
  registry). Call `checkWriteHeadroom` before every future sample/bounce write.
- **Multi-tab guard (`src/core/platform/multiTabGuard.ts`):**
  `acquireDatabaseTabLock()` on Web Lock **`bangerbox-db`** (§9.7 binding name) with
  `ifAvailable` probe; blocked ⇒ `{ acquired: false, whenReleased }` drives
  `AlreadyOpenScreen`'s take-over button. Acquired in `main.tsx` BEFORE anything
  touches the database.
- **Boot order (`main.tsx`):** `detectCapabilities()` → (hard-missing ⇒
  `CapabilityGate`) → `acquireDatabaseTabLock()` → (blocked ⇒ `AlreadyOpenScreen`)
  → `ErrorBoundary(AppErrorFallback)` → `App`. The DB itself boots from
  `StoragePanel` on mount via `bootDatabase()`.
- **UI test seams:** components take `apiOverride` props (`StoragePanelApi`,
  `PwaUpdateApi`); shared fakes live in `src/test/fakes/` (never export helpers from
  a `.test` file — importing one re-registers its tests).

## 5. Repository catalogue (`src/core/storage/repositories/`)

`createRepositories(driver): Repositories` binds all nine. Rows are raw snake_case
table rows (§9.3); camelCase domain mapping belongs to Phase 2 hydration. All lists
that can grow are `Page<T>`-enveloped (`{ rows, limit, offset, hasMore }`), clamped
to `MAX_PAGE_SIZE`/`DEFAULT_PAGE_SIZE` = 200 (§9.2).

- `ProjectRepository`: `create(ProjectCreate)`, `getById`, `listRecent(page)`
  (modified_at DESC), `update(id, ProjectSettingsPatch)` (stamps modified_at),
  `touch(id, at?)`, `remove(id)`.
- `SequenceRepository`: `create`, `getById`, `listByProject(projectId, page)`
  (position ASC), `update(id, SequencePatch)` (`tempo: null` = follow project
  default), `remove`.
- `TrackRepository`: `create`, `getById`, `listBySequence(sequenceId, page)`,
  `update(id, TrackPatch)`, `remove`.
- `MidiEventRepository`: `insertMany(events)`, `listByTrack(trackId, page)`
  (tick_start ASC), `replaceTrack(trackId, events)` (atomic), `deleteMany(ids)`,
  `clearTrack(trackId)`.
- `AutomationRepository`: `insertMany(points)`, `listByOwner(scope, ownerId, page)`,
  `replaceTarget(scope, ownerId, targetPath, points)` (atomic lane replace),
  `deleteMany(ids)`, `clearOwner(scope, ownerId)` (no FK ties owner_id — call on
  sequence/track delete).
- `ProgramRepository`: `create`, `getById`, `listByProject(projectId, page)`,
  `update(id, { name?, payload? })`, `remove` (tracks' program_id → NULL via FK).
- `SampleRepository`: `create`, `getById`, `listByProject(projectId, page)`,
  `listGlobal(page)` (project_id IS NULL), `listByTag(tag, page)`,
  `setTags(sampleId, tags)` (atomic replace), `tagsFor(sampleId)`, `remove` (OPFS
  file removal is the caller's separate step).
- `SongRepository`: `listByProject(projectId)`, `replaceForProject(projectId,
  entries)` (positions restamped from array order — add/remove/reorder all reduce to
  this).
- `SettingsRepository`: `get(key)`, `set(key, value)` (upsert), `remove(key)`.

## 6. DDL snapshot

`PRAGMA user_version` = **1** = the §9.3 DDL verbatim (tables `projects`,
`sequences`, `programs`, `tracks`, `midi_events`, `automation_points`, `samples`,
`sample_tags`, `song_entries`, `app_settings` + the five §9.3 indexes). Source of
truth: `src/core/storage/migrations/001-initial-schema.ts` (never edit; append
migration v2+ for changes).

## 7. Worker / message protocol versions

- **DB worker RPC:** kinds `init`, `diagnostics`, `exportBinary`, `query`,
  `execute`, `transaction`, `close` (see §4 above). Extend by adding kinds to the
  `DbRequest` union + Zod schema + worker `dispatch` — never repurpose existing ones.
- **Worklet messages (Phase 0, unchanged):** `GainProofResultMessage
  { kind: 'proofResult', input, output }`, `KernelDisposeMessage { kind: 'dispose' }`.
- Scheduler worker (§7.1.3) does not exist yet — arrives Phase 4.

## 8. Component tree topography (as implemented)

```
main.tsx  (async bootstrap)
├─ detectCapabilities()                    (§2.1, before any render)
├─ [hard missing]  CapabilityGate
├─ acquireDatabaseTabLock()                (§9.7, before any DB access)
├─ [blocked]       AlreadyOpenScreen { whenReleased }
└─ [sole tab]      ErrorBoundary(AppErrorFallback = Safe Mode skeleton §8.1:
                   │                reload · .mpcweb export [stub] ·
                   │                exportBinary download · double-confirm hard reset)
                   └─ App { capabilities, pwaApiOverride?, storageApiOverride? }
                      ├─ header (wordmark + __APP_VERSION__)
                      ├─ soft-capability chip list
                      ├─ StoragePanel     (boots DB + migrations, persist request,
                      │                    usage readout, SQLite+OPFS self-test —
                      │                    STUB(phase-2), driven by the smoke)
                      ├─ EngineSelfTest   (STUB(phase-3) worklet/WASM proof)
                      └─ PwaUpdatePrompt
```

## 9. Kernel inventory

| Kernel | Source | Status |
| --- | --- | --- |
| `gainProof` | `src/core/dsp/assembly/gainProof.ts` → `src/core/dsp/dist/gainProof.wasm` (gitignored, rebuilt by `npm run build:wasm`) | Phase 0 pipeline proof; seam exemplar until real kernels (§5.6.4) in Phases 4–6 |

## 10. Stores

Not yet implemented — Phase 2 builds all eight §4.2 stores, undo, autosave,
hydration, and the sync-layer skeleton on top of this storage layer.

## 11. Open stubs / deliberate technical debt

- `// STUB(phase-2)` `src/core/platform/capabilities.ts` — freeze the report into
  `useUIStore.capabilities` once the store exists.
- `// STUB(phase-2)` `src/ui/StoragePanel.tsx` — superseded by real project
  load/hydrate + stores; the §9.7 eviction warning then moves into the proper toast
  queue.
- `// STUB(phase-3)` `src/ui/EngineSelfTest.tsx` — superseded by the real start gate
  + audio bootstrap (§5.1).
- `// STUB(phase-6)` `src/core/storage/opfs.ts` — worker sync-access-handle
  streaming arrives with the sample/looper pipelines. Until then `samplePath`/
  `bouncePath` have no production caller (accepted §3.4 exception: they are the
  §9.1 path contract, exercised by unit tests).
- `// STUB(phase-6)` `src/ui/AppErrorFallback.tsx` — "Export project (.mpcweb)"
  rescue action needs the §9.6 pack pipeline; renders disabled with a tooltip.
- Vite build still emits the harmless vite-plugin-pwa `inlineDynamicImports`
  deprecation warning (plugin-owned).

## 12. Verification commands (all green at handover)

`npm run dev` · `npm run build` · `npm run preview` · `npm test` (71) ·
`npm run test:e2e` (14/14) · `npm run lint` · `npm run type-check` · `npm run verify`
