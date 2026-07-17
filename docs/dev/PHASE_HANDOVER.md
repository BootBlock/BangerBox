# BangerBox — Phase Handover (after Phase 5 — Programs & Sound Design)

Generated at the close of Phase 5 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 5 merged to `main`. All §12 Phase 5 exit criteria green inside the phase
worktree before landing: **363 unit tests** (Phase 0–4 suites plus the Phase 5 additions —
program voice resolution, mod-matrix evaluator, enriched-voice node accounting, envelope
scheduling, voice-modulation mapping, keygroup polyphony + glide, arpeggiator core + scheduler
integration, program-scope address grammar, and the Program Edit panel component test),
`test:e2e` **28/28** real-browser smoke — dev AND offline — now including the Phase 5 proofs:
**velocity switches the layer** (hard = +12 st ≈ 2× soft pitch) and **keygroup octave repitch**
(≈ 2.0×), both offline renders through the real resolution + voice path — alongside the Phase
3/4 audio + sequencer proofs — plus `lint`, `type-check`, `verify`, `build`.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

1. Project name **BangerBox**; package `bangerbox`; "WEB-MPC" retired.
2. **npm** only; committed `package-lock.json`; Node ≥ 24 (`engines`).
3. **git** at project root; repo is public — no secrets, personal data, or real device identifiers.
4. **No Tone.js.** Bespoke 960 PPQN lookahead scheduler in a **standard Web Worker** (live since
   Phase 4, `src/core/sequencer/scheduler.worker.ts` over the pure `SchedulerCore`, §7.1); the
   audio graph is built directly on the Web Audio API.
5. **AssemblyScript** for WASM DSP (`asc`, `--runtime stub -O3`), behind the §5.6 kernel seam.
   Phase 5 added **no** WASM kernels; the voice engine + sound design are pure TypeScript on
   native Web Audio nodes. §5.6.4 kernels arrive Phase 6.
6. **`@sqlite.org/sqlite-wasm`**, worker-hosted, OPFS VFS.
7. **Hand-rolled typed promise-based `postMessage` RPC** (no Comlink); the scheduler bridge reuses it.
8. **`motion`** (`'motion/react'`) for animation.
9. **No router** — 12 modes via `useUIStore.activeMode`.
10. **No component library**; bespoke primitives in `src/ui/primitives/`; icons `lucide-react` via
    `src/ui/icons.ts` only (registry still not created — Program Edit used plain inputs, not icons).
11. **Zod** for all runtime validation (incl. the scheduler message protocol, now with `arp`).
12. **fflate** (worker-side) for `.mpcweb` (Phase 6).
13. **Vitest** (unit, `happy-dom`) + **Playwright smoke on system Edge** (`channel: 'msedge'`).
14. **Local-first hosting**: `npm run dev`/`preview` with COOP/COEP from the Vite server.
15. **Chromium ≥ 120 desktop Windows** baseline; capability gate enforces at startup.
16. **Zustand = runtime truth; SQLite = durable truth**; hydrate on load, debounced autosave.
17. **960 PPQN.**
18. Audio defaults: 48 000 Hz / 24-bit / Float32 / `latencyHint: 'interactive'`.
19. **BLE-MIDI only** for MIDI input in v1 (Phase 8).

## 2. Spec deviations / corrections in effect

- **§14 2026-07-17 (e) (Phase 0, awaiting ratification):** worklet loading via `?worker&url`. Unchanged.
- **§14 2026-07-17 (f) (Phase 4, clock-sync domain correction awaiting ratification):** both sides feed
  the offset model absolute-epoch time (`timeOrigin + performance.now()`). Unchanged.
- **§14 2026-07-17 (g) (Phase 5) — NEW:**
  - **Scheduler protocol extension (additive):** new `arp` request kind `{ enabled, mode, octaves,
    gate, division }` (keygroup arpeggiator, §7.3); `SCHEDULER_PROTOCOL_VERSION` stays **1**
    (extend-by-adding-kinds — no existing kind changed).
  - **Program-scope automation addresses (§7.8):** the registry now parses/builds
    `program:<id>.pad:<idx>.<param>` for leaves `filter.cutoff`, `filter.resonance`, `pitch`, `amp`,
    `pan` (with ranges + the §7.8 gate). Grammar is **live**; per-voice *application* is deferred to
    Phase 7 (tagged `STUB(phase-7)` in `audioBridge.applyAutomation`).
  - **§6 sound-design implementation choices** (spec §6 leaves these unspecified): filter as a
    `BiquadFilterNode` with its envelope + LFO on the biquad `detune` (cents), pitch envelope + LFO on
    source `detune`; full-scale mod depths are named constants in `voiceModulation.ts` (pitch ±1200
    cents, filter cutoff ±4 octaves, filter env ±4 octaves); `sampleHold`/`drift` LFO shapes
    approximated by native oscillators (square/sine) pending a worklet LFO; keygroup glide is a
    portamento into each new note; resolved pad/program `mixer` applied to the graph channel on first
    creation (live pad-mixer editing → graph is Phase 7 Mixer work).

