# BangerBox — Web-Based Music Production Centre (Web MPC) Specification

**Status:** Ready for implementation • **Rewritten:** 2026-07-17 • **Supersedes:** the 2026-07 draft ("WEB-MPC")

---

## 0. Document Status, Authority & Maintenance

- **Single source of truth.** This document is the absolute specification and implementation guide for an autonomous AI agent building BangerBox. All architectural plans, schemas, execution phases, and hardware integration requirements reside in this single file (`docs/todo/_spec.md`). Do not split it across multiple files. Companion _outputs_ (e.g. `docs/dev/PHASE_HANDOVER.md`, §13.1) are permitted; companion _specifications_ are not.
- **Requirement language.** **MUST / MUST NOT** are binding; **SHOULD** is binding unless a documented reason to deviate is recorded in §14; **MAY** is optional. "Forbidden" means the agent halts rather than doing it.
- **Completeness rule.** Every technical constraint, schema field, and execution step herein is binding. When editing this document, preserve all technical content — restructure freely, but never silently drop a constraint. Record every substantive change in the Changelog (§14).
- **Conflict resolution.** If two sections appear to conflict, the more specific section wins; if still ambiguous, the Locked Decisions (§1.3) win; if still ambiguous, halt and ask the human developer (§13.3.2).
- **Stable numbering.** Section numbers are permanent anchors — code comments reference them (`// spec §7.1.4`, §13.6). When editing, append new subsections rather than renumbering existing ones.

## 1. Introduction

### 1.1 Product Summary

BangerBox is an **offline-first, browser-based Digital Audio Workstation, sequencer, and sampler** — modelled on the workflow of the Akai MPC Live series, but expanded without artificial hardware limitations. It runs entirely client-side as an installable Progressive Web App: audio lives in the Origin Private File System, project data lives in WASM SQLite, and heavy DSP runs in AudioWorklets backed by WebAssembly. The primary target device is a Windows tablet (e.g. Microsoft Surface) running a Chromium browser, driven by touch and by a custom ESP32-based BLE-MIDI controller.

### 1.2 Core Principles

- **No monolithic files, no God objects.** Code is modular, separated by feature and responsibility (§2.5, §3.1).
- **Performance first.** Sample-accurate timing, AudioWorklets for heavy DSP, SharedArrayBuffer for high-frequency Worklet→UI data, canvas + `requestAnimationFrame` for all metering and playheads (§3.3, §5.5).
- **Offline first.** The application MUST function fully with the network disabled: Vite-built PWA, Service Worker precache, OPFS, WASM SQLite. No cloud dependency of any kind.
- **Unidirectional data flow.** UI → Zustand → sync layer → audio graph. Nothing skips a step (§3.1).
- **Strict phasing.** Every implementation phase (§12) completes its exit criteria and passes the Multi-Lens Review (§3.5) before the next begins.
- **British English.** All source code identifiers, comments, documentation, and UI labels use British English spelling (initialisation, synchronise, behaviour, colour). The locale is `en-GB`.
- **Premium, tactile aesthetic.** The interface must feel like high-end hardware, not a static web page: immediate touch feedback, purposeful motion, dense-but-legible layouts (§8.3).

### 1.3 Resolved Clarifications & Locked Decisions

_The following decisions resolve every ambiguity in the superseded draft. They are **binding for all phases** and MUST be restated in every `PHASE_HANDOVER.md` (§13.1). Where a decision refines an earlier open option, the governing section is cited. They may be revised only by the human developer, recorded in §14._

