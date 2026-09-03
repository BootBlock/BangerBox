# BangerBox — Phase Handover (after the data-integrity closure)

Generated at the close of the data-integrity work per Protocol Alpha (spec §13.1). A new session
MUST read `docs/todo/_spec.md` in full **and** this document before writing any code, and MUST
reuse the patterns recorded here rather than inventing parallel ones.

**State:** the data-integrity work merged to `main` (`--no-ff`). All eight §12 phases were already
complete; this was a defect closure against §4.4/§9.2/§9.6/§9.7/§9.3, not a new phase, so
`package.json` `config.phase` remains **"8"**. Suite: **1537 unit tests**, `test:e2e` real-browser
smoke (dev + offline, **50/50 steps**), plus `lint`, `type-check`, `format:check` and `verify`
(**no open stubs**).

**The Phase 8 live-hardware sign-off is still outstanding** (issue #13) and still requires the
human developer. Nothing in this work touched it.

**Bundle size and load time remain deliberately unconstrained** (§11.5, §14 2026-07-18 (j)).

Regenerate this document whenever a §14 entry lands, not only at a phase boundary.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

All nineteen stand unchanged. Three that bear on recent work:

- **#2 (Node ≥ 24)** is load-bearing beyond tooling: `build:factory` imports the app's own
  TypeScript through Node's native type stripping, so it MUST run as
  `node --import ./scripts/factory/register.mjs …`.
- **#5 (AssemblyScript for WASM DSP)** governs the new §5.7.9 warp source: the streaming granular
  path is an addition to the existing `granularStretch` kernel, behind the same §5.6.1 seam, not a
  second kernel and not TypeScript DSP inside a worklet.
- **#11 (Zod for runtime validation)** is what the §7.1.3 protocol relies on, and the reason a
  redundant `as` cast there was a real defect rather than a style point — see §2 (ai).

## 2. Spec deviations / corrections in effect

Phase 0–8 entries stand. The §14 entries since the last handover, newest first:

- **(aj) — the data-integrity closure (§4.4, §9.2, §9.3, §9.6, §9.7).** The ⚑ items below are
  settled policy a new session should treat as binding, not as spec text:
  - **A project switch REFUSES over work autosave could not write.** Not a confirmation modal:
    the refusal needs no new UI, and the escape hatch it costs is covered three ways — the
    message says to export, the queue is left standing so a later `saveNow()` still writes, and
    a permanently-unflushable batch is dropped by the queue's own issue-#72 rule, so a second
    attempt proceeds. The user is warned once, never trapped.
  - **Refusing and TEARING THE QUEUE DOWN are separate steps.** `newProject` and
    `installUnpackedAsNewProject` refuse before writing anything; the teardown stays in
    `loadProject`. Doing both up front left the still-open project with `markDirty` a no-op the
    moment anything after it failed — a worse loss than the one being prevented.
  - **`closeActiveProject` forces**, because §8.1's Safe Mode is the escape hatch and its own
    offer is to export.
  - **A tempo edit is UNDOABLE and belongs to the sequence row**, not to the transport mirror.
    With no active sequence it lands on `projects.bpm_default`, which §9.3 already defines as
    what a NULL `sequences.tempo` means. Swing has no project-level default, so with no sequence
    it moves the mirror and no more.
  - **The transport mirror writes back only what the ROWS changed**, because a §4.1 transient
    gesture holds it ahead of its row on purpose.
  - **A damaged `.mpcweb` is REFUSED; a lossy export is WRITTEN and warned about.** Import
    refuses before a row or byte is written. Export is per-sample recoverable and drops an
    unreadable sample from both the archive and its rows — the file may be the only copy of the
    user's work, so producing it and saying what is wrong beats producing nothing. The same rule
    governs an export that exceeds the import budget.
  - **`writeFileAtomic` is atomic wherever `FileSystemFileHandle.move()` is**, and best-effort
    where it is not. There is no atomic replacement to reach for without a rename.

- **(ai) — the §5/§7 playback wiring (§5.4, §5.7, §5.7.9, §6, §7.5, §7.9).** The ⚑ items below are
  settled policy a new session should treat as binding, not as spec text:
  - **`warp` means pitch decoupled from duration, not tempo-following.** §6 has no base-tempo
    field and inventing one is a §13.6 halt, so warp keeps `rate` at 1 and routes the pad's own
    detune through the granular engine. An octave-up warp pad sounds an octave up and lasts as
    long as the sample; the same pad without warp lasts half as long.
  - **The streaming granular path runs no WSOLA correlation search.** It is ~3 M multiply-adds per
    grain at 48 kHz, far outside a render quantum (§5.5). The offline `render` keeps it.
  - **A warp voice's declick does not move on a retune**, because detune is not its playback rate.
    `VoiceSource.pitchCoupled` is how the pool tells the two cases apart.
  - **A synced LFO's rate is resolved at note-on**; a live voice keeps the rate it started with.
    The **delay** answers the same question the other way and retunes immediately, because a
    `DelayNode` has no repeat boundary to wait for.
  - **`retrigger: false` is a property of the PAD**, not the voice — one oscillator per
    `(padKey, lfoIndex)`, kept for the pool's lifetime. A replaced one is **retired, not stopped**:
    voices still sounding through it keep it until the last of them ends.
  - **A groove template is keyed by its source sample's name**, so re-extracting replaces it.
  - **Song mode's schedule cursor is in absolute song SECONDS**, because a looping song has no
    monotonic tick. **The end is reached by the playhead, not by the lookahead**, and it is the end
    of the pass in progress.
  - **A zero-length song map stops whatever `songLoopEnabled` says.**
- **(ah) — automation authoring (§7.8, §8.5.2, §8.5.10).** The Grid lane scales to the registry
  range; scope is an explicit control; the recording tap is at the transient/commit channel;
  captured points are sequence-scoped; thinning takes both gates; a point drag stalls on an
  occupied tick; marquee select is per region; a keyboard step still records; the epsilon's range
  is passed in by the store that owns the parameter.
- **(ag) — sample assignment (issue #37).** Velocity bands are maintained rather than validated;
  zones follow a different rule because §6 lets them overlap; `dragDropPayload` is an armed
  selection, not a live drag.
- **(af)** `check:stubs` gained a phase-prose gate (issue #12).
- **(ae)** §11.2 no longer claims a `src/test/fixtures/` directory (issue #10).
- **(ad)** the three real-browser smokes run in CI (issue #15).
- **(ac)** the Looper gained its §8.5.8 controls (issue #3).
- **(q), (p)** §9.8 factory content. **Three ⚑ decisions there remain unratified** (issue #78).

## 3. Toolchain facts

- Installed majors unchanged. **No new dependencies** since Phase 0's closed §2.2 matrix.
- `npm run build:wasm` now emits a `granularStretch.wasm` carrying both the offline render and the
  streaming source; a worktree that does not run it gets a warp pad that falls back to coupled
  repitch rather than silence.
- **Lint trap (has cost two sessions):** `react-hooks/set-state-in-effect` fires when an effect
  reaches _any_ function that calls `setState`, not only a synchronous call in the effect body.
  The established shape is an **inline async IIFE with a `cancelled` flag** — see `BrowserPanel`,
  `FactorySection` and `SamplePicker`.
- **Run `lint` AFTER `format --write`, not before.** Prettier joins short `if` bodies onto one line,
  which trips `curly`; a lint run from before the formatting pass proves nothing.
- `format:check` is currently green across the repo. Nothing else runs Prettier — no pre-commit
  hook, and a local `git merge` never checks formatting — so re-run it after every merge.
- **Verifying in a browser from a worktree:** the dev server cannot serve `sqlite3.wasm`; run
  `npx vite build` then `npx vite preview`, and override `BANGERBOX_SMOKE_PORT` /
  `BANGERBOX_SMOKE_PREVIEW_PORT` (issue #105). A throwaway Playwright driver must live **inside the
  worktree** — Node resolves `playwright` from the file's own directory, not the working directory.
- **Heredocs through the Bash tool are unreliable for long multi-line content.** Write a patch
  script (or the file itself) with the Write tool and run it; a `<<'EOF'` block of a few hundred
  lines fails with an unmatched-quote parse error.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–8, the §9.8 factory chain, the §14 (ag) assignment seam, the (ah)
automation seam and the (ai) voice-source/scheduler/tempo seams still stand. New this work:

**The storage failure policy (spec §9.2, §9.7):**

- **`src/core/storage/retry.ts` is the only place that decides what a storage failure IS.**
  `isRecoverableStorageError` says which failures are transient contention (SQLite BUSY/LOCKED,
  OPFS `NoModificationAllowedError`) and `isNotFoundError` says which are an answer rather than a
  failure. A new storage call site classifies through those two, never with its own `catch {}`.
- **`withStorageRetry` rethrows the ORIGINAL typed error** when the budget runs out. A caller must
  still be able to branch on `DbError.code`, so there is no "gave up" wrapper.
- **Only idempotent operations go through it**: the three `WorkerDatabaseDriver` data calls and
  `writeFileAtomic`. `init`, `diagnostics`, `exportBinary` and `close` are deliberately outside.
- **`src/test/fakes/opfs.ts` is how OPFS policy is unit-tested.** Failures are injected through a
  mutable control object rather than by entry name, because the atomic write's temp file is named
  from `crypto.randomUUID()`. The real path is still proven by the §11.4 smoke, per §13.5 — the
  probe's `storagePolicyProof` is that proof.

**The `.mpcweb` reader (spec §9.6, §9.7):**

- **Unpacking is STREAMED (`Unzip` + `UnzipInflate`), never `unzipSync`.** The budget is checked
  inside `ondata`, where a throw unwinds straight out of `push`, so the remaining bytes are never
  inflated. `unzipSync` cannot bound anything, because it returns only once everything is held.
- **An entry the §9.6 layout does not name is never `start()`ed**, so an unknown entry costs
  nothing. Adding an entry kind means extending `isLayoutEntry`.
- **`unpackMpcweb` takes an optional budget** purely so the limits are provable at a size a unit
  test can build. Production always uses the §2.6 constants.
- **The archive's audio is reconciled against the sample rows `project.json` declares.** A row
  with no bytes refuses the import; bytes with no row are ignored.

**Tempo and swing (spec §9.3, §7.9):**

- **`src/store/tempo.ts` is the one place a tempo or swing edit enters the model.** The transport
  bar and the §10.3 Q-Link runtime both call it, with the §4.1 transient/commit split. Neither
  store owns the write: the transport store may not, or the mirror becomes authoritative and
  contradicts §7.9; the sequence store should not have to know which sequence is active.
- **`src/store/derive/transportMirror.ts` re-derives the mirror, and is NOT part of `syncLayer/`.**
  §4.3 is store → graph; this is store → store, and mixing them would blur the rule that the sync
  layer is the only code allowed to touch audio nodes. It is registered by `startProjectSession`.
- **`useProjectStore.bpmDefault`** is the §9.3 `projects.bpm_default` column, and `flushProject`
  writes it. Nothing wrote that column before.

**The voice source seam (spec §5.2 stage 1, §5.7.9):**

- **`src/core/audio/voiceSource.ts` is the only place that knows what a voice's source IS.** The
  pool builds its whole chain against `VoiceSource`: `node`, a `detune` AudioParam in cents,
  `pitchCoupled`, `sourceSeconds`, `start`/`stop`/`setOnEnded`/`automatedParams`/`destroy`. Both
  implementations expose `detune` in the same units, so the §6 pitch envelope, keygroup glide,
  pitch-routed LFOs and the §10.2 bend node all write to one address whichever is underneath.
  **Adding a third source kind means implementing this interface, not branching in the pool.**
- **`pitchCoupled` is the whole of the §5.4 declick's branch.** True ⇒ detune is the playback rate
  and the end is integrated from the contour (issue #87); false ⇒ the end is the source's own
  length and a retune does not move it.
- **`granular-source` follows the `dsp-effect` precedent exactly**: the module is compiled on the
  main thread and handed over via `processorOptions` (§5.6.2), one kernel per channel, freed on a
  `dispose` port message (§5.6.3). It differs in two ways a new source would share: it has **no
  `ended` event**, so the end of the region is a port message standing in for
  `AudioBufferSourceNode.onended`; and **start and stop are frame-accurate against `currentFrame`**,
  because a scheduled note arrives up to `LOOKAHEAD_MS` early (§7.1.4).
- **`src/core/audio/voiceBuffer.ts` owns reversal.** `ReversedBufferCache` is a `WeakMap` keyed by
  the source buffer, so a dropped sample takes its reversed copy with it. `mirroredTrim` is the
  non-obvious half: a reversed layer plays a reversed copy **and** its trim mirrored into that
  copy's frame numbering. The live engine and the §9.5 bounce both use it.

**The scheduler protocol (spec §7.1.3):**

- **`src/core/sequencer/schedulerDispatch.ts` decides what a validated message DOES**, leaving
  `scheduler.worker.ts` the thin shell §11.3 describes. Its `switch` is exhaustive, so the request
  type, the Zod union and the dispatch are forced into agreement.
- **Never cast a Zod union to its TypeScript counterpart.** The annotation on the `const` is the
  only thing that checks exhaustiveness, and an `as` suppressed exactly that — which is how
  `groove` reached production as a typed sender with no schema member (issue #71).
- **`schedulerWire.test.ts` drives every `SchedulerClient` sender through `parseSchedulerRequest`.**
  A new sender without a schema member fails there. Add the sender to that test.
- **A test stub for a wide interface should grow its own spies.** `sequencerSync.test.ts` uses a
  Proxy for exactly this reason; a hand-listed set of mocks is the same drift trap one layer up.
- **`ScheduledEvent.bpm`** carries the tempo the scheduler placed a note against — the segment's own
  in song mode (§7.9), not the transport's. Anything resolving a tempo-relative value per note reads
  it, falling back to the transport only for a live audition.

**Tempo reaching the graph (spec §4.3, §5.7):**

- **`audioBridge.setBpm` → `MixerGraph.setTempo` → every strip's inserts.** The fan-out is on the
  graph because the bridge holds no list of strips and a channel created later would be missed.
  A new tempo-synced effect implements `EffectCore.setTempo` and needs no plumbing of its own.
- **`EFFECT_PARAM_CHOICES`** names the labels behind an index-encoded §5.7 parameter (the filter's
  type, the saturator's curve, the delay's sync division). The insert editor renders a select for
  anything named there and a knob for everything else. A new enumerated parameter goes in that map.
- **`noteDivisionSeconds`** in `core/sequencer/ppqn.ts` is the one conversion from a §6 note division
  to seconds. Both the synced delay and the synced LFO use it; do not add a second.

## 5. Repository catalogue — unchanged. No repository or DDL change.

`dumpSnapshot` now reads `samples.listGlobal` as well as `listByProject`, so a §9.6 export carries
the §9.8 global-library audio its programs reference. No repository method was added.

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1**. **No migration added.**

`projects.bpm_default` is now WRITTEN as well as read (issue #93). The column has always existed
with a default of 120, so a project saved before this loads unchanged and needs no migration.

The §9.3 `projects.payload` gained three optional fields — `grooveTemplates`, `trackGrooveIds` and
`songLoopEnabled`. All three are `.optional()`, so a project written before them loads with §7.9's
own defaults and needs no migration.

## 7. Worker / worklet / message protocol versions

`SCHEDULER_PROTOCOL_VERSION` is still 1 and still inert (issue #96). Additive this work, per the
extend-by-adding precedent: the **`songLoop` request**, the **`songEnded` response**, and
**`ScheduledEvent.bpm`**. The `groove` request kind is unchanged — it simply reaches the worker now.

Worklet processors registered at the start gate are now four: `meter-tap`, `dsp-effect`, `recorder`
and **`granular-source`**. `prepareVoiceWorklets(context)` registers the last of them on an offline
context, which the §9.5 bounce calls so a warp pad bounces the way it plays.

`WorkletKernelName` gained `granularStretch`; `DspEffectKernelName` is the subset the DSP-effect
worklet hosts, which is what keeps that processor's kernel switch exhaustive rather than defensive.

## 8. Stores — all eight implemented (§4.2)

Changes this work, all additive and all recorded in §14 (aj):

- **`useProjectStore.bpmDefault`** with `setBpmDefault`, hydrated from `projects.bpm_default` and
  persisted by `flushProject`. It is the other half of the §4.2 effective tempo.
- **`src/store/tempo.ts`** — `commitTempo`/`commitSwing` and their transient pair. Not a slice: a
  command module over two slices, because neither owns the value alone.
- **`src/store/derive/transportMirror.ts`** — `subscribeTransportMirror`, registered by
  `startProjectSession` and disposed by `stopProjectSession`.
- **`AutosaveQueue.unsavedKeys`** — pending plus permanently-dropped keys, so a refusal can name
  what it is refusing over. `pendingKeys` alone cannot: a permanent failure clears the queue.
- **`describeDirtyKeys`** in `core/project/dirty.ts` turns that set into "2 sequences and 1 track".

Changes from the previous work, recorded in §14 (ai):

- **`useTransportStore.songLoopEnabled`** (§4.2's own field) with `setSongLoopEnabled`. It is the
  only setting in that store that persists, because it is arrangement state rather than a
  performance gesture, so its setter marks the project dirty.
- **`useSequenceStore.setGrooveTemplate`** is now an undoable commit that marks the project dirty;
  `assignTrackGroove` marks the project rather than the track, since both persist in the §9.3
  payload.
- **`DEFAULT_BPM`** joins `schemas/ranges.ts`, single-sourcing the 120 that the transport store and
  the §9.3 `bpm_default` column both carried.

## 9. Component tree topography (as implemented)

The transport bar's Tempo and Swing knobs now commit through `store/tempo.ts` rather than writing
the transport mirror directly. Otherwise unchanged except (from the previous work):

- **Song → header:** a **Loop song** `Toggle` beside the duration readout, with a line naming which
  of §7.9's two ends it selects. It is here and not in the §8.1 transport bar, per §8.5.12.
- **Mixer → `InsertPanel`:** an index-encoded parameter renders as a labelled select rather than a
  knob, so the delay's `sync`, the filter's `type` and the saturator's `curve` are all readable.
- **Sample Edit → tools row:** **Groove → save template** beside **Groove → bake to track**.
- **Program Edit → `LfoEditor`:** the "saved but not yet applied" notes for sync, phase offset and
  free-running are gone; the Hz field is disabled while a note division is chosen. Only the two
  shape approximations (`sampleHold`, `drift`) still carry a note.

## 10. Kernel inventory

The §5.6.4 set is complete and unchanged in membership. `granularStretch` now carries two entry
points: the offline `render` (WSOLA, for the §8.5.4 stretch tool) and the streaming
`createStream`/`prepareStream`/`streamBlock` (fixed-grid OLA, for the §5.7.9 warp source).

## 11. Outstanding / deliberate technical debt

**`check:stubs` reports ZERO open stubs.** Outstanding work lives in GitHub issues, not in code
comments.

**STILL OUTSTANDING FROM PHASE 8 — READ THIS FIRST:**

- **The live hardware sign-off (§12, issue #13) is NOT done and cannot be self-certified.** It
  needs the human developer, a physical ESP32 BLE-MIDI controller and a Windows pairing.

**Nearest neighbours to this work, in rough order of how much they cost a musician:**

- **#76** mod-matrix sums reach detune and amp gain unclamped, so a valid imported program can play
  32 octaves off at 33× gain; **#97** missing range, NaN and integer guards in the audio-param and
  DSP helpers; **#66** `decodeWav` accepts a WAV with no `fmt` chunk and decodes it against silent
  defaults; **#95** sequencer silent-failure modes; **#74** a mid-playback tempo change
  retroactively re-times elapsed playback. These five are the correctness-hardening cluster and are
  the natural next piece of work. **#74 is now adjacent to `store/tempo.ts`**, which is where a
  tempo change enters the model.
- **#99 remains OPEN for one point only**: export still holds every sample in memory at once.
  `zipSync` materialises the whole archive, so streaming it is a redesign of `pack.worker.ts` and
  `packClient.ts` rather than a fix. Everything else in that issue is closed.
- **#94** song mode omits automation, note repeat, arp, live erase and the per-pass recording flush.
  Untouched by this work.
- **#104** song and stem bounces write a WAV no user can reach.
- **#27, #28** the transient store channel re-renders every consumer per gesture frame, and Grid
  scroll and zoom still route through React state.
- **#54** destructive edits have no confirmation.

**Honest scope notes for this work:**

- **Export still holds every sample in memory** (issue #99, above). Nothing in this work changed
  that, and the new export-side warning is a report rather than a bound.
- **The §2.6 `.mpcweb` budgets are absolute, not ratio-based.** A 1 GiB archive from a 1 MB file is
  still a 1000× expansion and still allowed. A compression-ratio cap would be tighter but would
  refuse a legitimate project whose `project.json` happens to compress well, and #26 asked for the
  three absolute caps.
- **A permanently-unflushable batch lets the SECOND switch attempt through.** The queue drops such
  keys by its own issue-#72 rule, so the work really is gone by then — the user was warned once and
  chose to proceed. The alternative traps them.
- **An import refused after its rows commit leaves the archive in Recent, unopened.** Reachable
  only if the user edits between the install's own refusal check and the `loadProject` at its end.
  Nothing is lost; the project simply is not opened.
- **Verified in a real browser** at ports 5340 (preview) and 5342/5343 (smoke). Twenty driver
  checks and 50/50 smoke steps, no console errors: a tempo of 134 and a swing of 58 survived a
  reload where the unfixed build returned to 120/50; an archive declaring two samples and carrying
  one was refused by name ("1 of its 2 samples are missing from it (snare)"); a 301 kB archive
  inflating to 300 MiB was refused in 4.2 s as "too large (over 256 MB)" with the tab intact; a
  switch over an unwritable key was refused, left the user on the same project with the dot up, and
  succeeded on retry; and the storage policy round-tripped an atomic write with no temp left behind
  while an injected `NotReadableError` propagated instead of reading as "absent".

**Judgement calls from the previous work:**

- **The ⚑ policies in §14 (ai) are judgement calls**, not spec text. Each lives in exactly one place
  if a human prefers a different one.
- **A warp voice costs one copy of its region per note**, on the main thread, because
  `processorOptions` are structured-cloned and a `subarray` view would clone the whole sample behind
  it. A warp pad on a long sample is the case to watch; nothing caps it.
- **The streaming granular path is plain overlap-add**, so at a large pitch shift it is phasier than
  the offline `render`. Both are the same kernel and the difference is the correlation search.
- **A synced LFO on a note held across a manual BPM edit keeps its old rate.** §10.5 keeps tempo
  automation out of v1, so that is the only way to reach the case, and it lasts one note.
- **Switching playback mode mid-transport resumes at the elapsed position** rather than restarting.
  §7.9 and §8.5.12 do not say which is wanted; this is the least surprising reading and is the
  behaviour a test now pins.
- **`grooveTemplates` still has no name field**, so the Grid's picker shows the key — which is why a
  template is keyed by its source sample's name. A template list with real names would need a schema
  field.
- **Verified in a real browser** from the worktree at ports 5320/5321 and by the full smoke at
  5330/5331. Seven driver checks and 50/50 smoke steps, no console errors: reverse moved the burst
  from one half of the render to the other (0.0000/0.1517 forward, 0.4056/0.0000 reversed); warp
  held 600 Hz across 0.387 s where the plain voice held 600 Hz across 0.200 s; a 1/4-synced LFO
  measured 1 Hz at 60 bpm and 3.5 Hz at 240 against 2 Hz free-running; a quarter-turn sine started
  at +1.0000; the delay echoed at 0.350 / 0.500 / 1.000 / 0.375 s free, 1/4@120, 1/4@60 and 1/8.@120,
  and at 1.000 s after a retune to 60 bpm; and a groove saved in Sample Edit reached the Grid's
  picker.

## 12. Verification commands (all green at handover, inside the worktree and after the merge)

`npm run type-check` · `lint` · `test` (**1537**) · `format:check` · `verify` (**no open stubs**)
· `test:e2e` (dev + offline, **50/50 steps**, ports overridden per #105) · `build` ·
`build:wasm` · `build:factory`.
