# BangerBox — Phase Handover (after Phase 0 — Toolchain & Scaffold)

Generated at the close of Phase 0 per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** Phase 0 merged to `main` (merge commit `89e1b0c`). All §12 Phase 0 exit
criteria green inside the phase worktree before landing: `dev`, `build`, `preview`,
`test` (16 unit tests), `test:e2e` (9/9 real-browser smoke, including the offline PWA
shell and the worklet/WASM path), `lint`, `type-check`, `verify`.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

1. Project name **BangerBox**; package `bangerbox`; "WEB-MPC" retired.
2. **npm** only; committed `package-lock.json`; Node ≥ 24 (`engines`).
3. **git** repository at project root (initialised in Phase 0); repo is public — no
   secrets, personal data, or real device identifiers.
4. **No Tone.js.** Bespoke 960 PPQN lookahead scheduler in a Web Worker (§7.1); audio
   graph directly on the Web Audio API; no audio-framework dependency.
5. **AssemblyScript** for WASM DSP (`asc`, `--runtime stub -O3`), behind the §5.6
   kernel seam; `vite-plugin-wasm` not required.
6. **`@sqlite.org/sqlite-wasm`**, worker-hosted, OPFS VFS (as proven in Gubbins). No
   wa-sqlite/sql.js/IndexedDB for primary data.
