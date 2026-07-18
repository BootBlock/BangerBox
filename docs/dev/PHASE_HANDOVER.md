# BangerBox — Phase Handover (after Phase 6 — Sample Pipeline & Heavy DSP)

Generated at the close of Phase 6 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 6 merged to `main` (`--no-ff`). All §12 Phase 6 exit criteria green inside the
phase worktree before landing: **426 unit tests** (the Phase 0–5 suites plus the Phase 6
additions — WAV codec golden bytes, `RingBuffer` invariants, sample-edit ops, chop maths, groove
extraction/bake, the five WASM kernel golden-output tests, the `.mpcweb` snapshot + remap + zip
round-trip, and mixdown), `test:e2e` **31/31** real-browser smoke — dev AND offline — now
including the Phase 6 proofs: **worklet WASM effects render** (multibandComp, limiter),
**sample pipeline** (import → transient chop ≥ 3 slices → time-stretch ≈ 2×), and **`.mpcweb`
export/import round-trip** — alongside every prior Phase 0–5 proof — plus `lint`, `type-check`,
`verify`, `build`.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

1. Project name **BangerBox**; package `bangerbox`; "WEB-MPC" retired.
2. **npm** only; committed `package-lock.json`; Node ≥ 24 (`engines`).
3. **git** at project root; repo is public — no secrets, personal data, or real device identifiers.
4. **No Tone.js.** Bespoke 960 PPQN lookahead scheduler in a **standard Web Worker** (`scheduler.worker.ts`).
5. **AssemblyScript** for WASM DSP (`asc`, `--runtime stub -O3 --use abort=`), behind the §5.6 kernel
   seam. **Phase 6 added the five §5.6.4 kernels** (see §10).
6. **`@sqlite.org/sqlite-wasm`**, worker-hosted, OPFS VFS.
7. **Hand-rolled typed promise-based `postMessage` RPC** (no Comlink); reused by the scheduler and the
   NEW `pack.worker` + `wavEncode.worker` clients.
8. **`motion`** (`'motion/react'`) for animation.
9. **No router** — 12 modes via `useUIStore.activeMode` (modes mounted as functional panels, §9).
10. **No component library**; bespoke primitives in `src/ui/primitives/` (added `WaveformCanvas`); icons
    `lucide-react` via `src/ui/icons.ts` only (registry still not created — panels use plain controls).
11. **Zod** for all runtime validation (incl. the `.mpcweb` manifest + snapshot schemas).
12. **fflate** (worker-side) for `.mpcweb` — **now live** (`pack.worker.ts`, `zipSync`/`unzipSync`).
13. **Vitest** (unit, `happy-dom`) + **Playwright smoke on system Edge** (`channel: 'msedge'`).
14. **Local-first hosting**: `npm run dev`/`preview` with COOP/COEP from the Vite server.
15. **Chromium ≥ 120 desktop Windows** baseline; capability gate enforces at startup.
16. **Zustand = runtime truth; SQLite = durable truth**; hydrate on load, debounced autosave.
17. **960 PPQN.**
18. Audio defaults: 48 000 Hz / 24-bit / Float32 / `latencyHint: 'interactive'`.
19. **BLE-MIDI only** for MIDI input in v1 (Phase 8).

## 2. Spec deviations / corrections in effect

