# BangerBox — Phase Handover (after Phase 3 — Audio Core)

Generated at the close of Phase 3 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 3 merged to `main` (merge commit `d33547d`). All §12 Phase 3 exit
criteria green inside the phase worktree before landing: **199 unit tests** (Phase 0–2
suites plus the Phase 3 audio maths, factory/graph lifecycle + leak-free teardown,
insert wrapper + native effect params/DSP generators, voice steal/choke policy + pool,
metering slot registry, metronome/preview, solo-in-place, and the real bridge),
`test:e2e` **20/20** real-browser smoke — dev AND offline — now driving the audio engine
end to end: start gate → audible pad hit tracked by the master meter → leak-free
create/destroy churn (§5.3) → **OfflineAudioContext effect assertions (§11.2)** — plus
`lint`, `type-check`, `verify`, `build`.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

1. Project name **BangerBox**; package `bangerbox`; "WEB-MPC" retired.
2. **npm** only; committed `package-lock.json`; Node ≥ 24 (`engines`).
3. **git** at project root; repo is public — no secrets, personal data, or real device
   identifiers.
4. **No Tone.js.** Bespoke 960 PPQN lookahead scheduler in a Web Worker (§7.1, arrives
   Phase 4); the audio graph is built directly on the Web Audio API (**now live** — §5).
5. **AssemblyScript** for WASM DSP (`asc`, `--runtime stub -O3`), behind the §5.6 kernel
   seam. Phase 3's effects are **native** Web Audio nodes; WASM kernels arrive Phase 6.
6. **`@sqlite.org/sqlite-wasm`**, worker-hosted, OPFS VFS.
7. **Hand-rolled typed promise-based `postMessage` RPC** (no Comlink).
8. **`motion`** (`'motion/react'`) for animation.
9. **No router** — 12 modes via `useUIStore.activeMode`.
10. **No component library**; bespoke primitives in `src/ui/primitives/`; icons
    **`lucide-react`** via `src/ui/icons.ts` only (registry still not created — first
    consumer creates it).
11. **Zod** for all runtime validation.
12. **fflate** (worker-side) for `.mpcweb` (Phase 6).
13. **Vitest** (unit, `happy-dom`) + **Playwright smoke on system Edge**
    (`channel: 'msedge'`). Jest forbidden.
14. **Local-first hosting**: `npm run dev`/`preview` with COOP/COEP from the Vite server.
15. **Chromium ≥ 120 desktop Windows** baseline; capability gate enforces at startup.
16. **Zustand = runtime truth; SQLite = durable truth**; hydrate on load, debounced
    write-behind autosave (Phase 2). The **sync layer now drives a real audio graph**.
17. **960 PPQN.**
18. Audio defaults: 48 000 Hz / 24-bit storage / Float32 processing /
    `latencyHint: 'interactive'` (**the AudioContext is now created this way, §5.1**).
19. **BLE-MIDI only** for MIDI input in v1 (Phase 8).

## 2. Spec deviations / corrections in effect

- **§14 2026-07-17 (e) (Phase 0, awaiting human ratification):** worklet loading uses
  Vite's `?worker&url` import suffix. Unchanged — the new `meterTap.worklet.ts` loads
  this way (`src/core/audio/context.ts`).
- **No new §2.7 (Pinned API) corrections this phase.** Web Audio was used against the
  installed `lib.dom` types: `StereoPannerNode` for equal-power pan, `BiquadFilterNode`,
  `DelayNode`, `DynamicsCompressorNode`, `WaveShaperNode` (`oversample: '4x'`),
  `ConvolverNode`, `AudioBufferSourceNode`, `AudioWorkletNode` (meter tap), and
  `OfflineAudioContext` (offline effect renders). `Float32Array` is now generic over its
  buffer in TS 6 — DSP generators are typed `Float32Array<ArrayBuffer>` so they assign to
  `WaveShaperNode.curve` / `AudioBuffer` channels.
- **Fader law defined (§8.5.6).** The 0..1.2 strip `level` maps to gain by a single pure
  function (`src/core/audio/params/faderLaw.ts`): unity (0 dB) at 1.0, +6 dB at 1.2,
  linear-in-dB to a −60 dB floor, true silence at 0. Isolated + unit-tested; swappable.
- **`SyncBridge` extended (implementation, not a spec name).** Added `setChannelSend` and
  `setChannelInserts` so send/insert edits reach the graph; `mixerSync` forwards them
  diff-based. Transport methods (`setTransportPlaying/Recording`, `setBpm`) and
  `onActiveProgramChanged`/`onQLinkModeChanged` are wired but **no-op for audio** until
  the scheduler (Phase 4), pad mixer-strip population (Phase 5), and Q-Link (Phase 8).
