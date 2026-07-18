# BangerBox — Phase Handover (after Phase 8 — Hardware & Q-Link Ecosystem)

Generated at the close of Phase 8 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 8 merged to `main` (`--no-ff`). All §12 Phase 8 exit criteria green inside the
phase worktree before landing **except the live-hardware sign-off, which is outstanding and
requires the human developer** (see §11 below). Suite: **733 unit tests** (the Phase 0–7 suites
plus the Phase 8 additions — BLE-MIDI parser framing / running status / timestamp unwrap /
malformed input, CC throttle, Q-Link scaling and per-mode defaults, the Q-Link runtime driven
through the real stores, simulated-stream jitter and reconnect, binding persistence,
hardware-service wiring, the program-parameter store channel and its sync diff, the mixer
canonical-address fix, and the Q-Link Edit surface), `test:e2e` real-browser smoke — dev AND
offline — plus `lint`, `type-check`, `verify` (**no open stubs**), and `build`.

**Bundle size and load time remain deliberately unconstrained** (§11.5, §14 2026-07-18 (j)). Do
NOT reintroduce a size limit, a cold-load target, a size/timing gate in `npm run verify`, or
code-splitting undertaken to hit either. The remaining §11.5 runtime budgets (touch-to-sound,
underruns, 60 fps) are unchanged and still binding.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

1. Project name **BangerBox**; package `bangerbox`; "WEB-MPC" retired.
2. **npm** only; committed `package-lock.json`; Node ≥ 24 (`engines`).
3. **git** at project root; repo is public — no secrets, personal data, or real device identifiers.
   (Phase 8 note: no device IDs, MAC addresses, or pairing data are logged or committed.)
4. **No Tone.js.** Bespoke 960 PPQN lookahead scheduler in a **standard Web Worker**.
5. **AssemblyScript** for WASM DSP (`asc`, `--runtime stub -O3 --use abort=`), behind the §5.6 seam.
6. **`@sqlite.org/sqlite-wasm`**, worker-hosted, OPFS VFS.
7. **Hand-rolled typed promise-based `postMessage` RPC** (no Comlink).
8. **`motion`** (`'motion/react'`) for animation.
9. **No router** — 12 modes via `useUIStore.activeMode`, from the `MODE_DEFINITIONS` registry.
10. **No component library**; bespoke primitives; icons `lucide-react` via `src/ui/icons.ts` only.
11. **Zod** for all runtime validation — now including stored Q-Link bindings read back from
    `app_settings` (§10.3).
12. **fflate** (worker-side) for `.mpcweb`.
13. **Vitest** (unit, `happy-dom`) + **Playwright smoke on system Edge** (`channel: 'msedge'`).
14. **Local-first hosting**: `npm run dev`/`preview` with COOP/COEP from the Vite server.
15. **Chromium ≥ 120 desktop Windows** baseline; capability gate enforces at startup.
16. **Zustand = runtime truth; SQLite = durable truth**; hydrate on load, debounced autosave.
17. **960 PPQN.**
18. Audio defaults: 48 000 Hz / 24-bit / Float32 / `latencyHint: 'interactive'`.
19. **BLE-MIDI only** for MIDI input in v1 — **implemented this phase**. Web MIDI (USB) stays a
    §10.5 roadmap item and MUST NOT be built.

## 2. Spec deviations / corrections in effect

- **§14 2026-07-17 (e) (Phase 0):** worklet loading via `?worker&url`. Unchanged.
- **§14 2026-07-17 (f) (Phase 4):** clock-sync absolute-epoch domain. Unchanged.
- **§14 2026-07-17 (g) (Phase 5):** `arp` scheduler kind; program-scope automation grammar. Unchanged.
- **§14 2026-07-18 (h) (Phase 6):** `transientDetect` energy-flux detector (flagged for ratification);
  `reverb` uses `fdnReverb` when kernels are loaded; `granularStretch` = WSOLA. Unchanged.
- **§14 2026-07-18 (i) (Phase 7):** additive store fields; additive `groove` scheduler kind;
  `StartGate`; §9.1 worker write path; §9.5 bounce variants; §7.8 per-voice automation. Unchanged.
