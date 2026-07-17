# BangerBox — Phase Handover (after Phase 4 — Sequencer & Recording)

Generated at the close of Phase 4 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 4 merged to `main`. All §12 Phase 4 exit criteria green inside the phase
worktree before landing: **299 unit tests** (Phase 0–3 suites plus the Phase 4 timing
suite — PPQN maths, swing, quantise, lookahead loop-wrap, note repeat, song/tempo map,
parameter registry, automation engine, message protocol, playhead SAB, clock model, the
`SchedulerCore` scenarios incl. loop-boundary + song-transition + recording, and the
scheduler client + sequencer sync), `test:e2e` **24/24** real-browser smoke — dev AND
offline — now driving the sequencer end to end: **record-then-playback** (live-note capture
→ worker flush → store → playback dispatch) plus a transport-UI playhead-advance check —
alongside the Phase 3 audio proofs — plus `lint`, `type-check`, `verify`, `build`.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

1. Project name **BangerBox**; package `bangerbox`; "WEB-MPC" retired.
2. **npm** only; committed `package-lock.json`; Node ≥ 24 (`engines`).
3. **git** at project root; repo is public — no secrets, personal data, or real device identifiers.
4. **No Tone.js.** Bespoke 960 PPQN lookahead scheduler in a **standard Web Worker** — **now
   live** (`src/core/sequencer/scheduler.worker.ts` over the pure `SchedulerCore`, §7.1); the
   audio graph is built directly on the Web Audio API.
5. **AssemblyScript** for WASM DSP (`asc`, `--runtime stub -O3`), behind the §5.6 kernel seam.
   Phase 4 added **no** WASM kernels; the sequencer is pure TypeScript. Kernels arrive Phase 6.
6. **`@sqlite.org/sqlite-wasm`**, worker-hosted, OPFS VFS.
7. **Hand-rolled typed promise-based `postMessage` RPC** (no Comlink). The scheduler bridge
   reuses this pattern (typed union + Zod guards, `messages.ts`).
8. **`motion`** (`'motion/react'`) for animation.
9. **No router** — 12 modes via `useUIStore.activeMode`.
10. **No component library**; bespoke primitives in `src/ui/primitives/`; icons `lucide-react`
    via `src/ui/icons.ts` only (registry still not created — first consumer creates it).
11. **Zod** for all runtime validation (now incl. the scheduler message protocol).
12. **fflate** (worker-side) for `.mpcweb` (Phase 6).
13. **Vitest** (unit, `happy-dom`) + **Playwright smoke on system Edge** (`channel: 'msedge'`).
14. **Local-first hosting**: `npm run dev`/`preview` with COOP/COEP from the Vite server.
15. **Chromium ≥ 120 desktop Windows** baseline; capability gate enforces at startup.
16. **Zustand = runtime truth; SQLite = durable truth**; hydrate on load, debounced autosave.
    The sync layer now drives the audio graph **and** the scheduler worker.
17. **960 PPQN.**
18. Audio defaults: 48 000 Hz / 24-bit / Float32 / `latencyHint: 'interactive'`.
19. **BLE-MIDI only** for MIDI input in v1 (Phase 8).

## 2. Spec deviations / corrections in effect

- **§14 2026-07-17 (e) (Phase 0, awaiting ratification):** worklet loading via `?worker&url`. Unchanged.
- **§14 2026-07-17 (f) (Phase 4) — NEW, two parts:**
  - **Scheduler protocol extensions** (additive; DB-worker "extend by adding kinds" precedent —
    no §7.1.3 name renamed): `sequenceMeta`, `eventsDiff.sequenceId`, `liveNote.trackId`,
    `liveErase`/`erased`, `ScheduledEvent.accented`. See §7 below for the full protocol.
  - **Clock-sync domain correction (§7.1.2), flagged for human ratification:** the worker's
    `performance.timeOrigin` differs from the main thread's, so both sides feed the offset
    model the **absolute-epoch** time (`timeOrigin + performance.now()`); live-note timestamps
    are converted likewise. The 8-sample smoothing + 2 ms drift-snap of §7.1.2 is unchanged.