- **`check:lang` allowlist:** added `ConvolverNode.normalize` (platform-fixed API name,
  like `AnalyserNode`).
- **Prettier is not a phase gate** (unchanged); new Phase 3 files were prettier-clean.

## 3. Toolchain facts

- Installed majors unchanged: Vite 8.1.5, React 19, TypeScript 6, Tailwind 4, Zustand 5,
  Zod 4, motion 12, AssemblyScript 0.28, Vitest 4, Playwright 1.x, ESLint 9 (keep
  `eslint@^9` + `@eslint/js@^9`).
- **No new dependencies** — the §2.2 closed matrix is intact (`check:deps` green). The
  entire audio engine is built on native Web Audio + the existing dependency surface.
- `package.json` `config.phase` = **"3"** — bump each phase; `check:stubs` fails from
  phase ≥ 7 with open stubs.
- Vitest `pool: 'threads'`; excludes `**/.claude/worktrees/**`; tsconfig excludes
  `src/**/*.test.*`, `src/test/**`, `src/core/dsp/assembly/**`.
- Windows worktree-removal trap: `git worktree remove` can fail with "Permission denied"
  if a `node`/`msedge` process still holds a handle. This phase: kill stray processes,
  then `git worktree prune` + `Remove-Item -Recurse -Force` the leftover dir (the metadata
  was already pruned by the failed remove). Run git worktree ops from the main checkout.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phase 0–2 still stands (capability gate, kernel seam, `?worker&url`
worklet loading, PWA update flow, design tokens, enforcement scripts, storage §5–§6
below, the eight stores, undo core, autosave, hydration, sync-layer skeleton). New this
phase, all under `src/core/audio/` unless noted:

- **Injected-context rule.** Every graph builder/effect/pool takes a `BaseAudioContext`
  parameter — the real `AudioContext` at runtime, a fake in tests (happy-dom has no Web
  Audio), and `OfflineAudioContext` for renders/bounce (Phase 6). **Never** reach for a
  module-global context.
- **Fader law + ramps (`params/`)** — `faderLaw.ts` (`faderLevelToGain`/`dbToGain`, the
  §8.5.6 law) and `ramps.ts` (`rampParamLinear`/`rampParamTarget`/`setParamNow`, the
  §4.3 dezipper over `PARAM_RAMP_MS`). The sync layer/voices NEVER write `.value` during
  playback — they use these. (`params/registry.ts`, the §7.8 automation address registry,
  is **deferred to Phase 4** with the automation engine.)
- **Node factory + graph (`factory.ts`, `graph.ts`)** — `createChannelStrip` builds
  `input → [serial insert chain] → pan(StereoPanner) → fader(level gain) → mute(gain) →
  output`, with post-fader send taps; named `createTrackChannel/PadChannel/ReturnChannel/
  MasterBus`. Every handle has a paired `destroy()` disconnecting **all** its nodes
  (§3.2). `MixerGraph` owns master + 4 returns + monitor bus (monitor → destination,
  post master inserts, §5.9), creates track/pad channels on demand, routes
  pad→track→master and sends→returns; returns carry **no** sends (feedback-safe, §5.2).
- **Inserts (`inserts/`)** — `insert.ts` wraps an `EffectCore` with true-bypass routing,
  equal-power dry/wet `mix`, and a PDC dry-leg `DelayNode` matched to reported latency
  (§5.7.3; native = 0). `effects.ts` builds the six native cores (`eq4`, `filter`,
  `delay`, `compressor`, `saturator`, `reverb` v1 procedural-IR convolver); `effectParams.ts`
  holds per-effect defaults + ranges (enum params — filter type, saturator curve — encoded
  as int indices to fit `params: Record<string, number>`); `dspCurves.ts` is the pure
  waveshaper-curve + reverb-IR generator. `multibandComp`/`limiter` build as a tagged
  **passthrough** until Phase 6.
- **Voices (`voicePool.ts`, `voiceSelection.ts`, `voiceEnvelope.ts`)** — `VoicePool`
  (≤ `MAX_VOICES`): source → amp-envelope gain → pad channel; poly/mono/oneShot, choke +
  steal with a short fade (never a hard cut), AHDSR attack/release, leak-free teardown on
  `ended`/`destroy`. The steal-victim and choke-victim **selection is pure** in
  `voiceSelection.ts`; envelope scheduling is pure in `voiceEnvelope.ts`.
