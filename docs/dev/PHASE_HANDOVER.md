# BangerBox — Phase Handover (after the §8.5.7 sample-assignment seam)

Generated at the close of the issue #37 work per Protocol Alpha (spec §13.1). A new session
MUST read `docs/todo/_spec.md` in full **and** this document before writing any code, and MUST
reuse the patterns recorded here rather than inventing parallel ones.

**State:** the sample-assignment seam merged to `main` (`--no-ff`). All eight §12 phases were
already complete; this was a defect closure against §8.5.7/§8.5.5/§8.5.4, not a new phase, so
`package.json` `config.phase` remains **"8"**. Suite: **1318 unit tests**, `test:e2e` real-browser
smoke (dev + offline, **40/40 steps**), plus `lint`, `type-check`, `format:check` and `verify`
(**no open stubs**).

**The Phase 8 live-hardware sign-off is still outstanding** (issue #13) and still requires the
human developer. Nothing in this work touched it.

**Bundle size and load time remain deliberately unconstrained** (§11.5, §14 2026-07-18 (j)).

**This document was stale for a long stretch** — it claimed 829 tests while §14 (ab) recorded
1014 — because it was regenerated only at phase exits and the work since Phase 8 has all been
issue-shaped. Regenerate it whenever a §14 entry lands, not only at a phase boundary.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

All nineteen stand unchanged. Two that bear on recent work:

- **#2 (Node ≥ 24)** is load-bearing beyond tooling: `build:factory` imports the app's own
  TypeScript through Node's native type stripping, so it MUST run as
  `node --import ./scripts/factory/register.mjs …`.
- **#10 (no component library)** governs the two dialogs added for assignment: both are the
  bespoke `Modal` primitive, and the pad choosers inside them are plain buttons, never `Pad`.

## 2. Spec deviations / corrections in effect

Phase 0–8 entries stand. The §14 entries since the last handover, newest first:

- **(ag) — sample assignment (issue #37).** Three ⚑ items a new session should treat as settled
  policy rather than as spec text, since §6 and §8.5.7 do not fix them:
  - **Velocity bands are maintained, not validated.** Adding a layer re-splits 0..127 across the
    pad's layers; removing one grows the neighbour over the freed band. Overlap and silent
    velocity are therefore impossible by construction. `maxLayers` defaults to
    `DEFAULT_MAX_VELOCITY_LAYERS = 4`, with `MAX_VELOCITY_LAYERS = 8` as the Zod hard cap.
  - **Zones follow a different rule.** §6 lets zones overlap and `selectKeygroupZone` takes the
    first covering zone, so a new zone takes the widest uncovered key range and halves the widest
    existing zone only when none is free. Nothing else moves, so a hand mapping survives.
  - **`dragDropPayload` is an armed selection, not a live drag.** A pointer drag cannot cross two
    §8.5 modes; the payload is armed in Browser and spent in Program Edit.
- **(af)** `check:stubs` gained a phase-prose gate (issue #12).
- **(ae)** §11.2 no longer claims a `src/test/fixtures/` directory (issue #10).
- **(ad)** the three real-browser smokes run in CI (issue #15).
- **(ac)** the Looper gained its §8.5.8 controls (issue #3).
- **(ab)** the Prettier backlog was cleared and `format:check` joined CI (issue #11).
- **(aa)** `Button` and `FieldLabel` became primitives (issue #49).
- **(z)** `Toast` became a real §2.5 primitive (issue #9).
- **(y)** the worker-computed peak pyramid and the Browser waveform micro-preview (issue #8).
- **(x), (w), (v), (u), (t)** the declick and pitch-summing work (issues #85, #87).
- **(u)** factory samples de-duplicate into `/global_library/` (issue #81).
- **(q), (p)** §9.8 factory content. **Three ⚑ decisions there remain unratified** (issue #78).

## 3. Toolchain facts

- Installed majors unchanged. **No new dependencies** since Phase 0's closed §2.2 matrix.
- `npm run build:factory` writes the gitignored `public/factory/`; it runs ahead of `build`,
  after `build:wasm`. The browser smoke self-heals both artefacts.
- **Lint trap (has cost two sessions):** `react-hooks/set-state-in-effect` fires when an effect
  reaches _any_ function that calls `setState`, not only a synchronous call in the effect body,
  and extracting the work into a `useCallback` does NOT satisfy it. The established shape is an
  **inline async IIFE with a `cancelled` flag** — see `BrowserPanel`, `FactorySection` and
  `SamplePicker`. Where state only needs resetting when a dialog closes, prefer an **override
  held alongside a derived default** (see `AssignTargetDialog`) to an effect that syncs the two.
- **Run `lint` AFTER `format:check --write`, not before.** Prettier joins short `if` bodies onto
  one line, which trips `curly`; a lint run from before the formatting pass proves nothing.
- `format:check` is currently green across the repo. Nothing else runs Prettier — no pre-commit
  hook, and a local `git merge` never checks formatting — so re-run it after every merge.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–8 and the §9.8 factory chain still stands. New this work:

**The assignment seam (spec §8.5.7, §8.5.5, §8.5.4):**

- **`useProgramStore` owns every §6 rule.** `addPadLayer`, `setLayerSample`, `removePadLayer`,
  `addKeygroupZone`, `setZoneSample` and `removeKeygroupZone` each record exactly one undo entry
  and return `AssignResult` — `{ ok: true }` or `{ ok: false, reason }`, where `reason` is a
  **finished sentence** the UI shows verbatim. Returning `void` would leave every caller
  reporting "nothing happened", which is how a control reads as broken. Add new assignment rules
  here, never at a call site.
- **`src/core/project/sampleAssign.ts`** is the thin service over those actions: it writes the
  success and refusal copy once, announces through the single §8.2 `LiveRegion`, and owns the two
  composite chop operations (`assignSlicesToPads`, `createProgramFromSlices`) that need
  `commitAsOne` so a chop is one Ctrl+Z. It imports `announce` from
  `@/ui/primitives/LiveRegion`, **not** the barrel — the barrel would pull React and motion into
  every consumer of `@/core/project`, as `engine.ts` already avoids for `meterScope`.
- **Two dialogs, because the two directions differ.** `SamplePicker` (target known, sample
  missing) is opened by Program Edit's layer and zone lists and queries BOTH §9.1 roots directly
  rather than following `useBrowserStore.currentPath`. `AssignTargetDialog` (sample known, target
  missing) is opened by a Browser row. Its **"Choose on the pad grid…"** is the ONLY route by
  which `dragDropPayload` becomes armed in normal use — do not delete it thinking the drag
  covers it, because a pointer drag cannot cross two §8.5 modes.
- **Drop targets** on the Program Edit pad grid and the keygroup zone panel serve a drag that
  begins and ends inside one mode. `onDragOver` must `preventDefault()` or the drop never fires.
- **Banners are not live regions.** §8.2 allows one, the shell's. The armed banners carry their
  news to assistive tech through the pad `aria-label`s instead, which read "Assign to pad N"
  while a sample is armed.
- **`sampleCandidatePaths(projectId, sampleId)`** (in `opfs.ts`) returns both §9.1 roots, project
  first. A §6 payload records only an id and §9.3 permits either root, so live playback
  (`AudioEngine.loadProgramSample`) and the §9.5 bounce both try both. Any new code that turns a
  `sampleId` into a path MUST use this rather than rebuilding the project path.

## 5. Repository catalogue — unchanged. No repository or DDL change.

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1**. **No migration added.**

## 7. Worker / worklet / message protocol versions — all unchanged.

`SCHEDULER_PROTOCOL_VERSION` is still 1 and still inert (issue #96).

## 8. Stores — all eight implemented (§4.2)

Changes this work, both additive and both recorded in §14 (ag):

- **`useProgramStore`** gains the six assignment actions above and the exported `AssignResult`.
- **`useUIStore.dragDropPayload`** gains `rootNote`, so a sample armed for a keygroup zone lands
  at its own §9.3 unity pitch rather than at an assumed middle C.

## 9. Component tree topography (as implemented)

Unchanged except:

- **Browser →** each sample row's `Assign…` button (draggable, and a tap opens
  `AssignTargetDialog`) · `AssignTargetDialog` mounted at panel level.
- **Program Edit → `PadEditor`:** armed-sample banner above the pad grid; every pad is a drop
  target and assigns on press while a sample is armed.
- **Program Edit → `LayersEditor`:** "Add sample…" in the section header, "Change sample" and
  "Remove layer N" per row, `SamplePicker` mounted at section level.
- **Program Edit → `KeygroupEditor`:** the same three, plus "Remove zone N"; the zones section is
  itself the drop target.
- **Sample Edit → Chop:** a "Slices to" `SegmentControl` (pads / new program / library only).

## 10. Kernel inventory — unchanged (the §5.6.4 set is complete).

## 11. Outstanding / deliberate technical debt

**`check:stubs` reports ZERO open stubs.** Outstanding work lives in GitHub issues, not in code
comments; the list below names the issues rather than restating them.

**STILL OUTSTANDING FROM PHASE 8 — READ THIS FIRST:**

- **The live hardware sign-off (§12, issue #13) is NOT done and cannot be self-certified.** It
  needs the human developer, a physical ESP32 BLE-MIDI controller and a Windows pairing.

**Nearest neighbours to this work, in rough order of how much they block a musician:**

- **#7.8 automation authoring is the next seam.** `setAutomationLane` in `useSequenceStore` has
  no caller outside `persist.test.ts`, so no user can create an automation point by any route —
  the same shape of gap as #37 was.
- **#84** Reverse and Warp are persisted but never applied at playback, and **#107** the same for
  `LfoConfig.sync`/`phaseOffset`/`retrigger`. Both are now reachable to set and still inert.
- **#71** the non-destructive groove path is dead end to end.
- **#104** song and stem bounces write a WAV no user can reach.
- **#101** song mode never ends; **#93** tempo and swing edits are never persisted.
- **#34** several live regions compete with the single §8.2 announcer. This work deliberately
  added none, but it did not fix the existing ones.
- **#54** destructive edits have no confirmation and long operations show no progress. Layer and
  zone removal inherit that: undo is the only safety net.

**Honest scope notes for the assignment work:**

- **The three ⚑ policies in §14 (ag) are judgement calls**, not spec text. A human may prefer
  different band or zone placement; the rules are in one place (`useProgramStore`) if so.
- **A pointer drag is only useful within one mode.** §8.5.7 asks for drag-to-pad and the handlers
  exist, but the route users will take is the armed selection. Read `SamplePicker`'s header
  before "fixing" this.
- **Assignment does not audition on assign.** A user picks a sample, hears it in the picker if
  they press Audition, and hears the pad by striking it. There is no confirm-by-ear step.
- **Nothing enforces contiguity outside the assignment actions.** The velocity spinners and the
  §8.5.5 range bar can still open a gap deliberately, which §6 permits.
- **#105 did not block this work.** The browser smoke ran from the worktree with
  `BANGERBOX_SMOKE_PORT` / `BANGERBOX_SMOKE_PREVIEW_PORT` overridden (5310/5311); the issue's
  premise may be narrower than its title, or already fixed.

## 12. Verification commands (all green at handover, inside the worktree and after the merge)

`npm run type-check` · `lint` · `test` (**1318**) · `format:check` · `verify` (**no open stubs**)
· `test:e2e` (dev + offline, **40/40 steps**, ports overridden per #105) · `build` ·
`build:factory`.