1. **Project name: BangerBox.** Package name `bangerbox`. The working title "WEB-MPC" is retired.
2. **Package manager: npm.** Committed `package-lock.json`; no pnpm/yarn/bun lockfiles. Node ≥ 24 (`engines` field; the dev machine runs Node 25).
3. **Version control:** a **git** repository MUST be initialised at the project root in Phase 0 (required by the rollback protocol, §13.4). The repository is assumed public — no secrets, no personal data, no real device identifiers may ever be committed.
4. **Tone.js is rejected.** The superseded draft named Tone.js for the timing layer while simultaneously mandating a Web Worker scheduler and forbidding sequencer logic outside it. Resolution: **no Tone.js**. Timing is a bespoke 960 PPQN lookahead scheduler in a dedicated Web Worker (§7.1); the audio graph is built directly on the Web Audio API. No audio-framework dependency of any kind.
5. **WASM DSP language: AssemblyScript.** The dev machine has no Rust or Emscripten toolchain, and requiring one would break the "runnable completely locally via npm" mandate. AssemblyScript (`assemblyscript` dev-dependency, compiled with `asc` via `npm run build:wasm`) provides WASM with explicit linear-memory control using an npm-only toolchain. All DSP kernels MUST be written behind the kernel seam defined in §5.6 so that individual kernels can later be re-implemented in Rust/C++ without touching consumers, if profiling ever demands it. `vite-plugin-wasm` is **not** required (worklet WASM is loaded via transferred bytes, §5.6.2).
6. **SQLite distribution: official `@sqlite.org/sqlite-wasm`**, worker-hosted, on the OPFS VFS (SharedArrayBuffer-coordinated) — the configuration proven to work for this workload. No wa-sqlite, no sql.js, no IndexedDB fallback for primary data.
7. **RPC bridge: hand-rolled, strictly typed promise-based `postMessage` wrapper.** Comlink is not added.
8. **Animation library: `motion`** (the successor package to Framer Motion; import from `motion/react`). Every reference to "Framer Motion" in this document means this package.
9. **No router library.** BangerBox is a single-screen application with 12 modes (§8.5) switched via `useUIStore.activeMode`. TanStack Router / React Router are forbidden.
10. **No component library.** All controls (pads, knobs, faders, meters) are bespoke primitives in `src/ui/primitives/` (§8). shadcn/ui, Radix, MUI, Chakra, Ant are forbidden. Icons: **`lucide-react`** exclusively, re-exported through `src/ui/icons.ts`.
11. **Validation: Zod** for all runtime schema validation — program payloads, `.mpcweb` import, RPC payload guards, BLE payload sanitisation.
12. **Compression: `fflate`** (worker-side) for `.mpcweb` pack/unpack (§9.6).
13. **Testing: Vitest** (unit, `happy-dom`) plus a **Playwright real-browser smoke** driving the system-installed Edge (`channel: 'msedge'` — no browser binary download), asserting `crossOriginIsolated === true` and exercising the real OPFS/worklet path (§11). Jest is forbidden.
14. **Hosting target: local-first.** The canonical execution environment is `npm run dev` / `npm run preview` on the target tablet, with COOP/COEP headers set by the Vite server. **A GitHub Pages deployment now also exists** (requested by the human developer; §14 2026-07-18 (m)) — the single custom `src/sw.ts` performs both precache and COOP/COEP header injection, `public/coi-bootstrap.js` registers that worker and reloads once so the first visit becomes isolated, and the base path is `/BangerBox/` via the `BANGERBOX_BASE` env var set only by the deploy workflow. Pages is a **mirror, not the canonical environment**: it deploys manually via `workflow_dispatch`, and `npm run dev` / `npm run preview` remain the reference execution path against which behaviour is judged.
15. **Browser baseline: Chromium ≥ 120 on desktop-class Windows.** Firefox and Safari are unsupported in v1 — untested, not developed against, and out of scope for bug fixing beyond start-up (Web Bluetooth and stable OPFS-SAB behaviour require Chromium). **The §2.1 gate enforces this by capability, never by browser identity** (§14 2026-07-18 (n)): a browser that genuinely has every hard requirement runs, whatever its name, and one that does not is blocked with a per-requirement explanation. A non-Chromium engine that passes therefore reaches the app and receives a dismissible "not supported" notice rather than a wall. UA sniffing (`detectBrowser`) drives that notice and the wording of advice only — it MUST NOT gate access, because a capability probe cannot be wrong about what the browser can do and a UA string can.
16. **State ownership:** Zustand is the **runtime** source of truth; SQLite is the **durable** source of truth. Hydrate stores from SQLite on project load; persist via debounced write-behind autosave (§4.4). React state never duplicates either.
17. **Sequencer resolution: 960 PPQN** (the superseded draft's embedded image rendered this value unreadable; it is 960).
18. **Audio defaults:** project sample rate default **48 000 Hz** (options 44 100/48 000/96 000), storage bit depth default **24-bit** (options 16/24/32-float). All in-engine processing is Float32. `AudioContext` `latencyHint: 'interactive'`.
19. **MIDI input transport: Web Bluetooth (BLE-MIDI) only in v1.** Web MIDI (USB) is a recorded roadmap item (§10.5), not in scope.

#### 1.3.1 Derived Defaults (Not Separately Polled)

- 128 drum pads per drum program (8 banks × 16); pad index = MIDI note 0–127 (`bank × 16 + padIndex`).
- 4 send/return channels; 4 insert slots per pad, per track, and on the master (configurable 1–8 via `globalInsertLimit`).
- Default velocity layers per pad: up to 4 (soft-configurable to 8).
- Minimum 4 concurrent keygroup programs (user-configurable upward).
- Global polyphony 64 voices (§5.4).
- Undo history capped at 100 entries (§4.5).
- Q-Link hardware encoders: 4 by default, supported up to 16 (§10.3).
- en-GB locale for all formatting (`Intl.*`; no date/number libraries).
- UUIDs via `crypto.randomUUID()` — the `uuid` package is forbidden.

### 1.4 Non-Goals (v1)

Explicitly out of scope — the agent MUST NOT build bridging code for these: cloud sync or any network feature beyond PWA asset caching; multi-user collaboration; VST/plugin hosting; MIDI _output_ to external gear; audio-interface input tracks beyond the Looper (§8.5.8); video; notation; internationalisation beyond en-GB (all strings are plain literals — no i18n framework); mobile-phone form factors (tablet/desktop only); Firefox/Safari support (§1.3 #15 — they are not developed against or tested; the capability gate does not lock them out, but no work is undertaken to make them work).

### 1.5 Glossary

| Term            | Meaning                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| **PPQN**        | Pulses Per Quarter Note — the sequencer's internal tick resolution (960).                                     |
| **Pad**         | One of 128 trigger cells in a drum program, owning layers, envelopes, LFOs, mod matrix, and mixer parameters. |
| **Program**     | A playable instrument definition (Drum or Keygroup) targeted by tracks.                                       |
| **Sequence**    | A pattern: a set of tracks with MIDI events and sequence-scoped automation, with its own length/tempo/swing.  |
| **Track**       | A lane inside a sequence holding MIDI events, targeting one program, with its own mixer channel.              |
| **Q-Link**      | A context-aware mapping from a hardware encoder to an application parameter (§10.3).                          |
| **Choke group** | Pads sharing a group number cut each other off (e.g. closed hat chokes open hat).                             |
| **OPFS**        | Origin Private File System — browser-private persistent storage for audio blobs and the SQLite file.          |
| **SAB**         | SharedArrayBuffer — shared memory between threads, used with `Atomics`.                                       |
| **PDC**         | Plugin Delay Compensation — delaying parallel dry paths to match effect latency (§5.7.3).                     |

## 2. Target Environment, Stack & Project Configuration

### 2.1 Runtime Baseline & Capability Gating

On startup, **before** any store hydration or audio code, the app MUST run a capability gate that feature-detects:

- **Hard requirements** (missing ⇒ render a friendly, styled blocking screen explaining exactly what is missing and which browser to use; nothing else loads): `crossOriginIsolated === true`, `SharedArrayBuffer`, `AudioWorklet`, `navigator.storage.getDirectory` (OPFS), `WebAssembly`, `Atomics`.
- **Soft requirements** (missing ⇒ feature is hidden/disabled with an explanatory tooltip, app still runs): `navigator.bluetooth` (hardware mode), `navigator.mediaDevices.getUserMedia` (Looper mic source), `navigator.storage.persist`, Screen Wake Lock.

All feature detection lives in `src/core/platform/capabilities.ts` and is executed exactly once; results are frozen into `useUIStore.capabilities`.

### 2.2 Dependency & Tooling Matrix

The dependency surface is **closed**: only the packages below may appear in `package.json`. Adding any other package requires a Halt & Query (§13.3.2). Versions follow the latest stable at install time; these majors are known to interoperate: Vite 8, React 19, TypeScript 6, Tailwind 4, Zustand 5.

**Runtime dependencies**

| Package                                              | Purpose                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `react`, `react-dom`                                 | UI (React 19, functional components + hooks only)          |
| `zustand`                                            | State management (modular slices, `subscribeWithSelector`) |
| `zod`                                                | Runtime schema validation                                  |
| `@sqlite.org/sqlite-wasm`                            | Durable store (worker-hosted, OPFS VFS)                    |
| `fflate`                                             | `.mpcweb` zip pack/unpack in a worker                      |
| `motion`                                             | Animation (`motion/react`)                                 |
| `lucide-react`                                       | Icons (via the `src/ui/icons.ts` registry only)            |
| `clsx`, `tailwind-merge`, `class-variance-authority` | Class composition for primitives                           |
| `react-error-boundary`                               | Global error boundary / Safe Mode (§8.1)                   |

**Dev dependencies:** `vite`, `@vitejs/plugin-react`, `typescript` (strict), `tailwindcss` + `@tailwindcss/vite`, `vite-plugin-pwa`, `assemblyscript`, `vitest`, `happy-dom`, `@testing-library/react` (+ `user-event`, `jest-dom`), `playwright`, `eslint` (+ `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `eslint-config-prettier`), `prettier`, `@types/*`.

**Forbidden (non-exhaustive):** Tone.js, Howler, standardized-audio-context, RxJS, Redux/MobX/Jotai/Recoil, react-router/TanStack Router, shadcn/Radix/MUI/Chakra/Ant, styled-components/Emotion, Comlink, uuid, lodash/underscore, moment/dayjs/date-fns, axios, jszip, sql.js, wa-sqlite, Next.js/Remix or any SSR meta-framework.

**Native-API preference:** `crypto.randomUUID()`, `Intl.NumberFormat`/`Intl.DateTimeFormat`, `structuredClone`, `BroadcastChannel`, Web Locks, `AbortController` — always preferred over a package.

### 2.3 Vite Configuration Requirements

`vite.config.ts` MUST:

1. Serve **cross-origin isolation headers** on both `server` and `preview`: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` (required for SharedArrayBuffer and the SQLite OPFS VFS).
2. Set `worker: { format: 'es' }`.
3. Set `optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] }` (official guidance; the package ships its own worker + wasm asset).
4. Register `@tailwindcss/vite` and `@vitejs/plugin-react`.
5. Configure `VitePWA` with `strategies: 'injectManifest'`, `srcDir: 'src'`, `filename: 'sw.ts'`, `registerType: 'prompt'`, `injectRegister: null`, and a precache glob including `wasm` (`**/*.{js,css,html,wasm,woff2,svg,ico,png}`) with `maximumFileSizeToCacheInBytes` raised to 16 MiB (SQLite + DSP wasm binaries). `devOptions.enabled: false` — dev relies on server headers, not the SW.
6. Alias `@` → `./src`.
7. Expose `__APP_VERSION__` via `define` from `package.json` (single-sourced version).
8. AudioWorklet processor modules are built as real files (via Vite's `?worker&url` import suffix, which emits an es-format worklet chunk — see §2.7 and §14 2026-07-17 (e)), never inlined as blob/data URLs — blob workers break under strict COEP.
9. The Vitest `test.exclude` MUST include `**/.claude/worktrees/**`, and `.gitignore` MUST include `.claude/worktrees/`: concurrent-agent worktrees (§13.3.4) carry full copies of `src/` and their own `node_modules`, and sweeping them loads a second React into the suite, breaking hooks for every test.

### 2.4 PWA Manifest & Service Worker

- **Manifest:** `id`/`scope`/`start_url` `/`; `name` "BangerBox"; `short_name` "BangerBox"; `display: 'standalone'`; `orientation: 'landscape'` (primary form factor is a landscape tablet); `lang: 'en-GB'`; dark `theme_color`/`background_color` matching the design tokens; SVG master icon + 192/512 PNG + separate 512 maskable PNG (generated by a `scripts/generate-icons.mjs` from a single glyph — never reuse the `any` icon as `maskable`).
- **Service worker (`src/sw.ts`):** custom `injectManifest` worker handling precache + offline navigation fallback. Update flow is **prompt-based**: a new build waits until the user accepts a "Reload to update" toast — never reload out from under an unsaved project.
- **Update prompt component** registers via `virtual:pwa-register` in app code.
- The SW MUST NOT intercept OPFS or blob URLs; it caches only the static app shell. Audio data never transits the SW.
- **Wake Lock:** while the transport is playing or recording, request a Screen Wake Lock (feature-detected, released on stop/blur).

### 2.5 Repository Layout (Strict)

Feature-based architecture. Never put all Zustand slices in one file; never put all AudioNodes in one file.

```
/src
  /core
    /platform/        capabilities.ts, wakeLock.ts, multiTabGuard.ts
    /audio/           context bootstrap, node factories + destroyNode, voice pool,
                      graph builders (mixer/master/returns), insert-slot wrapper,
                      metering tap, metronome, preview channel
      /worklets/      *.worklet.ts AudioWorkletProcessor modules
      /params/        parameter address registry + AudioParam ramp helpers
    /dsp/             kernel seam (TS interfaces), AssemblyScript sources (/assembly),
                      built wasm artefacts (/dist, gitignored), kernel loader
    /sequencer/       scheduler.worker.ts, clock-sync, PPQN maths (pure),
                      swing/quantise/groove (pure), note-repeat/arp (pure)
    /storage/         opfs.ts (typed OPFS wrapper), db.worker.ts, rpc.ts (typed bridge),
                      migrations/, repositories/ (ProjectRepository, SequenceRepository,
                      ProgramRepository, SampleRepository, ...)
    /midi/            ble transport, BLE-MIDI packet parser (pure), message router
    /project/         autosave, load/hydrate, .mpcweb pack/unpack (+ pack.worker.ts)
  /store/             one file per slice: useTransportStore.ts, useProjectStore.ts,
                      useTrackStore.ts, useProgramStore.ts, useMixerStore.ts,
                      useUIStore.ts, useHardwareStore.ts, useBrowserStore.ts,
                      undo/ (command core), syncLayer/ (store→graph subscribers)
  /ui
    /primitives/      Pad, Knob, Fader, XYSurface, MeterCanvas, WaveformCanvas,
                      TransportBar, ValueReadout, Toggle, SegmentControl, Modal, Toast
    icons.ts          lucide re-export registry
  /features/          one directory per mode: main/, grid/, muting/, sample-edit/,
                      program-edit/, mixer/, browser/, looper/, pad-perform/,
                      xyfx/, qlink-edit/, song/
  /styles/            index.css (design tokens: colours, spacing, radii, easings)
  /test/              setup, worklet/worker mocks, OfflineAudioContext helpers
  sw.ts
/assembly/            (AssemblyScript kernel sources, if not under src/core/dsp)
/scripts/             generate-icons.mjs, browser-smoke.mjs, build-wasm invocation,
                      build-factory.mjs (§9.8 factory packs)
/public/factory/      generated .mpcweb packs + index.json (gitignored artefact, §9.8)
/docs/dev/            PHASE_HANDOVER.md (generated per §13.1)
```

Pure logic (PPQN maths, swing, groove, BLE parsing, mod-matrix evaluation, AST-free of DOM/audio types) MUST live in dependency-free modules so it is trivially unit-testable.

### 2.6 Engine Constants Registry

All timing/behaviour constants live in `src/core/constants.ts` — never as magic numbers at call sites:

| Constant                 | Value | Meaning                                                |
| ------------------------ | ----- | ------------------------------------------------------ |
| `PPQN`                   | 960   | Sequencer resolution                                   |
| `LOOKAHEAD_MS`           | 100   | Scheduler lookahead window                             |
| `SCHEDULER_INTERVAL_MS`  | 25    | Worker scheduling wake interval                        |
| `CLOCK_SYNC_INTERVAL_MS` | 250   | Main→worker clock model refresh                        |
| `VOICE_STEAL_FADE_MS`    | 5     | Fade applied to a stolen voice                         |
| `CHOKE_FADE_MS`          | 20    | Fade applied to choked pads                            |
| `DECLICK_FADE_MS`        | 3     | Fade applied at the natural end of a voice             |
| `PARAM_RAMP_MS`          | 10    | Dezipper ramp for live parameter changes               |
| `MAX_VOICES`             | 64    | Global voice pool size                                 |
| `AUTOSAVE_DEBOUNCE_MS`   | 2000  | Write-behind autosave debounce                         |
| `CC_THROTTLE_MS`         | 16    | Min interval between applied CC updates per controller |
| `UNDO_LIMIT`             | 100   | Undo stack depth                                       |

### 2.7 Pinned API Contract (Anti-Hallucination Reference)

LLM agents reliably hallucinate _plausible_ API shapes from outdated training data. The forms below are the **only** correct ones for this project's dependency majors. The general rule is binding: **never write a library call from memory** — when uncertain, read the installed package's `.d.ts` under `node_modules/`, or an existing working call site in this repo, before writing the call site. If reality (installed types, runtime behaviour) contradicts this table, that is a Halt & Query (§13.3.2) — correct the table via §14, never silently improvise.

| Concern                   | Canonical form                                                                                                                                                                                                | Known hallucination to avoid                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Animation                 | `import { motion, AnimatePresence } from 'motion/react'`                                                                                                                                                      | `from 'framer-motion'` (retired package name)                                                                                                                                                        |
| SQLite init (worker only) | `import sqlite3InitModule from '@sqlite.org/sqlite-wasm'` → `const sqlite3 = await sqlite3InitModule(...)` → `new sqlite3.oo1.OpfsDb('/bangerbox.sqlite3')` — see `db.worker.ts` for the proven bootstrap | wa-sqlite / sql.js API shapes; opening the OPFS DB outside the worker                                                                                                                                |
| Tailwind 4                | CSS-first: `@import 'tailwindcss';` + `@theme { … }` token blocks in `src/styles/index.css`; Vite plugin `@tailwindcss/vite`                                                                                  | v3-era `tailwind.config.js`, `content` arrays, `@tailwind base/components/utilities` directives                                                                                                      |
| Zustand 5                 | `export const useXStore = create<XState>()(subscribeWithSelector((set, get) => ({ … })))` (curried `create`)                                                                                                  | v3/v4 non-curried middleware patterns; default-export stores                                                                                                                                         |
| React 19                  | `createRoot(el).render(<App />)`; function components + hooks only                                                                                                                                            | `ReactDOM.render`, class components, `PropTypes`                                                                                                                                                     |
| PWA registration          | `virtual:pwa-register` module imported in app code (see §2.4)                                                                                                                                                 | hand-rolled inline `navigator.serviceWorker.register` scripts                                                                                                                                        |
| Worklet loading           | `import workletUrl from './x.worklet.ts?worker&url'` → `audioContext.audioWorklet.addModule(workletUrl)` (Vite emits a real es-format chunk; see §14 2026-07-17 (e))                                          | blob-URL workers/worklets (break under strict COEP); bare `addModule(new URL('./x.worklet.ts', import.meta.url))` — Vite 8 has no worklet handling for that form and inlines raw TS as a `data:` URL |
| WASM → worklet            | compile `WebAssembly.Module` on the main thread; pass it via `processorOptions`; instantiate inside the processor constructor (§5.6.2)                                                                        | `fetch()` inside `AudioWorkletGlobalScope` (does not exist there)                                                                                                                                    |
| Clock sync source         | `audioContext.getOutputTimestamp()` → `{ contextTime, performanceTime }` (§7.1.2)                                                                                                                             | reading `audioContext.currentTime` from a worker                                                                                                                                                     |
| AssemblyScript build      | `asc` with `--runtime stub -O3` (release); manual buffer lifetime via `heap.alloc` / `heap.free`                                                                                                              | the default incremental-GC runtime (GC in the render path defeats the purpose)                                                                                                                       |
| UUIDs                     | `crypto.randomUUID()`                                                                                                                                                                                         | the `uuid` package                                                                                                                                                                                   |
| Playwright                | `chromium.launch({ channel: 'msedge' })` (system browser)                                                                                                                                                     | downloading a bundled Chromium                                                                                                                                                                       |

## 3. Strict Engineering Guardrails

### 3.1 Architecture Rules

- **Unidirectional flow (strict):** UI components MUST NEVER mutate AudioNodes, worker state, or the DB directly. Correct flow: _UI action → Zustand store action → sync layer (`subscribeWithSelector` subscribers) → audio graph / scheduler worker / repository_. The single exception is read-only rAF rendering (meters/playheads) reading SABs (§3.3).
- **Composition over inheritance.** React functional components with custom hooks; instruments composed from small pure DSP nodes and factories, never large classes with inheritance trees.
- **Repository pattern.** React code never contains SQL. All SQL lives in `src/core/storage/repositories/*`, called through the typed RPC bridge into the DB worker.
- **Strategic YAGNI.** Implement the extensible architecture defined here; do not write bridging code for unrequested large-scale features (see §1.4). Shared utilities that serve modularity/performance (event bus, ring buffers, debouncers, math mappers, clamp/scale helpers) are explicitly permitted.

### 3.2 Memory & Resource Management (Crucial Audio Guardrails)

- Every node-creating factory MUST have a paired `destroy` that calls `disconnect()` on every node it created, cancels scheduled `AudioParam` events, and drops all references. Orphaned nodes are a critical failure. Pad clear, program change, project close, and mode unmount all route through these destroys.
- Temporary `AudioBuffer`s (decode intermediates, editor previews) MUST be actively dereferenced when replaced.
- **WASM linear memory** allocated for a worklet kernel (reverb tails, granular windows) MUST be freed via the kernel's exported `free()` when the node is destroyed (§5.6.3). Kernel instances are per-node, never shared.
- SABs are allocated once per concern (meter bus, playhead, looper ring) and pooled — never allocated per frame.
- `AudioBufferSourceNode`s self-release on `ended`; the voice pool (§5.4) removes registry entries in the `ended` handler.

### 3.3 React Render Optimisation (Anti-Lag)

- High-frequency values (playhead tick, VU levels, waveform scroll, XY touch position, knob drag angle mid-gesture) MUST NEVER pass through React state or Zustand-driven React re-renders. They render via rAF onto `<canvas>` or via direct ref style writes.
- Zustand consumers select the narrowest slice (`useStore(s => s.bpm)`) — never whole-store subscriptions in components.
- Knob/fader drags update the audio graph continuously (through the store's _transient_ channel, §4.3) but commit a single undo entry on gesture end.

### 3.4 Definition of Done & Wiring Rules

- **Scaffolding policy:** iterative development is expected. State + audio graph may be built and verified with stub UI first; the polished UI follows (§12 sequencing). However, **dead final UI is a critical failure**: every shipped control is wired end-to-end.
- **Orphan-proofing:** every exported function, store, or component is imported and used within the live application tree. No speculative exports.
- **State-to-graph verification:** on mount, every control reflects the _current_ store value, and the store value reflects the actual node state (hydration order: DB → store → graph → UI).

### 3.5 Multi-Lens Feature Gating & Review Protocol

Every feature passes all five lenses before the next task begins; failing any lens means refactor first:

1. **Accessibility (WCAG):** ARIA (`role`, `aria-label`, `aria-valuemin/max/now` on every knob/fader/pad), full keyboard operation, visible focus rings, contrast ≥ WCAG AA, `prefers-reduced-motion` honoured.
2. **Spatial & alignment:** fluid responsive layout (CSS Grid/Flex, `gap`, `rem`, `dvh`); no absolute-pixel guesswork; minor padding polish defers to human visual QA.
3. **DSP & wiring:** store↔graph synchronised per §3.4; unmount paths verified leak-free.
4. **Offline & cache:** feature works with DevTools network disabled; assets routed through SW precache/OPFS.
5. **Memory & resources:** WASM freed, nodes disconnected, SAB/rAF loops cancelled on unmount (verify via `performance.memory`/heap snapshots during review).

### 3.6 Styling Discipline & Design Tokens

- **Tailwind CSS only** — no bespoke CSS files beyond `src/styles/index.css` (token definitions + keyframes), no CSS-in-JS.
- Every colour, easing, radius, shadow, and animation value comes from a **design token** defined in `src/styles/index.css` and exposed as Tailwind utilities. Raw hex/`oklch()` literals or ad-hoc palette classes (`bg-red-500`) in components are forbidden. Dark theme is the default aesthetic; tokens carry both themes.
- Reusable visual behaviour (velocity glow, pad press, meter gradient) is a primitive variant, never re-styled at call sites — ZERO DRY violations in `src/ui/primitives/`.

### 3.7 Language Standardisation

British English everywhere: identifiers (`initialiseAudioContext`, `colourScheme`), comments, docs, UI copy. Web-platform API names obviously keep their spelling (`AnalyserNode` is coincidentally already correct; `AudioContext` etc. are unchanged).

## 4. State Management Architecture (Zustand)

### 4.1 Principles

- One file per slice under `src/store/`, each created with `subscribeWithSelector` middleware.
- Stores hold **runtime truth**; SQLite holds **durable truth** (§1.3 #16). Hydration on project load; write-behind autosave on mutation (§4.4).
- Stores expose **actions** (named methods) — components never call `setState` directly. Actions validate inputs (clamp ranges) before committing.
- A lightweight **transient channel** exists per store for continuous gestures: `setTransient(path, value)` updates subscribers (sync layer) without creating undo entries or autosave writes; `commit(path, value)` finalises (undo + autosave). Both flow through the same sync layer.

### 4.2 Store Catalogue

All interfaces below are binding (fields may be _added_ with a changelog entry; never removed).

**`useTransportStore`**

```ts
interface TransportState {
  isPlaying: boolean;
  isRecording: boolean;
  countInBars: 0 | 1 | 2;
  metronomeEnabled: boolean;
  metronomeLevel: number; // 0..1
  recordMode: 'overdub' | 'replace';
  playbackMode: 'sequence' | 'song';
  activeSequenceId: string | null;
  bpm: number; // effective tempo (follows active sequence, §7.9)
  swingAmount: number; // 50..75 (%)
  swingDivision: 8 | 16; // swung subdivision (1/8 or 1/16)
  loopEnabled: boolean;
  loopStartTick: number; // 960 PPQN
  loopEndTick: number;
  // NOTE: currentTick is NOT stored here — the playhead position lives in the
  // scheduler SAB (§7.1.4) and is read by canvases via rAF. The store keeps only
  // a coarse bar:beat readout updated at most 4×/second for accessible text display.
  coarsePosition: { bar: number; beat: number };
  // actions: play(), stop(), record(), setBpm(), setSwing(), setLoop(), ...
}
```

**`useProjectStore`** — `projectId`, `projectName`, `sampleRate`, `bitDepth ('16'|'24'|'32f')`, `globalInsertLimit (1..8)`, `modifiedSinceLastSave: boolean`, plus project lifecycle actions (`newProject`, `loadProject(id)`, `saveNow()`, `exportMpcweb()`, `importMpcweb(file)`).

**`useSequenceStore`** — the sequence/track/event runtime model (the superseded draft's `useTrackStore`, renamed for accuracy):

```ts
interface SequenceState {
  sequences: Record<string, Sequence>; // metadata: name, lengthBars, timeSig, tempo?, swing
  tracks: Record<string, Track>; // per-sequence lanes: programId, position, name, type
  events: Record<string, MidiEvent[]>; // keyed by trackId, sorted by tickStart
  automation: Record<string, AutomationPoint[]>; // keyed by `${scope}:${ownerId}:${targetPath}`
  songEntries: SongEntry[]; // song mode playlist (§8.5.12)
  // actions: CRUD for all of the above; every mutation also posts an incremental
  // diff to the scheduler worker (§7.1.3) and an undo entry (§4.5).
}
```

**`useProgramStore`** — `programs: Record<string, DrumProgram | KeygroupProgram>` (deep schema §6), `activeProgramId`, `activePadId`, pad/layer/envelope/LFO/mod-matrix actions. No audio nodes in the store — plain data only.

**`useMixerStore`** — per-channel strip state for pads (within active program), tracks, 4 returns, and master:

```ts
interface ChannelStrip {
  id: string; // 'pad:<programId>:<padIndex>' | 'track:<id>' | 'return:0..3' | 'master'
  level: number; // 0..1.2 (fader law defined in §8.5.6)
  pan: number; // -1..1 (equal-power)
  mute: boolean;
  solo: boolean;
  sendLevels: [number, number, number, number];
  inserts: InsertSlotState[]; // { id, effectType, enabled, params: Record<string, number> }
}
```

**`useUIStore`** — `activeMode` (one of the 12 modes), `modalState`, `dragDropPayload` (browser→pad drags), `theme`, `capabilities` (§2.1), `viewportHeight` note (use `dvh` CSS rather than JS where possible), toast queue, focused-control registry for Screen-mode Q-Links (§10.3).

**`useHardwareStore`** — `bleDeviceConnected`, `bleDeviceName`, `connectionState ('idle'|'connecting'|'connected'|'reconnecting')`, `qLinkMode ('screen'|'pad'|'program'|'project')`, `qLinkBindings: QLinkBinding[]` (§10.3), `ccMappings` (raw CC → logical encoder index), plus connect/disconnect/rebind actions.

**`useBrowserStore`** — current OPFS path, cached query results for the file browser (sample lists with tags), tag filter state, preview playback state, favourites.

### 4.3 The Sync Layer (Store → Graph)

`src/store/syncLayer/` contains the **only** code allowed to touch audio nodes in response to state. One subscriber module per domain (mixer, program, transport, hardware), each using `subscribeWithSelector` with narrow selectors. Rules:

- Native `AudioParam` targets: apply via ramp helpers (`setTargetAtTime`/`linearRampToValueAtTime` with `PARAM_RAMP_MS` dezipper). Never set `.value` directly during playback.
- Worklet parameters: via the node's `AudioParam`s (from `parameterDescriptors`) with the same ramp helpers; bulk/config changes via the node's `port` with typed messages.
- Transport/sequence changes: forwarded to the scheduler worker as typed messages (§7.1.3).
- The sync layer is idempotent and diff-based: it compares previous/next selector values and touches only what changed.

### 4.4 Persistence Lifecycle & Autosave

- **Hydration:** `loadProject(id)` reads all rows via repositories, Zod-validates payloads, populates stores, then builds the audio graph, then mounts UI. A load failure falls back to Safe Mode (§8.1) — never a white screen.
- **Autosave:** every committed mutation marks the owning entity dirty; a write-behind queue flushes dirty entities via repositories after `AUTOSAVE_DEBOUNCE_MS` of quiet, and immediately on `visibilitychange → hidden` and before project switch/export. The transport bar shows an unobtrusive unsaved-dot until flushed.
- **Explicit save:** `saveNow()` flushes synchronously (awaited) and is surfaced in the UI.
- Autosave writes MUST NOT jank playback: repository calls are already off-main-thread; the queue coalesces per-entity.

### 4.5 Undo / Redo

- Command-pattern core in `src/store/undo/`: each undoable action records `{ label, undo(), redo() }` closures capturing minimal diffs (not full snapshots).
- **Undoable:** note/automation edits, program parameter commits, track/sequence structure changes, mixer commits, sample-editor destructive operations (via file-version pointers, §8.5.4), pad assignment, Q-Link binding edits.
- **Not undoable:** transport actions, live performance gestures (pad hits, note repeat), BLE connection state, autosave.
- Depth `UNDO_LIMIT` (100); gesture coalescing per §3.3; UI exposure via toolbar buttons + `Ctrl+Z`/`Ctrl+Y`.

## 5. The Audio Engine

### 5.1 Context Bootstrap & Start Gate

- A single `AudioContext` (`latencyHint: 'interactive'`, `sampleRate` = project sample rate) created once in `src/core/audio/context.ts`.
- **Browser autoplay policy:** the UI presents an explicit styled **Start screen/button**; `audioContext.resume()` is called from that user gesture before any audio code runs. The app also listens for `statechange` and re-surfaces the gate if the context is externally suspended.
- All worklet modules (`audioWorklet.addModule`) and DSP wasm fetches complete during the start gate with a progress indicator; failures render actionable errors, not console noise.
- If the device's hardware rate differs from the project rate, the `AudioContext` is created at the project rate and the browser resamples at the hardware boundary; this is accepted and logged, never a crash.

### 5.2 Graph Topology (Strict Signal Hierarchy)

Every signal path follows this exact hierarchy for total mixing control:

1. **Source:** `AudioBufferSourceNode` (sample playback) or worklet source (time-stretch engine §5.7.9, metronome, looper monitor).
2. **Pad DSP:** amp envelope `GainNode` → filter `BiquadFilterNode` (+ pitch handled at source `playbackRate`/`detune` and via mod matrix).
3. **Pad inserts:** serial chain of insert slots (default 4).
4. **Pad sends:** 4 discrete `GainNode` taps → the 4 global return channels.
5. **Track grouping:** all pad outputs of the program on a track merge into the track input `GainNode`.
6. **Track inserts:** serial chain (default 4) on the track group.
7. **Track sends:** 4 discrete `GainNode` taps → returns.
8. **Master bus:** all track outputs + all return outputs merge here.
9. **Master inserts:** e.g. mix-bus compressor, limiter.
10. **Hardware out:** `audioContext.destination`.

Additional fixed infrastructure: **metering taps** (§5.8) after stages 5 and 8 and on each return; and a dedicated **monitor bus** (metronome + Browser-mode audition, §5.9) that merges directly into stage 10, _after_ the master inserts, so the click and auditioning are never coloured or compressed by master FX.

**Edge cases (binding):**

- **Feedback prevention:** the routing matrix MUST programmatically forbid a return channel's sends from targeting any return (returns have no sends in v1 — their strips omit send controls), eliminating feedback loops structurally.
- **Phase coherence / PDC:** every insert slot reports `latencySamples` (0 for native nodes; declared by worklet kernels). The insert wrapper delays its dry path by the wet path's latency (§5.7.3); chains sum their reported latency for display.
- **Solo logic:** solo is implemented as computed mutes (solo-in-place across pads/tracks/returns), evaluated in the sync layer, never in the UI.

### 5.3 Node Factory & Lifecycle

`src/core/audio/factory.ts` provides typed constructors (`createPadChain`, `createTrackChannel`, `createReturnChannel`, `createInsert(effectType)`, `createMasterBus`) each returning `{ input, output, params, destroy() }` handles. `destroy()` obligations per §3.2. Program change and pad clear MUST route through destroys; the Playwright smoke includes a create/destroy churn test asserting stable heap (§11.4).

### 5.4 Voice Management

- Global pool of `MAX_VOICES` (64). A "voice" = one source + its pad DSP chain instance.
- Per-pad playback modes: `poly` (default), `mono` (retrigger cuts previous), `oneShot` (ignores note-off, plays to sample end).
- **Voice stealing:** when the pool is exhausted, steal the oldest _released_ voice, else the oldest voice overall; stolen voices get a `VOICE_STEAL_FADE_MS` linear fade before disconnect — never a hard cut/click.
- **Choke groups (0–16):** triggering a pad with `chokeGroup > 0` applies a `CHOKE_FADE_MS` fade-out + stop to all sounding voices of other pads in the same group within the program.
- **End-of-buffer declick:** a voice that plays to the end of its region ends with a `DECLICK_FADE_MS` linear fade to true zero, landing exactly on the region's end. The no-hard-cut rule covers *every* way a voice ends, not only stealing and choke: a sample whose last frame is not at a zero crossing — a chop slice, a trimmed layer, a truncated one-shot — would otherwise step to silence and click. The fade is clamped to the voice's own start, so a voice shorter than the fade never ramps from before its note-on.
- Note-off applies the amp envelope release; the `ended` event finalises voice teardown.

### 5.5 AudioWorklet & Threading Rules (Strict)

- **Worklet mandate:** real-time DSP beyond native nodes MUST be an `AudioWorkletProcessor`: granular time-stretch/pitch-shift (independent time/pitch — plain `playbackRate` is only used where coupled repitching is the _intended_ behaviour, i.e. keygroups and pad tune), algorithmic reverb (Phase 6+), multiband compression, lookahead limiter, the looper recorder, and the metering tap.
- **Oversampling:** any custom non-linear worklet (saturation/clipping) MUST oversample internally 2×/4× and downsample before output. (v1's saturator uses the native `WaveShaperNode` with `oversample: '4x'`, which satisfies this; a custom worklet version inherits the requirement.)
- **No allocation in `process()`:** worklet processors pre-allocate all buffers at construction; the render quantum allocates nothing and never touches `postMessage` except at ≥ 60 ms intervals for non-critical telemetry.
- **SharedArrayBuffer (targeted use only):**
  - _Worklet→UI (metering, §5.8) and worker→UI (playhead, §7.1.4):_ lock-free single-writer SAB regions with `Atomics` — never `postMessage` streams.
  - _Standard automation:_ native `AudioParam` scheduling methods — SAB is architectural overkill there and MUST NOT be used for it.
- **Worker distinction rule:** AudioWorklets ONLY for real-time sample streaming/processing. Sequencer timing, transient detection, WAV encode, DB, and packing run in standard Web Workers. Sequencer logic inside an AudioWorklet is forbidden.
- **Ring buffer utility:** one shared, tested `RingBuffer` implementation (`Float32Array` data + `Int32Array` read/write indices via `Atomics`) in `src/core/dsp/ringBuffer.ts`, used by looper capture and any worklet→worker streaming.

### 5.6 WASM DSP Kernels (AssemblyScript)

**5.6.1 Kernel seam.** Every kernel implements a common lifecycle exported from its wasm module: `create(sampleRate, maxBlock, ...cfg) → handle`, `process(handle, inPtr, outPtr, frames)` (+ kernel-specific param setters), `free(handle)`. TypeScript wrapper classes in `src/core/dsp/` own memory views and hide pointers from consumers. Consumers depend only on the wrapper interface — the implementation language is swappable (§1.3 #5).

**5.6.2 Loading into worklets.** Worklet global scope has no `fetch`. The main thread fetches and compiles `WebAssembly.Module` once per kernel (cached), then passes the module via `processorOptions` (structured-clone of `WebAssembly.Module` is supported cross-thread). The processor instantiates it locally in its constructor. The same pattern serves plain workers (transient detection).

**5.6.3 Memory rules.** Each node/worker instantiation gets its own instance + linear memory. `free(handle)` MUST be called from the wrapper's `destroy()`; the worklet calls it in response to a `dispose` port message before the node is disconnected. Kernel wrappers are registered with a debug-mode leak tracker that warns on undisposed instances (dev builds only).

**5.6.4 v1 kernel set:** `transientDetect` (spectral flux, §7.5), `granularStretch` (§5.7.9), `multibandComp`, `fdnReverb`, `lookaheadLimiter` (Phase 6+ for the latter three). Each kernel ships with an offline golden-output test (§11.2).

### 5.7 Built-In Effects Set

Insert effects are created by `createInsert(effectType)` and expose a uniform wrapper: `enabled` (true bypass via routing, not zero-gain), `mix` (equal-power dry/wet with PDC on the dry leg — §5.7.3), and typed params (all ranges validated in the store action layer).

| ID              | Engine                                                                                    | Parameters (all automatable, §7.8)                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `eq4`           | native (4 biquads in series)                                                              | lowShelf `{freq 20–500, gain ±15 dB}`, peak1/peak2 `{freq 50–16k, gain ±15, q 0.1–10}`, highShelf `{freq 1k–20k, gain ±15}`             |
| `filter`        | native biquad                                                                             | type `lp/hp/bp/notch`, cutoff 20–20 kHz (log), resonance 0.1–20                                                                         |
| `delay`         | native (`DelayNode` + feedback loop w/ LP filter)                                         | time: free 1–2000 ms **or** synced division (1/32–1/2, dotted/triplet); feedback 0–0.95; tone 200 Hz–18 kHz; mix                        |
| `compressor`    | native `DynamicsCompressorNode` + makeup gain                                             | threshold −60–0 dB, ratio 1–20, attack 0.1–100 ms, release 10–1000 ms, knee 0–40, makeup 0–24 dB                                        |
| `saturator`     | native `WaveShaperNode`, `oversample: '4x'`                                               | drive 0–36 dB, curve `soft/hard/tube`, output trim, mix                                                                                 |
| `reverb`        | v1: native `ConvolverNode` with procedurally generated IRs; Phase 6+: `fdnReverb` worklet | size 0.2–10 s, damping, pre-delay 0–200 ms (DelayNode), mix. IR regeneration is debounced and rendered in a worker, never on param drag |
| `multibandComp` | worklet + WASM (Phase 6)                                                                  | 3 bands, crossovers 40–500 / 500–8k Hz, per-band threshold/ratio/attack/release/makeup                                                  |
| `limiter`       | worklet + WASM (Phase 6)                                                                  | ceiling −6–0 dBFS, release 10–500 ms; fixed 1.5 ms lookahead reported as latency (PDC)                                                  |

**5.7.3 PDC rule:** the insert wrapper reads the effect's `latencySamples` and inserts a matching `DelayNode` on its dry leg; chain latency totals are shown in the mixer strip tooltip. Native effects report 0; the limiter reports its lookahead.

**5.7.9 Time-stretch engine:** granular WSOLA-style kernel (`granularStretch`): `rate` 0.25–4× and `pitch` ±24 semitones independently; grain 40–120 ms, overlap 50–75 %. Used by the sample editor's stretch tool (offline render to a new sample) and per-pad "warp" playback mode (real-time worklet source). A phase-vocoder upgrade is roadmap, not v1.

### 5.8 Metering

- A single `meterTap.worklet.ts` class instantiated per metered point (pad-selected, per-track, per-return, master L/R) writing `[peak, rms]` per channel into its assigned slot of one global meter SAB (`Float32Array`; slot registry in `src/core/audio/metering.ts`; an `Int32Array` header carries a generation counter via `Atomics`).
- UI meter canvases read the SAB in a shared rAF loop (one loop for all meters, not one per component), applying peak-hold and clip-latch presentation client-side. React re-renders: zero.

### 5.9 Metronome & Preview Channel

- Metronome: scheduled by the sequencer worker like any event (accented beat 1), synthesised via a tiny pre-rendered click buffer (no network asset), routed to the monitor bus with its own level control; supports count-in (§7.7).
- Preview channel: Browser-mode auditioning plays through a dedicated gain on the monitor bus, never through pad/track chains.

## 6. Programs, Pads & Sound Design (Data Schemas)

All program payloads are plain JSON (stored in `programs.payload`, §9.3), Zod-validated on load and import. Binding TypeScript model:

```ts
interface AhdsrEnvelope {
  // times in ms, levels 0..1
  attack: number;
  hold: number;
  decay: number;
  sustain: number;
  release: number;
  curve: 'linear' | 'exponential';
}

interface LfoConfig {
  rate: number; // Hz when sync = 'free'
  sync: 'free' | NoteDivision; // NoteDivision: '1/1'..'1/32' incl. dotted/triplet
  shape: 'sine' | 'triangle' | 'sawUp' | 'sawDown' | 'square' | 'sampleHold' | 'drift';
  phaseOffset: number; // 0..1
  retrigger: boolean; // restart on note-on
}

type ModSource = 'lfo1' | 'lfo2' | 'ampEnv' | 'pitchEnv' | 'filterEnv' | 'velocity' | 'random' | 'noteNumber';
type ModTarget =
  | 'pitch'
  | 'filterCutoff'
  | 'filterResonance'
  | 'pan'
  | 'amp'
  | 'layerStart'
  | 'lfo1Rate'
  | 'lfo2Rate'
  | `insert${1 | 2 | 3 | 4}:${string}`; // insert parameter address
interface ModRoute {
  source: ModSource;
  target: ModTarget;
  amount: number /* -1..1 */;
}

interface VelocityLayer {
  sampleId: string; // FK → samples table (OPFS-backed)
  velocityStart: number;
  velocityEnd: number; // 0..127, layers may not overlap
  tuneSemitones: number; // ±36 (coupled repitch)
  tuneCents: number; // ±100
  gainDb: number; // ±24
  startFrame: number;
  endFrame: number; // non-destructive trim (0 = defaults)
  reverse: boolean;
}

interface Pad {
  padIndex: number; // 0..127 (bank = index >> 4)
  name: string;
  chokeGroup: number; // 0..16 (0 = none)
  playbackMode: 'poly' | 'mono' | 'oneShot';
  warp: boolean; // true = granularStretch source (§5.7.9)
  layers: VelocityLayer[]; // 0..maxLayers (default cap 4, configurable to 8)
  envelopes: { amp: AhdsrEnvelope; pitch: AhdsrEnvelope; filter: AhdsrEnvelope };
  pitchEnvSemitones: number; // pitch env depth
  filter: { type: 'lp' | 'hp' | 'bp' | 'off'; cutoff: number; resonance: number; envDepth: number };
  lfos: [LfoConfig, LfoConfig]; // minimum 2 per pad
  modMatrix: ModRoute[]; // unbounded schema; validated cap 32 routes
  mixer: { level: number; pan: number; sendLevels: [number, number, number, number] };
  inserts: InsertSlotState[]; // default 4 slots
}

interface DrumProgram {
  id: string;
  name: string;
  type: 'drum';
  pads: Pad[]; // sparse — only assigned pads present
}

interface KeygroupZone {
  // extends the layer idea across the keyboard
  sampleId: string;
  rootNote: number; // MIDI note of unity pitch
  lowNote: number;
  highNote: number; // key range
  lowVelocity: number;
  highVelocity: number;
  tuneCents: number;
  gainDb: number;
}

interface KeygroupProgram {
  id: string;
  name: string;
  type: 'keygroup';
  zones: KeygroupZone[];
  // shares Pad's sound-design surface at program scope:
  envelopes: Pad['envelopes'];
  filter: Pad['filter'];
  lfos: Pad['lfos'];
  modMatrix: ModRoute[];
  mixer: Pad['mixer'];
  inserts: InsertSlotState[];
  polyphony: number; // 1..32 voices from the global pool
  glideMs: number; // mono glide (0 = off)
  pitchBendRange: number; // semitones applied by pitch bend (default 2, 1..12)
}
```

- **Drum programs:** 128 pads (8 banks × 16). Layer selection is velocity-switched (round-robin is out of scope v1).
- **Keygroup pitching:** `playbackRate = 2^((note - rootNote + tuneCents/100) / 12)` via `AudioBufferSourceNode.detune`/`playbackRate` — coupled repitch is correct here by design.
- **Mod matrix evaluation:** control-rate (per voice start + per rAF-scheduled block via `AudioParam` ramps for LFO-driven targets on native nodes; per-block inside worklet kernels for worklet targets). The evaluator is a pure function with unit tests (§11.1).
- At least 4 keygroup programs MUST be able to sound concurrently.

## 7. Sequencer, Timing, Recording & Automation

### 7.1 Clock Architecture (Lookahead Worker Scheduler)

**7.1.1 Placement.** The entire timing loop lives in `scheduler.worker.ts` (a standard Web Worker — never the UI thread, never an AudioWorklet). The main thread only (a) forwards transport/state changes in, and (b) turns scheduled-event batches into audio-graph calls out.

**7.1.2 Clock model.** The worker cannot read `audioContext.currentTime`, so the main thread sends a sync pair every `CLOCK_SYNC_INTERVAL_MS` from `audioContext.getOutputTimestamp()`: `{ contextTime, performanceTime }`. The worker maintains `offset = contextTime − performanceTime/1000` (smoothed over the last 8 samples to reject jitter) and estimates context time as `performance.now()/1000 + offset`. Drift beyond 2 ms snaps and logs.

**7.1.3 Message protocol (typed, versioned):**

- Main → worker: `init { playheadSab }`, `clockSync`, `transport { isPlaying, isRecording, startTick }`, `tempo`, `swing`, `loop`, `eventsDiff { trackId, upserts, deletes }` (incremental — never full re-sends during playback), `automationDiff`, `songSequence { orderedSequenceIds }`, `liveNote { note, velocity, on, timestamp }` (for note repeat + record capture), `noteRepeat { enabled, division }`, `metronome { enabled, countInBars }`.
- Worker → main: `scheduleBatch { events: ScheduledEvent[] }` where `ScheduledEvent = { kind: 'noteOn'|'noteOff'|'click'|'automationRamp', trackId?, note?, velocity?, when /* context secs */, tick, durationSec?, target?, value?, rampEnd? }`; `recorded { trackId, events }` (on capture flush); `loopWrapped { tick }`; `songAdvanced { entryIndex }`.

**7.1.4 Scheduling loop.** Every `SCHEDULER_INTERVAL_MS` the worker computes all events whose musical time falls in `[nowTick, nowTick + ticksIn(LOOKAHEAD_MS)]`, converts ticks→context seconds via the tempo map, applies swing (§7.4) and micro-offsets, and posts one `scheduleBatch`. The main-thread dispatcher calls `voicePool.trigger(...)`/`AudioParam` ramps with exact `when` values. The worker also writes `currentTick` (Float64) + transport flags into the **playhead SAB** every wake; canvases read it via rAF. When rendering, playhead canvases subtract `audioContext.outputLatency` (where reported) from the position so the drawn playhead matches what is _audible_, not what has merely been scheduled.

**7.1.5 Determinism & tests.** Tick↔seconds conversion, swing offsets, loop wrapping, and lookahead window maths are pure functions in `src/core/sequencer/` with exhaustive unit tests (including tempo changes mid-loop and loop-boundary double-scheduling protection — an event may be scheduled exactly once per loop pass).

### 7.2 Resolution & Musical Maths

- **960 PPQN** internally everywhere. Positions/durations are integer ticks; the UI renders bars:beats:ticks using the sequence time signature (default 4/4; numerator 1–16, denominator 2/4/8/16).
- Conversion: `secondsPerTick = 60 / (bpm × PPQN)`. Tempo is per-sequence (nullable → project default); song mode builds a tempo map across entries (§7.9).

### 7.3 Note Repeat & Arpeggiator

- **Note repeat:** when active with a held pad (UI or BLE), the worker generates notes locked to the chosen division — 1/4, 1/8, 1/16, 1/32, 1/64, each straight or triplet — at the held velocity (or a fixed adjustable velocity), respecting swing. Latch option holds the last pad.
- **Arpeggiator (keygroup tracks):** modes `up / down / upDown / played / random`, octave range 1–4, gate 5–100 %, division as above. Runs in the worker beside note repeat (shared subdivision clock).

### 7.4 Swing & Quantisation

- **Swing:** classic MPC algebra — 50–75 % shifting every _even-numbered_ subdivision of the swing division (`swingDivision` 1/8 or 1/16). Offset ticks = `(swing − 50)/50 × (divisionTicks/2)`, applied at schedule time (non-destructive).
- **Quantise (destructive, undoable):** snap selected events to a grid (1/4–1/64, straight/triplet) with strength 0–100 % and optional swing applied into the grid.
- **Non-destructive capture:** recording never quantises at capture; raw 960 PPQN timing is stored, quantise is an explicit edit.

### 7.5 Groove Extraction

The WASM `transientDetect` kernel (spectral flux with adaptive threshold; params: sensitivity, min-spacing ms) runs in a plain worker over an OPFS `.wav`, returning transient timestamps. `grooveFromTransients()` (pure) maps them to a timing+velocity grid (a **groove template**), stored per project and applicable to any track as a **non-destructive quantisation map** (applied at schedule time like swing; also bake-able as a destructive edit).

### 7.6 Live Input Path

BLE/UI note input follows two parallel paths simultaneously (§10.2): (1) immediate audition — main thread triggers the voice pool directly with `when = now` (this is the _sole_ sanctioned bypass of the store for latency reasons, and it mutates nothing); (2) `liveNote` message to the worker for note-repeat processing and record capture.

### 7.7 Recording Workflow

- Arm via `record()`; playback starts after `countInBars` of metronome (0/1/2).
- **Overdub** (default) merges captured events into the track each loop pass; **replace** clears the region being passed over while recording.
- Capture applies input-latency compensation (§10.2) and stores raw ticks + velocity; note-off closes durations (min duration 1 tick).
- While holding a pad + touching **Erase**, that pad's events are removed as the loop passes (MPC-style live erase).
- Each recording pass commits one undo entry ("Recorded take").

### 7.8 Hierarchical Automation

- **Two scopes:** _sequence_ automation (loops with the pattern; owner = sequence) and _track_ automation (spans the song arrangement; owner = track). Track scope overrides sequence scope for the same target while both exist (last-writer at schedule time, track wins).
- **Data model:** `AutomationPoint { id, scope, ownerId, targetPath, tick, value, curve: 'step'|'linear'|'exp' }`.
- **Target addressing:** canonical string paths registered in `src/core/audio/params/registry.ts`, e.g. `mixer.track:<id>.level`, `mixer.pad:<prog>:<idx>.sendLevels.2`, `program:<id>.pad:<idx>.filter.cutoff`, `insert:track:<id>:slot2.mix`. Only registered, automatable parameters accept points (Zod-validated).
- **Engine:** the worker schedules `automationRamp` events for the lookahead window; the dispatcher applies them as `AudioParam` ramps (native and worklet params alike). Non-AudioParam targets are not automatable in v1.
- **Record automation:** Q-Link/knob movements while recording write points (thinned by minimum tick spacing + value epsilon).

### 7.9 Song Mode Playback

`songEntries: { id, position, sequenceId, repeats }[]`. In `playbackMode: 'song'` the worker plays entries in order, honouring per-sequence tempo/length (building a tick-offset + tempo map), posting `songAdvanced` for UI. Seamless transitions: the lookahead window may span an entry boundary and MUST schedule across it correctly (unit-tested).

## 8. UI Architecture, Modes & Interaction Standards

### 8.1 Application Shell

- Layout: persistent **transport bar** (play/stop/rec, position readout, BPM, swing, metronome, save-dot, undo/redo, storage gauge), persistent **mode rail** (12 modes, touch-large), content area for the active mode. All sized with fluid units (`dvh`, `rem`, grid `gap`).
- The **storage gauge** is a compact usage bar that warns as origin usage approaches the §9.7 90 % hard stop, and carries the §9.7 eviction state; it also owns the first-run persistence request, being the only always-mounted surface. See changelog 2026-07-18 (o).
- A mode **fits its viewport** rather than scrolling as a page: panels either hold their content height or are marked to absorb the leftover, and a mode with irreducibly tall content (Program Edit) scrolls inside itself. Below the `lg` breakpoint the modes stack into one column and the content area scrolls.
- **Global error boundary + Safe Mode:** a top-level `react-error-boundary` fallback offering: Export project (`.mpcweb`), Download raw SQLite binary, and Hard Reset (purge OPFS + DB after double confirmation). The user must never be trapped in a white screen.
- **Multi-tab guard:** Web Locks claim at startup; a second tab shows a styled "BangerBox is already open in another tab" screen (§9.7).

### 8.2 Accessibility (WCAG) Standards

- Every interactive element: correct role, `aria-label`, and for continuous controls `aria-valuemin/max/now` + `aria-valuetext` (human units — "−6.0 dB", "1.2 kHz").
- Full keyboard operation: logical Tab order per mode, arrow-key increments on knobs/faders (fine with Shift), Space/Enter triggers pads, distinct high-contrast focus rings (token-based).
- Contrast AA minimum; live announcements (transport state, save confirmations) through a single polite `LiveRegion`.
- `prefers-reduced-motion`: all motion collapses to opacity/instant transforms.

### 8.3 Visual Flair & Animation Standards

- The interface must feel like premium tactile hardware, not a dry web page: `motion/react` for layout shifts, modal/tab transitions (shared layout IDs for the mode rail), spring-based micro-interactions.
- Pads/buttons: immediate press feedback (`whileTap` scale ≈ 0.95) plus velocity-driven glow (box-shadow intensity from hit velocity, decaying via CSS transition — not React state).
- 60 fps is the budget: animations use transform/opacity only (GPU-composited); anything animating layout properties continuously is a review failure.

### 8.4 Canvas Rendering Rules

Playheads, waveforms, meters, grid note lanes, and the XY surface render on `<canvas>` driven by shared rAF loops. Canvases are DPR-aware, resize via `ResizeObserver`, and every canvas component provides an offscreen-culled idle state (no rAF work when not visible). React DOM updates for these are forbidden (§3.3).

### 8.5 Required Modes (all 12)

1. **Main:** dashboard — active sequence/track/program summary, bar counter, quick pad grid (current bank), recent projects. (Storage usage moved to the §8.1 transport-bar gauge and the durable-layer diagnostics to Q-Link Edit — changelog 2026-07-18 (o).)
2. **Grid / Piano Roll:** canvas note editor — drum rows (pad names) or piano roll (keygroups); draw/erase/select/move/resize; velocity lane; per-track automation lane selector; zoom/scroll (pinch + drag); grid snap selector incl. off; quantise dialog (§7.4).
3. **Track & Pad Mute:** large touch hitboxes for live mute/solo toggling of tracks and pads; latched and momentary modes.
4. **Sample Edit:** canvas waveform (min/max peak pyramid rendering for long files; pyramids are computed in a Web Worker on first load, cached in memory per sample, and recomputed only after destructive edits — never on the main thread or per frame); tools: Trim (non-destructive per-layer), **Chop** (manual markers / equal slices / WASM transient detection with sensitivity slider; slices assign to pads or new program), Normalise, Reverse, Fade in/out, Time-stretch render (§5.7.9), zoom to sample level. Destructive ops render **new** OPFS files (new `sampleId`, undo swaps the pointer back; originals persist until "Purge unused" in Browser).
5. **Program Edit:** deep editor for §6 — per-pad layers (drag ranges), AHDSR envelope graphs (draggable handles on canvas), filter, 2 LFOs, mod matrix (add/remove routes, source/target pickers from the registry), choke/playback mode; keygroup zone editor with keyboard range drag.
6. **Mixer:** channel strips (pads-of-active-program | tracks | returns | master tabs): fader (dB law: −∞..+6 dB mapped perceptually), pan, mute/solo, 4 send dials, insert slot list (add/replace/reorder/bypass; tapping opens the effect's parameter panel), meter per strip (§5.8), master PDC readout.
7. **Browser:** OPFS/library navigation backed by SQLite queries — folder tree (projects/global), tag chips + text filter, favourites, audition on tap (preview channel, §5.9), waveform micro-preview, drag-to-pad assignment (`dragDropPayload`), import button (file picker → §9.4), "Purge unused samples" maintenance action. **Factory content (§9.8)** is browsed here too: a Factory section lists the `/factory/index.json` catalogue with each pack's title, kind and size, and installs on tap — a `kit` merging into the active project, a `demo` opening as a new one. Packs are fetched on demand, so the section states when a pack is not yet cached and surfaces a fetch failure as a retryable error rather than an empty list.
8. **Looper:** record source (resample master / mic if capability present), length in bars (locked to tempo), record/overdub/clear, live input meter + progress ring; capture via recorder worklet → ring buffer → worker WAV encode → OPFS; result appears as a sample assignable to pads/tracks.
9. **Pad Perform:** 16-pad grid locked to scales — chromatic, major, natural/harmonic/melodic minor, major/minor pentatonic, blues, dorian, phrygian, lydian, mixolydian, locrian — or chord sets (triads, 7ths); root + octave selectors; notes route to the active keygroup program.
10. **XYFX:** full-screen touch canvas mapping X and Y to any two registered automatable parameters (picker per axis); latch toggle (hold vs release-return); crosshair + trail rendering; movements are transient store updates (recordable as automation when recording).
11. **Q-Link Edit:** table of encoder bindings for the active Q-Link mode; learn flow ("turn an encoder, tap a parameter"); manual path picker (registry-driven); min/max/curve per binding (§10.3).
12. **Song:** ordered playlist of sequences with per-entry repeat count; add/remove/reorder (drag); song duration readout; "Bounce song" action (§9.5).

## 9. Persistence: OPFS, SQLite & Project Interchange

### 9.1 OPFS Directory Structure (Strict)

```
/bangerbox.sqlite3                     (owned by the SQLite OPFS VFS)
/projects/{projectId}/samples/{sampleId}.wav
/projects/{projectId}/bounces/{name}.wav
/global_library/{sampleId}.wav
```

All OPFS access goes through the typed wrapper `src/core/storage/opfs.ts` (path building, existence checks, streamed reads/writes via sync access handles in workers).

### 9.2 SQLite Worker Orchestration

- The `@sqlite.org/sqlite-wasm` instance lives entirely in `db.worker.ts` on the OPFS VFS; the main thread never imports the wasm.
- A strictly typed promise-based RPC bridge (`rpc.ts`) carries parameterised statements only — string-concatenated SQL is forbidden.
- The worker serialises writes through an internal queue (OPFS holds an exclusive lock; rapid successive writes must never surface `SQLITE_BUSY`).
- Repositories (main thread) are the only RPC clients; unpaginated `SELECT *` over unbounded tables is forbidden — browser queries page at 200 rows.
- **Migrations:** `PRAGMA user_version`-driven sequential migration scripts, each wrapped in a transaction with rollback-on-failure; destructive table changes use the safe recreation pattern (create-new → copy → drop-old → rename). Querying `sqlite_master` to guess schema state is forbidden.

### 9.3 Database Schema (v1 DDL, binding)

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,             -- crypto.randomUUID()
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,             -- Unix ms
  modified_at   INTEGER NOT NULL,
  sample_rate   INTEGER NOT NULL DEFAULT 48000,
  bit_depth     TEXT    NOT NULL DEFAULT '24' CHECK (bit_depth IN ('16','24','32f')),
  bpm_default   REAL    NOT NULL DEFAULT 120.0,
  insert_limit  INTEGER NOT NULL DEFAULT 4,
  payload       TEXT    NOT NULL DEFAULT '{}'  -- Zod-validated project extras (master strip, groove templates)
);

CREATE TABLE sequences (
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
);
CREATE INDEX idx_sequences_project ON sequences(project_id, position);

CREATE TABLE programs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('drum','keygroup')),
  payload     TEXT NOT NULL                    -- DrumProgram | KeygroupProgram JSON (§6)
);

CREATE TABLE tracks (
  id           TEXT PRIMARY KEY,
  sequence_id  TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  program_id   TEXT REFERENCES programs(id) ON DELETE SET NULL,
  position     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('drum','keygroup','audio')),
  mixer        TEXT NOT NULL DEFAULT '{}'      -- ChannelStrip JSON (§4.2)
);
CREATE INDEX idx_tracks_sequence ON tracks(sequence_id, position);

CREATE TABLE midi_events (
  id             TEXT PRIMARY KEY,
  track_id       TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  tick_start     INTEGER NOT NULL,             -- 960 PPQN
  duration_ticks INTEGER NOT NULL,
  note           INTEGER NOT NULL,             -- 0..127 (drum: pad index)
  velocity       INTEGER NOT NULL,             -- 1..127
  extra          TEXT                          -- reserved JSON (probability, provenance)
);
CREATE INDEX idx_midi_events_lookup ON midi_events(track_id, tick_start);

CREATE TABLE automation_points (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('sequence','track')),
  owner_id    TEXT NOT NULL,
  target_path TEXT NOT NULL,                   -- §7.8 registry address
  tick        INTEGER NOT NULL,
  value       REAL NOT NULL,
  curve       TEXT NOT NULL DEFAULT 'linear' CHECK (curve IN ('step','linear','exp'))
);
CREATE INDEX idx_automation_lookup ON automation_points(owner_id, target_path, tick);

CREATE TABLE samples (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global library
  name         TEXT NOT NULL,
  opfs_path    TEXT NOT NULL UNIQUE,
  frames       INTEGER NOT NULL,
  sample_rate  INTEGER NOT NULL,
  channels     INTEGER NOT NULL CHECK (channels IN (1,2)),
  root_note    INTEGER NOT NULL DEFAULT 60,
  created_at   INTEGER NOT NULL
);
CREATE TABLE sample_tags (
  sample_id TEXT NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (sample_id, tag)
);
CREATE INDEX idx_sample_tags_tag ON sample_tags(tag);

CREATE TABLE song_entries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  repeats     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_song_entries ON song_entries(project_id, position);

CREATE TABLE app_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
```

### 9.4 Audio Import & Decode Pipeline

1. Accept `.wav`, `.mp3`, `.flac`, `.ogg` via file picker or drag-drop.
2. Decode with `audioContext.decodeAudioData()` (main thread — it is internally async/off-thread).
3. **Standardise:** resample to the project sample rate via `OfflineAudioContext` if needed; mixdown >2 channels to stereo.
4. Encode to WAV at the project bit depth (16/24-bit int or 32-bit float; encoder is a pure, unit-tested function running in a worker) and write to OPFS.
5. Insert the `samples` row (+ inferred tags: source folder name, "imported").
6. Reject files that would breach the storage headroom check (§9.7) _before_ writing.

### 9.5 Bounce & Mixdown

- Rendering uses **`OfflineAudioContext` on the main thread** (it renders asynchronously without blocking the realtime graph; plain workers cannot host it — the superseded draft's "render in a worker" is corrected to: _render_ on main, _encode + write_ in a worker).
- The bounce builder reconstructs the full graph (sources scheduled from the DB via the same pure scheduling maths — code shared with the live scheduler) inside the offline context, renders, then ships the buffer to a worker for WAV encode → `/bounces/`.
- Available as: bounce sequence, bounce song, bounce selected track (post-insert, pre-master), resample-to-pad.

### 9.6 Project Packing (`.mpcweb` Interchange Format)

A `.mpcweb` file is a **zip** (fflate, in `pack.worker.ts`) with this exact layout:

```
manifest.json    { "format": "mpcweb", "formatVersion": 1, "appVersion": "<semver>",
                   "projectId": "<uuid>", "projectName": "...", "exportedAt": "<ISO8601>" }
project.json     Versioned JSON snapshot: project row + sequences + tracks + midi_events
                 + automation_points + programs (payloads) + song_entries + samples metadata.
samples/<sampleId>.wav   Every sample referenced by the project (global-library refs are copied in).
```

- **Export:** flush autosave → repositories dump → worker zips (streamed) → browser download. Raw `.sqlite` binaries are never the interchange format (schema portability); the Safe-Mode raw download (§8.1) is a rescue hatch, not interchange.
- **Import:** Zod-validate manifest + snapshot (reject unknown `formatVersion` with a friendly error); remap all UUIDs on collision; write samples to OPFS; insert rows; open the project. Import is transactional — a failure mid-way leaves no partial project.

### 9.7 Storage Safeguards

- `navigator.storage.persist()` requested at first run; if refused, show a persistent dismissible warning that the browser may evict data.
- **Quota hard-stop:** before any sample write/bounce, check `navigator.storage.estimate()`; if the write would push usage beyond 90 % of quota, refuse gracefully with a storage-management prompt (Browser mode purge tools) — never corrupt a half-written file (write to temp name, atomic rename on completion).
- **Multi-tab guard:** `navigator.locks.request('bangerbox-db', { ifAvailable: true }, ...)` at startup; on failure show the already-open screen (§8.1). The OPFS SQLite lock makes this mandatory, not cosmetic.

### 9.8 Factory Content & Demo Projects

BangerBox ships free, licence-safe starter content so a new user can make sound
before sourcing any audio of their own.

**Delivery format.** Factory content ships as `.mpcweb` archives (§9.6) — no new
format, no new pipeline, no new dependency. Packs are fetched on demand from
`/factory/`, then installed through the same unpack → Zod-validate → UUID-remap →
OPFS-write → row-insert path as a user import. `public/factory/index.json` is a
Zod-validated catalogue: `{ id, title, kind: 'kit' | 'demo', file, bytes,
description }` per pack. Packs are never base64-inlined in JS (the §12 Phase 3
`demoSample.ts` pluck is inlined; that does not scale and is not the precedent here).

**Provenance.** All shipped audio is generated procedurally by
`scripts/build-factory.mjs` from pure synthesis — no sampled, recorded or
third-party material. The repository is MIT-licensed and publicly deployed, so
shipped audio must be unencumbered; generating it removes provenance risk entirely
and keeps rebuilds byte-reproducible. Curated third-party CC0 material is out of
scope.

**Build.** `npm run build:factory` writes `public/factory/`, which is gitignored and
regenerated ahead of `build` — the same artefact discipline as the §5.6 WASM kernels.
Output MUST be byte-deterministic across rebuilds: a seeded PRNG for any noise
source, fixed zip entry mtimes, and a pinned `exportedAt`/`created_at`/`modified_at`
in every generated snapshot. Samples are 48 kHz mono WAV at 16-bit; total shipped
payload stays under 8 MB.

**Install modes.** A `demo` pack installs as a new project and opens it. A `kit`
pack MERGES into the active project: its programs and samples are inserted, its
sequences, tracks and song entries are discarded. Both modes remap every UUID (§9.6)
and both are transactional in the §9.6 sense — a mid-way failure leaves no partial
project and no orphaned OPFS files.

**Storage.** Installing a pack is a storage-growing write and MUST pass the §9.7
headroom hard-stop, checked against the pack's uncompressed sample payload BEFORE
any OPFS write, refusing gracefully with the Browser-mode purge affordance.

**Caching.** The §2.4 precache glob covers neither `.wav` nor `.mpcweb` and is not
widened. Packs and the catalogue are runtime-cached cache-first in a dedicated cache
(`bangerbox-factory-v*`), kept separate from the precache so the §2.4 stale-precache
prune cannot evict them.

**Content (v1).** Three kits (~40 samples: 808-flavoured, 909-flavoured, acoustic-ish)
and three demo projects — a four-bar boom-bap loop, a house track exercising mixer
automation and a Q-Link-mapped filter sweep (§10.3), and a Song-mode arrangement of
several sequences (§7.9). Samples are duplicated per demo project in v1;
`/global_library/` de-duplication (§9.1) is deferred.

## 10. Hardware Interfacing

### 10.1 BLE-MIDI Transport & Parsing

- `navigator.bluetooth.requestDevice` filtered on the BLE-MIDI service UUID `03B80E5A-EDE8-4B33-A751-6CE34EC4C700`; characteristic `7772E5DB-3868-4112-A1A9-F2669D106BF3`; subscribe to notifications.
- **Packet parsing (pure, unit-tested, `src/core/midi/parser.ts`):** BLE-MIDI framing — header byte (bit 7 set; bits 0–5 = timestamp high), per-message timestamp byte (bit 7 set; bits 0–6 = timestamp low) forming a 13-bit millisecond clock that wraps every 8 192 ms (unwrap against arrival time); **running status** support; multiple messages per packet. v1 handles Note On (velocity 0 ⇒ Note Off), Note Off, Control Change, Pitch Bend; SysEx is skipped safely (never crashes the parser).
- Parsed messages carry a reconstructed `performance.now()`-domain timestamp.

### 10.2 Input Routing, Latency & Execution Flow

- **Note messages** follow the dual path of §7.6: immediate audition (zero added latency, bypasses React entirely) + worker delivery for note-repeat/recording. A configurable **input latency offset** (default 15 ms, settable 0–50 ms in Q-Link Edit's settings pane) is subtracted from BLE timestamps when recording, compensating BLE transmission delay.
- **CC messages** MUST flow: BLE listener → binding lookup → mapped value → **Zustand store action** → sync layer → node. Directly mutating the audio graph from the MIDI listener is forbidden (auditioned _notes_ are the sole exception, and they touch the voice pool, not graph parameters).
- **Pitch bend** applies to the active keygroup program's sounding voices via per-voice `detune` ramps, scaled by the program's `pitchBendRange` (§6; default ±2 semitones). Drum programs ignore pitch bend. Like note audition, this is a voice-pool path (throttled per §10.4), not a store mutation.

### 10.3 Dynamic Q-Link Architecture (Context-Aware Encoders)

- **Modes** (`useHardwareStore.qLinkMode`): `screen` (encoders map to the currently focused UI panel — components register their parameters via a `useQLinkFocus(params[])` hook into `useUIStore`'s focus registry; e.g. opening a Delay insert maps knobs to Time/Feedback/Mix/Tone), `pad` (selected pad's Pitch / Filter Cutoff / Amp Attack / Amp Release by default), `program` (program macros), `project` (global macros: master level, global swing, master filter).
- **Binding schema (binding):**

```ts
interface QLinkBinding {
  encoderIndex: number; // 0..15 (4 physical by default)
  cc: number; // raw CC number from ccMappings
  targetStore: 'mixer' | 'program' | 'transport' | 'project';
  targetParameterPath: string; // §7.8 registry address
  minValue: number;
  maxValue: number;
  curve: 'linear' | 'log';
  mode: 'absolute' | 'relative'; // relative = two's-complement increment encoders
}
```

- **Execution flow (strict):** CC in → look up binding for current mode → scale into `[min,max]` per curve → dispatch to the target store action (transient during turn, commit on 250 ms idle) → sync layer updates the node → UI reacts concurrently. Bindings persist per mode in `app_settings`.

### 10.4 ESP32 / DIY Controller Constraints

- **CC jitter throttling:** per-CC coalescing — keep only the latest value, apply at most every `CC_THROTTLE_MS` (rAF-aligned), with ±1 value hysteresis, preventing render thrash and AudioParam spam from noisy analogue pots (software-side even if the firmware has hysteresis).
- **Connection lifecycle:** listen for `gattserverdisconnected`; set `connectionState: 'reconnecting'`; attempt automatic `device.gatt.connect()` retries with backoff (3 attempts) before prompting. A drop MUST NOT crash the graph, pause playback, or lose Q-Link bindings.
- **Windows pairing quirk:** the connect dialog includes a help note telling Windows users to pair the ESP32 in **Windows Settings → Bluetooth** _before_ using Connect in the app.
- **Timestamping:** always schedule from reconstructed BLE timestamps (§10.1) — never "on receipt" — feeding the lookahead engine for recording accuracy.

### 10.5 Roadmap (Recorded, Not In Scope)

Web MIDI (USB) input; MIDI clock sync in/out; MIDI export (.mid); phase-vocoder stretch; algorithmic reverb presets; audio input tracks; tempo (BPM) automation within a sequence.

## 11. Testing & Verification Strategy

### 11.1 Unit Tests (Vitest, `happy-dom`)

Mandatory coverage for all pure logic: PPQN/tempo maths, swing/quantise/groove functions, loop wrapping + lookahead windowing, mod-matrix evaluation, BLE-MIDI parser (framing, running status, timestamp unwrap, malformed input), WAV encoder (golden bytes), fader/pan laws, ring buffer (concurrent read/write invariants), Zod schemas (accept/reject fixtures), undo core, `.mpcweb` snapshot round-trip (in-memory).

### 11.2 DSP Verification (OfflineAudioContext)

Each DSP kernel and effect ships a renders-under-`OfflineAudioContext` test (run in the Playwright browser context, §11.4, since Node lacks Web Audio): render a known input through the node/kernel and assert numeric properties (RMS within tolerance, spectral peak location, latency sample count, silence after release). Golden buffers live in `src/test/fixtures/`.

### 11.3 Worker & Worklet Mocking

- The DB worker is bypassed in unit tests via an injected in-memory driver behind the same `IDatabaseDriver` interface (repositories never touch `postMessage` directly).
- The scheduler worker's logic is a pure class (`SchedulerCore`) instantiated directly in tests with a fake clock; the worker file is a thin message shell.
- Worklet-dependent components mock the node wrappers; `src/test/mocks/` provides a fake `AudioContext` sufficient for factory lifecycle tests (create/destroy call accounting).

### 11.4 Real-Browser Smoke (Playwright, system Edge)

`scripts/browser-smoke.mjs` (npm `test:e2e`) against the dev server: asserts `crossOriginIsolated === true`; boots the app; passes the start gate; creates a project; loads a bundled test sample; triggers pads and asserts non-silent output via an `AnalyserNode` probe; runs the create/destroy churn heap check (§5.3); records a two-bar sequence with the fake clock accelerated; exports and re-imports a `.mpcweb`; **fails on any console error**. Screenshot artefacts are git-ignored.

### 11.5 Performance Budgets (Review-Gated)

- Touch-to-sound < 30 ms (UI path); zero audible underruns during 8 tracks + 4 inserts playback on the target tablet; UI holds 60 fps with all meters live.
- **No bundle-size or load-time budget applies.** Both are deliberately unconstrained (human developer's decision, §14 2026-07-18 (j)): the app is local-first and installed, so payload size and cold-start duration are not user-facing costs worth trading features or clarity against. Do not reintroduce a size limit, a cold-load target, a size or timing gate in `npm run verify`, or code-splitting/deferred-loading undertaken to hit either. Splitting and lazy loading done for genuine load-order or correctness reasons (the wasm/sqlite assets already load on demand) remain fine. The remaining budgets above are *runtime* qualities — how the instrument feels once it is running — and those stay binding.
- A dev-only perf HUD (frame time, audio underrun counter via `audioContext.outputLatency` monitoring, voice count) toggles with a keyboard shortcut.

## 12. Implementation Phases

_Each phase is a strict boundary: the agent executes it autonomously end-to-end (§13.3), and MUST satisfy every exit criterion — including the Multi-Lens Review (§3.5) and the listed tests — before the next phase begins. UI beyond stubs is deferred to Phase 7 except where a phase names it._

**Phase 0 — Toolchain & Scaffold.**
Objective: a verified empty shell. Deliverables: `git init`; Vite + React + TS strict scaffold; Tailwind 4 + token file; ESLint/Prettier; `vite.config.ts` per §2.3; PWA manifest + `sw.ts` + update prompt; capability gate screen (§2.1); constants registry; Vitest + Playwright harness (smoke asserts `crossOriginIsolated`); `npm run build:wasm` pipeline with a trivial AssemblyScript kernel proving the worklet-module-transfer path (§5.6.2); enforcement scripts `check:deps`, `check:lang`, `check:stubs` aggregated as `npm run verify` (§13.6).
Exit: `dev`, `build`, `preview`, `test`, `test:e2e`, `lint`, `type-check`, `verify` all green; installable offline PWA shell.

**Phase 1 — Storage Foundation.**
Objective: durable data layer. Deliverables: OPFS wrapper; DB worker + typed RPC + write queue; migration engine + v1 DDL (§9.3); repositories with paginated queries; multi-tab guard; `storage.persist()` + quota checks; Safe Mode skeleton.
Exit: repository round-trip unit tests (in-memory driver) + real-OPFS smoke test creating/reading a project.

**Phase 2 — State & Undo.**
Objective: the brain. Deliverables: all eight stores (§4.2) with actions + Zod validation; transient/commit channels; undo core; autosave queue; project load/hydrate; sync-layer skeleton with subscriber registration.
Exit: store unit tests incl. undo coalescing and autosave debounce (fake timers); hydration test from a fixture DB.

**Phase 3 — Audio Core.**
Objective: sound out. Deliverables: context bootstrap + start gate; node factory + destroys; full mixer graph (§5.2) incl. returns/master/monitor bus; insert wrapper + native effects (`eq4`, `filter`, `delay`, `compressor`, `saturator`, `reverb` v1); voice pool + choke + stealing; pad playback from OPFS samples; meter worklet + SAB + canvas meters; metronome; minimal test UI (pad grid stub + mixer stub).
Exit: audible end-to-end path; meters reflect real peaks; churn test leak-free; OfflineAudioContext effect assertions.

**Phase 4 — Sequencer & Recording.**
Objective: the pulse. Deliverables: scheduler worker + clock sync + playhead SAB; events diff protocol; swing; loop; note repeat; recording (count-in, overdub/replace, live erase); quantise; automation engine + parameter registry; song-mode playback maths.
Exit: timing unit suite (incl. loop-boundary and song-transition scheduling); record-then-playback smoke test.

**Phase 5 — Programs & Sound Design.**
Objective: the instrument. Deliverables: full §6 schemas live (layers, AHDSR application, LFOs, mod matrix, keygroups incl. ≥4 concurrent, glide); program CRUD + persistence; Program Edit mode (functional, unpolished); arpeggiator.
Exit: mod-matrix evaluator tests; velocity-layer switching audible test; keygroup pitch-accuracy offline render test.

**Phase 6 — Sample Pipeline & Heavy DSP.**
Objective: the sampler. Deliverables: import/decode/standardise pipeline; Sample Edit mode with waveform canvas + all tools; `transientDetect` kernel + chop; `granularStretch` kernel + warp mode + stretch render; Looper; bounce/mixdown (§9.5); `.mpcweb` export/import; Browser mode with tagging/audition/drag-to-pad; remaining WASM effects (`multibandComp`, `fdnReverb`, `limiter`) with PDC.
Exit: kernel golden-output tests; pack/unpack round-trip smoke; transient chop accuracy fixture test.

**Phase 7 — Full UI Assembly & Polish.**
Objective: the surface. Deliverables: all 12 modes complete and polished per §8 (Grid editor, Mute, Mixer, Pad Perform, XYFX, Q-Link Edit, Song, Main dashboard); motion/tactility standards; accessibility pass across every mode; perf HUD; wake lock.
Exit: full Multi-Lens sweep of every mode; perf budgets (§11.5) measured and met; zero dead controls (§3.4).

**Phase 8 — Hardware & Q-Link Ecosystem.**
Objective: the controller. Deliverables: BLE transport + parser; dual-path note routing + latency offset; CC throttle; Q-Link runtime (all four modes) + Screen-mode focus registry; auto-reconnect; Windows pairing helper; binding persistence.
Exit: parser unit suite; simulated-stream jitter/reconnect tests; live hardware session sign-off with the human developer.

## 13. Agent Execution Protocols

### 13.1 Protocol Alpha — Inter-Session Handover

Each phase may run in a fresh session with no memory of previous ones. At phase completion the agent MUST regenerate `docs/dev/PHASE_HANDOVER.md` containing: the Locked Decisions (§1.3) restated; current DDL snapshot; repository method signatures; store interfaces as implemented; worker/worklet message protocol versions; component tree topography; kernel inventory; deliberate stubs/technical debt. A new session MUST parse this spec **and** the handover before writing any code, and MUST reuse established patterns rather than inventing parallel ones.

**Continuation prompt mandate:** after the handover is written and the phase branch is merged (§13.3.4), the agent MUST end its final message with the **next** phase's session prompt — generated from the canonical template in §13.7 with its placeholders filled — inside a raw fenced markdown block, ready to paste into a fresh session with zero additional context. Then stop. This self-perpetuating chain is the primary continuity mechanism; the handover document is its payload.

### 13.2 Protocol Beta — Autonomous TDD

For every domain feature: write the failing tests first (unit or offline-render per §11), implement, run the suite, and only then build dependent layers. Halt for the human only if tests still fail after the two permitted correction attempts (§13.4) or if fixing them would contradict the handover's locked schema.

### 13.3 Protocol Gamma — Autonomous Execution

**13.3.1** Within a phase the agent proceeds continuously without asking permission between tasks, self-correcting lint/type/test failures up to the two-strike limit.
**13.3.2 Halt & Query thresholds** (the only reasons to stop): genuine architectural ambiguity where guessing risks structural debt; scope bleeding into a future phase or §1.4 non-goal; destructive schema/data changes beyond the migration pattern; a needed dependency outside the closed matrix (§2.2); phase completion.
**13.3.3 Patch hygiene:** surgical edits only; never write truncation placeholders ("… rest unchanged") to disk; keep the build green at every commit; commit messages describe _what/why_, never internal process.

**13.3.4 Concurrent-Agent Worktree Discipline.** Multiple agents may work on this repository concurrently. All phase work therefore happens in a dedicated **git worktree**, never in the main checkout:

- Create branch `phase-<N>-<slug>` and worktree `.claude/worktrees/phase-<N>` (this path is gitignored and excluded from the test sweep, §2.3). Every file operation for the phase uses absolute paths inside that worktree.
- **Phase 0 bootstrap exception:** the repository does not exist yet — first `git init` + an initial commit on `main` in the project root (`.gitignore`, this spec as-is), then immediately create the phase-0 worktree and do all scaffold work there.
- Each worktree runs its **own `npm install`**. No junctions/symlinks to the root `node_modules`; if one is ever created for speed, it MUST be removed _before_ `git worktree remove` (Windows junction + worktree removal is a known data-loss trap).
- Never modify the main checkout or another agent's worktree; expect `main` to have advanced while you worked.
- **Completion sequence:** merge `main` into the phase branch (trivial conflicts resolved; non-trivial conflicts are a Halt & Query, §13.3.2) → re-run full verification green **inside the worktree** → from the main checkout, `git merge --no-ff phase-<N>-<slug>` → `git worktree remove` the worktree → delete the branch.

### 13.4 Protocol Delta — Blast Radius & Rollback

Before any multi-file fix, note the intended blast radius (files + tables). Maximum **two** autonomous attempts at a given bug; on the second failure, `git` revert to the last good state, write a root-cause analysis, and await human input. Panic-fix cascades across unrelated files are forbidden.

### 13.5 Verification Ergonomics

The `:memory:`-driver unit path and mocked bridges (§11.3) are for logic; they never prove the real OPFS/SAB/worklet path — the Playwright smoke (§11.4) is the proof and MUST stay green per phase. Audio correctness beyond "no errors" is proven by offline renders (§11.2), not by ear alone; human listening QA is the final polish gate, not the primary verification.

### 13.6 Protocol Epsilon — Anti-Drift Enforcement

Prose rules do not stop drift; gates do. The following are mechanical, not advisory:

- **Naming freeze.** Every identifier this spec names — store names, file paths (§2.5), constants (§2.6), worker/worklet filenames, message `kind`s (§7.1.3), DB tables/columns (§9.3), effect IDs (§5.7), parameter address forms (§7.8) — is binding. The agent MUST NOT rename, "improve", or synonymise them. If a name proves genuinely wrong, that is a Halt & Query, then a §14 entry.
- **Spec anchors in code.** Any implementation choice that is non-obvious without this document carries a `// spec §x.y` comment (house style). This is for the _reviewer's_ traceability — it is the one sanctioned "why" comment form.
- **Green-before-next.** `type-check`, `lint`, and the unit tests covering the touched area MUST pass before the next task begins; the full suite plus the browser smoke MUST pass at phase exit. Building on top of a red build is forbidden.
- **Enforcement scripts** (Phase 0 deliverables, aggregated as `npm run verify`, run at every phase exit):
  - `check:deps` — fails if `package.json` contains any package outside the §2.2 matrix, or any forbidden package.
  - `check:lang` — scans identifiers and UI strings for American spellings (color/behavior/initialize/synchronize/normalize…) with an explicit allowlist file for platform API names (`AnalyserNode` is British already; `normalize()` the string method, `KeyboardEvent.getModifierState` etc. are platform-fixed and allowlisted).
  - `check:stubs` — every temporary stub or deferred wiring is tagged `// STUB(phase-N): reason`. The script lists open stubs (they must appear in the handover) and **fails** from Phase 7 onward if any remain.
- **In-repo precedent rule.** The DB worker, RPC bridge, `sw.ts`, `vite.config.ts`, and the PWA update prompt are written and proven; they are the reference patterns for this codebase. Before adding anything adjacent to them, read the existing file and extend its pattern rather than designing a parallel one. (This rule previously pointed at an external reference repository, retired in §14 2026-07-18 (l).)
- **No invented documentation.** Uncertain API ⇒ read `node_modules` types or the existing call sites in this repo (§2.7); still uncertain ⇒ Halt & Query. Writing a call site from memory that contradicts installed types is treated as a failed review, not a style issue.
- **Commit cadence.** Small commits at each green milestone; the working tree is clean at every session end; messages describe _what/why_ only.

### 13.7 Canonical Session Prompt Template

Each phase runs in a fresh session bootstrapped by a **self-contained prompt**. The outgoing agent generates the next one from this exact template (fill `<N>`, `<N+1>`, `<PHASE_NAME>`, `<slug>`; keep everything else verbatim; drop the two "[Phase 0 only: …]" notes for phases ≥ 1). The generated prompt MUST be the final thing in the agent's last message, in a raw fenced markdown block (§13.1).

```markdown
# BangerBox — Phase <N> Implementation Session

You are implementing **BangerBox**, an offline-first PWA DAW/sequencer/sampler. Work in
the repository root you have been opened in.

## Before writing any code (mandatory, in this order)

1. Read the **entire** specification at `docs/todo/_spec.md`. It is the single, binding
   source of truth — every schema, locked decision (§1.3), pinned API (§2.7), and
   protocol (§13) applies to this session.
2. Read `docs/dev/PHASE_HANDOVER.md` fully (Protocol Alpha, §13.1) and reuse its
   established patterns — never invent parallel ones. [Phase 0 only: it will not exist
   yet — proceed on the spec alone.]
3. Set up your isolated worktree (§13.3.4): branch `phase-<N>-<slug>`, worktree at
   `.claude/worktrees/phase-<N>`, its own `npm install`. ALL work happens inside that
   worktree — never in the main checkout, which other agents may be using concurrently.
   [Phase 0 only: the repo does not exist yet — first `git init` + an initial commit on
   `main` in the project root, then create the worktree.]
4. Post a brief high-level execution plan for the phase before touching the file system.

## Task

Execute **Phase <N> — <PHASE_NAME>** (spec §12) autonomously and end-to-end under the
spec §13 protocols: continuous execution, halting only at the §13.3.2 thresholds; TDD
(§13.2); two-strike rollback (§13.4); anti-drift gates (§13.6 — naming freeze,
`// spec §x.y` anchors, green-before-next, `npm run verify`). **Never write a library
call from memory** — use the Pinned API Contract (§2.7), the installed `.d.ts` under
`node_modules/`, or an existing working call site in this repo.
British English throughout (§3.7). The repo is public: no secrets, no personal data;
small green-milestone commits describing what/why only.

## Definition of done

Every Phase <N> exit criterion in spec §12 is met, including the Multi-Lens Review
(§3.5), with all verification commands green inside the worktree.

## End-of-session obligations (in order)

1. Land the phase per §13.3.4: merge `main` into the phase branch, re-verify green,
   merge the phase branch into `main` with `--no-ff` from the main checkout, remove the
   worktree, delete the branch.
2. Regenerate `docs/dev/PHASE_HANDOVER.md` on `main` (Protocol Alpha, §13.1).
3. Report results honestly — including anything skipped, stubbed, or failing.
4. End your final message with the **Phase <N+1>** continuation prompt, generated from
   spec §13.7 with placeholders filled, in a raw fenced markdown block — then STOP.
   Do not begin Phase <N+1>. [After the final phase: state that the chain is complete
   instead of emitting a prompt.]
```

## 14. Changelog

- **2026-07-18 (t)** — _End-of-buffer declick and the §6 layer trim wired through to playback, from an investigation into an audible click at the end of a played sample. Adds `DECLICK_FADE_MS` to the §2.6 registry and one §5.4 rule._ **(1) The click was the engine, not the samples.** Every fade in the voice pool existed to handle an *interruption* — `VOICE_STEAL_FADE_MS` on a steal, `CHOKE_FADE_MS` on a choke, the amp release on note-off. A voice that simply reached the end of its buffer had none: the amp gain sat at the AHDSR sustain level, the `AudioBufferSourceNode` ran out of data, and output stepped from the sample's last frame straight to zero in one frame. §5.4 already said a voice is "never a hard cut/click", but only stealing was written to enforce it; that rule now covers every ending. Two paths made this reliably audible rather than theoretical: a `oneShot` pad is skipped by `release()` by design, so the buffer end was its *only* ending, and §8.5.4 chop slices are cut at transient boundaries, which never land on a zero crossing. **(2) `scheduleAmpDeclick` in `voiceEnvelope.ts`** holds the param with `cancelAndHoldAtTime` and ramps linearly to true zero at the region end. Reaching zero by the end outranks completing the AHDSR contour, so whatever segment is still running is truncated — and because a later note-off or steal holds the param at its own earlier time, the interruption fades continue to win over this one. The fade start is clamped to the voice's note-on so a voice shorter than the fade cannot ramp from before it exists. **(3) The §6 per-layer trim was resolved but never played — fixed as part of the same change, since the two are one mechanism.** `resolveDrumVoice` has always carried `startFrame`/`endFrame` from the velocity layer, but `resolvedVoiceToTrigger` dropped both and the pool called `source.start(now)` with no offset or duration, so trim was silently a no-op at playback (the comment in `programVoice.ts` claiming it was "applied Phase 6" was wrong). Both fields are now forwarded and the source starts at the trimmed offset for the trimmed duration. This had to land *with* the declick, not after it: an `endFrame` that cuts mid-waveform is precisely the case that clicks hardest, so wiring trim up without the fade would have made the reported symptom worse. **(4) `playRegion` resolves the trim defensively.** `endFrame` of 0 is the schema default meaning "whole sample", and an inverted or out-of-range pair also degrades to the buffer's end — a stale trim can never silence a pad. **(5) The declick's end time is derived from the voice's base detune only.** A pitch envelope, keygroup glide or pitch LFO varies the real playback rate over the note's life, so for those voices the fade is an approximation rather than frame-exact; for the common untuned case it is exact. Making it exact would mean integrating the detune schedule, which is not worth the complexity for a 3 ms fade. **No schema, DDL, store or sequencer behaviour changed;** the §8.5.4 chop write path was deliberately left alone (a fade-in there would dull the very transient the slice is cut on) and is filed as a follow-up.

- **2026-07-18 (s)** — _Factory generator stops reimplementing the app's own schema factories and packer. Supersedes item (8) of (p); no behavioural change to the shipped app._ §9.8 was implemented twice concurrently; the version on `main` shipped, and an unmerged branch (`feat/factory-content`, tip `effe30e`) carried one technique worth adopting, now salvaged here before that branch was retired. **(1) `scripts/factory/resolve-hook.mjs` + `register.mjs`.** A ~30-line Node loader hook supplying exactly the two rules the app's source relies on Vite for — the `@/` alias (§2.3.6) and extensionless `.ts` / `/index.ts` resolution — installed via `node --import`. Build-time only; it never reaches the browser, and the Vitest suite already goes through Vite so tests need no hook. With it the generator imports `createDefaultDrumProgram` / `createDefaultPad` / `createDefaultChannelStrip` (§6), `packMpcweb` (§9.6), `samplePath` (§9.1) and `encodeWav` (§9.4) directly, and the hand-mirrored copies of all of them are deleted (`scripts/factory/snapshot.mjs` loses 45 lines net). A second definition of a pad or of the archive layout can no longer exist to drift. **(2) `packMpcweb` gains an optional `exportedAt` (§9.6).** A user export omits it and gets "now"; the factory pins it, which pins both the manifest timestamp and every zip entry mtime. This deletes the generator's private re-implementation of the §9.6 archive layout, and with it the last place `MPCWEB_FORMAT_VERSION` was duplicated. **(3) A determinism defect in the salvaged approach was found and fixed before adoption — this is the part worth reading.** `createDefaultPad` and `createDefaultChannelStrip` mint insert-slot ids with `crypto.randomUUID()` (§1.3.1). Calling them verbatim, as the unmerged branch did, makes every rebuild emit different ids and therefore different archive bytes, silently violating §9.8's byte-reproducibility requirement — the branch's own determinism test could not have been passing. The fix keeps the real factories (so future §6 fields are picked up automatically, which is the actual point) and re-stamps every generated id from the seeded derivation immediately afterwards, documented at the head of `snapshot.mjs`. `factoryPacks.test.ts` builds twice and compares bytes, so a missed re-stamp fails the suite rather than shipping irreproducible packs. **Suite unchanged at 823 tests; `build:factory` output is byte-identical in size and structure to the previous generator.**

- **2026-07-18 (r)** — _Test-seam fix, from an investigation into three stacked "Autosave failed — will retry." toasts observed during the browser smoke's multi-tab guard step. No product code changed; §4.4 autosave behaviour is unaltered._ **The toasts were a defect in the §11.4 audio probe, not in the application, and were unrelated to the multi-tab guard.** `recordThenPlayback` in `ui/audioProbe.ts` fabricated its one-bar smoke sequence and track by calling `useSequenceStore.hydrate` directly — and bound the sequence to a throwaway `crypto.randomUUID()` project id rather than the open project. `hydrate` is the DB → store load path: it replaces the model wholesale and deliberately marks nothing dirty (spec §4.4), because everything it loads already exists in the database. Injecting a synthetic track through it therefore produced a track that existed **only in memory** while a live autosave queue was registered. The probe then recorded onto that track, `commitRecordedTake` marked `events:<trackId>` dirty, and every flush of that key failed in the DB worker with `SQLITE_CONSTRAINT_FOREIGNKEY` (SQLite result code 787) on the `midi_events` → `tracks` foreign key — one warning toast per retry. **Fixed by inserting both rows through the repositories before hydrating, and binding the sequence to the live project id,** so the store and the database agree and the recorded take persists as the proof's own description implies it does. **Diagnostic notes for future readers.** (1) The toasts appeared during the multi-tab step only because that is where the smoke next pauses long enough to see them; they are raised ~2 s after the *record* step, several steps earlier, and reproduce with no second tab ever opened. (2) They are self-limiting rather than an infinite retry loop — the queue drains once the stale store entry clears — which is why the run stayed green and nobody noticed. (3) The toast text discards the underlying `DbError` and its SQLite result code, which is what actually identified this; that error is what any similar investigation should recover first. **In normal single-tab use this cannot occur:** no product path puts a track in the store without persisting it — `addTrack` marks `track:<id>` dirty, and `hydrate` only ever loads rows that already exist. **The smoke now asserts on toasts, which is the reason this went unseen.** It checked console and page errors but never the toast queue, so a warning the user would plainly see failed nothing. `wireToastRecorder` installs a MutationObserver as a Playwright init script (before any page script, re-installed on every navigation) that appends every toast to `__toastLog` **as it is raised** — sampling the DOM at the end cannot work, because toasts are transient and an early warning has usually gone by the time a later step looks. `assertNoWarningToasts` then fails the run on any `warning`/`error` toast, quoting each message; `info`/`success` are allowed, being user-action confirmations. Verified by reverting the probe fix and re-running: the new step fails with all four autosave toasts named — one more than the DOM ever showed at once. This required one product-side seam: `data-testid="toast"` and `data-tone` on the toast element in `ui/ToastViewport.tsx`, because `role` alone cannot distinguish a toast from the §8.2 announcer, which is also `role="status"`. **No other product behaviour changed;** 748 unit tests pass (the probe and the smoke are browser-only scaffolding with no unit coverage), and the dev smoke passes 19/19 with the new step.
- **2026-07-18 (q)** — _§9.8 Factory Content & Demo Projects implemented. Records the implementation decisions §9.8 leaves open. **Items marked ⚑ are flagged for human ratification** — they are semantic choices, not mechanical details._ **(1) Deterministic ids in the build script, departing from §1.3.1.** §1.3.1 mandates `crypto.randomUUID()`; `scripts/build-factory.mjs` instead derives UUIDv4-shaped ids from its seeded PRNG. Random ids would change the archive bytes on every rebuild, which §9.8 explicitly forbids. The rule is unaffected at runtime: these ids are build artefacts that the install path remaps wholesale (§9.6) before they ever reach a database, so nothing globally unique depends on them. **(2) The catalogue is a bare JSON array.** §9.8 specifies the per-pack entry shape and no wrapper object, so none was invented (§13.6 naming freeze) — no `version` or `packs` envelope. Two validation rules were added on top of the specified fields: pack `id`s must be unique (the UI keys on them), and `file` must match a bare `*.mpcweb` filename, because the catalogue is network input that is concatenated into a fetch URL and a path-traversal guard belongs at the schema. **(3) ⚑ The §9.7 gate measures the unpacked payload, not the catalogue's `bytes`.** §9.8 requires the hard stop be "checked against the pack's uncompressed sample payload", but the catalogue schema it specifies carries only the archive size. Rather than extend that schema, the archive is unpacked in memory — which necessarily happens before any OPFS write anyway — and the summed uncompressed sample bytes are what the gate sees. This keeps the specified schema exactly as written and is strictly more accurate than any declared size could be, since a declared size is a claim and this is a measurement. **(4) ⚑ Kit-merge transactionality is by compensation, not by construction.** §9.8 requires both install modes be "transactional in the §9.6 sense". For a `demo` that is free and identical to §9.6: nothing is visible until the new project is opened. A `kit` merge writes into a project the user already has open, so that structural guarantee cannot apply. It is implemented instead as compensating rollback — every OPFS path written and every row inserted is recorded, and a failure unwinds them in reverse, best-effort per item so one failed cleanup cannot abort the rest. This is a genuine semantic difference from §9.6's guarantee (a crash between write and unwind can still leave residue, where the import path cannot), which is why it is flagged. **(5) ⚑ The house demo's "Q-Link-mapped filter sweep" ships as an automated insert, not a stored binding.** §9.8 asks for a Q-Link-mapped sweep citing §10.3, but §10.3 persists Q-Link bindings in `app_settings`, which is outside the §9.6 project snapshot — a `.mpcweb` pack structurally cannot carry one. The demo therefore ships a `filter` insert on its drum track with a four-bar cutoff automation lane; the parameter becomes Q-Link-reachable through the §10.3 `screen`-mode focus registry when its insert panel is opened. If §9.8 intended packs to be able to ship bindings, that requires extending the interchange format and is a Halt & Query. **(6) `installUnpackedAsNewProject` extracted from `importMpcweb`.** Additive refactor with no behaviour change, so that §9.8's "same path as a user import" is literally one path rather than two that resemble each other. **(7) Service worker gains `OWNED_CACHES`.** `activate` previously deleted every cache whose key was not the precache, which would have evicted `bangerbox-factory-v1` on every update. Both caches are now owned and swept together; the §2.4 precache glob is unchanged and packs stay out of it, so `pruneStalePrecache` cannot reach them. **(8) The build script reuses the app's own modules rather than copying them — superseded, see (s).** Originally the generator reused only `encodeWav` (Node ≥ 24, §1.3 #2, strips types natively and `wav.ts` has type-only imports) and mirrored the §6 program payload and §9.3 row shapes by hand, because Node cannot resolve the app's extensionless bundler-style imports; `factoryPacks.test.ts` guarded that mirror against drift. **§14 (s) removed the mirror entirely** via a build-time module-resolution hook, so the generator now calls the app's real §6 factories, §9.6 packer and §9.1 path helper. The guard test remains, now as an output-correctness test. **(9) A browser-smoke step was added**, departing from the Phase 8 precedent of adding none. §9.8's install path is OPFS writes and SQLite inserts, which the unit suite necessarily mocks; per §13.5 the real path is only proven in a browser, so the smoke fetches the catalogue over HTTP, merges a kit into the live project and opens a demo. **No audio, sequencer, schema, DDL or mode behaviour changed; no dependency was added (§2.2 intact).**
- **2026-07-18 (p)** — _Factory content specified, directed by the human developer so that a new user can make sound before sourcing any audio of their own. Adds §9.8; revises the §2.5 layout and §8.5 item 7. **Specification only — no code was written and none of this is implemented.**_ **(1) Delivery reuses `.mpcweb` (§9.6) rather than introducing a factory format.** Packs are fetched from `/factory/` and installed through the existing unpack → Zod-validate → UUID-remap → OPFS-write → row-insert path, so factory content is a *client* of the import pipeline and not a second one to keep in step with it. This is what keeps the §2.2 dependency matrix closed: a bespoke format would want its own reader, and the zip/validation/remap machinery already exists. `public/factory/index.json` is a Zod-validated catalogue (`{ id, title, kind, file, bytes, description }`). Packs are fetched, never base64-inlined — the §12 Phase 3 `demoSample.ts` pluck is inlined, and that entry explicitly does not generalise past a few hundred KB. **(2) All shipped audio is generated procedurally by `scripts/build-factory.mjs` from pure synthesis.** The repository is MIT-licensed and publicly deployed (changelog (l), (m)), so anything shipped must be unencumbered; synthesising removes provenance risk outright rather than managing it, keeps the repo small, and suits a drum machine whose sounds are synthesised anyway. Curated third-party CC0 material is **out of scope** — if it is ever wanted it needs a provenance manifest (source URL, author, licence, SHA-256 per file) and its own decision here first. **Output MUST be byte-deterministic:** seeded PRNG for noise, fixed zip entry mtimes, pinned `exportedAt`/`created_at`/`modified_at`. Without that a rebuild produces a different payload for identical inputs, which defeats caching and makes any diff of the artefact meaningless. **(3) `public/factory/` is a gitignored, regenerated artefact**, the same discipline §5.6 applies to the WASM kernels — `npm run build:factory` runs ahead of `build`, and the `.gitignore` entry is owed when the script lands. **(4) Two install modes, because a kit and a demo are not the same act.** A `demo` installs as a new project and opens it; a `kit` MERGES into the *active* project — its programs and samples are inserted, its sequences, tracks and song entries discarded — since a user reaching for a kit is working on something and does not want it replaced. Both remap every UUID and both are transactional in the §9.6 sense: no partial project, no orphaned OPFS files. **(5) Installing a pack is a storage-growing write** and passes the §9.7 90 %-of-quota hard-stop, checked against the pack's *uncompressed* sample payload **before** any OPFS write — checking the compressed size would let a pack through that cannot fit once unpacked. Refusal is graceful, with the Browser-mode purge affordance. **(6) The §2.4 precache glob is NOT widened** to cover `.wav` or `.mpcweb`; a fresh install would otherwise pull the entire shipped payload before the app first ran. Packs and the catalogue are runtime-cached cache-first in a dedicated `bangerbox-factory-v*` cache, deliberately separate from the precache so the §2.4 stale-precache prune cannot evict them. **(7) v1 content:** three kits (~40 samples — 808-flavoured, 909-flavoured, acoustic-ish) and three demos (a four-bar boom-bap loop; a house track exercising mixer automation and a Q-Link-mapped filter sweep, §10.3; a Song-mode arrangement of several sequences, §7.9). Total shipped payload under 8 MB, 48 kHz mono 16-bit WAV. Samples are duplicated per demo project, matching the existing per-project isolation model; `/global_library/` de-duplication (§9.1) stays deferred and is not a prerequisite. **(8) Correction while drafting:** the caching rule as first written cited a §2.3.5 that does not exist in this document — the service worker and its precache glob are §2.4, and the reference was repointed there.
- **2026-07-18 (o)** — _Mode layout defect fix and storage relocation, directed by the human developer after seeing panel contents painting outside their panels on Main. Revises §8.1 and §8.5.1._ **(1) The layout defect, in the shared `Panel` (§3.5/§3.6 — one container, so one bug reached all 12 modes).** Every panel's `<section>` carried `min-h-0`, which removes a flex item's automatic minimum size. Panels are flex items in height-constrained columns, so each border box could shrink *below* its own body and the children painted outside the panel — measured at 1280×800 as 36 px on Now playing, 230 px on Quick pads, and non-zero on every other panel in the mode. `min-h-0` is only meaningful for a panel that *scrolls*; a fixed panel must refuse to shrink. A panel now either absorbs the leftover height (`scroll`, or the new `fill`) or holds its content height (`shrink-0`), and a `fill` body is a flex column so the child that scales can claim the space. **(2) A mode now fits its viewport (§8.1) instead of scrolling as a page.** `<main>` is `lg:overflow-hidden`; page scroll is retained below `lg`, where the modes stack into one column and fitting is impossible. `Pad` and `XYSurface` gain `fill`, dropping their fixed aspect ratios so pad grids and the XY surface scale to the space left rather than dictating it. **This exposed four modes that had been relying on the page scrollbar and were silently overflowing before this change:** Perform (624 px clipped at 1280×800), XYFX (209 px), Grid (a `min-h-96` floor on the Note editor panel, whose `GridCanvas` already had a ResizeObserver and wanted to fill), and Program Edit — which is irreducibly taller than any viewport (layers, envelopes, mod matrix) and now scrolls inside itself, keeping the transport bar and mode rail fixed. **(3) Storage usage moved from the Main dashboard to a persistent transport-bar gauge (`StorageGauge`), amending §8.5.1's enumerated Main contents.** The developer questioned why storage occupied prominent dashboard space. The figure's purpose is a *warning*, not a statistic: §9.7 hard-stops any storage-growing write at 90 % of quota, so the moment it matters is mid-session while importing samples or bouncing — which a dashboard the user last looked at an hour ago cannot serve. The gauge reports in all 12 modes (strictly more available than §8.5.1 required), turns amber at 75 % and red at the hard stop, and carries the eviction state. **It also takes over the §9.7 first-run persistence request**, which previously fired wherever `StoragePanel` mounted; with that panel off Main it would otherwise have fired only if the user happened to visit the mode hosting it. The transport bar is the only always-mounted surface, so the request belongs there. **(4) Durable-layer diagnostics (SQLite version, boot status, self-test) moved to Q-Link Edit's new Storage panel**, with the other device settings, behind a collapsed disclosure. The §9.7 eviction warning stays *outside* that disclosure — it is a condition to act on, not a diagnostic to go looking for. `scripts/browser-smoke.mjs` drives the storage steps in Q-Link Edit accordingly and gains a step asserting the transport gauge reports usage. **No audio, sequencer, storage, schema or persistence behaviour changed;** 748 unit tests and the dev-section browser smoke pass.
- **2026-07-18 (n)** — _Capability-gate defect fix and start-up UX, directed by the human developer after hitting the gate intermittently in Firefox. Revises §1.3 #15 and §1.4._ **(1) Three defects in `public/coi-bootstrap.js`, which together made the §2.1 gate fire intermittently on a browser that was in fact capable.** (a) The single-reload guard introduced in (m) was a one-shot `sessionStorage` flag, set *before* reloading and never cleared. One failed attempt therefore short-circuited every subsequent navigation for the remainder of the browsing session — the gate appeared, a reload could not clear it, and only closing the tab would. This is the intermittency the developer observed. It is now an attempt *counter* (max 2), cleared the moment isolation succeeds, so a transient failure costs one retry rather than a session. (b) The reload was driven solely by `controllerchange`, an event that cannot fire when a worker is *already* controlling the page but the navigation was served from the HTTP/back-forward cache without headers — a state the old code would wait in forever. A `navigator.serviceWorker.ready` path now covers it. (c) `sessionStorage` **throws** rather than returning `null` when storage is blocked (Firefox's block-cookies setting, some private windows); that exception escaped and aborted the bootstrap *before* `register()`, so the worker never installed at all and isolation could never be achieved. Every access is now wrapped. **(2) §1.3 #15 clarified, not loosened.** The gate has always been capability-based and never checked browser identity; Firefox passes every hard requirement and has therefore always been able to run, which the old wording ("explicitly unsupported… a capability gate enforces this") wrongly implied was prevented. The decision recorded here is to keep enforcement by capability — a probe cannot be wrong about what a browser can do, a UA string can — and to add a **dismissible** `UnsupportedBrowserNotice` (§8.1) for engines outside the Chromium baseline. Firefox/Safari remain out of scope for testing and bug fixing per §1.4; they are simply not locked out. `detectBrowser` is UA sniffing and is confined to that notice and to the wording of advice; it MUST NOT gate access. **(3) `CapabilityGate` rewritten for a non-developer reader (§2.1 "friendly, styled" now has teeth).** The old screen listed raw API names under a blanket "Firefox and Safari are not supported", which was both inaccurate (see 2) and unactionable. Each missing requirement now carries its own plain-English name, what its absence costs the user, and a specific remedy — `HARD_CAPABILITY_DETAILS` in `core/platform/capabilities.ts`, with `HARD_CAPABILITY_LABELS` derived from it so the two cannot drift. When *everything* missing is isolation-related the screen leads with "BangerBox needs one more reload" and a reload button instead of implying the browser is at fault, because that is the overwhelmingly common case and (1) made it common. Added: outbound links to the repo, wiki and issue tracker (`core/platform/links.ts`), and a Copy diagnostics button. **`links.troubleshooting` deliberately points at in-repo `docs/TROUBLESHOOTING.md`, not the wiki** — a GitHub wiki serves its Home page with HTTP 200 for any page that does not exist, so a deep link to an unwritten wiki page silently misdirects the reader instead of failing visibly; repoint it once that wiki page exists. **(4) `scripts/gate-smoke.mjs` (new, `npm run test:gate`).** The browser and Pages smokes both prove the app gets *past* the gate; nothing exercised the gate itself, and nothing guarded the bootstrap's retry logic — which is exactly where (1) hid. Not in CI: like its siblings it drives system Edge (§1.3 #13). **No audio, sequencer, storage, schema or mode behaviour changed.**
- **2026-07-18 (m)** — _GitHub Pages deployment, CI and repository security, directed by the human developer. Revises §1.3 #14, which had held Pages out of scope until requested._ **(1) Pages deployment (§1.3 #14).** `src/sw.ts` gains a second responsibility: it now re-wraps every response it serves with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin`, because a static host cannot send them and `crossOriginIsolated` is a HARD §2.1 capability. Opaque and error responses are passed through untouched. This subsumes the old `preserveRequestUrl` helper — constructing a fresh Response already clears `response.url`, which is what kept `?vfs=opfs` intact on sqlite-wasm's OPFS proxy worker offline; that reasoning moved into the new function's comment rather than being lost. **(2) `public/coi-bootstrap.js` (new).** A service worker cannot affect the response that loaded the page registering it, so the first Pages visit is never isolated. This classic script, loaded from `<head>` before `main.tsx`, registers the worker and reloads once. **It registers the worker itself rather than merely awaiting one, and that is load-bearing:** `main.tsx` runs the §2.1 gate *before* mounting `<App/>`, and the PWA registration lives inside `<App/>` (`usePwaUpdate`). Waiting for a controller would therefore deadlock — gate blocks, `<App/>` never mounts, worker never registers, headers never arrive, gate blocks forever. A `sessionStorage` flag bounds it to a single reload so a genuinely unsupported browser falls through to the gate instead of looping. **(3) Base path (§2.3).** `vite.config.ts` takes `base` from `BANGERBOX_BASE`, defaulting to `/`. Only the deploy workflow sets `/BangerBox/`; dev, preview, `Run.ps1` and the browser smoke are byte-for-byte unchanged, preserving local-first as canonical. The manifest `id`/`scope`/`start_url` are derived from the same constant — a project Pages site is served from a repository subpath and the PWA will not install if they disagree. **(4) Pre-existing defect fixed, found by the new Pages smoke.** `core/sequencer/messages.ts` built `z.instanceof(SharedArrayBuffer)` at module scope. `SharedArrayBuffer` is *undefined* when not cross-origin isolated, so importing that module threw a ReferenceError and took down the entry bundle before `main.tsx` could run — meaning every unsupported browser, and every first Pages load, got a **blank page instead of the §2.1 capability gate**. It was invisible locally because the dev and preview servers always set the headers. Replaced with a `z.custom` guard that checks `typeof` first. The gate's whole purpose is to explain an unsupported environment, so this defeated §2.1 wherever it mattered most. **(5) `scripts/pages-smoke.mjs` (new, `npm run test:pages`).** The existing browser smoke drives dev and preview, and both send the headers themselves, so neither can prove the Pages path. The new script serves `dist/` from a deliberately header-less static server and asserts both halves: with the worker reachable, isolation is achieved after one reload and the app boots; with it blocked, the capability gate renders rather than a blank page — a direct regression guard on (4). Not in CI: like the browser smoke it drives system Edge (§1.3 #13). **(6) CI and repository security.** `.github/workflows/tests.yml` runs type-check, lint, `npm run verify`, the unit suite (after `build:wasm` — the kernels are gitignored artefacts) and a production build, on push to `main` and on PRs. `format:check` is deliberately omitted until the 25 pre-existing Prettier-dirty files are fixed, so CI is not born red. `.github/workflows/deploy.yml` is `workflow_dispatch`-only. `.github/dependabot.yml` groups minor/patch bumps and pins the §2.2-blocking majors (ESLint, TypeScript); note that a Dependabot PR *adding* a package will fail `check:deps` by design. Secret scanning, push protection, Dependabot alerts and security updates, and private vulnerability reporting are enabled on the repository. **No audio, sequencer, storage, schema or UI behaviour changed;** 733 unit tests, the 33-step browser smoke and the 7-check Pages smoke all pass.
- **2026-07-18 (l)** — _Pre-publication preparation, directed by the human developer, ahead of the repository's first public push._ **(1) Absolute local filesystem paths removed:** the checkout location of the external reference repository (§1.3 #6, §2.7, §13.7) and of the BangerBox checkout itself (§13.7). They recorded a directory layout on the developer's machine — the environment detail §1.3 #3 keeps out of a public repo. The §13.7 template now tells the incoming session to work in the repository root it was opened in, which is how every session has actually started. **(2) The external reference repository is no longer named anywhere in this document or in source comments, and the rule requiring its consultation is retired.** It was a private project used as a proven pattern source during Phases 0–8; those patterns are now embodied in this repo's own working files, so the dependency served its purpose and has ended. The §13.6 "reference-implementation rule" is replaced by an **in-repo precedent rule**: the DB worker, RPC bridge, `sw.ts`, `vite.config.ts`, and the PWA update prompt are written and proven, and are themselves the reference patterns to extend rather than design around. §2.7's "never write a library call from memory" rule is unchanged in force — its third fallback is now an existing call site in this repo rather than an external one. Source-comment attributions ("adapted from the proven … X") were removed in 16 files; **every technical explanation those comments carried was kept verbatim** — only the provenance clause went. No behaviour, constraint, name, or schema changed, and no code path was touched. **(3) Added:** a root `LICENSE` (MIT, matching the `license` field `package.json` has always carried) and a public `README.md`. Neither is a spec artefact; neither supersedes any part of this document.
- **2026-07-18 (k)** — _Phase 8 implementation session (Hardware & Q-Link Ecosystem); recorded under the §0 completeness rule. All §10 constraints preserved._ **(1) Parameter-registry extensions (additive, §7.8; no address form changed):** `PROGRAM_PARAM_RANGES` gains `amp.attack` and `amp.release`, because §10.3 names Amp Attack and Amp Release among the pad-mode Q-Link defaults and §7.8 gates binding on registration — without them two of the spec's own four defaults could not exist. A new `transportParam` target kind adds `transport.swing` and `transport.bpm`: §10.3 names "global swing" among the project-mode macros and `QLinkBinding.targetStore` already admitted `'transport'`, so the addresses were implied by the existing schema rather than invented. New bound `ENVELOPE_TIME_MS_RANGE` (0–10 000 ms) constrains what an *encoder* can dial; stored envelopes remain floored only at `ENVELOPE_TIME_MS_MIN`. **(2) Additive store actions (§4.2 permits adding; none removed):** `useProgramStore.setPadParamTransient` / `commitPadParam` give program-scope sound-design leaves the same transient/commit channel the mixer store already had (§4.1), so a turning encoder streams values without flooding undo. A new `programParams` sync subscriber (§4.3) pushes those leaves to the voices already sounding, via a new `SyncBridge.applyParam`; amp-envelope *times* are deliberately excluded from that push because an AHDSR is applied at note-on (§6), so they take effect on the next hit. **(3) `AudioEngine.triggerLiveNote` gains an optional `timestampMs`** (defaulting to `performance.now()`, so every existing caller is unchanged) and a new `applyPitchBend`; BLE input therefore joins the *existing* §7.6 dual path with its reconstructed, latency-compensated timestamp rather than adding a third path, exactly as §10.2/§10.4 require. **(4) Implementation choices §10 leaves open:** the parser reconstructs a message's timestamp by unwrapping the 13-bit clock against packet arrival, treating any stamp more than 1 ms in the future as belonging to the previous 8 192 ms window, and carries a low-byte wrap *within* a packet into the high bits; pitch bend is normalised with the two halves scaled independently so both extremes reach ±1 despite the asymmetric 14-bit range; the ±1 CC hysteresis (§10.4) always admits the raw extremes 0 and 127 so the ends of a pot's travel stay reachable; relative (two's-complement) encoders step through the binding's *curve* in normalised space, 127 detents to a full sweep, so both encoder modes feel like the same control; the Q-Link dispatch keys off the parsed registry address rather than the binding's `targetStore` field, since the address is authoritative and cannot disagree with itself; and `program` Q-Link mode addresses registered §7.8 leaves directly, because §10.3 calls its targets "program macros" but §6 defines no macro layer and inventing one would breach §3.1 Strategic YAGNI and the §13.6 naming freeze. **(5) Pre-existing defect fixed:** `useMixerStore` parsed only a bare `<channelId>.<field>` path, so the canonical registry addresses the Mixer, XYFX and insert panels pass silently no-opped — those controls were dead (§3.4). Path parsing now delegates to the registry that owns the grammar and handles `insert:<channelId>:slot<N>.<param>`. The taper (`valueToNormalised`/`normalisedToValue`) moved from `ui/primitives/controlMaths.ts` into `core/math.ts` (re-exported, so no primitive's import changed) so hardware encoders and on-screen knobs map values through one implementation (§3.6). **(6) Web Bluetooth types are declared locally** in `core/midi/bleTypes.ts` rather than adding `@types/web-bluetooth`, following the `worklet-globals.d.ts` precedent; the §2.2 closed matrix is untouched. The BLE transport, packet parser, dual-path routing with the §10.2 latency offset, CC throttling (§10.4), the Q-Link runtime across all four modes with the Screen-mode `useQLinkFocus` registry, auto-reconnect with backoff, the Windows pairing helper, and per-mode binding persistence in `app_settings` were implemented per §10 as specified. **The §12 exit criterion "live hardware session sign-off with the human developer" is NOT met and cannot be self-certified — it requires the human developer with a physical ESP32 controller.**
- **2026-07-18 (j)** — _Spec revision directed by the human developer (§1.3: locked decisions and constraints may be revised only by the human developer, recorded here)._ **Removed the main-JS-chunk size budget and the cold-load target from §11.5** ("main JS chunk < 500 KB gzip (wasm/sqlite excluded, lazily loaded)"). Rationale: BangerBox is an offline-first, locally-installed PWA (§1.3 #14 local-first hosting), so bundle payload is not a user-facing cost worth constraining features against, and an agent reading the budget as a gate could refuse or complicate work to stay under it. **Also removed, at the same direction, the cold-load target** ("cold load < 3 s with warm SW"), as a load-time figure is a back-door payload constraint. §11.5 now carries an explicit note that bundle size AND load time are unconstrained, and that a size limit, a cold-load target, a size/timing gate in `npm run verify`, or code-splitting and deferred loading undertaken to hit either MUST NOT be reintroduced. **The remaining §11.5 budgets are unchanged and still binding** — touch-to-sound < 30 ms, zero underruns at 8 tracks + 4 inserts, and 60 fps with meters live — as these describe how the instrument behaves once running, rather than what it costs to load. The §12 Phase 7 exit criterion "perf budgets (§11.5) measured and met" now refers only to those remaining budgets. No code changed: no size gate ever existed in `verify`, `vite.config.ts` carries no `manualChunks`/`chunkSizeWarningLimit`, and no Phase 7 implementation decision was made on size grounds.
- **2026-07-18 (i)** — _Phase 7 implementation session (Full UI Assembly & Polish); recorded under the §0 completeness rule. All §8 constraints preserved._ **(1) Additive store fields (§4.2 permits adding fields with a changelog entry; none removed):** `useHardwareStore.inputLatencyMs` (+ `setInputLatencyMs`) holds the §10.2 input-latency offset the Q-Link Edit settings pane edits (default 15 ms, range 0–50); `useSequenceStore.grooveTemplates` + `trackGrooveIds` (+ `setGrooveTemplate`, `assignTrackGroove`) hold the §7.5 project-scoped groove templates and their per-track assignment. Both hydration fields are optional so pre-Phase-7 snapshots still load. **(2) Scheduler protocol extension (additive, §7.1.3):** a new `groove { trackId, template }` request kind carries the §7.5 template to `SchedulerCore`, which applies its timing offset and velocity scale at schedule time alongside swing — non-destructive, exactly as §7.5 specifies ("applied at schedule time like swing"); stored events are never rewritten. `SCHEDULER_PROTOCOL_VERSION` stays 1 (extend-by-adding-kinds precedent, §13.6 — no existing kind changed). **(3) §5.1 start gate promoted to a full-screen `StartGate`** owning engine bootstrap, suspend/resume re-surfacing, and actionable errors; the shell mounts only once the engine runs, so no mode can touch the graph before the worklets exist. The Phase 3 `AudioEnginePanel` became engine *diagnostics* (demo pads, metronome, master fader/meter) inside Main mode's §8.5.1 storage/engine section, and the Phase 4 `SequencerTransport` stub was **deleted** as superseded by the persistent §8.1 `TransportBar` (it duplicated the transport's `data-testid`). **(4) §9.1 worker sync-access-handle write path implemented** (`opfsWrite.worker.ts` + `opfsWriteClient.ts`), atomicity unchanged (temp file then rename, §9.7); sample and bounce writes take it above a 512 KiB threshold, smaller writes and worker-less environments keep `writeFileAtomic`. **(5) §9.5 bounce variants completed** — bounce song (honouring per-entry repeats and per-sequence tempo, §7.9), bounce selected track (post-insert/pre-master), and resample-to-pad, all sharing one `renderSegments` core with the sequence bounce so the tick→seconds maths cannot diverge. **(6) §7.8 per-voice program-parameter automation implemented:** program-scope leaves split by destination — `filter.cutoff`/`filter.resonance`/`pitch` ramp on each sounding voice of the pad via the voice pool, while `amp`/`pan` apply to the pad's mixer channel (applying those per voice would double them against the channel the voices already feed). This closed the last `STUB(phase-7)`; `check:stubs` reports none, as §13.6 requires from Phase 7 onward. **(7) Implementation choices §8 leaves open:** `ValueReadout` renders a `<span>` rather than `<output>` (the implicit `role="status"` would make every readout a live region competing with the toasts and the single §8.2 announcer); the mode rail is a `<div role="tablist">` inside a `<nav>` landmark (a `<nav>` cannot take an interactive role); tab panels are named by the mode's full title rather than the abbreviated rail label; `Modal` moves focus to the dialog container rather than its first focusable, which in DOM order is the dismiss button; pad velocity is taken from the vertical strike position (MPC convention) with a fixed nominal velocity for keyboard triggers; groove templates are assigned per track. The 12 modes (§8.5), the bespoke primitive set with the shared gesture engine (§3.6 zero-DRY), motion/tactility standards (§8.3), the accessibility pass (§8.2, now a mechanical 12-mode sweep), the dev perf HUD (§11.5), and the Screen Wake Lock (§2.4) were implemented per spec.
- **2026-07-18 (h)** — _Phase 6 implementation session (Sample Pipeline & Heavy DSP); recorded under the §0 completeness rule. All §5/§7/§8/§9 constraints preserved._ **(1) `transientDetect` algorithm (§7.5), flagged for human ratification:** implemented as an energy-flux onset detector — per-frame energy of the signal's first difference (a high-frequency-weighted spectral-energy flux without a full FFT), with an adaptive local-mean threshold, minimum-spacing suppression, and sub-hop refinement to the sharpest transition — rather than a literal FFT spectral flux. The §5.6.1 kernel seam and the onset-accuracy contract (the transient-chop fixture) are met; an FFT spectral-flux upgrade stays swappable behind the seam (§1.3 #5). **(2) `reverb` Phase 6+ engine (§5.7):** the `reverb` insert now uses the `fdnReverb` worklet (feedback delay network) when the kernel modules are loaded (start gate / offline prepare), per the §5.7 "Phase 6+: fdnReverb worklet" note; the native `ConvolverNode` remains the fallback when they are not (e.g. unit tests without the gate). No effect ID changed. **(3) `granularStretch` (§5.7.9):** WSOLA — stage 1 resamples by the pitch ratio, stage 2 time-stretches with correlation-aligned overlap-add — giving independent time/pitch; a phase-vocoder upgrade remains roadmap as stated. **(4) DSP-effect worklet params:** the `multibandComp`/`limiter`/`fdnReverb` worklet applies parameter changes directly in the kernel (the §4.3 dezipper ramp is native-`AudioParam`-only); the limiter reports its 1.5 ms lookahead as PDC latency (§5.7.3). **(5) Phase-scoped functional-UI choices (spec sequences polished UI to Phase 7):** Looper v1 captures the master bus (resample-master source) to a mono sample via the `looper-recorder` worklet → `RingBuffer` → WAV worker → OPFS (§5.5/§8.5.8); mic source and bar-locked length are Phase 7. Bounce v1 renders the resolved voices of the active sequence offline (`OfflineAudioContext` + shared tick maths, §9.5) to `/bounces/`; the full insert/mixer graph in the bounce is Phase 7. Sample Edit and Browser modes ship as functional (unpolished) panels like Phase 5's Program Edit — waveform peaks drawn directly (worker pyramid cache §8.5.4 is Phase 7), drag-to-pad/tag-chips/favourites deferred. `.mpcweb` import always remaps every UUID (§9.6, not only on collision) so imported copies never collide. **(6) OPFS writes** use the atomic `writeFileAtomic` (main-thread `createWritable`, temp-then-rename, §9.7); a worker sync-access-handle streaming path (§9.1) is a Phase 7 throughput refinement (`STUB(phase-7)`). The import/decode/standardise pipeline (§9.4), the WAV codec (16/24/32f, golden bytes §11.1), the `RingBuffer` (§5.5), Chop (equal/marker/transient, §8.5.4), groove extraction + bake (§7.5), the five §5.6.4 WASM kernels with offline golden-output tests (§11.2), and the `.mpcweb` pack/unpack round-trip (§9.6/§11.1) were implemented per spec.
- **2026-07-17 (g)** — _Phase 5 implementation session (Programs & Sound Design); recorded under the §0 completeness rule. All §6/§7 constraints preserved._ **(1) Scheduler protocol extension (additive, §7.1.3):** a new `arp` request kind `{ enabled, mode, octaves, gate, division }` drives the keygroup arpeggiator (§7.3) in `SchedulerCore` beside note repeat, sharing the subdivision clock; `SCHEDULER_PROTOCOL_VERSION` stays 1 (extend-by-adding-kinds precedent, §13.6 — no existing kind changed). **(2) Program-scope automation addresses (§7.8):** the parameter registry now parses/builds `program:<id>.pad:<idx>.<param>` for the sound-design leaves `filter.cutoff`, `filter.resonance`, `pitch`, `amp`, `pan` (with ranges + the §7.8 registration gate); per-voice _application_ of these is deferred to Phase 7 with the Program/Mixer surface (tagged `STUB(phase-7)` in `audioBridge.applyAutomation`), the grammar itself is live. **(3) §6 sound-design implementation choices (spec §6 leaves these unspecified):** the enriched voice applies the per-voice filter as a `BiquadFilterNode` with its envelope + LFO on the biquad `detune` (cents) and the pitch envelope + LFO on the source `detune`; full-scale modulation depths are named constants in `voiceModulation.ts` (pitch ±1200 cents, filter cutoff ±4 octaves, filter-envelope ±4 octaves); the `sampleHold`/`drift` LFO shapes are approximated by native oscillators (square/sine) pending a worklet LFO; keygroup glide is a portamento into each new note; the resolved pad/program `mixer` (level/pan/sends) is applied to the graph channel on first creation (live pad-mixer editing → graph is Phase 7 Mixer work). Layers, AHDSR application (amp/pitch/filter, curve-honouring decay), 2 LFOs, mod matrix (pure evaluator), keygroups (≥4 concurrent, polyphony, glide, coupled repitch), program CRUD + persistence, the functional Program Edit mode, and the arpeggiator were implemented per §6/§7.3 as specified.
- **2026-07-17 (f)** — _Phase 4 implementation session (Sequencer & Recording); recorded under the §0 changelog rule, with the clock-domain item flagged for human ratification._ Two categories of change, both preserving all existing §7 constraints: **(1) Scheduler message-protocol extensions** (additive, following the established DB-worker precedent "extend by adding kinds; never repurpose" — no §7.1.3 name was renamed): `sequenceMeta` (per-sequence length/time-signature/tempo plus active sequence + playback mode, which the worker needs to build the §7.9 song tempo map), `eventsDiff.sequenceId` (the owning sequence, needed to select a segment's tracks in song mode), `liveNote.trackId` (the record-capture destination track), a `liveErase` request + `erased` response pair (MPC live erase, §7.7), and `ScheduledEvent.accented` (metronome beat-1 accent, §5.9). **(2) Clock-sync domain correction (§7.1.2), flagged for human ratification:** a dedicated Web Worker has its own `performance.timeOrigin`, so feeding the §7.1.2 offset model the worker's raw `performance.now()` would bias every estimate by the origin delta and collapse scheduling. Corrected so both sides operate in the absolute-epoch domain — the main thread sends `performanceTime = performance.timeOrigin + getOutputTimestamp().performanceTime`, the worker estimates with `performance.timeOrigin + performance.now()`, and live-note timestamps are converted likewise before capture. The offset-smoothing (8-sample) and 2 ms drift-snap behaviour of §7.1.2 is unchanged — only the time domain fed into it is corrected. The playhead SAB, lookahead windowing, swing, loop wrapping, note repeat, recording, quantise, automation engine + parameter registry, and song-mode maths were all implemented per §7 as specified.
- **2026-07-17 (e)** — _Phase 0 implementation session; recorded under the §2.7 correction rule and flagged for human ratification._ Pinned-API correction, verified empirically against installed Vite 8.1.5: the §2.7 "Worklet loading" canonical form `audioContext.audioWorklet.addModule(new URL('./x.worklet.ts', import.meta.url))` does **not** survive `vite build` — Vite's URL-asset handling has no worklet awareness (its bundler detection covers only `new Worker(new URL(...))`), so the worklet inlined as a raw-TypeScript `data:` URL, violating the binding real-files/no-blob rule (§2.3.8). Corrected to Vite's documented `?worker&url` import suffix (`import workletUrl from './x.worklet.ts?worker&url'` → `addModule(workletUrl)`), which emits a genuine content-hashed es-format worklet chunk honouring `worker.format` in both dev and build (verified: `dist/assets/gainProof.worklet-*.js`, exercised by the §11.4 smoke). §2.3.8 and the §2.7 table row updated; the underlying constraints (real files, es format, never blob/data URLs, module transfer via `processorOptions`) are unchanged.
- **2026-07-17 (d)** — Session-chain & concurrency hardening: Protocol Alpha now mandates that every phase ends by emitting the next phase's self-contained session prompt from the new canonical template (§13.7); added Concurrent-Agent Worktree Discipline (§13.3.4 — all phase work in `.claude/worktrees/phase-<N>` worktrees, Phase 0 bootstrap exception, no `node_modules` junctions at worktree removal, merge-back sequence); Vitest/`.gitignore` worktree exclusions added to §2.3.
- **2026-07-17 (c)** — Hardening for autonomous implementation by an LLM agent (Opus 4.8): added the Pinned API Contract (§2.7) fixing the exact call forms for the dependency majors (motion/react import, sqlite-wasm `oo1.OpfsDb` bootstrap, Tailwind 4 CSS-first config, Zustand 5 curried `create`, WASM-via-`processorOptions`, AssemblyScript `--runtime stub`, etc.) with a binding "never write library calls from memory" rule; added Protocol Epsilon (§13.6) — naming freeze, `// spec §x.y` anchor comments, green-before-next gating, mechanical enforcement scripts (`check:deps`, `check:lang`, `check:stubs` via `npm run verify`, wired into Phase 0 and every phase exit), the reference-implementation consultation rule (retired in (l)), and commit cadence; added the stable section-numbering rule (§0).
- **2026-07-17 (b)** — Post-rewrite review refinements: defined pitch-bend behaviour (keygroup-only, per-voice `detune`, new `pitchBendRange` field on `KeygroupProgram`, §6/§10.2); playhead rendering now compensates for `audioContext.outputLatency` (§7.1.4); waveform peak pyramids specified as worker-computed and cached (§8.5.4); tempo automation recorded as a roadmap item (§10.5). Tone.js reconsidered at the human developer's prompt and its exclusion **reaffirmed**: its Transport schedules on the main thread and cannot satisfy the §7.1 worker mandate, and the spec already forbids its use for state or nodes, leaving it nothing to contribute.
- **2026-07-17** — Full rewrite of the 2026-07 draft: named the project (BangerBox); repaired the unreadable PPQN value (960, was an embedded image); removed Google-Docs export artefacts; resolved contradictions (Tone.js removed in favour of the worker scheduler; WASM toolchain locked to AssemblyScript after verifying no Rust/Emscripten on the dev machine; mixdown corrected to main-thread `OfflineAudioContext` + worker encode); locked the dependency matrix against a known-good stack; added everything required to be actionable — full store/program/automation TypeScript schemas, complete SQLite DDL, effects set with parameters, voice management, metronome/count-in/recording workflow, undo/redo, time signatures, `.mpcweb` format definition, BLE-MIDI packet-level parsing, capability gating, storage safeguards incl. multi-tab guard, testing strategy with per-phase exit criteria, and performance budgets. All technical constraints of the draft are preserved and tightened.
