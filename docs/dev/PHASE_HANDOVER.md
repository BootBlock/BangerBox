# BangerBox — Phase Handover (after Phase 2 — State & Undo)

Generated at the close of Phase 2 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 2 merged to `main` (merge commit `329a27e`). All §12 Phase 2 exit
criteria green inside the phase worktree before landing: **134 unit tests** (domain Zod
schemas accept/reject, undo core incl. gesture coalescing, autosave debounce with fake
timers, the eight stores' actions/clamping/transient-commit, sync-layer diff +
leak-free disposal, and the fixture-DB **hydration + autosave-persist round-trip**),
`test:e2e` **14/14** real-browser smoke — dev AND offline, now exercising the boot-time
project session (create/open + hydrate) on the real OPFS/worker path — plus `lint`,
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
    write-behind autosave. **(Now implemented — this is Phase 2's core.)**
17. **960 PPQN.**
18. Audio defaults: 48 000 Hz / 24-bit storage / Float32 processing /
    `latencyHint: 'interactive'`.
19. **BLE-MIDI only** for MIDI input in v1 (Web MIDI is roadmap).

## 2. Spec deviations / corrections in effect

- **§14 2026-07-17 (e) (from Phase 0, still awaiting human ratification):** worklet
  loading uses Vite's `?worker&url` import suffix. Unchanged.
- **No new §2.7 (Pinned API) corrections this phase.** Zustand 5 was used exactly as
  pinned — curried `create<T>()(subscribeWithSelector((set, get) => …))`, with
  `subscribeWithSelector` imported from `zustand/middleware`; the diff-based sync
  subscribers use `store.subscribe(selector, listener, opts)`. Zod 4 idioms verified
  against the installed package: `z.record(keySchema, valueSchema)`, `z.tuple([...])`,
  `z.enum([...] as const)`, `.loose()` for forward-compatible payloads,
  `z.discriminatedUnion('type', …)`.
- **Stub re-tag (recorded, not a spec change):** `src/ui/StoragePanel.tsx` carried a
  `STUB(phase-2)` ("superseded by real project load/hydrate + the §4.2 stores"). The
  state engine those words describe is now live (`src/core/project/session.ts` runs it
  at boot), but the diagnostic panel itself cannot be removed until the Browser/Main
  modes and the toast-queue eviction notice ship in Phase 7 — and the browser smoke
  still drives it as the storage proof. The tag is now `STUB(phase-7)` with that
  reason. The `STUB(phase-2)` in `capabilities.ts` is **resolved**: `main.tsx` freezes
  the report into `useUIStore.capabilities`.
- **Prettier is not a phase gate.** Several pre-existing Phase 0/1 files fail
  `prettier --check`; the repo enforces `eslint` (with `eslint-config-prettier`
  disabling conflicting rules), not prettier. New Phase 2 files were prettier-formatted.
  Note the `eslint` `curly` rule can conflict with prettier's wrapping — braced blocks
  are the stable fixed point.

## 3. Toolchain facts

- Installed majors unchanged: Vite 8.1.5, React 19, TypeScript 6, Tailwind 4,
  Zustand 5, Zod 4, motion 12, AssemblyScript 0.28, Vitest 4, Playwright 1.x,
  ESLint 9 (keep `eslint@^9` + `@eslint/js@^9` — 10 conflicts with jsx-a11y).
- **No new dependencies** — the §2.2 closed matrix is intact (`check:deps` green).
- `package.json` `config.phase` = **"2"** — bump each phase; `check:stubs` fails from
  phase ≥ 7 with open stubs.
- Vitest `pool: 'threads'`; excludes `**/.claude/worktrees/**`; tsconfig excludes
  `src/**/*.test.*`, `src/test/**`, `src/core/dsp/assembly/**`.
- Windows: `git worktree remove` succeeded cleanly this phase (no locked-cwd husk),
  run from the main checkout with the shell outside the worktree.

## 4. Established patterns (reuse, do not reinvent)

Everything from the Phase 0/1 handovers still stands (capability gate, kernel seam,
worklet WASM transfer, `?worker&url` worklet loading, PWA update flow, design tokens,
enforcement scripts, smoke harness, the storage layer §5–§6 below). New this phase:

- **Domain schemas (`src/core/project/schemas/`)** — leaf Zod modules + inferred
  domain types + `create*` default factories, shared by both store-action clamps and
  the load/import validation boundary (spec §6). `ranges.ts` is the single home for
  every numeric bound (used by `.min/.max` and by `clamp`). Never import a store from
  a schema module — schemas are leaves. `math.ts` (`clamp`/`clamp01`/`clampInt`) is the
  pure clamp seam. Note-division and effect-id string forms are pinned there.
- **Undo core (`src/store/undo/`)** — pure `CommandStack` (label/undo/redo closures
  capturing **minimal diffs**, `UNDO_LIMIT` cap, key-based coalescing + `endCoalescing`
  seal) wrapped by the reactive `useUndoStore`. Store commits go through
  `pushUndo`/`commit`. **Gesture coalescing is achieved by the transient/commit split**
  (many `setTransient` → one `commit` = one entry); the stack's `coalesceKey` is a
  secondary mechanism for flows that stream multiple commits.
- **Commit seam (`src/store/commit.ts`)** — `commit({label, apply, revert, dirtyKeys,
  coalesceKey?})` applies the change, records one undo entry, and marks entities dirty.
  Transient updates bypass it (plain `set`, still hitting the sync subscribers).
- **Autosave (`src/core/project/`)** — `AutosaveQueue` (pure debounce + per-entity
  coalescing over a caller `flush`; `flushNow` for `saveNow`/visibility; failed flushes
  re-queue and retry via a re-armed debounce, never spin; `onIdle` clears the unsaved
  dot). `dirty.ts` is the store-free bridge: `registerAutosave(queue, {onDirty})`,
  `markDirty(key)`, and the `dirtyKey` builders. `persist.ts` turns dirty keys into
  repository writes (upsert-or-delete for structural entities, atomic replace for
  events/automation/song), FK-ordered.
- **Hydration (`src/core/project/hydrate.ts` + `mappers.ts`)** — reads every row
  (paged), maps snake_case → camelCase, Zod-validates JSON blobs (program payloads,
  project payload, track mixer), and populates all stores DB→store. `parseTrackMixer`
  falls back to a default strip for the `'{}'` default.
- **Project lifecycle (`service.ts` + `projectService.ts` + `session.ts`)** — the
  store's lifecycle actions delegate to a **registered** `ProjectService`
  (`registerProjectService`), so the store imports no repositories.
  `startProjectSession()` (called once in `main.tsx`) boots the DB, opens/creates the
  active project, hydrates, registers the sync subscribers, and flushes autosave on
  `visibilitychange → hidden`.
- **Sync layer (`src/store/syncLayer/`)** — `registerSyncSubscribers(bridge?)` wires
  per-domain diff-based subscribers (narrow selectors) and returns **one disposer**
  that unwires all (leak-free). The `SyncBridge` interface is a **no-op** until Phase 3
  implements it over the real audio graph. Listeners wrap the bridge call so only the
  current value (not the `(value, previous)` pair) reaches it.

## 5. Repository catalogue (`src/core/storage/repositories/`) — unchanged from Phase 1

`createRepositories(driver): Repositories` binds all nine. Rows are raw snake_case
(§9.3); the camelCase mapping now lives in `core/project/mappers.ts`. All growable
lists are `Page<T>`-enveloped, clamped to `MAX_PAGE_SIZE`/`DEFAULT_PAGE_SIZE` = 200.
The **Create/Patch input types are now re-exported from the repositories index**
(`ProjectCreate`, `ProjectSettingsPatch`, `SequenceCreate`, `SequencePatch`,
`TrackCreate`, `TrackPatch`, `ProgramCreate`, `ProgramPatch`, `MidiEventCreate`,
`AutomationPointCreate`, `SampleCreate`, `SongEntryCreate`) for the persist layer.

- `ProjectRepository`: `create`, `getById`, `listRecent(page)`, `update(id, patch)`,
  `touch(id, at?)`, `remove(id)`.
- `SequenceRepository`: `create`, `getById`, `listByProject`, `update(id, patch)`
  (`tempo: null` = follow project default), `remove`.
- `TrackRepository`: `create`, `getById`, `listBySequence`, `update`, `remove`.
- `MidiEventRepository`: `insertMany`, `listByTrack`, `replaceTrack` (atomic),
  `deleteMany`, `clearTrack`.
- `AutomationRepository`: `insertMany`, `listByOwner(scope, ownerId, page)`,
  `replaceTarget(scope, ownerId, targetPath, points)` (atomic), `deleteMany`,
  `clearOwner`.
- `ProgramRepository`: `create`, `getById`, `listByProject`, `update({name?,payload?})`,
  `remove` (tracks' program_id → NULL).
- `SampleRepository`: `create`, `getById`, `listByProject`, `listGlobal`, `listByTag`,
  `setTags`, `tagsFor`, `remove`.
- `SongRepository`: `listByProject`, `replaceForProject` (positions restamped).
- `SettingsRepository`: `get`, `set` (upsert), `remove`.

## 6. DDL snapshot — unchanged

`PRAGMA user_version` = **1** = the §9.3 DDL verbatim (`projects`, `sequences`,
`programs`, `tracks`, `midi_events`, `automation_points`, `samples`, `sample_tags`,
`song_entries`, `app_settings` + the five §9.3 indexes). Source of truth:
`src/core/storage/migrations/001-initial-schema.ts` (never edit; append v2+). **No
migration was added in Phase 2** — the store model round-trips through the existing v1
schema (payloads/mixer as JSON blobs).

## 7. Worker / message protocol versions

- **DB worker RPC:** kinds `init`, `diagnostics`, `exportBinary`, `query`, `execute`,
  `transaction`, `close` — unchanged. Extend by adding kinds; never repurpose.
- **Worklet messages (Phase 0):** `GainProofResultMessage`, `KernelDisposeMessage`.
- **Scheduler worker (§7.1.3): still does not exist — arrives Phase 4.**
- **Sync-layer bridge (`src/store/syncLayer/bridge.ts`, new):** the `SyncBridge`
  interface — `setChannel{Level,Pan,Mute,Solo}`, `setTransport{Playing,Recording}`,
  `setBpm`, `onActiveProgramChanged`, `onQLinkModeChanged`. **No-op until Phase 3**
  implements it over the audio graph.

## 8. Stores (`src/store/`) — all eight implemented (§4.2)

Curried `create<T>()(subscribeWithSelector((set, get) => …))`, one file per slice.
Actions clamp inputs; commits go through the `commit` seam (undo + dirty). Field shapes
match §4.2 verbatim.

- **`useTransportStore`** — `isPlaying/isRecording/countInBars/metronomeEnabled/
  metronomeLevel/recordMode/playbackMode/activeSequenceId/bpm/swingAmount/swingDivision/
  loopEnabled/loopStartTick/loopEndTick/coarsePosition`; actions `play/stop/setRecording/
  setBpm/setSwing/setLoop/…`. Runtime-only — **not undoable, not autosaved** (§4.5).
- **`useProjectStore`** — `projectId/projectName/sampleRate/bitDepth/globalInsertLimit/
  modifiedSinceLastSave`; `applyProject` (hydration), settings setters (dirty-marking),
  and the delegated lifecycle actions `newProject/loadProject/saveNow/exportMpcweb/
  importMpcweb`.
- **`useSequenceStore`** — the **renamed `useTrackStore`** (§4.2): `sequences/tracks/
  events` (keyed by trackId, tick-sorted) `/automation` (keyed
  `${scope}:${ownerId}:${targetPath}`) `/songEntries`; `hydrate` + add/update/remove for
  sequences & tracks, `setTrackEvents/addEvents/removeEvents`, `setAutomationLane`,
  `setSongEntries` — all undoable + dirty. Track **mixer** state does NOT live here (it
  lives in `useMixerStore` under `track:<id>`).
- **`useProgramStore`** — `programs/activeProgramId/activePadId`; `setPrograms`,
  `addProgram/removeProgram/renameProgram`, `setActiveProgram/setActivePad`, the generic
  **`updateProgram(id, updater, label?)`** (the deep §6 editing seam for Phase 5), and
  `upsertPad/removePad`. Plain data only — no audio nodes.
- **`useMixerStore`** — `channels: Record<string, ChannelStrip>` keyed
  `'pad:<programId>:<padIndex>' | 'track:<id>' | 'return:0..3' | 'master'`. **The
  transient/commit channel lives here:** `setTransient(path, value)` /
  `commit(path, value)` where `path = '<channelId>.level|.pan|.sendLevels.<0-3>'`;
  gesture origins are held in a module-level `Map` (no re-renders). Plus
  `setMute/setSolo/addInsert/removeInsert/setInsertEnabled` and
  `mixerChannelDirtyKey(channelId)` (routes a strip to its owning entity's dirty key —
  track→track, pad→program, master/return→project payload). Hydration loads
  master + 4 returns + one strip per track; **pad strips are populated on program
  activation in Phase 3/5.**
- **`useUIStore`** — `activeMode` (the 12 modes, exported as `MODES`), `modal`,
  `dragDropPayload`, `theme`, `capabilities` (frozen at boot), `toasts` (queue, capped),
  `focusedControlParams` (Screen-mode Q-Link registry, §10.3). Runtime-only.
- **`useHardwareStore`** — `bleDeviceConnected/bleDeviceName/connectionState/qLinkMode/
  qLinkBindings/ccMappings`; connection setters, `setBindings` (hydrate),
  `upsertBinding/removeBinding` (undoable + dirty `settings:qlink:<mode>`), `setCcMapping`.
  BLE runtime is Phase 8.
- **`useBrowserStore`** — `currentPath/samples/tagFilter/textFilter/favourites/
  previewSampleId/previewPlaying`; view/cache store, runtime-only. Query-backed Browser
  UI + favourite persistence land in Phase 6.

**Undo:** `useUndoStore` (+ `pushUndo/endUndoGesture/clearUndoHistory`), UI exposure via
the `ProjectStatusBar` toolbar buttons and `Ctrl+Z`/`Ctrl+Y` (`useUndoKeyboard`).
`clearUndoHistory()` runs on project load.

## 9. Component tree topography (as implemented)

```
main.tsx  (async bootstrap)
├─ detectCapabilities()  →  useUIStore.setCapabilities()   (§2.1, before any render)
├─ [hard missing]  CapabilityGate
├─ acquireDatabaseTabLock()                                (§9.7, before any DB access)
├─ [blocked]       AlreadyOpenScreen { whenReleased }
└─ [sole tab]      ErrorBoundary(AppErrorFallback = Safe Mode §8.1)
                   │   └─ App { capabilities, pwaApiOverride?, storageApiOverride? }
                   │      ├─ header (wordmark + __APP_VERSION__)
                   │      ├─ soft-capability chip list
                   │      ├─ ProjectStatusBar  (store-driven: active project name,
                   │      │                      unsaved dot, undo/redo + Ctrl+Z/Y)
                   │      ├─ StoragePanel       (DB boot + self-test — STUB(phase-7),
                   │      │                      driven by the smoke)
                   │      ├─ EngineSelfTest     (STUB(phase-3) worklet/WASM proof)
                   │      ├─ PwaUpdatePrompt
                   │      └─ ToastViewport      (§4.2 toast queue)
                   └─ startProjectSession()  (fire-and-forget after render:
                        bootDatabase → loadOrCreateActiveProject → hydrateStores →
                        registerSyncSubscribers + visibility autosave)
```

## 10. Kernel inventory — unchanged

| Kernel | Source | Status |
| --- | --- | --- |
| `gainProof` | `src/core/dsp/assembly/gainProof.ts` → `dist/gainProof.wasm` (gitignored) | Phase 0 pipeline proof; seam exemplar until the §5.6.4 kernels in Phases 4–6 |

## 11. Open stubs / deliberate technical debt

- `// STUB(phase-3)` `src/ui/EngineSelfTest.tsx` — superseded by the real start gate +
  audio bootstrap (§5.1).
- `// STUB(phase-6)` `src/core/project/projectService.ts` (×2) — `exportMpcweb` /
  `importMpcweb` throw until the §9.6 `.mpcweb` pack/unpack pipeline exists.
- `// STUB(phase-6)` `src/core/storage/opfs.ts` — worker sync-access-handle streaming
  (sample/looper pipelines).
- `// STUB(phase-6)` `src/ui/AppErrorFallback.tsx` — "Export project (.mpcweb)" rescue
  needs the §9.6 pipeline; renders disabled.
- `// STUB(phase-7)` `src/ui/StoragePanel.tsx` — the state engine is live at boot; this
  diagnostic panel (and the §9.7 eviction warning it hosts) retires when the
  Browser/Main modes + toast-queue eviction notice ship in Phase 7.
- **Deferred wiring (not stubbed, by design):** the `SyncBridge` is a no-op until
  Phase 3; scheduler-worker event diffs from `useSequenceStore` mutations arrive in
  Phase 4; pad mixer strips populate on program activation (Phase 3/5); Q-Link binding
  persistence is minimal (one `app_settings` key per mode) pending Phase 8.
- Vite build still emits the harmless vite-plugin-pwa `inlineDynamicImports`
  deprecation warning (plugin-owned).

## 12. Verification commands (all green at handover, inside the phase worktree)

`npm run dev` · `npm run build` · `npm run preview` · `npm test` (**134**) ·
`npm run test:e2e` (**14/14**, dev + offline) · `npm run lint` · `npm run type-check` ·
`npm run verify`. (The main checkout has no `node_modules`; install before re-running.)