- **§14 2026-07-17 (e) (Phase 0):** worklet loading via `?worker&url`. Unchanged.
- **§14 2026-07-17 (f) (Phase 4):** clock-sync absolute-epoch domain. Unchanged.
- **§14 2026-07-17 (g) (Phase 5):** `arp` scheduler kind; program-scope automation grammar. Unchanged.
- **§14 2026-07-18 (h) (Phase 6) — NEW (read the changelog for full detail):**
  - **`transientDetect` (§7.5), flagged for ratification:** energy-flux onset detector (per-frame energy
    of the first difference — a high-frequency-weighted spectral-energy flux WITHOUT a full FFT) with an
    adaptive local-mean threshold, min-spacing, and sub-hop refinement — not a literal FFT spectral flux.
    The seam + the transient-chop accuracy fixture are met; an FFT upgrade stays swappable (§1.3 #5).
  - **`reverb` Phase 6+ engine (§5.7):** the `reverb` insert uses the **`fdnReverb` worklet** when the
    kernel modules are loaded (start gate / offline prepare); the native `ConvolverNode` remains the
    fallback when they are not (e.g. unit tests without the gate). No effect ID changed.
  - **`granularStretch` (§5.7.9):** WSOLA (resample-by-pitch-ratio, then correlation-aligned OLA
    time-stretch) → independent time/pitch. Phase-vocoder remains roadmap.
  - **DSP-effect worklet params** apply directly in the kernel (the §4.3 dezipper is native-`AudioParam`
    only); the limiter reports its 1.5 ms lookahead as PDC latency (§5.7.3).
  - **Functional (unpolished) Phase 6 UI**, mirroring Phase 5's Program Edit. `.mpcweb` import **always**
    remaps every UUID (not only on collision). OPFS writes use `writeFileAtomic` (main-thread atomic
    temp-then-rename); a worker sync-access-handle streaming path is a Phase 7 perf refinement.

## 3. Toolchain facts

- Installed majors unchanged (Vite 8.1.5, React 19, TS 6, Tailwind 4, Zustand 5, Zod 4,
  AssemblyScript 0.28, Vitest 4, Playwright 1.x, ESLint 9). **No new dependencies** — the §2.2 closed
  matrix is intact (fflate was already listed).
- `package.json` `config.phase` = **"6"**.
- **`npm run build:wasm` now builds six kernels** (`gainProof` + the five §5.6.4 kernels); artefacts under
  `src/core/dsp/dist/` (gitignored; built on demand by the unit/e2e harness).
- **New smoke fast path:** `npm run test:e2e:quick` (`--dev-only`) runs only the dev-server section
  (skips the production `vite build` + offline reload) for iteration; the full `test:e2e` (dev + offline)
  stays the binding phase-exit proof.
- **BigInt lesson (important):** `@sqlite.org/sqlite-wasm` returns INTEGER columns as **BigInt**. Coerce
  with `Number(...)` before arithmetic, and never `JSON.stringify` a raw row (BigInt throws) — the
  `.mpcweb` serialiser uses a BigInt→Number replacer; `db.worker` already `Number(...)`s the rowid.
- Windows worktree-removal trap unchanged: kill stray `node`/`msedge`, `git worktree prune`, then
  `Remove-Item -Recurse -Force`. Full smoke ~15–20 min (double build + Edge); use `--dev-only` (~3–6 min)
  while iterating.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–5 still stands. New this phase:

**Pure logic (dependency-free, unit-tested — spec §2.5):**
- **`core/audio/wav.ts`** — `encodeWav(channels, rate, bitDepth)` / `decodeWav(bytes)`; canonical
  16/24-bit PCM + 32-bit IEEE-float WAV. THE codec for import/looper/bounce/`.mpcweb`.
- **`core/dsp/ringBuffer.ts`** — `RingBuffer` (SPSC lock-free, `Atomics`, one reserved slot); `.create(slots)`
  / `push` / `pull` / `availableToRead|Write`. Consumed by the Looper recorder worklet.
- **`core/audio/sampleEdit.ts`** — `normalise` / `reverse` / `fadeIn` / `fadeOut` / `trim` / `peakOf`
  (non-destructive; return fresh channels).
- **`core/audio/chop.ts`** — `equalSlices` / `slicesFromMarkers` / **`slicesFromOnsets`** (regions START at
  each transient) / `enforceMinSpacing`. `SliceRegion = { startFrame, endFrame }`.
- **`core/sequencer/groove.ts`** — `grooveFromTransients` / `grooveShiftAtTick` / `applyGrooveToEvents`;
  `GrooveTemplate`. Schedule-time application (like swing) is Phase 7; the destructive bake is live.

**WASM kernel seam (spec §5.6):**
- **`core/dsp/kernelBase.ts`** — `StreamingKernel<TExports>` base: owns I/O memory views, `process`,
  `destroy`; `StreamingKernel.allocate(...)`. Streaming kernels (limiter, multiband, reverb) extend it.
- **`core/dsp/kernelModules.ts`** — main-thread compile + cache of the worklet-hosted kernel modules
  (`multibandComp`/`limiter`/`fdnReverb`); `loadKernelModules()` (start gate) + `getKernelModule(name)`.
- Per-kernel wrappers mirror `gainProofKernel.ts`; analysis kernels (`transientDetect`) and offline-render
  kernels (`granularStretch`) are bespoke (not `StreamingKernel`).

**Worklet-hosted WASM effects (spec §5.6.2 / §5.7):**
- **`core/audio/worklets/dspEffect.worklet.ts`** (`registerProcessor('dsp-effect')`) hosts one kernel per
  channel; protocol in **`dspEffectProtocol.ts`** (`{module, kernel, maxBlock, params}` via
  `processorOptions`; `{kind:'param'|'dispose'}` over the port).
- **`inserts/effects.ts`**: `buildEffectCore` routes `multibandComp`/`limiter`/`reverb` to
  `buildWorkletEffect` when `getKernelModule(kernel)` is loaded; else native/passthrough. Limiter reports
  latency for PDC. `effectParams.ts` gained ranges + defaults for `multibandComp`/`limiter`.
- **`context.ts`**: `loadAudioWorklets` now also loads the `dsp-effect` + `looper-recorder` worklets and
  `loadKernelModules()`; **`prepareWorkletEffects(context)`** registers them on an offline context (used by
  `renderEffectOffline` — spec §11.2).

**Sample pipeline (spec §9.4):**
- **`core/audio/sampleImport.ts`** — `mixdownToStereo` / `planarChannels` (pure); `encodeWavInWorker`
  (transfers buffers to `wavEncode.worker.ts`); **`saveChannelsAsSample`** (the SHARED write path for
  import/edit/looper — captures `frames` BEFORE the encode transfer detaches the buffers); `importDecodedSample`
  / `importAudioFile`.
- **`core/audio/sampleEditService.ts`** — `readSampleChannels`, `applyEditToNewSample`,
  `stretchSampleToNewSample` (granularStretch), `chopSampleToNewSamples` (transientDetect → `slicesFromOnsets`).
- **`core/audio/grooveService.ts`** — `extractGrooveFromSample` / `extractAndBakeGroove`.
- **`core/audio/bounceService.ts`** — `bounceActiveSequence` (offline render of resolved voices → `/bounces/`).
- **`core/audio/looper.ts`** — `Looper` (recorder worklet → RingBuffer drain → `saveChannelsAsSample`);
  **`recorder.worklet.ts`** (`looper-recorder`). `AudioEngine.createLooper()` / `auditionSample(path)`.

**Interchange (spec §9.6):**
- **`core/project/mpcweb.ts`** — Zod manifest + snapshot schemas; `serialiseSnapshot` (BigInt→Number replacer)
  / `parseSnapshot` / `buildManifest` / `parseManifest` (rejects unknown formatVersion) / **`remapSnapshot`**
  (regenerate all UUIDs via whole-JSON id replacement; returns `sampleIdMap`).
- **`core/project/mpcwebZip.ts`** — `packMpcweb` / `unpackMpcweb` (fflate). **`pack.worker.ts`** + **`packClient.ts`**
  (`packMpcwebInWorker` / `unpackMpcwebInWorker`).
- **`core/project/snapshotService.ts`** — `dumpSnapshot` / `restoreSnapshot` (drains repo pages; FK-ordered inserts).
- **`projectService.ts`**: `exportMpcweb` / `importMpcweb` live; **`getActiveRepositories()`** exposed for the modes.

## 5. Repository catalogue — unchanged from Phase 1/2.
No repository or DDL change in Phase 6. `SampleRepository` (`create`/`getById`/`listByProject`/`listGlobal`/
`listByTag`/`setTags`/`tagsFor`/`remove`) backs the sample pipeline; the `.mpcweb` dump/restore uses the
existing `listByProject`/`listBySequence`/`listByTrack`/`listByOwner` reads and the `create`/`insertMany`
writes. **Note:** raw rows carry BigInt integer fields from the live DB (coerce with `Number`).

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1** = the §9.3 DDL verbatim
(`src/core/storage/migrations/001-initial-schema.ts`). **No migration added in Phase 6** — samples persist in
the existing `samples` + `sample_tags` tables; bounces are OPFS `/bounces/` files (not table rows).

## 7. Worker / worklet / message protocol versions

- **DB worker RPC:** unchanged.
- **Worklets:** `meter-tap` (Phase 3), `gain-proof` (Phase 0), **NEW `dsp-effect`** (hosts multibandComp/
  limiter/fdnReverb, module via `processorOptions`), **NEW `looper-recorder`** (master → RingBuffer).
- **Scheduler worker:** `SCHEDULER_PROTOCOL_VERSION = 1` (unchanged; no Phase 6 change).
- **NEW workers:** `pack.worker` (`.mpcweb` zip pack/unpack) + `wavEncode.worker` (WAV encode) — each a thin
  shell over pure functions, with a correlation-id promise client.
- **Sync-layer bridge (`audioBridge.ts`):** `applyAutomation` program-param application still `STUB(phase-7)`.

## 8. Stores — all eight implemented (§4.2), shapes unchanged.
`useBrowserStore` is now populated live (`refreshSamples` → `setSamples`). No store interface changed.

## 9. Component tree topography (as implemented — panels, not the polished 12-mode rail; Phase 7)

```
App → header · soft-capability chips · ProjectStatusBar · StoragePanel · AudioEnginePanel ·
      ProgramEditPanel · SampleEditPanel · LooperPanel · BrowserPanel
SampleEditPanel  → import · sample list · WaveformCanvas · tools (Normalise/Reverse/Fade/Trim/
                   Chop/Groove-bake/Time-stretch) — each renders a new sample
LooperPanel      → Record / Stop&save → engine.createLooper() → RingBuffer → new sample
BrowserPanel     → Export/Import .mpcweb · Bounce sequence · Purge unused · audition list
AppErrorFallback → Safe Mode: Export .mpcweb (now live) · Download .sqlite · Hard reset
```

## 10. Kernel inventory — **the §5.6.4 set is now complete** (all built by `build:wasm`, golden-tested):
- `gainProof` (Phase 0 exemplar).
- **`lookaheadLimiter`** — brickwall limiter, 1.5 ms lookahead reported as PDC latency (streaming).
- **`multibandComp`** — 3-band compressor, complementary one-pole crossovers (unity = passthrough) (streaming).
- **`fdnReverb`** — feedback delay network (4 lines, Hadamard mix, damping, pre-delay) (streaming; the reverb
  Phase 6+ engine).
- **`transientDetect`** — energy-flux onset detector (analysis kernel: `analyse` → `onsetAt`/`count`).
- **`granularStretch`** — WSOLA independent time/pitch (offline-render kernel: `render`).

## 11. Open stubs / deliberate technical debt

`check:stubs` reports **3** open stubs (all `phase-7`; none block Phase 6):
- `// STUB(phase-7)` `src/core/audio/audioBridge.ts` — per-voice program-parameter automation application (§6/§7.8).
- `// STUB(phase-7)` `src/core/storage/opfs.ts` — worker sync-access-handle streaming (throughput refinement).
- `// STUB(phase-7)` `src/ui/StoragePanel.tsx` — diagnostic panel.

**Deferred wiring (not stubbed, by design) — Phase 7 targets:**
- **Groove schedule-time application** (non-destructive, like swing) — the extract + destructive bake are live;
  the swing-style apply-at-schedule path is Phase 7 (Grid editor).
- **Looper:** mic source + bar-locked/tempo-synced length + overdub + live meter ring (master-resample mono
  capture is live).
- **Bounce:** the full insert/mixer graph in the offline render (resolved-voice bounce is live); bounce-song /
  bounce-track / resample-to-pad variants.
- **Sample Edit:** deep canvas tooling (draggable trim/markers), worker-computed waveform peak-pyramid cache
  (§8.5.4) — peaks are drawn directly now.
- **Browser:** folder tree, tag chips, favourites persistence, waveform micro-preview, drag-to-pad assignment
  (import/list/audition/export-import/purge/bounce are live).
- **`transientDetect`:** FFT spectral-flux upgrade behind the seam.
- Prior Phase 3/4/5 deferrals (playhead canvas rendering, per-voice program automation, LFO worklet /
  tempo-synced LFO, pad-mixer live editing → graph, Mixer-mode strips) still stand.

## 12. Verification commands (all green at handover, inside the phase worktree)
`npm run dev` · `build` · `preview` · `test` (**426**) · `test:e2e` (**31/31**, dev + offline — worklet WASM
effects, sample pipeline import/chop/stretch, `.mpcweb` round-trip, plus every Phase 0–5 proof) ·
`test:e2e:quick` (dev-only fast path) · `lint` · `type-check` · `verify`.
(The main checkout has no `node_modules`; `npm install` before re-running.)
