# BangerBox — Phase Handover (after Phase 7 — Full UI Assembly & Polish)

Generated at the close of Phase 7 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 7 merged to `main` (`--no-ff`). All §12 Phase 7 exit criteria green inside the
phase worktree before landing: **562 unit tests** (the Phase 0–6 suites plus the Phase 7
additions — control maths, primitive ARIA/keyboard contracts, wake-lock lifecycle, scale/chord
tables, grid geometry, schedule-time groove, pad-strip derivation, program-param mapping, and a
**mechanical 12-mode accessibility sweep**), `test:e2e` **33/33** real-browser smoke — dev AND
offline — now including the Phase 7 proof **all 12 modes mount from the rail** alongside every
prior Phase 0–6 proof, plus `lint`, `type-check`, `verify` (**no open stubs**), and `build`.

**Perf budget (§11.5) measured:** main JS chunk **198.5 KiB gzip** against the 500 KiB budget
(wasm/sqlite excluded, as the budget specifies).

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

1. Project name **BangerBox**; package `bangerbox`; "WEB-MPC" retired.
2. **npm** only; committed `package-lock.json`; Node ≥ 24 (`engines`).
3. **git** at project root; repo is public — no secrets, personal data, or real device identifiers.
4. **No Tone.js.** Bespoke 960 PPQN lookahead scheduler in a **standard Web Worker** (`scheduler.worker.ts`).
5. **AssemblyScript** for WASM DSP (`asc`, `--runtime stub -O3 --use abort=`), behind the §5.6 kernel seam.
6. **`@sqlite.org/sqlite-wasm`**, worker-hosted, OPFS VFS.
7. **Hand-rolled typed promise-based `postMessage` RPC** (no Comlink); reused by the scheduler, pack,
   wavEncode, and the NEW `opfsWrite` worker clients.
8. **`motion`** (`'motion/react'`) for animation — now live in the mode rail (shared `layoutId`),
   mode cross-fade, `Modal`, and the PWA toast.
9. **No router** — 12 modes via `useUIStore.activeMode`, mounted from the `MODE_DEFINITIONS` registry.
10. **No component library**; bespoke primitives in `src/ui/primitives/`; icons `lucide-react` via
    `src/ui/icons.ts` **only** (the registry now exists and is the sole import site).
11. **Zod** for all runtime validation.
12. **fflate** (worker-side) for `.mpcweb`.
13. **Vitest** (unit, `happy-dom`) + **Playwright smoke on system Edge** (`channel: 'msedge'`).
14. **Local-first hosting**: `npm run dev`/`preview` with COOP/COEP from the Vite server.
15. **Chromium ≥ 120 desktop Windows** baseline; capability gate enforces at startup.
16. **Zustand = runtime truth; SQLite = durable truth**; hydrate on load, debounced autosave.
17. **960 PPQN.**
18. Audio defaults: 48 000 Hz / 24-bit / Float32 / `latencyHint: 'interactive'`.
19. **BLE-MIDI only** for MIDI input in v1 (**Phase 8 — next**).

## 2. Spec deviations / corrections in effect

- **§14 2026-07-17 (e) (Phase 0):** worklet loading via `?worker&url`. Unchanged.
- **§14 2026-07-17 (f) (Phase 4):** clock-sync absolute-epoch domain. Unchanged.
- **§14 2026-07-17 (g) (Phase 5):** `arp` scheduler kind; program-scope automation grammar. Unchanged.
- **§14 2026-07-18 (h) (Phase 6):** `transientDetect` energy-flux detector (flagged for ratification);
  `reverb` uses the `fdnReverb` worklet when kernels are loaded; `granularStretch` = WSOLA; DSP-effect
  worklet params apply in-kernel. Unchanged.