- **Samples (`sampleCache.ts`, `demoSample.ts`)** — `SampleCache`: OPFS read →
  `decodeAudioData`, memoised per path, injectable read/decode seam for tests (§9.4).
  `demoSample.ts`: a tiny WAV embedded as base64 (precached, offline-safe) that seeds the
  real OPFS sample path for the Phase 3 audible proof; its OPFS write is **memoised per
  project** so concurrent pad hits don't race two atomic writes onto a locked destination.
  (The real import/decode/standardise pipeline is Phase 6.)
- **Metering (`metering.ts`, `worklets/meterTap.worklet.ts`, `ui/primitives/meterScope.ts`
  + `MeterCanvas.tsx`)** — one global meter SAB (`Int32` generation header + `Float32`
  `[peak, rms]` per channel per slot) with a slot registry (idempotent allocate, reuse on
  release). `meter-tap` worklet computes peak+rms per quantum, writes its slot lock-free,
  bumps the generation via `Atomics`, passes signal through inline; **no `postMessage`, no
  allocation in `process()`** (§5.5). `meterScope` runs **one** shared rAF loop for all
  meters; `MeterCanvas` draws with peak-hold + clip-latch, colours from design tokens,
  `role="meter"` + throttled `aria-valuenow`, **zero React re-renders** (§3.3).
- **Monitor bus (`metronome.ts`, `preview.ts`)** — `Metronome` (pre-rendered accented/
  normal click, own level gain → monitor bus) and `PreviewChannel` (single-voice Browser
  audition → monitor bus). The scheduler drives the metronome in Phase 4; the Browser UI
  drives preview in Phase 6.
- **Engine + bridge (`engine.ts`, `audioBridge.ts`, `context.ts`, `solo.ts`)** —
  `AudioEngine` owns the graph, voice pool, meter registry + master meter tap, metronome,
  preview, sample cache, and the bridge; `initialise()` loads worklets (start gate, §5.1)
  and publishes the meter SAB to `meterScope`. `createAudioBridge` is the **real
  `SyncBridge`**: level/pan/send ramps, insert-chain rebuild, and **solo-in-place computed
  mutes** (pure `computeEffectiveMutes` in `solo.ts`, §5.2); `resyncAll()` flushes the
  current mixer state on start. `context.ts` creates the single `AudioContext`
  (`latencyHint:'interactive'`, project sample rate) and resumes it from the user gesture.
- **Test/offline seams (`offlineTest.ts`, `ui/audioProbe.ts`, `test/mocks/audioContext.ts`)**
  — `renderEffectOffline` renders a tone through an insert in `OfflineAudioContext` and
  measures RMS/peak (§11.2, browser-only). `audioProbe` installs
  `window.__bangerboxAudioProbe` (master peak, live voice count, churn, offline render) —
  the DOM-reachable seam the smoke drives (§11.4). `test/mocks/audioContext.ts` is a
  behaviour-free fake Web Audio graph recording node creation / connect / disconnect /
  `AudioParam` scheduling for lifecycle + leak-free-teardown unit tests.

## 5. Repository catalogue (`src/core/storage/repositories/`) — unchanged from Phase 1/2

`createRepositories(driver): Repositories` binds all nine (raw snake_case rows §9.3;
camelCase mapping in `core/project/mappers.ts`; growable lists `Page<T>`-enveloped,
`MAX_PAGE_SIZE`/`DEFAULT_PAGE_SIZE` = 200). Create/Patch input types re-exported from the
repositories index. Signatures unchanged:

- `ProjectRepository`: `create`, `getById`, `listRecent(page)`, `update(id, patch)`,
  `touch(id, at?)`, `remove(id)`.
- `SequenceRepository`: `create`, `getById`, `listByProject`, `update(id, patch)`
  (`tempo: null` = follow project default), `remove`.
- `TrackRepository`: `create`, `getById`, `listBySequence`, `update`, `remove`.
- `MidiEventRepository`: `insertMany`, `listByTrack`, `replaceTrack`, `deleteMany`,
  `clearTrack`.
- `AutomationRepository`: `insertMany`, `listByOwner(scope, ownerId, page)`,
  `replaceTarget(scope, ownerId, targetPath, points)`, `deleteMany`, `clearOwner`.
- `ProgramRepository`: `create`, `getById`, `listByProject`, `update({name?,payload?})`,
  `remove`.
- `SampleRepository`: `create`, `getById`, `listByProject`, `listGlobal`, `listByTag`,
  `setTags`, `tagsFor`, `remove`.