- **Parameter registry scope (Phase 4):** `src/core/audio/params/registry.ts` registers the
  **mixer** (level/pan/send) and **insert** parameter address kinds only (spec §7.8 forms
  `mixer.<channelId>.level|.pan|.sendLevels.<0-3>`, `insert:<channelId>:slot<N>.<param>`).
  Program-scope sound-design addresses (`program:<id>.pad:<idx>.…`) register in Phase 5 with
  per-voice automation. `parseParamTarget` returns null for unregistered paths (§7.8 gate).
- **Automation application altitude:** the dispatcher applies automation ramps through the
  channel handle setters at scheduler resolution (~25 ms) with the §4.3 dezipper — piecewise
  linear tracking, not a single ramp to the next point. Audible + correct; a per-segment
  `linearRampToValueAtTime(value, rampEnd)` refinement is a later polish item.
- **Groove extraction (§7.5) deferred to Phase 6** (needs the `transientDetect` WASM kernel);
  **arpeggiator (§7.3) deferred to Phase 5** (shares the note-repeat subdivision clock).
- `check:lang` allowlist unchanged.

## 3. Toolchain facts

- Installed majors unchanged (Vite 8.1.5, React 19, TS 6, Tailwind 4, Zustand 5, Zod 4,
  motion 12, AssemblyScript 0.28, Vitest 4, Playwright 1.x, ESLint 9).
- **No new dependencies** — the §2.2 closed matrix is intact. The sequencer is pure TypeScript
  on native Web Workers + SharedArrayBuffer + Atomics.
- `package.json` `config.phase` = **"4"**.
- Vitest `pool: 'threads'`; excludes `**/.claude/worktrees/**`.
- Windows worktree-removal trap (Phase 3 note still applies): kill stray `node`/`msedge`
  processes, then `git worktree prune` + `Remove-Item -Recurse -Force` any leftover dir.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–3 still stands. New this phase:

- **`src/core/sequencer/` — pure timing modules (dependency-free, exhaustively unit-tested,
  §7.1.5):** `ppqn.ts` (tick↔seconds, bars/beats), `swing.ts` (§7.4 MPC offset), `quantise.ts`
  (§7.4 destructive), `lookahead.ts` (linear→sequence loop folding, once-per-pass windowing,
  §7.1.5), `noteRepeat.ts` (§7.3 grid), `songMap.ts` (§7.9 tick + tempo map, seconds⇄tick),
  `automation.ts` (§7.8 curve eval + track-over-sequence + ramp emission), `clockSync.ts`
  (§7.1.2 model). **Never** duplicate this maths at a call site.
- **`SchedulerCore` (`schedulerCore.ts`) — the pure lookahead engine (§7.1, §11.3).** All timing
  logic; driven by an injected clock (`tick(now)` takes context seconds). Setters mirror the
  message protocol; `tick()` returns `{ batch, recorded, erased, loopWrapped, songAdvanced }`.
  Sequence + song modes, count-in/metronome, note repeat, recording capture/flush, live erase,
  automation — all here. **The worker file is a thin shell over it.**
- **Scheduler worker + client (§7.1.1/3):** `scheduler.worker.ts` (thin message shell +
  `ClockModel` + `PlayheadWriter`, ticks every `SCHEDULER_INTERVAL_MS`), `schedulerClient.ts`
  (`SchedulerClient` — owns the worker, sends `clockSync` every `CLOCK_SYNC_INTERVAL_MS` from
  `getOutputTimestamp()`, typed sends, routes responses to callbacks). Injectable `WorkerLike`
  (reused from `rpc.ts`) makes both unit-testable.
- **Message protocol (`messages.ts`, §7.1.3):** typed `SchedulerRequest`/`SchedulerResponse`
  unions + Zod guards + `SCHEDULER_PROTOCOL_VERSION = 1`. Parse at both boundaries. **Extend by
  adding kinds; never repurpose or rename** (naming freeze, §13.6).
