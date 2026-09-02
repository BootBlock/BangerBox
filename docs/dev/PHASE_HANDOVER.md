# BangerBox — Phase Handover (after the §7.8 automation-authoring seam)

Generated at the close of the automation-authoring work per Protocol Alpha (spec §13.1). A new
session MUST read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** the automation-authoring seam merged to `main` (`--no-ff`). All eight §12 phases were
already complete; this was a defect closure against §7.8/§8.5.2/§8.5.10/§3.4, not a new phase, so
`package.json` `config.phase` remains **"8"**. Suite: **1370 unit tests**, `test:e2e` real-browser
smoke (dev + offline, **40/40 steps**), plus `lint`, `type-check`, `format:check` and `verify`
(**no open stubs**).

**The Phase 8 live-hardware sign-off is still outstanding** (issue #13) and still requires the
human developer. Nothing in this work touched it.

**Bundle size and load time remain deliberately unconstrained** (§11.5, §14 2026-07-18 (j)).

Regenerate this document whenever a §14 entry lands, not only at a phase boundary.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

All nineteen stand unchanged. Two that bear on recent work:

- **#2 (Node ≥ 24)** is load-bearing beyond tooling: `build:factory` imports the app's own
  TypeScript through Node's native type stripping, so it MUST run as
  `node --import ./scripts/factory/register.mjs …`.
- **#10 (no component library)** governs the automation controls added here: the scope and curve
  pickers are the bespoke `SegmentControl`, and the point list's value fields are plain inputs.

## 2. Spec deviations / corrections in effect

Phase 0–8 entries stand. The §14 entries since the last handover, newest first:

- **(ah) — automation authoring (§7.8, §8.5.2, §8.5.10).** Seven ⚑ items a new session should treat
  as settled policy rather than as spec text:
  - **The Grid's automation lane scales to the REGISTRY range**, not to the points it holds.
    A lane whose address the registry does not recognise falls back to the data's own span and is
    **read-only** — hydration bypasses the §7.8 gate deliberately, so such a project still loads.
  - **Scope is an explicit control.** Track scope overrides sequence scope for the same target, and
    any track's lane wins, so the Grid states the precedence rather than letting the user find out
    by ear.
  - **The recording tap is at the transient/commit channel**, not in any mode. Adding a new
    gesture surface needs no capture code of its own.
  - **Captured points are sequence-scoped**, owned by the sequence being recorded into, so they
    loop with the pattern like the notes captured beside them.
  - **Thinning takes both gates**, and the value epsilon is a fraction of the target's registered
    range. A pass overwrites the span it sweeps; a loop wrap opens a fresh sweep.
  - **A point drag stalls on an occupied tick** rather than deleting the point there. Drawing does
    replace, because it is a deliberate placement.
  - **Marquee select is interpreted per region** and takes notes on intersection, not containment.
- **(ag) — sample assignment (issue #37).** Velocity bands are maintained rather than validated;
  zones follow a different rule because §6 lets them overlap; `dragDropPayload` is an armed
  selection, not a live drag.
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
- **Verifying in a browser from a worktree:** the dev server cannot serve `sqlite3.wasm`; build and
  `vite preview` instead, and override `BANGERBOX_SMOKE_PORT` / `BANGERBOX_SMOKE_PREVIEW_PORT`
  (issue #105). A throwaway Playwright driver must live **inside the worktree** — Node resolves
  `playwright` from the file's own directory, not the working directory.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–8, the §9.8 factory chain and the §14 (ag) assignment seam still stands.
New this work:

**The automation-authoring seam (spec §7.8, §8.5.2, §8.5.10):**

- **`useSequenceStore.setAutomationLane` owns every §7.8 gate.** It is the only route by which a
  point enters the model. It checks the target against the registry, Zod-validates every point,
  stamps each point with the lane it is being written into, deletes an emptied lane rather than
  storing it empty, accepts a `coalesceKey` for a gesture, and returns `AutomationEditResult` —
  `{ ok: true }` or `{ ok: false, reason }`, where `reason` is a **finished sentence** the UI shows
  verbatim. Add new automation rules here, never at a call site. Hydration bypasses it on purpose.
- **`src/core/audio/params/catalogue.ts`** answers "what can this thing automate", built from the
  registry's own path builders and gated through `isAutomatable`. Both the Grid's lane picker and
  the XYFX axis pickers read it. Any new picker MUST read it too rather than assembling addresses
  by hand — that is how the two used to drift.
- **`src/store/automationRecord.ts`** is the capture service. The engine publishes its playhead
  reader to it with `setAutomationClock` on start and `null` on dispose, exactly as it publishes the
  meter registry to `meterScope` — the recorder must never import the engine, which imports the
  stores that import the recorder. `recordParamGesture(path, value, 'move' | 'end')` is called from
  `useMixerStore.setTransient`/`commit` and `useProgramStore.setPadParamTransient`/`commitPadParam`.
  A new gesture surface that goes through those actions is captured with no work of its own.
- **The thinning maths is pure**, in `src/core/sequencer/automation.ts` beside the curve maths:
  `shouldRecordSample` and `mergeRecordedPoint`. Keep new capture rules there, not in the service.
- **`PlayheadReading.isCapturing`** is recording AND past the count-in. Use it, not `isRecording`,
  for anything that writes against the playhead position.
- **Canvas gestures hold their state in refs, never React state.** The marquee rectangle is a
  `useRef` the existing rAF loop paints; `GridCanvas` already does the same for touch points and
  the in-flight drag. Routing a drag through React state is a review failure (issues #27, #28).
- **A freshly drawn point's id is resolved once and held** for the rest of the drag. The store
  action commits through Zustand, so the id only reaches the canvas on the next render, and the
  first drag sample moves the point off the tick it was found by.

## 5. Repository catalogue — unchanged. No repository or DDL change.

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1**. **No migration added.**

## 7. Worker / worklet / message protocol versions

`SCHEDULER_PROTOCOL_VERSION` is still 1 and still inert (issue #96). The `automationDiff` message
and the `automationRamp` scheduled-event kind are unchanged.

**The playhead SAB gained a third flag bit**, `isCapturing` (§14 (ah) item 7). `PlayheadWriter.write`
takes it as an optional fourth argument, so a three-argument call still compiles and reads as "not
capturing". `SchedulerCore.isCapturing(now)` is its source.

## 8. Stores — all eight implemented (§4.2)

Changes this work, all additive and all recorded in §14 (ah):

- **`useSequenceStore.setAutomationLane`** gains a `coalesceKey` parameter and an
  `AutomationEditResult` return, plus the two §7.8 gates described above.
- **`useMixerStore`** and **`useProgramStore`** call `recordParamGesture` from their transient and
  commit actions. Nothing else about those actions changed.

## 9. Component tree topography (as implemented)

Unchanged except:

- **Grid → controls row:** an **Automation scope** `SegmentControl` (Track / Sequence) before the
  lane picker, a **Curve** `SegmentControl` (Step / Linear / Exp) after it, a precedence warning
  when a track lane overrides the sequence lane on screen, and a read-only warning for a lane the
  registry does not recognise. The lane picker now lists registered parameters, not only lanes that
  already hold points.
- **Grid → `GridCanvas`:** the automation lane is 96 px (it was 48) because it is now a drag target;
  breakpoints are drawn as grab handles and selected ones are larger and outlined; a marquee
  rectangle is painted while a select drag is live.
- **Grid → right column:** the "Notes" panel is joined by an **"Automation"** panel when a lane is
  selected — Add point, Delete selected points, and one row per point carrying a selection button, a
  value field and a delete button. This is the §8.2 keyboard path for the lane.
- **XYFX:** the axis pickers read the shared catalogue, so they now offer all four sends and the
  parameters of whatever effects occupy a channel's insert slots.

## 10. Kernel inventory — unchanged (the §5.6.4 set is complete).

## 11. Outstanding / deliberate technical debt

**`check:stubs` reports ZERO open stubs.** Outstanding work lives in GitHub issues, not in code
comments.

**STILL OUTSTANDING FROM PHASE 8 — READ THIS FIRST:**

- **The live hardware sign-off (§12, issue #13) is NOT done and cannot be self-certified.** It
  needs the human developer, a physical ESP32 BLE-MIDI controller and a Windows pairing.

**Nearest neighbours to this work, in rough order of how much they block a musician:**

- **#84** Reverse and Warp are persisted but never applied at playback, and **#107** the same for
  `LfoConfig.sync`/`phaseOffset`/`retrigger`. Both are reachable to set and still inert.
- **#71** the non-destructive groove path is dead end to end: the `groove` request kind has no
  member in `schedulerRequestSchema`, so the worker's Zod guard rejects every groove message.
- **#101** song mode never ends — `songEnded` and `songLoopEnabled` appear nowhere in `src`.
- **#70** the delay has no tempo-synced division.
- **#104** song and stem bounces write a WAV no user can reach.
- **#94** song mode omits automation, note repeat, arp, live erase and the per-pass recording flush.
  Automation authoring makes this more visible, not less: a lane recorded in sequence mode is
  ignored while song mode plays.
- **#93** tempo and swing edits are never persisted.
- **#27, #28** the transient store channel re-renders every consumer per gesture frame, and Grid
  scroll and zoom still route through React state. This work added no new instance — the marquee
  and the automation drags are ref-driven — but it did not fix the existing ones, and the recorder
  now writes to the sequence store on every accepted sample, which #27 makes more expensive than it
  should be.
- **#34** several live regions compete with the single §8.2 announcer.
- **#54** destructive edits have no confirmation. Automation point deletion inherits that: undo is
  the only safety net.

**Honest scope notes for this work:**

- **The seven ⚑ policies in §14 (ah) are judgement calls**, not spec text. §7.8 fixes the data model
  and the thinning inputs and leaves the rest open. Each rule lives in exactly one place if a human
  prefers a different one.
- **Automation is not undoable as one pass.** A recorded gesture coalesces into one undo entry per
  lane, sealed at the gesture's commit — not one entry per recording pass, because the note capture
  interleaved with it breaks the coalescing run. §7.7's "one undo entry per recording pass" is about
  notes and is unaffected.
- **The point list has no tick field.** A point's value is editable from the keyboard; its tick is
  not, so moving a point in time is a pointer-only gesture. That matches the note list beside it,
  which also offers select and delete but no pitch or tick editing — the same gap, not a new one.
- **`AUTOMATION_LANE_HEIGHT` is a constant, not a user setting.** A lane taller than 96 px would
  give a value drag more travel; nothing exposes that choice.
- **Capture has no per-parameter arm.** Every registered parameter a gesture touches while recording
  is captured. §7.8 asks for exactly that and names no arming control, but a user who nudges a fader
  mid-take will find a lane they did not intend to write.
- **Verified in a real browser** from the worktree at ports 5320/5321: a drawn lane at level 0
  silenced the master (peak 0.00000) and the same lane at 1.2 did not (peak 0.2760); a recorded XYFX
  gesture wrote 9 points, and the same 9 survived a save and a page reload.

## 12. Verification commands (all green at handover, inside the worktree and after the merge)

`npm run type-check` · `lint` · `test` (**1370**) · `format:check` · `verify` (**no open stubs**)
· `test:e2e` (dev + offline, **40/40 steps**, ports overridden per #105) · `build` ·
`build:factory`.