- `SongRepository`: `listByProject`, `replaceForProject`.
- `SettingsRepository`: `get`, `set`, `remove`.

## 6. DDL snapshot — unchanged

`PRAGMA user_version` = **1** = the §9.3 DDL verbatim. Source of truth:
`src/core/storage/migrations/001-initial-schema.ts` (never edit; append v2+). **No
migration was added in Phase 3** — the audio engine reads runtime state from the stores
and OPFS samples; nothing new persists. Pad **mixer strips** persist inside the program
payload / track mixer JSON exactly as in Phase 2 (population on program activation is
Phase 5).

## 7. Worker / worklet / message protocol versions

- **DB worker RPC:** kinds `init`, `diagnostics`, `exportBinary`, `query`, `execute`,
  `transaction`, `close` — unchanged. Extend by adding kinds; never repurpose.
- **Worklets:**
  - `meter-tap` (`src/core/audio/worklets/meterTap.worklet.ts`, **new**) —
    `processorOptions: { sab: SharedArrayBuffer, slot: number }`; 1 input / 1 output;
    writes `[peakL, rmsL, peakR, rmsR]` into its SAB slot and `Atomics.add`s the generation
    counter each quantum; passes signal through.
  - `gain-proof` (Phase 0) — **retained but no longer live-wired** (see §11).
- **Meter SAB layout (`metering.ts`, binding):** `Int32` header `[generation]` then
  `Float32` data of `METER_SLOTS(64) × VALUES_PER_SLOT(4)`; slot floats at
  `slot × 4 = [peakL, rmsL, peakR, rmsR]`. Single writer per slot; UI reads via one rAF
  loop.
- **Scheduler worker (§7.1.3): still does not exist — arrives Phase 4** (playhead SAB,
  `eventsDiff`, `clockSync`, etc.).
- **Sync-layer bridge (`src/store/syncLayer/bridge.ts`):** `SyncBridge` now includes
  `setChannelSend(channelId, index, level)` and `setChannelInserts(channelId, inserts)`
  in addition to `setChannel{Level,Pan,Mute,Solo}`, `setTransport{Playing,Recording}`,
  `setBpm`, `onActiveProgramChanged`, `onQLinkModeChanged`. `noopBridge` implements all;
  the real bridge is `createAudioBridge` (§4).

## 8. Stores (`src/store/`) — all eight implemented (§4.2), unchanged shapes

Field shapes match §4.2 verbatim (Phase 2). Phase 3 consumes them via the sync layer;
no store interfaces changed. Recap of the audio-relevant ones:

- **`useMixerStore`** — `channels: Record<string, ChannelStrip>` keyed
  `'pad:<programId>:<padIndex>' | 'track:<id>' | 'return:0..3' | 'master'`. The
  transient/commit channel (`setTransient`/`commit(path, value)`,
  `path = '<channelId>.level|.pan|.sendLevels.<0-3>'`) now moves the **real** graph via
  the mixer sync subscriber → bridge. `setMute/setSolo/addInsert/removeInsert/
  setInsertEnabled` likewise reach the graph. Solo is stored as a flag and evaluated as
  computed mutes in the bridge (§5.2). Pad strips still populate in Phase 5.
- **`useTransportStore`** — runtime-only; bpm/play/record forward to the bridge but are
  audio-no-op until the scheduler (Phase 4).
- **`useProgramStore`, `useSequenceStore`, `useProjectStore`, `useUIStore`,
  `useHardwareStore`, `useBrowserStore`** — unchanged from Phase 2.

**Undo:** `useUndoStore` (+ `pushUndo/endUndoGesture/clearUndoHistory`), UI via
`ProjectStatusBar` + `Ctrl+Z`/`Ctrl+Y`. `clearUndoHistory()` runs on project load.

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
                   │      ├─ ProjectStatusBar  (active project, unsaved dot, undo/redo)
                   │      ├─ StoragePanel       (DB boot + self-test — STUB(phase-7))
                   │      ├─ AudioEnginePanel   (NEW — Phase 3 minimal test UI: Start
                   │      │                      gate §5.1, pad-grid stub, metronome,
                   │      │                      master fader→sync→graph, master meter)
                   │      ├─ PwaUpdatePrompt
                   │      └─ ToastViewport
                   └─ startProjectSession()  (fire-and-forget after render:
                        bootDatabase → loadOrCreateActiveProject → hydrateStores →
                        registerSyncSubscribers(noopBridge) + visibility autosave)