- **Playhead SAB (`playheadSab.ts`, §7.1.4):** `Int32` seqlock header `[generation, flags]` +
  one `Float64` current tick; `PlayheadWriter`/`PlayheadReader` (seqlock, tear-free). Flags:
  `PLAYHEAD_FLAG_PLAYING`, `PLAYHEAD_FLAG_RECORDING`.
- **Parameter registry (`src/core/audio/params/registry.ts`, §7.8):** `parseParamTarget` /
  `isAutomatable` / canonical builders (`channelLevelPath` etc.) / `targetRange`. The single
  source of automatable addresses (used by automation dispatch; Q-Link/XYFX pickers reuse it in
  Phases 7/8).
- **Engine integration (`engine.ts`):** `AudioEngine` now owns the `SchedulerClient`, the
  playhead SAB + reader + a rAF **playhead pump** (updates `useTransportStore.coarsePosition`
  ≤ 4×/s, §4.2), the **dispatcher** (`dispatchScheduledEvent`: noteOn → voice pool, click →
  metronome, automationRamp → `bridge.applyAutomation`), and the demo instrument (preloaded
  demo buffer; `STUB(phase-5)` real program→pad resolution). `recorded`/`erased` route to
  `useSequenceStore`.
- **Automation dispatch (`audioBridge.ts`):** `AudioBridge.applyAutomation(targetPath, value,
  when, rampEnd)` resolves the registry target and ramps the channel level/pan/send or an
  insert param (`ChannelHandle.setInsertParam`, new).
- **Sequencer sync (`src/store/syncLayer/sequencerSync.ts`, §4.3/§7.1.3):** the only place that
  forwards transport/tempo/swing/loop/metronome/sequence-meta/events/automation/song to the
  scheduler worker. Registered on engine start (`session.ts`) with a full resync, then narrow
  diff-based updates. Live notes + note repeat are driven straight to the client by the input
  layer (§7.6), not through here.
- **Recording undo (`useSequenceStore.commitRecordedTake`):** one "Recorded take" undo entry
  per flush (§7.7); `overdub` merges, `replace` swaps the track's events.

## 5. Repository catalogue — unchanged from Phase 1/2 (see git history / prior handover).

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1** = the §9.3 DDL verbatim
(`src/core/storage/migrations/001-initial-schema.ts`). **No migration added in Phase 4** — the
sequencer reads runtime state from the stores; events/automation/song already persist via the
Phase 1/2 repositories and autosave.

## 7. Worker / worklet / message protocol versions

- **DB worker RPC:** unchanged (`init`, `diagnostics`, `exportBinary`, `query`, `execute`,
  `transaction`, `close`).
- **Worklets:** `meter-tap` (Phase 3), `gain-proof` (Phase 0, retained exemplar). No new worklets.
- **Scheduler worker (`scheduler.worker.ts`) — NEW, `SCHEDULER_PROTOCOL_VERSION = 1`:**
  - **Main → worker:** `init { playheadSab }`, `clockSync { contextTime, performanceTime }`
    (both absolute-epoch, §14 (f)), `transport { isPlaying, isRecording, startTick }`,
    `tempo { bpm }`, `swing { amount, division }`, `loop { enabled, startTick, endTick }`,
    `eventsDiff { trackId, sequenceId, upserts, deletes }`, `automationDiff { scope, ownerId,
    targetPath, points }`, `songSequence { orderedSequenceIds }` (repeats expanded),
    `sequenceMeta { sequences, projectBpm, activeSequenceId, playbackMode }`,
    `liveNote { note, velocity, on, timestamp, trackId }`, `noteRepeat { enabled, division }`,
    `metronome { enabled, countInBars }`, `liveErase { trackId, note, active }`.
  - **Worker → main:** `scheduleBatch { events: ScheduledEvent[] }`
    (`ScheduledEvent.kind ∈ noteOn|noteOff|click|automationRamp`; fields `when, tick, trackId?,
    note?, velocity?, durationSec?, target?, value?, rampEnd?, accented?`),
    `recorded { trackId, events }`, `erased { trackId, eventIds }`, `loopWrapped { tick }`,
    `songAdvanced { entryIndex }`.
