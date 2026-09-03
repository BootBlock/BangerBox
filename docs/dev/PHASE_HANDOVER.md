# BangerBox — Phase Handover (after the correctness-hardening closure)

Generated at the close of the correctness-hardening work per Protocol Alpha (spec §13.1). A new
session MUST read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** the correctness-hardening work merged to `main` (`--no-ff`). All eight §12 phases were
already complete; this was a defect closure against §6/§4.3/§5.6/§9.4/§7.1/§7.2, not a new phase,
so `package.json` `config.phase` remains **"8"**. Suite: **1632 unit tests**, `test:e2e`
real-browser smoke (dev + offline, **50/50 steps**), plus `lint`, `type-check`, `format:check` and
`verify` (**no open stubs**).

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
- **#11 again, from the other side:** Zod validating a payload does NOT mean the values in it are
  safe at the parameter. The §6 mod-matrix schema accepts 32 routes and each `amount` in ±1 and
  says nothing about their sum, so the clamp has to live where the sum reaches a parameter — see
  §2 (ak).

## 2. Spec deviations / corrections in effect

Phase 0–8 entries stand. The §14 entries since the last handover, newest first:

- **(ak) — the correctness-hardening closure (§6, §4.3, §5.6, §9.4, §7.1, §7.2).** The ⚑ items
  below are settled policy a new session should treat as binding, not as spec text:
  - **The §4.3 ramp helpers REFUSE a non-finite value; they never substitute one.** A NaN on an
    `AudioParam` poisons it, and everything downstream, for the rest of the session — the worst
    failure those helpers can cause, so it is the one they will not perform. They deliberately do
    NOT clamp to a range: a helper taking any param cannot know its range, and §4.1 store actions,
    the §6 schemas and the §7.8 registry each already own that.
  - **The §5.6 kernel wrappers CLAMP what is in range and REFUSE what is not a number.** An
    out-of-range `f64` is a coefficient inside an AssemblyScript kernel, not an error. A range
    floor is NOT a neutral value — −60 dB is a compressor's hardest threshold — so a non-finite
    parameter skips the write and the kernel keeps what it had (`kernelParam` returns null).
    `kernelParamOr` is for the parameters that genuinely have a neutral: a stretch rate of 1, a
    pitch shift of 0, the documented detection defaults.
  - **A structural argument THROWS.** A block size, sample rate or band index has no defensible
    substitute, and a bad band index is an out-of-bounds write into linear memory.
  - **Those §5.7 bounds are declared beside each wrapper, not imported from `effectParams.ts`.**
    The wrappers load inside the DSP-effect worklet (§5.6.2), and importing the effect table there
    would drag `@/core/project/schemas` — and Zod behind it — into the render thread.
    `kernelRanges.test.ts` is the §13.6 gate against the two copies drifting.
  - **A malformed `fmt ` chunk is REFUSED, never repaired**, and the decoder holds no format
    defaults at all — every field is undefined until a chunk supplies it, so there is nothing for
    a bad header to be decoded against. `encodeWav` likewise refuses ragged channels rather than
    zero-padding them, because fabricating audio is the wrong way to report a caller bug.
  - **A truncated lookahead window DEFERS.** It neither drops the remainder nor throws: throwing
    would stop playback over a window that is merely large.
  - **A torn seqlock read HOLDS the last good reading and reports itself stale**, inside
    `PlayheadReader` rather than at each call site.
  - **A stop disarms live erase.** Clearing it costs a user still holding Erase one re-press; not
    clearing it cost their notes.
  - **The tempo anchor is SEPARATE from the count-in boundary, and it MOVES.** See §4.
  - **A non-finite voice tune contributes NO detune**, not the range floor — `clamp` maps NaN to
    its minimum, which there was four octaves flat. A non-finite amp gain still lands on silence,
    which has no neutral and is recoverable.

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

**The guard layer (spec §4.3, §5.6, §6):**

- **`modMatrix.ts` owns the two clamps its own contract calls for.** `clampModSum` bounds a summed
  target to the ±1 full scale that target declares; `oscillatorDepthScale` scales LFO route depths
  in proportion, because those sum in the audio graph where nothing can clamp them. A new §6 mod
  target clamps through one of the two — do not add a third rule at a call site.