AudioEnginePanel "Start" → startAudioEngine()  (core/project/session.ts):
     createAudioContext(sampleRate) → resume → new AudioEngine → engine.initialise()
     (load worklets, attach master meter tap, publish SAB) → dispose the no-op sync,
     re-register sync subscribers with engine.bridge → engine.bridge.resyncAll()
     → installAudioProbe(engine)   (window.__bangerboxAudioProbe, §11.4 smoke seam)
```

`AudioEngine` graph (spec §5.2), all built on the injected context:
```
voice(source → ampGain) ─┐
                          ├─ pad channel (inserts → pan → fader → mute) ─┐
                          │                                              ├─ track channel ─┐
                          └─ (sends) ─────────────────→ returns[0..3] ───┤   (inserts →     ├─ master
                                                             │            │    pan → fader   │  (inserts →
                                                             └────────────┘    → mute)       │   fader → mute)
metronome / preview ─────────────────────────────────────────────→ monitor bus ─────────────┴─→ destination
                                                                    (master.output → meter-tap → silent sink → destination)
```

## 10. Kernel inventory

| Kernel | Source | Status |
| --- | --- | --- |
| `gainProof` | `src/core/dsp/assembly/gainProof.ts` → `dist/gainProof.wasm` (gitignored) | Phase 0 WASM-in-worklet + kernel-seam exemplar (§5.6.1/§5.6.2). Still built by `build:wasm` and unit-tested (`gainProofKernel.test.ts`); **no longer live-wired** (see §11). The pattern the Phase 6 kernels follow. |

Phase 3 effects are **native** Web Audio nodes — no WASM kernels were added. The §5.6.4
WASM kernels (`transientDetect`, `granularStretch`, `multibandComp`, `fdnReverb`,
`lookaheadLimiter`) arrive in Phases 4–6.

## 11. Open stubs / deliberate technical debt

`check:stubs` reports 6 open stubs at handover (none block until Phase 7):

- `// STUB(phase-6)` `src/core/audio/inserts/effects.ts` — `multibandComp`/`limiter` build
  as a clean passthrough until their worklet+WASM DSP lands (§5.7).
- `// STUB(phase-6)` `src/core/project/projectService.ts` (×2) — `exportMpcweb`/
  `importMpcweb` throw until the §9.6 pipeline.
- `// STUB(phase-6)` `src/core/storage/opfs.ts` — worker sync-access-handle streaming.
- `// STUB(phase-6)` `src/ui/AppErrorFallback.tsx` — "Export project (.mpcweb)" rescue.
- `// STUB(phase-7)` `src/ui/StoragePanel.tsx` — diagnostic panel retires when Browser/Main
  modes + the toast-queue eviction notice ship.

**Deferred wiring (not stubbed, by design):**
- **`gainProof` is retained but not imported by the live app tree.** Its sole live
  consumer, `EngineSelfTest.tsx`, was retired this phase (its role — proving the engine
  foundations — is now the real audio engine's job). The kernel/worklet/loader remain as
  the tested §5.6.2 exemplar for Phase 6. Consequence: **the browser smoke no longer
  exercises the WASM-in-worklet transfer path** (Phase 3 uses native effects); Phase 6
  re-establishes that smoke coverage with the real kernels. If a reviewer prefers strict
  §3.4 orphan-proofing, the alternative is to delete `gainProof.worklet.ts` +
  `kernelLoader.ts` and rebuild the exemplar in Phase 6 — a §14 call for the human.
- **Bridge no-ops:** transport play/record/bpm (scheduler, Phase 4); pad mixer-strip
  population on program activation (Phase 5); Q-Link mode (Phase 8).
- **`params/registry.ts`** (the §7.8 automation address registry) is deferred to Phase 4
  with the automation engine — Phase 3 resolves channel params directly by channel id.
- **Metering coverage:** only the **master** meter tap is attached this phase; per-track /
  per-return / selected-pad taps attach when the Mixer mode ships (Phase 7), reusing
  `MixerGraph.getChannel(id).meterPoint` + `MeterRegistry.allocate(id)`.
- Vite build still emits the harmless vite-plugin-pwa `inlineDynamicImports` deprecation
  warning (plugin-owned).

## 12. Verification commands (all green at handover, inside the phase worktree)

`npm run dev` · `npm run build` · `npm run preview` · `npm test` (**199**) ·
`npm run test:e2e` (**20/20**, dev + offline — audible path, live meter, leak-free churn,
OfflineAudioContext effect asserts) · `npm run lint` · `npm run type-check` ·
`npm run verify`. (The main checkout has no `node_modules`; `npm install` before
re-running.)