- **§14 2026-07-18 (i) (Phase 7) — NEW (read the changelog for full detail):**
  - **Additive store fields** (§4.2 permits adding with a changelog entry): `useHardwareStore.inputLatencyMs`
    (§10.2 offset, default 15 ms, 0–50); `useSequenceStore.grooveTemplates` + `trackGrooveIds` (§7.5).
    Both hydration fields are **optional**, so pre-Phase-7 snapshots still load.
  - **Additive scheduler kind `groove { trackId, template }`** — `SCHEDULER_PROTOCOL_VERSION` stays **1**
    (extend-by-adding precedent; no existing kind changed).
  - **§5.1 start gate promoted** to a full-screen `StartGate`; `AudioEnginePanel` became Main-mode
    diagnostics; the Phase 4 `SequencerTransport` stub was **deleted** (superseded by `TransportBar`).
  - **§9.1 worker sync-access-handle write path implemented**; atomicity unchanged.
  - **§9.5 bounce variants completed** (song / track / resample-to-pad) sharing one render core.
  - **§7.8 per-voice program automation implemented** — the last `STUB(phase-7)` is closed.
  - **§8 open choices:** `ValueReadout` is a `<span>` not `<output>` (implicit `role="status"`);
    the rail is `<div role="tablist">` inside a `<nav>`; tab panels are named by full mode title;
    `Modal` focuses the dialog container; pad velocity from vertical strike position; groove per track.

## 3. Toolchain facts

- Installed majors unchanged (Vite 8.1.5, React 19, TS 6, Tailwind 4, Zustand 5, Zod 4,
  AssemblyScript 0.28, Vitest 4, Playwright 1.x, ESLint 9). **No new dependencies** — the §2.2 closed
  matrix is intact.
- `package.json` `config.phase` = **"7"**.
- `npm run build:wasm` builds six kernels; artefacts under `src/core/dsp/dist/` (gitignored).
- **`npm run test:e2e:quick`** (`--dev-only`, ~3–6 min) for iteration; the full `test:e2e`
  (dev + offline, ~15–20 min) stays the binding phase-exit proof.
- **BigInt lesson (still important):** `@sqlite.org/sqlite-wasm` returns INTEGER columns as **BigInt**.
  Coerce with `Number(...)`; never `JSON.stringify` a raw row.
- **Lint traps hit this phase (worth knowing):** `react-hooks/refs` rejects mutating a ref during render
  (use `useLayoutEffect`); `react-hooks/set-state-in-effect` rejects a synchronous `setState` in an
  effect (seed state lazily, or move the write into an async body); `jsx-a11y` rejects a `<label>`
  wrapping a non-form control (SegmentControl is a radiogroup with its own `aria-label`) and a `<nav>`
  carrying `role="tablist"`.
- Windows worktree-removal trap unchanged: kill stray `node`/`msedge`, `git worktree prune`, then
  `Remove-Item -Recurse -Force`.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–6 still stands. New this phase:

**Primitives — the bespoke control set (spec §8, §3.6 ZERO DRY):**
- **`ui/primitives/controlMaths.ts`** — pure value↔travel mapping: `valueToNormalised` /
  `normalisedToValue` (linear + log taper, degrading to linear when a range touches zero),
  `stepValue`, `quantiseToStep`, **`formatValueText`** (the single `aria-valuetext` wording —
  "−6.0 dB", "1.2 kHz", "−∞ dB", en-GB minus sign).
- **`ui/primitives/useContinuousControl.ts`** — THE drag/keyboard gesture engine for every continuous
  control. Pointer moves paint via a `render` callback + the transient channel (no React state,
  §3.3); one `onCommit` per gesture (§4.5); arrows/Shift-fine/PageUp/Home/End; double-click resets
  to `defaultValue`. Options mirrored into a ref via `useLayoutEffect`.
- **`Knob`**, **`Fader`** (caller supplies `formatValue` — the fader *law* stays in `faderLaw.ts`),
  **`Pad`** (velocity from strike height; glow via the `--bb-pad-glow` custom property + the
  `--transition-bb-pad` token, never React state), **`XYSurface`** (canvas crosshair + trail, rAF,
  IntersectionObserver idle, paired ARIA sliders per axis), **`Toggle`**, **`SegmentControl`**
  (radiogroup + roving tabindex; key handler on the options, not the group), **`ValueReadout`**,
  **`Modal`** (focus trap + restore, Escape, reduced-motion), **`LiveRegion`** + **`announce()`**
  (the single polite announcer — `aria-live` WITHOUT `role="status"`).
