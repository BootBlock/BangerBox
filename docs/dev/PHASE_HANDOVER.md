# BangerBox — Phase Handover (after §9.8 Factory Content & Demo Projects)

Generated at the close of the §9.8 work per Protocol Alpha (spec §13.1). A new session MUST
read `docs/todo/_spec.md` in full **and** this document before writing any code, and MUST
reuse the patterns recorded here rather than inventing parallel ones.

**State:** §9.8 merged to `main` (`--no-ff`). All eight §12 phases were already complete; this
was a standalone spec section, not a new phase, so `package.json` `config.phase` remains
**"8"**. Suite: **823 unit tests** (the Phase 0–8 suites plus the §9.8 additions), `test:e2e`
real-browser smoke — dev AND offline — plus `lint`, `type-check`, `verify` (**no open stubs**),
and `build`.

**The Phase 8 live-hardware sign-off is still outstanding** and still requires the human
developer — see §11 below. Nothing in this work touched it.

**Bundle size and load time remain deliberately unconstrained** (§11.5, §14 2026-07-18 (j)).
The factory packs add ~3.2 MB of _runtime-fetched_ content that is deliberately NOT precached;
do not "optimise" this by widening the precache glob (§9.8 forbids it).

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

Unchanged from the Phase 8 handover, all nineteen. Two notes specific to this work:

- **#2 (Node ≥ 24)** now load-bearing beyond tooling: the factory generator imports the app's
  own TypeScript modules and relies on **Node's native type stripping**, plus the build-time
  resolution hook described in §4 (§14 2026-07-18 (s)). `build:factory` therefore MUST run as
  `node --import ./scripts/factory/register.mjs …`; invoking `scripts/build-factory.mjs`
  bare fails to resolve `@/`.
- **#12 (fflate)** now also packs the factory archives, through the app's own `packMpcweb`.
  No new dependency was added; the §2.2 closed matrix is intact.

## 2. Spec deviations / corrections in effect

All Phase 0–8 entries stand unchanged. New:

- **§14 2026-07-18 (q) — §9.8 (read the changelog for full detail).** Nine recorded decisions.
  **Three are flagged ⚑ for human ratification and a new session should treat them as open:**
  - **Kit-merge transactionality is by compensation, not by construction.** §9.6's guarantee
    is structural (nothing visible until the new project opens) and cannot apply to a merge
    into a live project. A crash between write and unwind can still leave residue.
  - **The §9.7 gate measures the unpacked payload, not the catalogue's `bytes` field.**
  - **The house demo's "Q-Link-mapped filter sweep" ships as an automated `filter` insert,
    not a stored binding** — Q-Link bindings live in `app_settings`, outside the §9.6
    snapshot, so a `.mpcweb` pack structurally cannot carry one.
  - Also: deterministic ids in the build script (departing from §1.3.1 for build artefacts
    only), the catalogue as a bare JSON array, and `OWNED_CACHES` in `sw.ts`.

## 3. Toolchain facts

- Installed majors unchanged. **No new dependencies.**
- `package.json` `config.phase` = **"8"** (unchanged — §9.8 is a spec section, not a phase).
- **`npm run build:factory`** (new) builds `public/factory/`; it runs ahead of `build`, after
  `build:wasm`. `public/factory/` is **gitignored**, like `src/core/dsp/dist/`.
- The browser smoke self-heals both artefacts: it runs `build:wasm` and `build:factory` if
  absent, so a fresh checkout can run `test:e2e` directly.
- **Lint trap (cost a cycle):** `react-hooks/set-state-in-effect` fires when an effect calls
  _any_ function that reaches `setState`, not merely a synchronous `setState` in the effect
  body — extracting the work into a `useCallback` does NOT satisfy it. The established
  pattern is an **inline async IIFE with a `cancelled` flag** (see `BrowserPanel` and
  `FactorySection`); reuse it rather than rediscovering this.
- Prettier: the new files are formatted. The repo's pre-existing `format:check` debt
  (~25 tracked files) is untouched and still needs its own formatting-only commit.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–8 still stands. New this work:

**The factory chain (spec §9.8) — one direction, reusing the §9.6 pipeline:**
`fetchFactoryCatalogue` → `fetchPack` → `unpackMpcwebInWorker` → `remapSnapshot` →
storage gate → (`installUnpackedAsNewProject` | `installKitPack`) → stores.

- **`scripts/factory/`** — the build is modular, not one file: `prng.mjs` (mulberry32 +
  `hashSeed` + `derivedId`), `synth.mjs` (synthesis primitives), `kits.mjs` (the three kits),
  `packs.mjs` (kit + demo assembly), `snapshot.mjs` (§6/§9.3 shapes + the zip). `build-factory.mjs`
  is the entry and exports `buildFactory(appVersion)` for in-memory use by tests.
- **Determinism discipline (§9.8):** every PRNG is seeded from the _sample's own name_, so
  adding or reordering a sample cannot change any other sample's bytes. Ids are derived, not
  random. Timestamps are pinned to `FACTORY_EPOCH_MS`. Zip entry `mtime` is fixed and entry
  order is sorted. **If you add content, do not reach for `Math.random()` or `Date.now()` —
  `factoryPacks.test.ts` builds twice and compares bytes, and will fail.**