- **§14 2026-07-18 (k) (Phase 8) — NEW (read the changelog for full detail):**
  - **Registry extensions (additive, §7.8; no address form changed):** `amp.attack` /
    `amp.release` in `PROGRAM_PARAM_RANGES` (§10.3 names them as pad-mode defaults, and §7.8
    gates binding on registration); a new **`transportParam`** target kind carrying
    `transport.swing` / `transport.bpm` (§10.3 names "global swing", and
    `QLinkBinding.targetStore` already admitted `'transport'`). New `ENVELOPE_TIME_MS_RANGE`
    bounds what an *encoder* can dial, not what a payload may hold.
  - **Additive store actions:** `useProgramStore.setPadParamTransient` / `commitPadParam` — the
    §4.1 transient/commit channel for program-scope leaves, mirroring the mixer store.
  - **`SyncBridge.applyParam`** + the new `programParams` sync subscriber (§4.3), pushing
    sound-design edits to voices already sounding. Amp-envelope *times* are deliberately excluded
    from that push: an AHDSR is applied at note-on (§6), so they take effect on the next hit.
  - **`AudioEngine.triggerLiveNote(..., timestampMs?)`** (optional, defaulted — every existing
    caller is unchanged) and **`applyPitchBend`**.
  - **Pre-existing defect fixed:** `useMixerStore` parsed only a bare `<channelId>.<field>` form,
    so the canonical registry addresses the Mixer, XYFX and insert panels pass silently no-opped
    and those controls were dead (§3.4). Parsing now delegates to the registry that owns the
    grammar. The control taper moved from `ui/primitives/controlMaths.ts` into `core/math.ts`
    (re-exported, so no primitive's import changed).
  - **Web Bluetooth types declared locally** (`core/midi/bleTypes.ts`) — no new dependency.

## 3. Toolchain facts

- Installed majors unchanged (Vite 8.1.5, React 19, TS 6, Tailwind 4, Zustand 5, Zod 4,
  AssemblyScript 0.28, Vitest 4, Playwright 1.x, ESLint 9). **No new dependencies** — the §2.2
  closed matrix is intact. TypeScript ships no Web Bluetooth types; the used surface is declared
  in `src/core/midi/bleTypes.ts` (following the `worklet-globals.d.ts` precedent) rather than
  installing `@types/web-bluetooth`.
- `package.json` `config.phase` = **"8"**.
- `npm run build:wasm` builds six kernels; artefacts under `src/core/dsp/dist/` (gitignored).
- **`npm run test:e2e:quick`** (`--dev-only`, ~3–6 min) for iteration; the full `test:e2e`
  (dev + offline, ~15–20 min) stays the binding phase-exit proof.
- **BigInt lesson (still important):** `@sqlite.org/sqlite-wasm` returns INTEGER columns as
  **BigInt**. Coerce with `Number(...)`; never `JSON.stringify` a raw row.
- **Lint traps:** `react-hooks/exhaustive-deps` rejects a `??`-defaulted array feeding a `useMemo`
  (memoise the fallback so its identity is stable). The Phase 7 traps still stand
  (`react-hooks/refs`, `set-state-in-effect`, `jsx-a11y` on `<label>` / `<nav>`).
- Windows worktree-removal trap unchanged: kill stray `node`/`msedge`, `git worktree prune`, then
  `Remove-Item -Recurse -Force`.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–7 still stands. New this phase, all under `src/core/midi/`:

**The hardware chain (spec §10) — one direction, no shortcuts:**
`BleMidiTransport` → `createMidiParser` → `createMidiRouter` → (voice pool | `createQLinkRuntime`
→ store action) → sync layer → graph. `createHardwareService` is the *only* module that reaches
for the live engine and stores; everything below it is pure or injectable, which is what makes the
whole chain testable without hardware.

- **`parser.ts`** — pure BLE-MIDI framing (§10.1): running status across packets, the 13-bit
  timestamp unwrapped against arrival time, an in-packet low-byte wrap carried into the high bits,
  SysEx skipped safely across packets, malformed input dropped rather than thrown. `reset()` runs
  on every (re)connect so a pre-drop running status never applies to a new link.
- **`ccThrottle.ts`** — per-CC coalescing at `CC_THROTTLE_MS`, rAF-aligned, ±1 hysteresis with the
  raw extremes always admitted so a pot's travel ends stay reachable. `hysteresisSteps` /
  `endpoints` are configurable, which is how pitch bend reuses it for 14-bit values.
- **`qlink.ts`** (pure) — `bindingForCc`, `scaleCcToValue`, `relativeIncrement` (two's complement),
  `nextValueForCc`, `defaultBindingsForMode`. Encoder travel maps through the **same taper**
  (`core/math`) the on-screen primitives draw, so a hardware turn and a knob drag agree.
- **`bleTransport.ts`** — `navigator.bluetooth` is **injected**, which is what makes the §12
  jitter/reconnect tests possible with no hardware. Three retries with doubling backoff, then idle
  for a user prompt; a deliberate disconnect suppresses auto-reconnect. `settled()` is the test seam.
- **`router.ts`** — notes on the §7.6 dual path (never throttled — every hit must sound) carrying
  the §10.2 latency offset; pitch bend to keygroup voices only, scaled by `pitchBendRange`; CC
  through the throttle into the runtime.
- **`qlinkRuntime.ts`** — the §10.3 execution flow. Dispatch keys off the **parsed registry
  address**, not the binding's `targetStore` field, because the address is authoritative and cannot
  disagree with itself. Transient during the turn, one commit after `QLINK_COMMIT_IDLE_MS` (250 ms).
- **`qlinkBindings.ts`** — `loadBindingsForMode` (Zod-validated read from `app_settings`); the
  write half is the existing autosave `settings:qlink:<mode>` dirty key. A mode with nothing
  stored clears the store, which is what lets `defaultBindingsForMode` apply.
- **`hardwareService.ts`** — the app-wide singleton. Mirrors connection state into
  `useHardwareStore` (so the UI reads hardware status like any other state), toasts a drop, and
  exposes `onNextControlChange` for the learn flow's CC half.
- **`ui/useQLinkFocus.ts`** — the Screen-mode focus registry hook (§10.3). A panel publishes its
  parameters while mounted and withdraws them on unmount, but only if its own list is still the one
  in force, so a panel mounting as another unmounts is not clobbered. `InsertPanel` uses it — the
  spec's own Delay example.

**Store additions:** `useProgramStore.setPadParamTransient` / `commitPadParam` (the §4.1 channel
for §6 sound-design leaves; `pitch` is the pad tune and moves every layer together, §5.5).
**Sync additions:** `store/syncLayer/programParams.ts` — the pure `changedPadLeaves` diff plus
`SyncBridge.applyParam`.
**Engine additions:** `triggerLiveNote(..., timestampMs?)`, `applyPitchBend`,
`VoicePool.applyProgramDetune`.

## 5. Repository catalogue — unchanged. No repository or DDL change in Phase 8.
Q-Link bindings use the existing `app_settings` table through `SettingsRepository`.

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1** = the §9.3 DDL verbatim
(`src/core/storage/migrations/001-initial-schema.ts`). **No migration added in Phase 8.**

## 7. Worker / worklet / message protocol versions

- **DB worker RPC:** unchanged. **Worklets:** unchanged.
- **Scheduler worker:** `SCHEDULER_PROTOCOL_VERSION = 1`, kinds unchanged — Phase 8 added none.
  BLE notes reuse the existing `liveNote`, now carrying the reconstructed, latency-compensated
  timestamp instead of "on receipt" (§10.4).
- **Sync-layer bridge (`audioBridge.ts`):** gains `applyParam`; `applyAutomation` now also
  recognises — and deliberately ignores — `transportParam` addresses, which belong to the
  scheduler rather than the graph.

## 8. Stores — all eight implemented (§4.2).
Phase 8 added **actions only**; no field was added or removed, so hydration is unchanged and
pre-Phase-8 snapshots load untouched.

## 9. Component tree topography (as implemented)

Unchanged from Phase 7 except:
- **Q-Link Edit** → connection panel (state readout, Connect/Disconnect, device name, the
  **Windows pairing helper**, and a Web-Bluetooth-unavailable note) · mode · encoders · input
  latency · binding table, now with a **CC** column and a registry-driven picker offering the
  transport macros, the selected pad's sound-design leaves, and every mixer channel address ·
  learn flow taking a parameter tap **or** a real CC from the controller.
- **Mixer → InsertPanel** publishes its effect parameters to the Screen-mode Q-Link focus registry.

## 10. Kernel inventory — unchanged (the §5.6.4 set is complete):
`gainProof`, `lookaheadLimiter`, `multibandComp`, `fdnReverb`, `transientDetect`, `granularStretch`.

## 11. Outstanding / deliberate technical debt

**`check:stubs` reports ZERO open stubs** (§13.6 requires none from Phase 7 onward).

**OUTSTANDING PHASE-8 EXIT CRITERION — READ THIS FIRST:**
- **The live hardware session sign-off (§12) is NOT done, and cannot be self-certified.** It
  requires the human developer, a physical ESP32 BLE-MIDI controller, and a Windows pairing.
  Everything that sign-off would exercise is covered by simulated-stream tests against an injected
  fake GATT stack — which is *not* the same proof. **Ask the human developer to run a live session
  before treating Phase 8 as closed.** Things to watch for: real-device timestamp drift against the
  13-bit unwrap; the actual CC numbers a given ESP32 build emits (the learn flow exists for exactly
  this, and `DEFAULT_QLINK_CC_BASE = 70` is only a convention); whether 15 ms is a sensible default
  input-latency offset on real hardware; and reconnect behaviour on a genuine range drop.

**Not stubs — honest scope notes:**
- **Q-Link `program` mode** addresses registered §7.8 leaves of the selected pad rather than a
  macro layer, because §6 defines no macro system and inventing one would breach §3.1 Strategic
  YAGNI and the §13.6 naming freeze. True program macros are a §6 schema addition, therefore a
  Halt & Query.
- **"Master filter"** (§10.3's third project-mode macro) has no default binding: it is an insert
  whose presence is not guaranteed. The manual picker reaches it once a filter insert exists.
- **Recording Q-Link movements as automation** (§7.8: "Q-Link/knob movements while recording write
  points") is not implemented. The same gap exists for XYFX from Phase 7 — they should be closed
  together, since both want one "record this parameter gesture" path.
- Phase 7's remaining notes still stand: groove-template persistence; the Phase 6 panels using
  `controls.tsx` rather than the new primitives; Looper mic source / overdub; Sample Edit drag
  handles and the peak-pyramid cache; Browser folder tree; Grid automation-lane drawing and marquee
  select; the `transientDetect` FFT upgrade; the full insert/mixer graph in the bounce.

## 12. Verification commands (all green at handover, inside the phase worktree)
`npm run dev` · `build` · `preview` · `test` (**733**) · `test:e2e` (dev + offline) ·
`test:e2e:quick` · `lint` · `type-check` · `verify` (**no open stubs**).
(The main checkout has no `node_modules`; `npm install` before re-running.)
