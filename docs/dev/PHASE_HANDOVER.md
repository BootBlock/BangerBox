# BangerBox — Phase Handover (after the song entry-index closure)

Generated at the close of the §7.9 entry-index work per Protocol Alpha (spec §13.1). A new session
MUST read `docs/todo/_spec.md` in full **and** this document before writing any code, and MUST
reuse the patterns recorded here rather than inventing parallel ones.

**State:** the entry-index work merged to `main` (`--no-ff`). All eight §12 phases were already
complete; this was a defect closure against §7.1.3/§7.7/§7.9, not a new phase, so `package.json`
`config.phase` remains **"8"**. Suite: **1831 unit tests**, `test:e2e` real-browser smoke
(dev + offline, **63/63 steps**), plus `lint`, `type-check`, `format:check` and `verify`
(**no open stubs**).

**`SCHEDULER_PROTOCOL_VERSION` is now 2** (§7.1.3), and it is the first bump the project has
made: `songSequence` carries §7.9 entries rather than a repeat-expanded id list, which changes
an existing kind's shape rather than adding one. See §2 (ao) and §7.

**The Phase 8 live-hardware sign-off is still outstanding** (issue #13) and still requires the
human developer. Nothing in this work touched it.

**Bundle size and load time remain deliberately unconstrained** (§11.5, §14 2026-07-18 (j)).

Regenerate this document whenever a §14 entry lands, not only at a phase boundary.

---

## 1. Locked Decisions (§1.3) — restated verbatim in effect

All nineteen stand unchanged. Four that bear on recent work:

- **#12 (fflate for `.mpcweb`)** now has one packer and one unpacker, both streaming. There is no
  `zipSync` path left in `src`; the §9.8 factory generator drives the same streaming packer.

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

- **(ao) — the song entry-index closure (§7.1.3, §7.7, §7.9, §9.5).** The ⚑ items below are
  settled policy a new session should treat as binding, not as spec text:
  - **The §7.9 playlist crosses the §7.1.3 boundary as ENTRIES, and the worker expands
    `repeats`.** `buildSongMap` already numbered entries the way §7.9 requires and was simply
    never given the real ones. Correcting the number on the way out instead would have meant a
    second place that knows what a repeat is.
  - **The SENDER sorts by `position` and the worker takes the array index.** `position` is the
    §9.3 column and `songEntries` is the store's own array, so the sort belongs beside the store.
    `SchedulerSongEntry` carries neither `id` nor `position`: a field the worker cannot use is
    one more thing that can disagree with the store.
  - **A guard field's floor comes from the section that DEFINES the field, not from the schema
    that happens to hold it.** `repeats` has a floor of 0 in §7.9 — a skipped entry is an
    arrangement — and 1 in `songEntrySchema`, which nothing parses at runtime. The guard refuses
    a whole MESSAGE over one bad field, so taking the stricter of the two silenced the entire
    playlist of a song the spec describes. A negative or fractional count is still refused.
  - **`songAdvanced`'s entry index and `flushOnSegmentChange`'s segment ordinal are DIFFERENT
    numbers and must stay so.** An entry played three times is one entry (§7.9's index) and
    three plays (§7.7's merge boundary).
  - **A consumer of `songAdvanced` MUST render the position-sorted projection**, which §8.5.12's
    playlist now does in render, in `removeEntry` and in `moveEntry`. Indexing the raw
    `songEntries` array is what §7.9 forbids in as many words.
  - **The entry mark clears on a stop and on leaving song mode, and a report that arrives after
    a stop is ignored.** The worker learns about a stop on its next wake (§7.1.4) and nothing
    arrives afterwards to correct the mark, so a stopped transport would show a playing row for
    good.
  - **There is ONE expansion of the §7.9 playlist.** The §9.5 song bounce used to carry its own,
    on the main thread, so the segment cap bounded the worker and left the render able to freeze
    the tab on the same damaged pack.
  - **What a live-erase sweep LONGER than one loop pass means is now recorded** (§7.7 answers
    only the ordinary case): the UNION of the sequence ticks the window passed over, each event
    exactly once. Counting instead would make the number of `erased` reports depend on the
    scheduler's wake rate.
  - **Song mode keeps its own erase SELECTION and shares `reportErased`.** A song slice is a
    segment window in song ticks and a sequence window is a linear window folded on the loop;
    one function taking either would be a flag, not a shared rule.

- **(an) — the accessibility closure (§2.1, §8.2, §9.7).** The ⚑ items below are settled
  policy a new session should treat as binding, not as spec text:
  - **The §8.2 announcer carries TWO channels and two is the whole set.** Polite waits its
    turn, assertive interrupts. Severity picks the channel; it may never again pick a
    `role`, because a role per notice is a live region per notice — the whole of issue #34.
    A third region would be a competing region again.
  - **The announcer is mounted by `App`, FIRST in its tree**, so it exists while the §5.1
    start gate is up and its listeners are registered before any sibling's first effect can
    announce. The three blocking screens render INSTEAD of `App` and keep their own regions.
  - **`useAnnounce` is the one route a call site takes.** An effect written out at each site
    is how a site grows a region of its own again.
  - **An indicator that flips on every edit is READABLE, not ANNOUNCED** — the unsaved dot
    keeps `sr-only` text and no `aria-live`.
  - **Four `formatValueText` tokens name a DOMAIN, not a unit**: `pan`, `fraction`,
    `faderLevel`, `ratio`. §8.2's wording belongs to the PARAMETER, not to the screen, so the
    same send reads the same on a Mixer knob and an XYFX axis. No new `formatValue` closure.
  - **`targetUnit` is the sibling of `targetRange`, and `resolveTargetUnit` of
    `resolveTargetRange`.** An insert parameter's unit belongs to the effect in the slot
    exactly as its range does. Resolving the two in different places is one edit from drawing
    a delay time in ms and announcing it as a fraction.
  - **A dimensionless parameter reads as a bare number, and that is right.** A filter Q has
    no unit. `effectParams.test.ts` gates which parameters are allowed to have none.
  - **The transport bar is a `group`, and the roving tabindex is deliberately NOT
    implemented.** The bar holds two sliders and two segmented controls that each own the
    arrow keys for their own value; the toolbar role was a promise it could not keep. The
    tab-stop count is answered by the skip link instead — 14 stops down to one, measured.
  - **The skip link is a BUTTON.** §1.3 #9 rules out a router and a hash would rewrite the
    §2.4 `start_url` for the session. Focusing the `tabIndex={-1}` panel does everything the
    anchor would.
  - **`AppShell` takes focus when it first appears**, which is the moment the start gate
    unmounts the button holding it. Gesture-driven, once per session.
  - **Bypass is the verb, and `pressed` inverts to match it.** §5.7 defines `enabled` as true
    bypass; a bypass light is lit when the effect is out of circuit. The store field keeps its
    §13.6 name and the inversion lives at the one place the two meet. An EMPTY slot reads as
    empty, never as bypassed.
  - **`accessibleName` must BEGIN with the visible label** (WCAG 2.5.3), on `Button`, `Knob`,
    `Fader` and `Toggle` alike.
  - **A §2.1 soft capability with no control to disable gets a shell notice; one with a
    control keeps the control.** `bluetooth` and `microphone` are already compliant at their
    own controls, so they get no strip — repeating in eleven modes what the owning mode says
    is not an improvement.
  - **§9.7's warning is readable, dismissible text in every mode**, never a `title`: a `title`
    is unreachable by keyboard and, on the §1.1 tablet, unreachable at all.
  - **A toast is announced by `ToastViewport` and by NOTHING else.** Eleven call sites used to
    `announce(message)` right after `pushToast(message, …)`; at `warning` tone that put the
    identical sentence in the polite AND the assertive region at once. A call site that raises
    a toast says nothing itself. `announce` direct is for a message with NO toast — the Grid's
    automation refusal and the §8.5.7 arm-for-pad-grid message are the only two left.
  - **A domain token is never suffixed onto a value with no reading.** "— pan" reads as a
    measurement in pans. Non-finite falls through to the unit-less em dash or infinity symbol.
  - **A shell notice announces what the DEVICE raises, not what is still on screen**, so a
    dismissal does not re-read the survivor.
  - **A §11.4 probe restores what it found, and a probe with no smoke caller guards nothing.**

- **(am) — the sequencer-correctness closure (§7.1.3, §7.3, §7.7, §7.8, §7.9).** The ⚑ items
  below are settled policy a new session should treat as binding, not as spec text:
  - **A song's equivalent of a loop pass is one SEGMENT** — one play of one sequence — and that
    is where §7.7 merges a take. `lastSegmentOrdinal` counts `pass × segments + index`, so a
    one-entry song with looping on still flushes at every wrap.
  - **A capture measures its LENGTH on a monotonic cursor and anchors its START to the pattern.**
    `capturePositionAt` returns both domains at once. Folding the note-on and the note-off
    separately puts them in different segments across a song entry boundary, and behind each
    other across a loop wrap; either way the subtraction goes negative and a held note collapses
    to `captureAt`'s 1-tick floor. A position past the last segment is clamped INTO it, because
    §7.9 closes open notes exactly there.
  - **The note-repeat and arp grids are enumerated in SONG ticks**, then each hit is timed at its
    own segment's tempo. A grid re-phased per segment would stutter at every entry boundary.
  - **A sequence-scope automation lane belongs to the sequence PLAYING**, not to
    `activeSequenceId`, so `effectivePoints` takes the sequence as an argument.
  - **A track lane is sampled at the ABSOLUTE SONG TICK, a sequence lane at the segment's
    sequence tick.** §7.8's two scopes first differ observably in song mode. Sequence mode is
    unchanged and samples both at the wrapped sequence tick: there the pattern IS the arrangement.
  - **A protocol-version mismatch is REPORTED and initialisation continues.** Refusing to start
    would turn a partial disagreement into a dead transport, and the §1.3 #11 guards already drop
    what a skewed build cannot read. The value is the NAME: §11.4 fails on a console error.
  - **`init.protocolVersion` is OPTIONAL — the only optional field in the request protocol.**
    Required, the guard dropped the handshake of the very build the version exists to name.
  - **Ids are colon-free, and `messages.ts` is the one place that is checked**, which is what
    lets the composite-key splits be arithmetic. A §7.8 `targetPath` is exempt: colons are its
    grammar.

- **(al) — the reachability & performance closure (§9.5, §9.6, §3.3, §4.1, §8.1).** The ⚑ items
  below are settled policy a new session should treat as binding, not as spec text:
  - **A bounce the user cannot reach has NOT been produced.** `/projects/{id}/bounces/` is OPFS:
    nothing browses it, no file manager opens it, and a `.mpcweb` export packs the project rather
    than its bounces. A control that reports success and produces nothing retrievable is worse
    than the dead control §3.4 forbids, because a dead one does not lie.
  - **There is exactly ONE `.mpcweb` packer, and it streams.** A second synchronous one beside it
    would be two pieces of code writing one format. The §9.8 factory generator drives the same
    packer with a pinned `exportedAt`, which pins both the manifest timestamp and every entry
    mtime.
  - **`project.json` and `manifest.json` are written LAST.** A caller reading samples one at a
    time only learns which it could not read as it goes, and the §9.6 completeness check compares
    the rows against the audio. Zip entry order is not part of the §9.6 layout.
  - **Each sample's buffer is TRANSFERRED and each output chunk becomes a `Blob` at once.**
    Without the transfer the clone copies the audio; without the per-chunk `Blob` the finished
    archive is back on the JS heap. Only ONE zip entry is open at a time.
  - **The transient overlay is the live value; the store is the committed one.** A relative §10.3
    encoder steps from where the parameter is NOW, which is why the channel has memory.
  - **A commit SETTLES first and PUBLISHES explicitly.** It settles before anything that can
    fail, because an address that stops resolving would otherwise leave the overlay answering
    forever; it publishes because the committed value need not be where the gesture left off
    (XYFX's release-return commits where the axes RESTED) and the store never moved, so a §4.3
    diff sees nothing.
  - **A voice built mid-gesture reads the LIVE program.** `applyParam` can only move a voice that
    exists, and `programParamChange` maps neither `amp.attack` nor `amp.release` at all.
  - **§10.3's "UI reacts concurrently" is kept by REF, not by re-render** — the `livePath` prop.
  - **The Grid zoom readout is painted by ref; only the buttons' `disabled` flags use React**,
    and there is deliberately no re-sync effect after each render.
  - **Confirm what destroys a container whose contents are not on screen; do not confirm what
    destroys the row the button sits on.** A §8.5.4 sample edit is not destructive in the §8.1
    sense at all, because it renders a new file and swaps a pointer.

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
- **Pipe the smoke to a FILE, never through `tail`.** `npm run test:e2e | tail -80` buffers the
  whole run, so a five-minute smoke shows nothing at all until it ends and looks hung throughout.
- **`react-hooks/refs` forbids reading `ref.current` during render.** For an object that must be
  created once and READ during render — the Grid's viewport store — use `useState(factory)` and
  never call the setter; a `useRef` with a lazy `??=` trips the rule.
- **`react-hooks/set-state-in-effect` also fires on a synchronous `setState` in an effect BODY.**
  Initialise from a lazy `useState` initialiser instead and let the subscription callback be the
  only setter. It does NOT trace across a module boundary, which is why `useAnnounce` may call
  `announce` (and so a `setState` inside `LiveRegion`) from an effect without tripping it.
- **A JSX comment cannot be the sole child of `{cond && (…)}`.** Put it above the conditional;
  inside it, the parser reports an unrelated "`)` expected" at the line after.
- **Driving the tab order in a browser needs `document.body.tabIndex = -1` first.** `body` is not
  focusable by default, so blurring alone leaves the caret where it was and Tab resumes from the
  middle of the page — which reads as "the skip link is not the first stop" when it is.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–8, the §9.8 factory chain, the §14 (ag) assignment seam, the (ah)
automation seam, the (ai) voice-source/scheduler/tempo seams, the (ak) guard layer and the (al)
transient channel still stand. New this work:

**The announcer (spec §8.2):**

- **`src/ui/primitives/LiveRegion.tsx` holds the ONLY `aria-live` nodes in the application
  tree**, and there are exactly two of them. A component that needs to say something imports
  `useAnnounce` (or `announce` for non-React code) — it does not grow a `role="status"`, a
  `role="alert"` or an `aria-live` of its own. Three tests assert that negative directly, on
  `AppShell`, on `StoragePanel` and on every `Toast` tone, and a fourth asserts the running
  application holds exactly two.
- **`ToastViewport` is where a toast is announced**, once per notice id, on the channel its
  severity chooses. `pushToast` refreshes a repeated notice in place rather than queueing a
  second copy, which is what makes "once" mean once for an autosave failing every tick.
- **`announce(message, urgency)` defaults to polite.** Interrupting is for what the user must
  act on now — a failure, a refusal, a warning — never for confirming that something worked.

**Human units (spec §8.2, §7.8):**

- **`formatValueText` is still the one place a value becomes `aria-valuetext`**, and it now
  knows four domain tokens beside its units. A new parameter gets a token there, not a
  `formatValue` callback at its call site.
- **`effectParams.ts` owns a §5.7 parameter's label and unit beside its range.** Reach them
  through `effectParamLabel` / `effectParamUnit`; the tables themselves are module-private, and
  `effectParams.test.ts` fails if a ranged parameter has no label or no known unit.
- **`targetUnit` / `resolveTargetUnit` answer for a §7.8 ADDRESS**, which is what a picker and
  an XY axis hold. Add a new registry leaf to both the range table and the unit table.
- **`Fader` has a horizontal variant.** An inline continuous setting uses it rather than a
  native `<input type="range">`, which §1.3 #10 forbids and which shares none of the §8.2
  keyboard contract.

**The shell (spec §8.1, §8.2, §2.1):**

- **`src/ui/shell/PlatformNotices.tsx` is where a condition the DEVICE imposes is told to the
  user**, in all 12 modes. It reads `useUIStore.capabilities` and `useUIStore.storagePersisted`
  and renders `SOFT_CAPABILITY_NOTICES`. A new always-true-of-the-device warning goes here; a
  warning about something the user just did is a toast.
- **`useUIStore.storagePersisted` is the §9.7 grant.** `StorageGauge` asks and publishes;
  everything else reads. The surface that must SHOW it is not the surface that ASKS for it.
- **The skip link and the mode-panel focus move both live in `AppShell`**, because the panel is
  what they target and the shell is what mounts once per session.

**Song mode and capture (spec §7.7, §7.9):**

- **`emitSongPass` is where song mode does everything sequence mode does.** Note repeat, the
  arpeggiator, automation and live erase all run from it or from the slice loop inside it. A new
  schedule-time feature is added to BOTH `scheduleSequence` and `emitSongPass`, or it is silently
  sequence-only — which is the whole of issue #94.
- **`capturePositionAt` is the only place a capture position is computed**, and it returns
  `{ patternTick, monotonicTick }` because a captured note needs both: the start belongs in the
  pattern (`midi_events.tick_start`, §9.3) and the length belongs on a cursor that only moves
  forward. `positionTickAt` still answers where the PLAYHEAD is, which in song mode is genuinely
  a song tick — the two are separate functions rather than one with a flag.
- **`emitSongHit` places a live-generated hit on the song timeline.** Both note repeat and the
  arpeggiator go through it, so neither can drift from the other on swing, tempo or tick domain.
- **`reportErased` applies a sweep AFTER the read that found it**, never during: it replaces
  `track.events`. It is the SHARED half of live erase; each mode selects its own ids, because
  the two windows are in different domains.
- **`buildSongMap` is the only expansion of the §7.9 playlist.** The scheduler and the §9.5 song
  bounce both call it, so `repeats`, the position sort, the skipped-entry index and the
  `MAX_SONG_SEGMENTS` bound cannot mean two things. A new consumer of the playlist calls it too.
- **`useTransportStore.songEntryIndex` is the one consumer of `songAdvanced`.** `AudioEngine`
  writes it and §8.5.12's playlist reads it; the setter owns the three rules that keep it honest
  (cleared on stop, cleared on leaving song mode, ignored while stopped).

**The worker boundary (spec §7.1.3, §1.3 #11):**

- **`schedulerIdSchema` in `messages.ts` is where the colon-free id invariant is checked.** Every
  id field crossing into the worker takes it. Nothing downstream restates the assumption.
- **`parseAutomationLaneKey` is the only place a lane key is split**, beside the
  `automationLaneKey` that builds it. It replaced four open-coded copies, one of which cast the
  scope to its union without checking it.
- **`automationRampForWindow` is the only implementation of the §7.8 emission rule**, and its
  value tick is passed separately from its two times because the two are in different domains
  wherever the transport wraps. Do not add a second.
- **A guard field takes the range the store clamps to.** `ranged(BPM_RANGE)` / `ranged(SWING_RANGE)`
  rather than a bare `z.number()`: the guard IS the worker's validation contract, so it may not be
  the looser of the two.
- **`AudioEngine.watchScheduledEvents` is how a browser proof reads the worker's output.** The
  scheduled batch is its only observable output and nothing downstream distinguishes a note from
  a click from a ramp. Empty in production.

**The transient channel (spec §4.1, §3.3):**

- **`src/store/transientChannel.ts` is the ONLY route a continuous gesture takes.** Neither
  `setTransient` nor `setPadParamTransient` calls `set()` any more, because that replaces the
  containing map's identity and re-renders every component selecting it. A new continuous
  control publishes here; it does not write a store.
- **It is a channel WITH MEMORY.** `readTransientValue` answers "where is this parameter now",
  which the store cannot while a gesture is in flight. `anyTransientInFlight()` is the cheap
  guard for a per-note lookup.
- **`commit` settles FIRST and publishes EXPLICITLY.** Both orders matter and both are recorded
  above. A new store action with a transient/commit pair copies that shape.
- **Addresses are canonical §7.8 registry paths.** `useMixerStore.canonicalPathOf` rewrites the
  two legacy forms without needing the strip, which is what lets a commit settle an insert
  address whose slot effect has changed underneath it.
- **`programWithLiveGestures` is what a VOICE BUILDER reads.** The graph bridge moves nodes that
  exist; a voice not yet built has to be given the live value. The §9.5 bounce deliberately does
  not call it — a render is of committed state.
- **`livePath` is how a control shows a gesture it is not driving** (spec §10.3). It paints by
  ref inside `useContinuousControl`; a `Knob` or `Fader` bound to a §7.8 address should pass it.

**Reaching the user (spec §9.5, §9.6, §8.1):**

- **`core/platform/download.ts` is the only way anything BangerBox writes leaves the browser.**
  Every other store the app has is origin-private. A new export path calls `downloadBlob`, and
  `downloadFileStem` is the one reduction of a free-text project name to a filename.
- **`createMpcwebPacker` is the only packer.** Streaming, one entry open at a time, snapshot
  written last, and reconciling the snapshot's sample rows down to what was actually added.
- **`ConfirmDialog` carries the rule for what needs a confirmation**, in prose, in one place.
  Read it before adding a destructive action.
- **`FilePickerButton` separates `busy` from `disabled`**: the first is what THIS control is
  doing, and so its label; the second is every other reason it cannot start. A shared flag in
  both slots is what made a bounce relabel the import pickers "Importing…".

**The Grid viewport (spec §3.3, §8.4):**

- **`src/features/grid/gridViewport.ts` holds scroll and zoom outside React.** The canvas's rAF
  loop and its pointer handlers read `viewport.get()`; nothing re-renders when it moves. The
  clamps are pure functions there, testable without a canvas.
- **The store compares fields before notifying**, because a wheel held against an edge produces
  a stream of updates that change nothing.
- **`GridZoomControls` is the only React-visible consumer**, and it paints the readout by ref.

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

**No repository method was added or changed this work.** `exportMpcweb` reads the same rows; it
simply reads each sample's bytes one at a time and hands them over rather than gathering them.

From the data-integrity work: `dumpSnapshot` reads `samples.listGlobal` as well as `listByProject`, so a §9.6 export carries
the §9.8 global-library audio its programs reference. No repository method was added.

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1**. **No migration added.**

**No DDL column, §9.3 payload field or §6 payload shape changed this work.**

From the data-integrity work: `projects.bpm_default` is WRITTEN as well as read (issue #93). The column has always existed
with a default of 120, so a project saved before this loads unchanged and needs no migration.

The §9.3 `projects.payload` gained three optional fields — `grooveTemplates`, `trackGrooveIds` and
`songLoopEnabled`. All three are `.optional()`, so a project written before them loads with §7.9's
own defaults and needs no migration.

## 7. Worker / worklet / message protocol versions

`SCHEDULER_PROTOCOL_VERSION` is **2** as of the entry-index work (issue #130). `songSequence` now
carries `orderedEntries` — the §7.9 playlist in `position` order, each `{ sequenceId, repeats }` —
instead of a repeat-expanded `orderedSequenceIds`. That is the FIRST change to an existing kind's
shape rather than an addition, and so the first thing the version has ever had to name: an older
peer's message no longer parses, and without the bump the only symptom would be the §1.3 #11 guard
dropping it in silence. `SchedulerSongEntry` is exported from the sequencer barrel. No request or
response KIND was added.

From the previous work, and otherwise unchanged: the version is no longer inert (issue #96): the `init` request
carries it and `applySchedulerRequest` compares it with the worker's own copy, reporting a
mismatch — or a handshake with no version at all — through `console.error`, which §11.4 fails the
smoke on. Adding a request or response kind still does not bump it (the extend-by-adding-kinds
rule); changing one's shape does. **`init.protocolVersion` is the one OPTIONAL field in the request
union**, so a skewed peer's handshake reaches the report instead of being dropped by the guard.

From the previous work, and unchanged: the **pack worker's** protocol changed completely:
the single `pack` request is replaced by a session — `packBegin` / `packSample` / `packEnd` /
`packAbort`, each carrying a `session` id beside the `id` that correlates its reply, plus a
`packChunk` response that belongs to a session rather than to any request (issue #99). `unpack`
is unchanged. `packMpcwebInWorker` is gone; `beginMpcwebPack` replaces it and returns a `Blob`.

From the previous work, and unchanged: nothing was added to the §7.1.3 protocol — no request kind, no response kind, no `ScheduledEvent` field. Two
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

**`useTransportStore.songEntryIndex` is new this work** (§4.2 permits adding fields with a
changelog entry; none removed), with `setSongEntryIndex`. It is the §7.9 playlist entry song mode
is playing — the index into the POSITION-SORTED entry list, `null` when the song is not rolling.
`AudioEngine`'s `onSongAdvanced` writes it and §8.5.12's `SongMode` reads it. It persists nowhere:
it is playback position, not arrangement. It changes at most once per sequence pass, so it is
ordinary React state rather than a §3.3 high-frequency value.

From the previous work, and unchanged: **`useUIStore.storagePersisted`** (§4.2 permits adding fields
with a changelog entry; none removed), with `setStoragePersisted`. It is the §9.7 persistence grant — `true`,
`false`, or `null` before the first-run request has answered. `StorageGauge` writes it and
`PlatformNotices`, `StoragePanel` and the §11.4 probe read it. Nothing persists it: it is a
property of the browser, re-asked every session.

From the previous work, and unchanged: **no store SLICE changed, but two store actions changed
what they do** (issue #27):
`useMixerStore.setTransient` and `useProgramStore.setPadParamTransient` no longer call `set()`.
They publish on the §4.1 transient channel, and the store holds the pre-gesture value until the
commit. Anything that read a store mid-gesture reads `readTransientValue` first — the §10.3
relative-encoder step and `programWithLiveGestures` are the two that had to.

New modules beside the slices:

- **`src/store/transientChannel.ts`** — `publishTransient`, `settleTransient`, `readTransientValue`,
  `anyTransientInFlight`, `subscribeTransientChannel`, `subscribeTransientPath` and
  `resetTransientChannel` (called by `stopProjectSession`).
- **`src/store/syncLayer/transientSync.ts`** — the one subscriber, registered by
  `registerSyncSubscribers`. It applies every value through `bridge.applyParam`.
- **`useProgramStore.programWithLiveGestures`** — the live program a voice builder reads.

From the correctness-hardening work: `store/tempo.ts` is still the one place a tempo edit enters the
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

**Mode changes this work:** §8.5.12's `SongMode` renders its playlist in `position` order — the
projection §7.9 numbers its entries against — and marks the entry that is playing, with an
`sr-only` "(playing)" beside the name and `aria-current` on the row. `removeEntry` and `moveEntry`
take the same sorted projection. No primitive changed and no shell component was added.

From the previous work, and unchanged — **one shell component**: `PlatformNotices`, a dismissible strip between the
transport bar and the mode content, rendering the §2.1 soft-capability notices and the §9.7
eviction warning. It renders nothing at all when the device can do everything, which on the
§1.3 #15 baseline is every session where persistence was granted.

**Primitive changes this work:** `LiveRegion` renders two regions (polite + assertive) and
exports `useAnnounce`; `Toast` carries no `role`; `Knob`, `Fader` and `Toggle` take an optional
`accessibleName` (which must BEGIN with the visible label — WCAG 2.5.3); `Fader` takes
`orientation`, `quantise` and `showValue`.

**Shell changes this work:** `AppShell` renders the skip link and focuses the mode panel once on
mount, and no longer mounts `LiveRegion` (`App` does); `TransportBar` is a `group` rather than a
`toolbar` and its unsaved-dot text is no longer live; `StorageGauge` publishes the §9.7 grant to
the store and its `title` carries usage alone.

**Mode changes this work:** `InsertPanel` names every control in a slot after the slot and its
effect, names the `<li>`, and its bypass toggle inverts; `MixerMode`, `XyfxMode`, `GridMode` and
`SampleEditPanel` pass units; the last two replaced their native ranges with a horizontal
`Fader`; `StoragePanel` lost its eviction warning to the shell.

**From earlier work, and unchanged — two primitives** (spec §2.5): `FilePickerButton` (a file
picker on the shared button chassis, which a `<label>` could not have) and `ConfirmDialog` (which
also carries the §8.1 rule for what earns a confirmation). `Button` exports `buttonChassis` so the
picker shares it rather than copying it; `ValueReadout` takes an optional `valueRef`; `Knob` and
`Fader` take an optional `livePath`.

Mode changes:

- **Mixer → track strip:** a **Bounce stem** action (spec §9.5). Only track strips carry it.
- **Browser → toolbar:** **Resample to pad…** beside Bounce sequence, and the two `<label>` file
  inputs are `FilePickerButton`s. Every control names the operation actually running.
- **Program Edit:** **Delete program…** and **Clear pad…** open a `ConfirmDialog` that counts what
  goes; removing a layer or a route raises a toast naming Undo instead.
- **Grid → header:** `GridZoomControls`, a leaf that subscribes to the ref-held viewport.
- **Looper:** every transport control is held from the moment a take stops until it is written.
- **Main → Master fader:** takes `livePath`, so a §10.3 turn moves it as it happens.

From the correctness-hardening work: One primitive helper did: `formatValueText` reads a NaN as an
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

**No kernel changed this work.** The §5.6.4 set is complete and unchanged in membership. Every wrapper now guards its parameters
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

**#130 is CLOSED by this work, and #16 was already closed** by the 2026-07-18 `collectErase` fix —
the neighbour list below had gone stale and said otherwise. Nothing was added to the
`check:orphans` allowlist.

**Nearest neighbours now, in rough order of how much they cost a musician:**

- **#132** sequence mode plays EVERY sequence at once, and a live erase deletes the held pad from
  all of them. `scheduleSequence` iterates `this.tracks` with no `sequenceId` filter where
  `emitSongPass` has one, and `sequencerSync` forwards an `eventsDiff` for every track in the
  project. Filed while pinning #16's "and nothing else" half; reproduced against the real core.
  Both halves are wrong — a sequence that is not playing sounds, and its notes are erased.
- **#131** a new insert displays and announces its RANGE FLOOR while the graph runs the §5.7
  defaults — `addInsert`/`replaceInsert` write `params: {}` and `createInsert` merges
  `defaultEffectParams` over it, so a fresh delay sounds at 350 ms and reads as 1 ms. A §3.4
  store-to-graph disagreement; filed while closing #35, where the missing unit made it legible.
- **#13** the Phase 8 live-hardware sign-off, which needs the human developer.

**Honest scope notes for the entry-index work:**

- **Live erase applies to the LOOKAHEAD window**, so the erased region sits up to `LOOKAHEAD_MS`
  later than the region the user swept. That is inherent to a lookahead scheduler — the notes
  under the playhead are already scheduled — and at 100 ms it is a twentieth of a bar at 120 bpm.
  Nothing is done about it and nothing should be.
- **A held erase commits one "Delete notes" undo entry per scheduler wake.** `removeEvents` takes
  a `coalesceKey` and `AudioEngine`'s `onErased` passes none, so a sweep across a bar can spend a
  good part of the §4.5 100-entry history. Observed here, out of scope, not fixed.
- **`songEntrySchema`'s `repeats` floor moved from 1 to 0**, which is §7.9's own. Nothing parsed
  it at runtime, so the change is inert for the store and load-bearing for the §7.1.3 guard.
- **`MAX_SONG_SEGMENTS` truncates and warns rather than refusing.** A `console.warn` does not fail
  the §11.4 smoke, which fails on console errors; the bound is on memory, and the anomaly is
  visible rather than gated.
- **Issue #16 needed no code.** The `collectErase` fix landed on 2026-07-18 and was verified here
  by reverting it, which fails the shipped wrap test. What was missing was the multi-pass rule,
  the song-wrap test and a real-browser measurement.
- **Every regression test was proven against the unfixed code**: 3 of 4 entry-index assertions and
  the sync-layer assertion fail against the repeat-expanding sender, 3 of 7 playlist assertions
  fail against a raw-array index and 3 more against the three review fixes reverted, and both new
  erase tests fail against the code they were written to catch.
- **Measured in a real browser**: 10/10 driver checks at ports 5342–5344 and 63/63 smoke steps, no
  console errors. A sweep held across the bar line of a 3840-tick loop took ticks 3600 and 0 and
  left 960, 1920 and 2880; against the reverted `collectErase` it took the complement and left
  only tick 0. A two-entry song of three plays reported entry indices [0, 1] and Song mode marked
  row 0 while that entry was on its SECOND play; against the repeat-expanding sender the same song
  reported [0, 1, 2] and marked row 1, a whole entry early. Two smoke steps are new and permanent.

**Honest scope notes for the accessibility work:**

- **A new insert still announces its range floor.** Issue #131 above; observed here and not
  fixed, because the wrong NUMBER has a different cause from the missing UNIT.
- **`wakeLock` is the only §2.1 soft capability given a shell strip rather than a disabled
  control**, because it has no control to disable. A browser meeting the §1.3 #15 baseline never
  sees it, so the copy is unexercised in practice.
- **Notice dismissal is session-scoped**, exactly as `StoragePanel`'s warning was. §9.7 asks for
  persistent-until-dismissed, not remembered across loads.
- **Issue #51's "microphone has zero consumers" was stale.** `LooperPanel` already reads the
  capability, disables the Mic source and says why, with tests. The dead thing was the labelling
  table, and it is now deleted.
- **The roving tabindex was considered and rejected**, not deferred. It would take the arrow keys
  from the two sliders and two segmented controls that need them, to satisfy a role the bar never
  needed. `role="toolbar"` now appears nowhere in the codebase.
- **Every regression test was proven against the unfixed code**: 13 mutations, 29 failing
  assertions, none of the 13 unnoticed.
- **Measured in a real browser**: 27/27 driver checks at port 5342 and 59/59 smoke steps at
  5343/5344, no console errors. Two of those steps are new and permanent: the announcer's two
  channels under real toasts, and the §9.7 warning's text, its Dismiss name and its place in the
  tab order. The announcer existed while the start gate was up; the running
  application held exactly two live regions with three toasts on screen; the skip link was the
  first tab stop and reached the panel in one press where the bar is 14 stops deep; focus was
  already on the panel when the shell appeared; the Tempo knob stepped 120 → 121 on an arrow key;
  pan read "Centre", a send "0 %" and the fader "0.0 dB" on one strip; ten insert knobs announced
  ten units and none a bare number or a registry key; both XY axes read "0.0 dB" and "Centre"; no
  `input[type=range]` survived; six bypass toggles carried six distinct names with the four empty
  slots unpressed; and a refused persistence grant raised a readable, dismissible warning whose
  button is in the tab order.

**Honest scope notes from the sequencer work:**

- **A held note's recorded duration is now its REAL length, in both modes.** Measuring the span
  before folding it fixed song mode's entry boundary and, with it, the same latent defect in
  sequence mode, where a note held across a loop wrap used to be recorded a tick long. No cap is
  imposed on the result: §7.7 states none, and choosing one would be inventing a rule. A note
  held for several passes therefore records longer than its own pattern.
- **A protocol skew is only ever REPORTED.** Nothing refuses to run on one, and nothing surfaces
  it to the user — it is a console error the §11.4 smoke fails on. The two halves come from one
  Vite build, so it is a tripwire rather than a live risk.
- **Song mode's live erase and note repeat were verified with the transport rolling, not the
  entry index.** `songAdvanced`'s own numbering is issue #130 and is untouched.
- **Issue #87 needed no code.** §14 (v)/(w)/(x) had already integrated the whole detune contour;
  what was missing was a real-browser measurement, which `declickContourProof` now supplies.

**Honest scope notes from the reachability work:**

- **A §10.3 turn moves an on-screen control only where the call site passes `livePath`.** The five
  Mixer controls and Main's master fader do; Program Edit's plain number fields do not, and update
  at the commit as they always did.
- **`audioBridge.resyncAll` reads COMMITTED state**, so an engine restart mid-gesture would land
  the graph on the pre-gesture value. Nothing in the app restarts the engine mid-gesture.
- **The import side still materialises each `.mpcweb` entry before validating it.** It is bounded
  by the §2.6 budget (issue #26) but not streamed into the database, so a large import still peaks
  at roughly the archive's uncompressed size. Only the export side was made streaming.
- **A Grid mode unmount resets the viewport**, exactly as the `useState` viewport did before it.
  The store is created per mount.
- **Measured in a real browser** for the sequencer work: 21/21 driver checks at port 5350 and
  55/55 smoke steps at 5342/5343, no console errors. Song mode emitted 114 automation ramps
  climbing 0.05 → 0.44 across a three-entry song where the unfixed build emitted none; live erase
  removed all four notes it swept; a take played into the middle entry was merged into the track
  while the transport was still rolling, at tick 961 of a 3840-tick pattern where the unfixed
  build wrote 4800 at the stop; one pad held on two tracks produced 6 repeats on each at their own
  velocities where the unfixed build produced 12 on the first; the arpeggiator kept [60, 64] on
  one track and [72, 76] on the other; the handshake carried version 1, the guard refused four
  out-of-contract messages and still admitted a versionless handshake; and a voice swept an octave
  down sounded 0.4552 s against a flat 0.2995 s, ending on 0.00102 rather than a step.
- **Measured in a real browser** for the reachability work: 15 driver checks and 55/55 smoke steps
  at ports 5342/5343/5344, no console errors. Sixty transient samples woke 0 store subscribers and the
  commit woke exactly 1, while the master peak followed the fader 0.4018 → 0.0024 → 0.4018; a
  60-sample pointer drag on a real Mixer fader held a 4.17 ms median frame; 120 wheel events over
  the Grid canvas zoomed 1.00× → 2.31× at a 4.16 ms median (16.7 ms is the §11.5 60 fps budget);
  all four §9.5 bounces read back over real OPFS and three of them downloaded by name
  (`First-Project-bounce.wav`, `-song.wav`, `-Track-1.wav`); and both confirmations counted their
  contents and refused to act on the first tap.

**Honest scope notes from the correctness-hardening work:**

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

`npm run type-check` · `lint` · `test` (**1831**) · `format:check` · `verify` (**no open stubs**)
· `test:e2e` (dev + offline, **63/63 steps**, ports overridden per #105) · `build` ·
`build:wasm` · `build:factory`.