- **The generator uses the app's own modules — do not reintroduce copies** (§14 2026-07-18 (s)).
  `scripts/factory/resolve-hook.mjs` + `register.mjs` supply the `@/` alias and extensionless
  `.ts` resolution that Node lacks, so `snapshot.mjs` calls the real `createDefaultPad`,
  `createDefaultChannelStrip`, `createDefaultDrumProgram`, `packMpcweb`, `samplePath` and
  `encodeWav`. Build-time only; Vitest goes through Vite and needs no hook.
- **THE TRAP, if you import more app factories:** several mint ids with `crypto.randomUUID()`
  (`createDefaultPad` and `createDefaultChannelStrip` do, for insert slots). Calling them is
  right — it is how future §6 fields arrive automatically — but every id they generate MUST be
  re-stamped via `restampInsertIds` or the equivalent, or rebuilds stop being byte-identical.
  This is exactly the defect that made the salvaged branch's own determinism test unpassable.
- `factoryPacks.test.ts` remains the guard: it unpacks every built archive with the **real**
  `unpackMpcweb`, validates payloads with the **real** `programSchema`, and builds twice
  comparing bytes.
- **`factoryCatalogue.ts`** (pure) — the catalogue Zod schema. `file` is constrained to a bare
  `*.mpcweb` filename: the catalogue is network input concatenated into a fetch URL, so the
  path-traversal guard lives at the schema.
- **`factoryMerge.ts`** (pure) — `buildKitMerge` (re-parent programs/samples, discard
  arrangement) and `uncompressedSampleBytes`. Pure so the discard rules are testable without
  a database.
- **`factoryService.ts`** — the only module here that touches OPFS, repositories or stores.
  `installKitPack` records every written path and inserted row and unwinds them in reverse on
  failure, best-effort per item so one failed cleanup cannot abort the rest.
- **`installUnpackedAsNewProject`** (extracted from `importMpcweb`) — the single new-project
  install path, shared by user import and factory `demo`. Do not add a third.
- **`sw.ts`:** `FACTORY_CACHE = 'bangerbox-factory-v1'`, cache-first, and **`OWNED_CACHES`** —
  `activate` previously deleted every cache but the precache, which would have evicted factory
  content on every update. Only successful responses are cached, so a transient failure stays
  retryable.
- **`FactorySection.tsx`** — the §8.5 item 7 surface, mounted inside `BrowserPanel`.

## 5. Repository catalogue — unchanged. No repository or DDL change.

`installKitPack` uses the existing `programs.create` / `samples.create` / `.remove`.

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1**. **No migration added.**

## 7. Worker / worklet / message protocol versions — all unchanged.

The pack worker's `pack`/`unpack` request shapes are untouched; factory packs are ordinary
`.mpcweb` archives and go through the same two messages.

## 8. Stores — all eight implemented (§4.2). No field or action added.

`installKitPack` calls the existing `useProgramStore.addProgram`.

## 9. Component tree topography (as implemented)

Unchanged from Phase 8 except **Browser → `FactorySection`**: catalogue list with per-pack
title, description, kind badge, size, cache state and an install button labelled by mode
(Merge for a kit, Open for a demo) · a retryable error row when the catalogue fetch fails ·
a distinct empty state, so "no packs in this build" and "the fetch failed" never look alike.

## 10. Kernel inventory — unchanged (the §5.6.4 set is complete).

## 11. Outstanding / deliberate technical debt

**`check:stubs` reports ZERO open stubs.**

**STILL OUTSTANDING FROM PHASE 8 — READ THIS FIRST:**

- **The live hardware session sign-off (§12) is NOT done and cannot be self-certified.** It
  needs the human developer, a physical ESP32 BLE-MIDI controller and a Windows pairing.
  Unchanged by this work; see the Phase 8 handover for what to watch for.

**Honest scope notes for §9.8:**

- **The three ⚑ decisions in §14 (p) are unratified.** They are judgement calls where §9.8 is
  silent or where §9.6's guarantee does not transfer; a human should confirm them.
- **Factory content is v1 breadth, not depth.** Three kits (40 samples) and three demos, all
  drum programs — no keygroup/melodic factory content, which §9.8 does not ask for.
- **Samples are duplicated per demo project**, as §9.8 permits for v1. `/global_library/`
  de-duplication (§9.1) is deferred and would meaningfully cut the 3.2 MB payload.
- **A kit merge is not undoable.** §4.5 lists what is undoable and pack installation is not
  among them; it is also not obviously a "mutation" in the §4.5 sense. Worth a human decision
  — a user who merges the wrong kit into a project currently has only "Purge unused samples".
- **The synthesised kits are functional, not designed.** They are correct, click-free and
  licence-safe, but nobody has listened to them critically. Human listening QA (§13.5's final
  polish gate) has not happened, and the tuning constants in `scripts/factory/kits.mjs` are
  the obvious place to iterate.
- Phase 7/8's remaining notes all still stand (recording Q-Link/XYFX gestures as automation;
  groove-template persistence; Looper mic source/overdub; Sample Edit drag handles and peak
  pyramid cache; Browser folder tree; Grid automation-lane drawing and marquee select; the
  `transientDetect` FFT upgrade; the full insert/mixer graph in the bounce).

## 12. Verification commands (all green at handover, inside the worktree)

`npm run build` · `test` (**829**) · `test:e2e` (dev + offline, **21/21 steps**) ·
`test:e2e:quick` · `lint` · `type-check` · `verify` (**no open stubs**) · `build:factory`.
(The main checkout has no `node_modules`; `npm install` before re-running.)