- **`ui/icons.ts`** — the lucide re-export registry; features never import `lucide-react` directly.

**Shell (spec §8.1):**
- **`ui/shell/AppShell.tsx`** — transport bar + rail + active mode; only the active mode is mounted.
- **`ui/shell/TransportBar.tsx`**, **`ModeRail.tsx`** (motion `layoutId` indicator, roving tabindex),
  **`Panel.tsx`** (the shared section container every mode composes from),
  **`StartGate.tsx`** (§5.1), **`PerfHud.tsx`** (§11.5, `import.meta.env.DEV`, Ctrl+Shift+P),
  **`useWakeLock.ts`** (§2.4, store subscription — not a React selector).
- **`ui/usePadTrigger.ts`** — the ONE way a surface sounds a pad (§7.6 dual path); Phase 8's BLE
  input joins these same two legs rather than adding a third.

**Mode registry:** **`features/modes.ts`** — `MODE_DEFINITIONS` (id, label, title, icon, Component).
The rail, the content area, and the accessibility sweep all read it.

**Pure logic (dependency-free, unit-tested — spec §2.5):**
- **`features/grid/gridGeometry.ts`** — tick↔x, note↔row, `eventAtPoint`, `resizeHandleAtPoint`.
- **`features/pad-perform/scales.ts`** — all 13 §8.5.9 scales, triad/7th chord sets, `noteName`.
- **`core/audio/voiceParams.ts`** — `programParamChange` (which §7.8 leaf goes per-voice vs to the
  pad channel) + `padKeyFor`.
- **`store/syncLayer/padStrips.ts`** — `padStripsForProgram` (§6 pad mixers → channel strips).

**Engine additions:**
- **`AudioEngine.triggerLiveNote(trackId, note, velocity, on)`** — the §7.6 dual path.
- **`VoicePool.applyPadParam(padKey, target, value, when)`** — per-voice §7.8 automation, ramped.
- **`SchedulerCore.setGroove(trackId, template)`** — schedule-time groove beside swing (§7.5).
- **`core/platform/wakeLock.ts`** — injectable-API controller, serialised, reacquires on visibility.
- **`core/storage/opfsWrite.worker.ts`** + **`opfsWriteClient.ts`** + **`writeFileStreamed`** (§9.1).
- **`core/audio/bounceService.ts`** — `renderSegments` core + `bounceActiveSequence` / `bounceTrack` /
  `bounceSong` / `resampleSequenceToSample` (§9.5).

## 5. Repository catalogue — unchanged from Phase 1/2. No repository or DDL change in Phase 7.

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1** = the §9.3 DDL verbatim
(`src/core/storage/migrations/001-initial-schema.ts`). **No migration added in Phase 7.** Groove
templates live in runtime state and belong in `projects.payload` when persisted (§9.3 names them
there) — see Open items below.

## 7. Worker / worklet / message protocol versions

- **DB worker RPC:** unchanged.
- **Worklets:** `meter-tap`, `gain-proof`, `dsp-effect`, `looper-recorder` — unchanged.
- **Scheduler worker:** `SCHEDULER_PROTOCOL_VERSION = 1`; **NEW additive `groove` request kind**.
- **Workers:** `pack.worker`, `wavEncode.worker`, **NEW `opfsWrite.worker`** (sync access handles).
- **Sync-layer bridge (`audioBridge.ts`):** `applyAutomation` is **fully implemented** — no stubs.

## 8. Stores — all eight implemented (§4.2).
Added this phase (additive only): `useHardwareStore.inputLatencyMs`; `useSequenceStore.grooveTemplates`
+ `trackGrooveIds`. `programSync` now publishes the active drum program's pad strips into
`useMixerStore` (never clobbering existing strips), which is what makes the Mixer's pads tab live.

## 9. Component tree topography (as implemented)

