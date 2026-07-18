# BangerBox

An offline-first, browser-based Digital Audio Workstation, sequencer, and sampler — modelled on the
workflow of the Akai MPC Live series, but without the artificial limits of fixed hardware.

BangerBox runs entirely client-side as an installable Progressive Web App. Audio lives in the Origin
Private File System, project data lives in WASM SQLite, and heavy DSP runs in AudioWorklets backed by
WebAssembly. There is no server, no account, and no cloud dependency of any kind — with the network
disabled, the application still works completely.

> **Status:** Phase 8 of 8 complete. The engine, sequencer, sampler, full UI, and BLE-MIDI hardware
> layer are implemented and tested (733 unit tests plus a real-browser smoke suite). Live-hardware
> sign-off against a physical controller is the one outstanding item.

## Features

- **Sampler** — 128 drum pads per program (8 banks × 16), up to 4 velocity layers per pad, keygroup
  programs with zone editing, choke groups, and voice stealing across a 64-voice pool.
- **Sequencer** — a bespoke 960 PPQN lookahead scheduler in a dedicated Web Worker. Swing, loop,
  note repeat, count-in, overdub/replace recording, live erase, and quantise.
- **Sample editing** — trim, normalise, reverse, fades, time-stretch render, and chop by manual
  markers, equal slices, or WASM transient detection.
- **Mixing** — per-pad, per-track, return, and master channel strips with a serial insert chain,
  4 sends, and plugin delay compensation.
- **Effects** — native Web Audio nodes (EQ, filter, delay, compressor, saturator) alongside
  AssemblyScript WASM kernels (multiband compressor, FDN reverb, limiter, granular stretch).
- **Hardware control** — BLE-MIDI input with running-status framing, timestamp unwrapping, CC
  throttling, auto-reconnect, and a Q-Link encoder runtime with learn-based parameter binding.
- **12 modes** — Main, Grid/Piano Roll, Track & Pad Mute, Sample Edit, Program Edit, Mixer, Browser,
  Looper, Pad Perform, XYFX, Q-Link Edit, and Song.
- **Project interchange** — `.mpcweb` export/import (zipped via `fflate` in a worker), plus offline
  bounce and mixdown through `OfflineAudioContext`.

## Requirements

- **Node.js 24 or newer** (the project uses npm; a `package-lock.json` is committed).
- **A Chromium browser, version 120 or newer**, on desktop-class Windows. Firefox and Safari are
  explicitly unsupported — Web Bluetooth and stable OPFS + SharedArrayBuffer behaviour require
  Chromium. A capability gate enforces this at startup.
- The primary target device is a Windows tablet (for example a Microsoft Surface) driven by touch,
  optionally alongside a custom ESP32-based BLE-MIDI controller.

Cross-origin isolation (`crossOriginIsolated === true`) is required for SharedArrayBuffer, so the
app must be served with COOP/COEP headers. The Vite dev and preview servers set these for you.

## Getting started

```bash
npm install
npm run build:wasm   # compile the AssemblyScript DSP kernels
npm run dev
```

`npm run build:wasm` is not optional on a fresh checkout. The compiled kernels are build
artefacts and are not committed, and the DSP golden-output tests load them from disk — so
`npm test` reports failures until they exist. `npm run build` runs it for you; a bare
`npm test` does not.

On Windows you can instead run `Run.ps1` (or `Run.bat`), which checks the toolchain, starts the dev
server, and opens the browser against a concrete loopback address.

## Scripts

| Script               | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `npm run dev`        | Vite dev server with COOP/COEP headers                              |
| `npm run build`      | Build the WASM kernels, type-check, and produce the bundle          |
| `npm run preview`    | Serve the production build locally                                  |
| `npm run build:wasm` | Compile the AssemblyScript DSP kernels via `asc`                    |
| `npm test`           | Vitest unit suite (`happy-dom`)                                     |
| `npm run test:e2e`   | Playwright smoke test on the system-installed Edge                  |
| `npm run test:pages` | Pages smoke: isolation via the service worker on a header-less host |
| `npm run lint`       | ESLint                                                              |
| `npm run type-check` | TypeScript project references, no emit                              |
| `npm run verify`     | Dependency, language, and stub enforcement checks                   |

The `verify` script enforces project invariants mechanically: the dependency surface is closed to a
fixed allowlist, all identifiers and prose use British English, and no unresolved stubs remain.

## Running it hosted

A build is published to GitHub Pages at **https://bootblock.github.io/BangerBox/** — open it in
Chromium and install it from the address bar if you want it as a standalone app. Deployment is
manual: the _Deploy to GitHub Pages_ workflow runs only via **Actions → Run workflow**, so
publishing is a deliberate act rather than a consequence of merging.

Getting a PWA that needs `SharedArrayBuffer` onto a static host takes a small amount of
machinery, because GitHub Pages cannot send the COOP/COEP headers cross-origin isolation
requires. The service worker adds those headers to everything it serves, and
[public/coi-bootstrap.js](public/coi-bootstrap.js) registers that worker and reloads once so the
first visit becomes isolated too. `npm run test:pages` exercises exactly this against a
deliberately header-less server. Local development is unaffected — the Vite dev and preview
servers send the headers directly, and the base path only changes for the Pages build.

## Architecture

Data flows in one direction — UI → Zustand → sync layer → audio graph — and nothing skips a step.
Zustand is the runtime source of truth; SQLite is the durable one. Stores hydrate from SQLite on
project load and persist through a debounced write-behind autosave.

```
src/
  core/       audio graph, DSP kernels, sequencer, MIDI, storage, project I/O
  features/   mode-specific feature surfaces
  ui/         bespoke primitives (pads, knobs, faders, meters) and the app shell
  styles/     design tokens (Tailwind 4, CSS-first configuration)
```

Notable deliberate constraints: no audio framework (the graph is built directly on the Web Audio
API), no router, no component library, and no i18n framework. Every colour, easing, and radius comes
from a design token rather than a literal.

## Documentation

- [`docs/todo/_spec.md`](docs/todo/_spec.md) — the complete specification and implementation guide.
  It is the single source of truth for architecture, schemas, phases, and hardware integration.
- [`docs/dev/PHASE_HANDOVER.md`](docs/dev/PHASE_HANDOVER.md) — the current implementation-state
  handover: locked decisions in effect, deviations, module topography, and outstanding work.

BangerBox was built phase by phase by an autonomous AI agent working against that specification,
with a human developer ratifying each phase boundary. The spec documents the protocols governing
that process alongside the technical design, so both documents read as internal engineering records
rather than end-user manuals.

## Licence

Released under the [MIT Licence](LICENSE).