7. **Hand-rolled typed promise-based `postMessage` RPC** (no Comlink).
8. **`motion`** (import from `'motion/react'`) for animation.
9. **No router library** — 12 modes via `useUIStore.activeMode`.
10. **No component library**; bespoke primitives in `src/ui/primitives/`; icons
    **`lucide-react`** via `src/ui/icons.ts` only (registry not yet created — first
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

## 2. Spec deviation recorded this phase (⚠ human ratification requested)

**§14 changelog entry 2026-07-17 (e):** the §2.7 pinned form
`audioContext.audioWorklet.addModule(new URL('./x.worklet.ts', import.meta.url))` does
**not** survive `vite build` on Vite 8.1.5 — Vite has no worklet awareness for bare
URL assets (only `new Worker(new URL(...))` is detected) and inlined the worklet as a
raw-TypeScript `data:` URL, violating §2.3.8 (real files, never blob/data URLs).
**Corrected, empirically verified form (now in §2.7):**

```ts
import workletUrl from './x.worklet.ts?worker&url'; // Vite emits a real es-format chunk
await audioContext.audioWorklet.addModule(workletUrl);
```

§2.3.8 and the §2.7 table were updated in the spec; underlying constraints unchanged.
Verified by the smoke in dev, production build, and offline.

## 3. Toolchain facts

- Installed majors: Vite 8.1.5, React 19, TypeScript 6, Tailwind 4, Zustand 5, Zod 4,
  motion 12, AssemblyScript 0.28, Vitest 4, Playwright 1.x, ESLint **9** (pinned:
  ESLint 10 conflicts with `eslint-plugin-jsx-a11y`'s peer range — keep `eslint@^9` +
  `@eslint/js@^9` until jsx-a11y supports 10).
- `package.json` scripts: `dev`, `build` (= `build:wasm` → `tsc -b` → `vite build`),
  `build:wasm`, `preview`, `test` (vitest run), `test:watch`, `test:e2e` (browser
  smoke), `lint`, `lint:fix`, `type-check`, `format`, `format:check`, `check:deps`,
  `check:lang`, `check:stubs`, `verify` (the three checks), `icons`.
- `package.json` `config.phase` holds the current phase number ("0") — **bump it each
  phase**; `check:stubs` fails from phase ≥ 7 with open stubs.
- Vitest: `pool: 'threads'` (Node 25 forks-pool cold-start race — lesson from
  Gubbins); excludes `**/.claude/worktrees/**` (§2.3.9).
- tsconfig: `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`;
  `src/core/dsp/assembly/**` is **excluded** from tsc and ESLint (AssemblyScript
  built-ins are not app TypeScript).
- Prettier owns formatting (110 col, single quotes); ESLint `curly: multi-line`
  re-asserted after `eslint-config-prettier`.
- Windows note: `git worktree remove` can leave an empty locked directory husk if any
  shell still has its cwd inside — harmless (gitignored), clears on session end. Never
  create `node_modules` junctions (§13.3.4).

## 4. Established patterns (reuse, do not reinvent)

- **Capability gate** (`src/core/platform/capabilities.ts`): pure
  `evaluateCapabilities(hard, soft)` → deeply frozen `CapabilityReport`; probes run
  exactly once via `detectCapabilities()` before anything else in `src/main.tsx`;
  hard-missing renders `<CapabilityGate missing={…}/>` only.
- **Kernel seam** (`src/core/dsp/gainProofKernel.ts` is the exemplar): wasm exports
  `create(sampleRate, maxBlock) → handle`, param setters, `allocateBuffer`/`freeBuffer`,
  `process(handle, inPtr, outPtr, frames)`, `free(handle)`; TS wrapper owns
  `Float32Array` views (created once, after all allocations), hides pointers, exposes
  `destroy()`; per-instance linear memory; `--use abort=` keeps kernel modules
  import-free.
- **Worklet WASM transfer** (spec §5.6.2, proven end-to-end): main thread
  `loadKernelModule(url)` (fetch + `WebAssembly.compile`, promise-cached) →
  `WebAssembly.Module` via `processorOptions` → synchronous
  `new WebAssembly.Instance(module)` in the processor constructor → worklet frees on a
  `{ kind: 'dispose' }` port message, `process()` returns `false` after disposal.
- **Worklet loading**: the `?worker&url` import (see §2 above). Worklet ambient types
  live in `src/core/audio/worklets/worklet-globals.d.ts`.
- **Worklet message shapes so far**: `GainProofResultMessage { kind: 'proofResult';
  input: number[]; output: number[] }`, `KernelDisposeMessage { kind: 'dispose' }`
  (defined beside the kernel wrapper).
- **PWA update flow**: `usePwaUpdate` hook with injectable `PwaUpdateApi` seam (fake
  in tests; real seam lazily imports `virtual:pwa-register`); `PwaUpdatePrompt` toast
  (motion/react + `useReducedMotion`); `registerType: 'prompt'`, `injectRegister:
  null`.
- **Service worker** (`src/sw.ts`): dedupe `__WB_MANIFEST` URLs before `addAll`;
  first-install-only `skipWaiting`; SKIP_WAITING handshake; stale-precache pruning;
  cache matches use `{ ignoreSearch: true, ignoreVary: true }` (install-time fetches
  carry no Origin header — Vary would break offline script loads); the index.html
  fallback applies to **navigations only**; same-origin GET only; never OPFS/blob.
- **Design tokens** (`src/styles/index.css`): Tailwind 4 `@theme` with `bb-` prefixed
  colour/radius/ease/shadow tokens (`--color-bb-bg` #141317 is also the manifest
  theme colour); global token-based `:focus-visible` ring; global
  `prefers-reduced-motion` collapse. Components use token utilities only.
- **Enforcement**: `check:lang` allowlist lives in
  `scripts/check-lang.allowlist.json` (regex + reason per entry) — extend it rather
  than weakening the scan; `check:deps` encodes the closed §2.2 matrix in
  `scripts/check-deps.mjs`.
- **Smoke harness** (`scripts/browser-smoke.mjs`): spawns vite via
  `node node_modules/vite/bin/vite.js` (clean kill on Windows); ports 5199 (dev) /
  5198 (preview); system Edge first; fails on any console/page error; screenshots to
  `scripts/smoke-artefacts/` (gitignored).
- Icons: `npm run icons` regenerates `public/icons/` from the single glyph in
  `scripts/generate-icons.mjs`.

## 5. Component tree topography (as implemented)

```
main.tsx
├─ detectCapabilities()                        (before any render — §2.1)
├─ [hard missing] CapabilityGate               (styled blocking screen)
└─ [supported]    ErrorBoundary(AppErrorFallback)
                  └─ App { capabilities, pwaApiOverride? }
                     ├─ header (wordmark + __APP_VERSION__ badge)
                     ├─ soft-capability chip list (title tooltips)
                     ├─ EngineSelfTest         (STUB(phase-3) proof panel)
                     └─ PwaUpdatePrompt        (usePwaUpdate seam)
```

## 6. Kernel inventory

| Kernel | Source | Status |
| --- | --- | --- |
| `gainProof` | `src/core/dsp/assembly/gainProof.ts` → `src/core/dsp/dist/gainProof.wasm` (gitignored, rebuilt by `npm run build:wasm`) | Phase 0 pipeline proof; keep as the seam exemplar until real kernels (§5.6.4) arrive in Phases 4–6 |

## 7. Storage / stores / repositories

Not yet implemented (Phase 1 = OPFS wrapper, DB worker + typed RPC, migrations + §9.3
DDL, repositories, multi-tab guard, quota checks, Safe Mode skeleton; Phase 2 = the
eight §4.2 stores + undo + autosave). No DDL snapshot exists yet — §9.3 is the source.
Consult Gubbins (`P:\Source\TypeScript\Gubbins`) for the proven DB-worker/RPC/OPFS
patterns before writing them (§13.6).

## 8. Open stubs / deliberate technical debt

- `// STUB(phase-2)` `src/core/platform/capabilities.ts` — freeze the report into
  `useUIStore.capabilities` once the store exists.
- `// STUB(phase-1)` `src/ui/AppErrorFallback.tsx` — grow into the full §8.1 Safe Mode
  (export `.mpcweb`, raw SQLite download, hard reset).
- `// STUB(phase-3)` `src/ui/EngineSelfTest.tsx` — superseded by the real start gate +
  audio bootstrap (§5.1); its worklet/WASM proof moves into the engine boot path.
- `src/core/constants.ts` is a spec-mandated registry whose consumers arrive in later
  phases; currently imported only by its drift-guard test (accepted §3.4 exception for
  a §12 Phase 0 deliverable).
- Vite build emits a deprecation warning from vite-plugin-pwa's SW build
  (`inlineDynamicImports` → `codeSplitting`); harmless, owned by the plugin.

## 9. Verification commands (all green at handover)

`npm run dev` · `npm run build` · `npm run preview` · `npm test` · `npm run test:e2e`
· `npm run lint` · `npm run type-check` · `npm run verify`