## 3. Toolchain facts

- Installed majors unchanged (Vite 8.1.5, React 19, TS 6, Tailwind 4, Zustand 5, Zod 4, motion 12,
  AssemblyScript 0.28, Vitest 4, Playwright 1.x, ESLint 9).
- **No new dependencies** — the §2.2 closed matrix is intact.
- `package.json` `config.phase` = **"5"**.
- Vitest `pool: 'threads'`; excludes `**/.claude/worktrees/**`.
- Windows worktree-removal trap: kill stray `node`/`msedge`, then `git worktree prune` +
  `Remove-Item -Recurse -Force` any leftover dir. (The Phase 5 smoke buffers all stdout to the end and
  can take ~15–20 min for the double build + Edge — it is not hung; wait for exit.)

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–4 still stands. New this phase (all under `src/core/audio/` unless noted):

- **`programVoice.ts` — pure program → voice resolution (§6).** `resolveVoice(program, note, velocity)`
  → `ResolvedVoice | null`: drum velocity-layer selection (`selectVelocityLayer`), keygroup zone
  selection (`selectKeygroupZone`) + coupled-repitch `keygroupDetuneCents`, and `resolvedVoiceToTrigger`
  (the single ResolvedVoice→`VoiceTriggerSpec` mapper shared by the engine dispatch and the offline
  pitch renders). Channel id is `pad:<programId>:<padIndex>` (drum) / `pad:<programId>:0` (keygroup).
- **`modMatrix.ts` — pure mod-matrix evaluator (§6).** `evaluateModMatrix(routes, sources)` →
  `Map<ModTarget, number>` (Σ source×amount, un-clamped, range-agnostic); `routesForSource`;
  `MOD_SOURCE_POLARITY`. **Never** re-derive modulation algebra at a call site.
- **`voiceModulation.ts` — §6 → Web Audio mapping (pure).** `lfoOscillator(shape)`,
  `biquadFilterType(type)`, `staticModulation(routes, note, velocity, random)` (voice-start offsets),
  and the depth constants. **`voiceEnvelope.ts`** gained `scheduleModEnvelope` (pitch/filter AHDSR on a
  param) and curve-honouring amp decay.
- **`voicePool.ts` — enriched voice (§5.2 stage 2, §6).** `VoiceTriggerSpec` now carries the optional
  §6 surface (`filter`, `pitchEnv`, `filterEnv`, `pitchEnvSemitones`, `lfos`, `modMatrix`,
  `programPolyphony`, `glideMs`). The chain is `source → ampGain → [filter] → destination`; LFOs are
  oscillators → gain → `source.detune`/`filter.detune`; keygroup polyphony steals oldest per program;
  mono glide portamentos from the previous pad pitch. All extra nodes torn down leak-free (§3.2 —
  asserted by the mock node-accounting tests). Omitting the §6 fields reproduces the Phase 3/4 voice.
- **`arpeggiator.ts` — pure arp grid (§7.3).** `arpSequence(held, mode, octaves)` (up/down/upDown/
  played/random across octaves) + `arpeggiatorHits(held, config, from, to)` (phase-locked, gated),
  sharing the note-repeat subdivision clock. Wired into `SchedulerCore.setArpeggiator` /
  `scheduleArpeggiator`, the worker `arp` case, and `SchedulerClient.setArpeggiator`.
- **Engine dispatch (`engine.ts`):** `triggerScheduledNote` resolves `track.programId` → program →
  `resolveVoice`; a resolved voice decodes its OPFS sample once (`programBuffers`), applies the §6 pad
  mixer to the graph channel on first creation (`channelMixerApplied`), and triggers via
  `resolvedVoiceToTrigger`. Tracks with no program (or unresolved notes) fall back to the demo sample
  (`triggerFallbackDemo`) so the Phase 4 record/playback smoke stays audible. `dispose` clears both caches.
- **Program-scope addresses (`params/registry.ts`):** `programParamPath`/`PROGRAM_PARAM_RANGES` + a
  `programParam` `ParamTarget` kind. `parseParamTarget` gates on the registered leaves.
- **Program Edit mode (`src/features/program-edit/`):** functional (Phase 5) editor mounted in `App`
  (`ProgramEditPanel`): program CRUD, `PadEditor` (bank grid + `EnvelopeEditor`/`FilterEditor`/
  `ModMatrixEditor`/`LayersEditor`), `KeygroupEditor` (zones + voice settings + shared sound design),
  and `ArpControl` (drives `engine.scheduler.setArpeggiator`). Reusable labelled inputs in `controls.tsx`.
  Every control commits through `useProgramStore` (§4.5). Plain inputs, not bespoke knobs — Phase 7.
- **Offline pitch renders (`offlineTest.ts`):** `renderProgramNotePitch(program, note, velocity)` builds
  a voice in an `OfflineAudioContext` over a synthesised known-pitch sine and measures pitch by
  autocorrelation. Exposed via the audio probe (`velocityLayerPitches`, `keygroupPitches`) for the smoke.