- **Playhead SAB layout:** `Int32 [generation, flags]` (seqlock; flags bit0 playing, bit1
  recording) then one `Float64` current tick. Single writer (worker), rAF reader (main).
- **Meter SAB layout:** unchanged from Phase 3.
- **Sync-layer bridge (`bridge.ts`):** unchanged `SyncBridge`; the **real** bridge now also
  exposes `applyAutomation` (on `AudioBridge`). Transport methods on `SyncBridge`
  (`setTransportPlaying`/`Recording`/`setBpm`) remain graph no-ops — transport now reaches the
  worker through **`sequencerSync`**, not the graph bridge.

## 8. Stores — all eight implemented (§4.2), shapes unchanged.
`useTransportStore` play/stop/record/bpm/swing/loop/metronome now drive the scheduler via
`sequencerSync`; `coarsePosition` is written by the engine playhead pump. `useSequenceStore`
gained `commitRecordedTake(trackId, events, mode)` (§7.7). Undo unchanged.

## 9. Component tree topography (as implemented)

```
main.tsx → capability gate → tab lock → ErrorBoundary(App)
App → header · soft-capability chips · ProjectStatusBar · StoragePanel · AudioEnginePanel
AudioEnginePanel "Start" → startAudioEngine():
   createAudioContext → resume → new AudioEngine → engine.initialise()
     (load worklets, attach master meter, preload demo instrument, scheduler.start(),
      start playhead pump) → re-register sync subscribers with engine.bridge
     → engine.bridge.resyncAll() → subscribeSequencerSync(engine.scheduler)  (full resync)
     → installAudioProbe(engine)
AudioEnginePanel (running) → pad grid · master fader+meter · metronome click · SequencerTransport
SequencerTransport → play/stop · record-arm · metronome · tempo · bar:beat readout (all wired)
```

## 10. Kernel inventory — unchanged. `gainProof` exemplar only; §5.6.4 WASM kernels arrive Phases 4–6
(Phase 4 added none — the sequencer is pure TypeScript).

## 11. Open stubs / deliberate technical debt

`check:stubs` reports **7** open stubs (none block until Phase 7):
- `// STUB(phase-5)` `src/core/audio/engine.ts` — one demo pad channel per (track, note); real
  program → pad → layer note resolution follows in Phase 5.
- `// STUB(phase-6)` ×5 — `multibandComp`/`limiter` passthrough, `.mpcweb` pack/unpack, OPFS
  streaming, Safe-Mode export (unchanged from Phase 3).
- `// STUB(phase-7)` `src/ui/StoragePanel.tsx` — diagnostic panel.

**Deferred wiring (not stubbed, by design):**
- **Arpeggiator (§7.3)** → Phase 5 (shares the `noteRepeat` subdivision clock).
- **Groove extraction (§7.5)** → Phase 6 (needs the `transientDetect` WASM kernel).
- **Program-scope automation addresses** (`program:<id>.pad:<idx>.…`) → Phase 5.
- **Automation ramp altitude:** dispatch applies at scheduler resolution via the §4.3 dezipper
  (not a single `linearRampToValueAtTime` to the next point) — a later polish refinement.
- **Playhead canvas rendering** (DPR canvas + `outputLatency` compensation, §7.1.4) → Phase 7;
  Phase 4 exposes the SAB + reader and drives only the coarse text readout.
- **`replace` record mode** swaps the whole track on flush (coarse); true region-clear-as-passed
  is a Phase 7 refinement.
- `gainProof` retained-but-unwired (Phase 3 note stands); Vite pwa `inlineDynamicImports`
  deprecation warning (plugin-owned).

## 12. Verification commands (all green at handover, inside the phase worktree)
`npm run dev` · `build` · `preview` · `test` (**299**) · `test:e2e` (**24/24**, dev + offline —
record-then-playback, transport-UI playhead advance, plus the Phase 3 audio proofs) · `lint` ·
`type-check` · `verify`. (The main checkout has no `node_modules`; `npm install` before re-running.)