- **`voicePool` clamps detune and amp peak against limits DERIVED from the §6 ranges**
  (`MAX_VOICE_DETUNE_CENTS`, `MAX_VOICE_GAIN`), not written down, so tightening a range tightens
  them too. These are defence in depth: `staticModulation` already bounds the matrix's own share.
- **`params/ramps.ts` is the only place that decides whether a value may reach an `AudioParam`.**
  Its `schedulable` guard is the whole rule; a new ramp helper goes through it.
- **`kernelBase.ts` is the only place that decides what a bad kernel parameter IS.**
  `kernelParam` / `kernelParamOr` for values, `assertPositiveInteger` / `assertSampleRate` for
  structure. A new kernel wrapper classifies through those four, never with its own `if (isNaN)`.
- **`clamp` from `@/core/math` maps NaN to `min`.** That is right for a UI travel value and wrong
  wherever the minimum is an extreme rather than a neutral. Check which case you are in before
  reaching for it — it is how a non-finite tune became four octaves flat.

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

**The tempo anchor and the click grid (spec §7.2, §7.1.4, §7.7):**

- **`anchorContext` / `originTick` / `anchorSongSeconds` are the tempo anchor, and it MOVES.**
  A mid-playback tempo change re-anchors all three to the moment of the change, carrying the tick
  and song seconds measured at the OLD tempo, so the elapsed part is immutable and the new tempo
  governs only what follows. Every tick↔seconds conversion in `SchedulerCore` reads the anchor.
- **`contentStartContext` is NOT the anchor.** It stays where content genuinely began, because it
  is what the §7.7 count-in gate compares a live note's timestamp against. Folding the two into
  one field made a §10.2 latency-compensated note, dated just before the change, look as though it
  had arrived during a count-in.
- **`originTick` is a LINEAR tick and a re-anchored one is mid-pass**, so `positionTickAt` folds it
  through `sequenceTickAt` like any other position. There is no short-circuit for a zero elapsed.
- **The re-anchor happens at the next `tick(now)`, not inside `setTempo`.** The core has no clock
  (§11.3 — the worker file is a thin shell), and `tick(now)` is where a trustworthy context time
  arrives. `pendingBpm` carries it across; the wait is at most `SCHEDULER_INTERVAL_MS`.
- **`nextScheduleTick` is deliberately NOT re-anchored.** It marks how far the lookahead has
  already posted, so on a slow-down it sits ahead of the playhead and the scheduler schedules
  nothing until the clock reaches it. That is why nothing is dropped or double-scheduled.
- **`clickBeatPhase` is captured once at the play gesture and never re-derived from `originTick`,**
  which the re-anchor moves mid-bar. The §5.9 accent follows the click INDEX, so no code may skip
  an index — `scheduleClicks` consumes the index of a click it declines to emit.
- **`reanchorClicks` rebuilds the grid around the NEXT unemitted click**, placing it at the
  earliest of where the old tempo was going to and one new beat from here, never before `now`.
- **A click more than one beat stale is not emitted.** A past `when` reaches Web Audio as "play
  now", so a wake after a backgrounded tab would dump every elapsed beat as one burst. One beat of
  tolerance, not zero: a click a few milliseconds late is still the beat the user expects.
- **A tempo change during a count-in re-derives the count-in from the play gesture**, so it is
  always a whole number of bars at the tempo in force. Clicks already posted at the old spacing
  stand, so the accent can shift by up to a beat inside that 0–2 bar window.