## 5. Repository catalogue — unchanged from Phase 1/2 (see git history / prior handover).
`ProgramRepository` CRUD (`create`/`getById`/`listByProject`/`update`/`remove`) already backs program
persistence; Phase 5 added no repository or DDL change (programs persist as `programs.payload` JSON, §9.3).

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1** = the §9.3 DDL verbatim
(`src/core/storage/migrations/001-initial-schema.ts`). **No migration added in Phase 5** — the enriched
§6 program model already round-trips through the `programs.payload` JSON (Zod-validated on load, `mappers.ts`).

## 7. Worker / worklet / message protocol versions

- **DB worker RPC:** unchanged.
- **Worklets:** `meter-tap` (Phase 3), `gain-proof` (Phase 0). **No new worklets** (the voice engine is
  native nodes; a worklet LFO for sampleHold/drift is a later refinement).
- **Scheduler worker — `SCHEDULER_PROTOCOL_VERSION = 1` (unchanged number):** Phase 4 kinds **plus** the
  new additive **`arp { enabled, mode, octaves, gate, division }`** (main → worker, §7.3). Worker →
  main responses unchanged. Zod-guarded at both boundaries.
- **Playhead / Meter SAB layouts:** unchanged.
- **Sync-layer bridge (`audioBridge.ts`):** `applyAutomation` now also recognises `programParam`
  targets (registered grammar) — application is a tagged `STUB(phase-7)`.

## 8. Stores — all eight implemented (§4.2), shapes unchanged.
`useProgramStore` carried the Phase 5 editing surface via its existing `updateProgram`/`upsertPad`/
`removePad` actions (all undoable, §4.5). No store interface changed.

## 9. Component tree topography (as implemented)

```
main.tsx → capability gate → tab lock → ErrorBoundary(App)
App → header · soft-capability chips · ProjectStatusBar · StoragePanel · AudioEnginePanel · ProgramEditPanel
AudioEnginePanel "Start" → startAudioEngine() (unchanged Phase 4 path; dispatch now resolves real programs)
ProgramEditPanel → program CRUD · (PadEditor | KeygroupEditor) · ArpControl
  PadEditor → bank grid · pad settings · EnvelopeEditor · FilterEditor · ModMatrixEditor · LayersEditor
  KeygroupEditor → voice settings · EnvelopeEditor · FilterEditor · ModMatrixEditor · zones
  ArpControl → enabled/mode/octaves/gate/division → engine.scheduler.setArpeggiator
```

## 10. Kernel inventory — unchanged. `gainProof` exemplar only; §5.6.4 WASM kernels arrive Phase 6
(Phase 5 added none — the voice engine + sound design are pure TypeScript on native Web Audio nodes).

## 11. Open stubs / deliberate technical debt

`check:stubs` reports **7** open stubs (none block until Phase 7):
- `// STUB(phase-7)` `src/core/audio/audioBridge.ts` — per-voice program-parameter automation
  application (§6/§7.8); the address grammar is registered now (**NEW this phase**).
- `// STUB(phase-6)` ×5 — `multibandComp`/`limiter` passthrough, `.mpcweb` pack/unpack, OPFS streaming,
  Safe-Mode export.
- `// STUB(phase-7)` `src/ui/StoragePanel.tsx` — diagnostic panel.

**Deferred wiring (not stubbed, by design):**
- **Note repeat + arpeggiator UI**: `SchedulerClient.setNoteRepeat`/`setArpeggiator` exist and are
  tested; note repeat still has no UI (Phase 7/8 Pad Perform), arp has the `ArpControl` in Program Edit.
- **Per-voice program automation** (`program:<id>.pad:<idx>.…`) application → Phase 7.
- **LFO refinements:** tempo-synced LFO rate (currently free-rate Hz) and a true `sampleHold`/`drift`
  worklet LFO → later. Additional LFO mod targets (pan, amp tremolo, layerStart, insert, lfoRate) —
  the evaluator computes them; the voice audibly applies pitch + filter-cutoff LFOs in v1.
- **Non-destructive layer trim / reverse** (`startFrame`/`endFrame`/`reverse`) carried on `ResolvedVoice`
  but applied in Phase 6 (sample pipeline).
- **Pad-mixer live editing → graph** and **program-scope mixer strips in `useMixerStore`** → Phase 7 Mixer.
- **Groove extraction (§7.5)** → Phase 6 (needs the `transientDetect` WASM kernel).
- Prior Phase 3/4 deferrals (playhead canvas rendering, `replace` region-clear, `gainProof` unwired,
  automation-ramp altitude) still stand.

## 12. Verification commands (all green at handover, inside the phase worktree)
`npm run dev` · `build` · `preview` · `test` (**363**) · `test:e2e` (**28/28**, dev + offline —
velocity-layer switching, keygroup pitch accuracy, plus the Phase 3/4 proofs) · `lint` · `type-check` ·
`verify`. (The main checkout has no `node_modules`; `npm install` before re-running.)