```
App → StartGate (§5.1) → AppShell
                          ├── TransportBar (play/rec/loop/click, position, tempo, swing,
                          │                 count-in, rec-mode, save-dot, save, undo/redo)
                          ├── ModeRail (12 tabs, motion layoutId, roving tabindex)
                          └── <main role="tabpanel"> active mode
                              ├── Main       → Now playing · Quick pads · Engine diagnostics
                              │                (AudioEnginePanel) · Sequences · Storage
                              │                (StoragePanel: DB boot, persist, self-test)
                              ├── Grid       → tool/snap/quantise/groove · GridCanvas
                              │                (notes, velocity lane, SAB playhead) · note list
                              ├── Mute       → latch/momentary · track cells · pad cells
                              ├── Sample     → (Phase 6 panel) import · waveform · tools
                              ├── Program    → (Phase 5 panel) pads/layers/env/LFO/mod matrix
                              ├── Mixer      → tabs · Fader+Meter · pan · mute/solo · sends ·
                              │                InsertPanel (add/reorder/bypass/params) · PDC
                              ├── Browser    → export/import/bounce/purge · filter · tag chips ·
                              │                favourites · drag-to-pad · audition
                              ├── Looper     → (Phase 6 panel) record / stop & save
                              ├── Perform    → scale|chords · root/octave · 16 pads
                              ├── XYFX       → axis pickers · latch · XYSurface
                              ├── Q-Link     → mode · encoders · input latency · binding table
                              └── Song       → playback mode · bounce song · playlist · add
App also mounts: PwaUpdatePrompt · ToastViewport;  AppShell mounts PerfHud · LiveRegion.
AppErrorFallback → Safe Mode: Export .mpcweb · Download .sqlite · Hard reset.
```

## 10. Kernel inventory — unchanged (the §5.6.4 set is complete):
`gainProof`, `lookaheadLimiter`, `multibandComp`, `fdnReverb`, `transientDetect`, `granularStretch`.

## 11. Open items / deliberate technical debt

**`check:stubs` reports ZERO open stubs** — §13.6 requires none from Phase 7 onward, and that gate
is met. The items below are *not* stubs; they are honest scope notes for the next sessions.

- **Groove template persistence:** templates and assignments live in runtime state and are wired
  end-to-end (extract → assign → schedule-time application). §9.3 names `projects.payload` as their
  durable home; adding them to `projectPayloadSchema` + the autosave path is a small, clearly-shaped
  follow-up.
- **Phase 6 panels retained as-is:** Sample Edit, Program Edit and Looper still use the functional
  `controls.tsx` inputs rather than the new Knob/Fader primitives. They are accessible, wired, and
  pass the 12-mode sweep — this is a visual-polish gap, not a functional one.
- **Looper:** mic source + bar-locked/tempo-synced length + overdub + live meter ring (master-resample
  mono capture is live).
- **Sample Edit:** draggable trim/marker handles and the §8.5.4 worker-computed peak-pyramid cache
  (peaks are drawn directly).
- **Browser:** folder tree (project/global navigation); filter/tags/favourites/drag-to-pad are live.
- **Grid:** the automation *lane editor* (the selector and the §7.8 lane data exist; drawing
  automation curves on the canvas is not implemented). Marquee multi-select (single-select is live).
- **XYFX/Q-Link:** XY movements are transient store updates but are not yet *recorded* as automation
  while the transport records (§8.5.10); the Q-Link learn flow accepts a parameter tap — the CC half
  arrives with the Phase 8 BLE transport, which is the natural place for it.
- **`transientDetect`:** FFT spectral-flux upgrade behind the seam (flagged in §14 (h)).
- **Bounce:** the full insert/mixer graph in the offline render (resolved-voice bounce is live).

## 12. Verification commands (all green at handover, inside the phase worktree)
`npm run dev` · `build` · `preview` · `test` (**562**) · `test:e2e` (**33/33**, dev + offline,
including "all 12 modes mount from the rail") · `test:e2e:quick` · `lint` · `type-check` ·
`verify` (**no open stubs**).
(The main checkout has no `node_modules`; `npm install` before re-running.)