**Reporting rather than skipping (spec §7.1.4, issue #95):**

- **`segmentWindow` returns `{ segments, reachedTo, truncated }`.** A caller advances its cursor to
  `reachedTo`, never to the end it asked for. `eventsInWindow` re-segments internally and reaches
  the same point, so `scheduleSequence` walks the window ONCE and clamps everything below to it.
- **`PlayheadReading` gained `stale`.** The reader holds its last tear-free snapshot, so a
  consumer that ignores the flag still gets the right number rather than tick 0.

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

`SCHEDULER_PROTOCOL_VERSION` is still 1 and still inert (issue #96). **Nothing was added to the
§7.1.3 protocol this work** — no request kind, no response kind, no `ScheduledEvent` field. Two
INTERNAL shapes inside `src/core/sequencer/` did change, and neither crosses the wire:
`segmentWindow` now returns `WindowSegments` rather than an array, and `PlayheadReading` carries a
`stale` flag.

From the previous work, and unchanged: the **`songLoop` request**, the **`songEnded` response**, and
**`ScheduledEvent.bpm`**. The `groove` request kind reaches the worker.

Worklet processors registered at the start gate are now four: `meter-tap`, `dsp-effect`, `recorder`
and **`granular-source`**. `prepareVoiceWorklets(context)` registers the last of them on an offline
context, which the §9.5 bounce calls so a warp pad bounces the way it plays.

`WorkletKernelName` gained `granularStretch`; `DspEffectKernelName` is the subset the DSP-effect
worklet hosts, which is what keeps that processor's kernel switch exhaustive rather than defensive.

## 8. Stores — all eight implemented (§4.2)

**No store changed this work.** `store/tempo.ts` is still the one place a tempo edit enters the
model; what changed is what the scheduler does with the message it already sent (§14 (ak)).

Changes from the data-integrity work, all additive and all recorded in §14 (aj):

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

**No component changed this work.** One primitive helper did: `formatValueText` reads a NaN as an
em dash rather than the literal "NaN", which a screen reader announces verbatim, and its kHz
abbreviation now tests the ROUNDED magnitude so 999.6 Hz reads "1.0 kHz" and not "1000 Hz".

The transport bar's Tempo and Swing knobs commit through `store/tempo.ts` rather than writing the
transport mirror directly. Otherwise unchanged except (from earlier work):

- **Song → header:** a **Loop song** `Toggle` beside the duration readout, with a line naming which
  of §7.9's two ends it selects. It is here and not in the §8.1 transport bar, per §8.5.12.
- **Mixer → `InsertPanel`:** an index-encoded parameter renders as a labelled select rather than a
  knob, so the delay's `sync`, the filter's `type` and the saturator's `curve` are all readable.
- **Sample Edit → tools row:** **Groove → save template** beside **Groove → bake to track**.
- **Program Edit → `LfoEditor`:** the "saved but not yet applied" notes for sync, phase offset and
  free-running are gone; the Hz field is disabled while a note division is chosen. Only the two
  shape approximations (`sampleHold`, `drift`) still carry a note.

## 10. Kernel inventory

The §5.6.4 set is complete and unchanged in membership. Every wrapper now guards its parameters
per §14 (ak) — clamp in range, refuse a non-finite one, throw on a bad structural argument — and
`LIMITER_RANGES`, `FDN_REVERB_RANGES` and `MULTIBAND_RANGES` mirror the §5.7 table under the
`kernelRanges.test.ts` gate. `granularStretch` carries two entry points: the offline `render` (WSOLA, for the §8.5.4 stretch tool) and the streaming
`createStream`/`prepareStream`/`streamBlock` (fixed-grid OLA, for the §5.7.9 warp source).

## 11. Outstanding / deliberate technical debt

**`check:stubs` reports ZERO open stubs.** Outstanding work lives in GitHub issues, not in code
comments.

**STILL OUTSTANDING FROM PHASE 8 — READ THIS FIRST:**

- **The live hardware sign-off (§12, issue #13) is NOT done and cannot be self-certified.** It
  needs the human developer, a physical ESP32 BLE-MIDI controller and a Windows pairing.

**#76, #97, #66, #95 and #74 are CLOSED by this work.** The correctness-hardening cluster is done.

**Nearest neighbours now, in rough order of how much they cost a musician:**

- **#104** song and stem bounces write a WAV no user can reach — `bounceTrack` and
  `resampleSequenceToSample` are implemented, tested and allowlisted in `check:orphans` precisely
  because nothing invokes them. Reachability, not DSP.
- **#99 remains OPEN for one point only**: export still holds every sample in memory at once.
  `zipSync` materialises the whole archive, so streaming it needs fflate's `Zip` and per-sample
  transfers through `packClient`, which is a redesign of `pack.worker.ts` rather than a fix.
  Everything else in that issue is closed.
- **#27, #28** the transient store channel re-renders every consumer per gesture frame, and Grid
  scroll and zoom still route through React state. §3.3 forbids exactly this.
- **#54** destructive edits have no confirmation.
- **#94** song mode omits automation, note repeat, arp, live erase and the per-pass recording flush.
  Untouched by this work, and now the largest remaining behavioural gap in §7.9.
- **#96** `SCHEDULER_PROTOCOL_VERSION` is still inert, and `automationRampForWindow` is still the
  dead duplicate of `schedulerCore`'s hand-rolled automation scheduling.

**Honest scope notes for this work:**

- **The clamps bound COMBINATIONS, not the schema.** §6 still validates 32 routes onto one target;
  the clamp is at the parameter. A tighter schema — a per-target sum cap — would refuse such a
  program at import instead, and #76 asked for the clamp rather than the schema change.
- **The LFO depth scale is PROPORTIONAL, so an over-full patch is quieter than it asks for.** Two
  routes at 0.6 each summed to 1.2 full scale before and now share 1.0. That is the point, but it
  is an audible change to a patch that was previously in the 1.0–1.2 band; nothing warns the user.
- **The ramp helpers do not clamp to a range, deliberately.** A value that is finite but wildly out
  of range still reaches its `AudioParam`. Range is the caller's business (§4.1, §6, §7.8); a
  helper that took any param and guessed at a range would be worse than one that guards only what
  it can know.
- **A non-finite kernel parameter leaves the kernel on its PREVIOUS value, silently.** Nothing
  reports it. The alternative was throwing inside a worklet, which kills the processor.
- **A tempo change during a count-in can shift the accent by up to a beat.** The count-in is
  re-derived from the play gesture at the new tempo, but clicks already posted at the old spacing
  cannot be recalled. Bounded to a 0–2 bar window before any content sounds.
- **The re-anchor leaves up to one `LOOKAHEAD_MS` of already-posted events at the old tempo.** They
  were scheduled before the change and are not re-timed — a seam of at most 100 ms, inherent to a
  lookahead scheduler. Nothing is dropped or double-scheduled; `nextScheduleTick` is what
  guarantees that.
- **`positionTickAt` in song mode no longer short-circuits**, so it now round-trips through
  `songTickToSeconds`/`songSecondsToTick` even at a zero elapsed. The round trip is exact for the
  anchor tick, but it is arithmetic where there used to be none.
- **A truncated lookahead window is reachable only with a loop about one tick long.** `loopActive`
  already requires `endTick > startTick`, so each iteration advances at least a tick and the
  100 000-segment guard needs a window 100 000 loops wide. The deferral is correct rather than
  frequently exercised.
- **Verified in a real browser** at ports 5360 (preview) and the smoke's own defaults. Nineteen
  driver checks and 50/50 smoke steps, no console errors: 32 velocity→pitch routes rendered
  600.0 Hz against a 300.0 Hz control (one octave, where the unfixed build asked for 32) and 32
  velocity→amp routes peaked 1.9889 against 0.9944; a `GainNode` survived three attempted NaN
  writes and still passed a 0.3536-RMS tone, and the limiter and reverb worklets rendered finite
  audio (0.3577 and 0.4208 RMS) from NaN parameters; four malformed WAV headers were each refused
  by name; a torn seqlock read held tick 3840 and reported itself stale where the unfixed reader
  returned 0; live erase removed all four notes while held and none of the four on the pass after a
  stop; and halving the tempo 4 s into playback moved the playhead 10206 → 10430 → 11710 rather
  than backwards.

**Judgement calls from the previous work:**

- **The ⚑ policies in §14 (ak) and (ai) are judgement calls**, not spec text. Each lives in exactly one place
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

`npm run type-check` · `lint` · `test` (**1632**) · `format:check` · `verify` (**no open stubs**)
· `test:e2e` (dev + offline, **50/50 steps**, ports overridden per #105) · `build` ·
`build:wasm` · `build:factory`.
