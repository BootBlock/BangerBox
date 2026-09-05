# BangerBox — Phase Handover (after the per-voice lane closure)

Generated at the close of the §7.8 per-voice lane work per Protocol Alpha (spec §13.1). A new
session MUST read `docs/todo/_spec.md` in full **and** this document before writing any code, and
MUST reuse the patterns recorded here rather than inventing parallel ones.

**State:** the per-voice lane work merged to `main` (`--no-ff`). All eight §12 phases were
already complete; this was a defect closure against §6/§7.8/§9.5/§10.2, not a new phase, so
`package.json` `config.phase` remains **"8"**. Suite: **1983 unit tests**, `test:e2e`
real-browser smoke (dev + offline, **80/80 steps**), plus `lint`, `type-check`, `format:check`
and `verify` (**no open stubs**).

**A §7.8 per-voice leaf names a §6 field of the PAD, and a lane REPLACES the patch's static
value.** `program:<id>.pad:<idx>.filter.cutoff`, `…filter.resonance` and `…pitch` were written
onto each SOUNDING voice, which reaches only the voices that exist at the moment of the write —
so a note struck between two automation windows was built from the §6 payload, and a §9.5
render, which builds every voice before it applies any ramp, was given no voice pool at all.
Each of the three now rides a `ConstantSourceNode` the whole pad shares and every voice is
built against. The §6 contour keeps modulating around it. See §2 (aw) and §4.

**The reason issue #138 gave was not the reason.** It said the write would land on the param the
voice's own §6 contour occupies, which §14 (x) forbids; that was true of none of the three. The
filter envelope and the cutoff LFO are on `filter.detune` while the write was on
`filter.frequency`, nothing in §6 modulates `filter.Q`, and (x) had already moved the pitch
write onto the voice's own bend node. The obstacle was always the SET of voices a write reaches.

**A §10.2 bend and a §7.8 pitch lane are separate nodes, so they SUM.** §10.2 used to say one
offset per voice was shared by the two and the later superseded the other; bending an automated
pitch now bends the automated pitch, exactly as bending mid-envelope bends the envelope. The
declick model carries the two on ONE additive track, because the graph sums them onto one param.

**A pad's tune and a LAYER's tune are different quantities.** §6 stores `tuneSemitones` per
layer and §8.5.5 sets them independently, while the §7.8 leaf names one value for the pad —
`padTuneSemitones(pad)` is the one place that says which layer is the pad's, and each layer's
DIFFERENCE from it stays with the voice.

**A §4.2 channel id NAMES a strip; the §5.2 graph REALISES it, once per track.** A pad channel
was keyed `pad:<programId>:<padIndex>` with no track in the id, and `ensurePadChannel` wired it
to the input of whichever track triggered it first — so two tracks playing one program shared a
node and the second track's fader, pan, mute, solo, sends and inserts were bypassed for every pad
the two shared. §5.2 stage 5 forces one signal PATH per track; §6 forces one set of VALUES per
program. Both are binding, so the two were never the same question: one §6 `Pad` record, one §4.2
strip, one §7.8 address, N realisations. `MixerGraph.channelsFor` replaces `getChannel`, returns
0..N, and every §4.2 and §7.8 writer iterates it. See §2 (av) and §4.

**No §7.8 address, §6 payload shape or §8.5.6 control changed, and §8.5.6 needs no track
selector.** A lane saved against `mixer.pad:<prog>:<idx>.level` means exactly what it always
meant; what changed is that it now reaches every track playing the program rather than the first
one to trigger it. The Pads tab still shows one strip per assigned pad of the active program,
because there is still exactly one set of values per pad — a selector would assert per-track pad
values that §6 has nowhere to store.

**EVERY lazily built channel is SEEDED, through `AudioBridge.seedChannel`.** A track channel is
built on the track's first note and a pad realisation on the first hit that needs it — both long
after `startAudioEngine`'s single `resyncAll`, and `mixerSync` pushes only what CHANGED. Without
it a project loaded with a track fader at 0.3 played that track at unity until the user moved it,
and `ResolvedVoice` carries a pad's `mixer` but not its `inserts`, so it is also the only way an
insert rack reaches a channel built after the edit that put it there.

**The insert chain is wired on a MICROTASK, and that is a §11.5 requirement.** `seedChannel` runs
on §7.6's audition path (`triggerLiveNote` → `soundResolvedVoice` → the pool, `when` = now), and
`createInsert('reverb')` synthesises its impulse response on the main thread. Building it before
`voicePool.trigger` would spend the whole 30 ms touch-to-sound budget on the first hit of a pad
that carries one.

**A channel holds `globalInsertLimit` insert slots (clamped to 1–8 as the settings enter the
store), and no effect may occupy a position past them.** §1.3.1 gives every channel 4, "configurable 1–8", and `addInsert` appended without
consulting it — so the FIRST effect a user added landed on slot 5 of a four-slot rack and the
fifth on slot 9, where the §7.8 grammar stops parsing and the panel's own knobs, every
automation lane and every §10.3 binding go dead while the effect sounds. `addInsert` now FILLS
the rack's first free slot; `replaceInsert` refuses a position at or past the limit; both
return an `InsertSlotResult` carrying a finished sentence. See §2 (au) and §4.

**A chain already OVER the limit is admitted whole and nothing is repaired.** A §9.6 import, a
§9.8 pack or a project saved before this keeps every slot and every effect sounds. Refusing
would make a project unopenable over an insert slot; truncating would delete an effect the
user made. That is §14 (ap)'s "the stored value always wins", one level up.

**`globalInsertLimit` is CONFIGURABLE for the first time.** `setGlobalInsertLimit` had no call
site outside a unit test, so the §9.3 `projects.insert_limit` column was inert on both sides.
Enforcing it makes it BIND, so §8.5.1's Project panel gained an **Insert slots** select beside
Sample rate and Bit depth.

**A deleted track takes its own pad realisations with it** (§3.2). They are connected to the
input node `removeTrackChannel` destroys, so leaving them would be an orphan on a dead branch
whose sends still feed the returns — and the shared form of that was #141's second symptom:
deleting one track silenced the other.

**A track that leaves the project is WITHDRAWN from the §7.1.3 worker by name.** The worker holds
every track on purpose (§14 (aq)), so nothing in its own state can tell it one has been deleted —
and `subscribeSequencerSync`'s events subscriber never handled a removed key, so `removeTrack`
told it nothing and it kept scheduling the track's notes for the rest of the session. The
withdrawal is a new §7.1.3 request KIND, `removeTrack { trackId }`, and the subscriber watches
`tracks` rather than `events`. See §2 (at), §4 and §7.

**A track OWNS its §7.8 track-scope automation lanes and its §7.5 groove assignment, and the
§9.3 `tracks` row cascades to neither.** `automation_points` declares no foreign key at all and
the assignment lives in `projects.payload`, so `useSequenceStore.removeTrack` takes both. A lane
left behind is not merely orphan data: `laneForTarget` lets a track lane override a sequence lane
on the same §7.8 address whatever track owns it.

**A pad's §4.2 channel strip is a PROJECTION of its §6 pad, maintained in both directions by
`src/store/derive/padStripMirror.ts`.** It publishes the active drum program's pads as strips —
without which §8.5.6's Pads tab was inert on every freshly loaded project, because
`useMixerStore.commit` returns before writing when no strip exists — and it writes an edited
strip back into the §6 payload, without which `flushProgram` saved the pad unchanged. It is
store → store and so deliberately outside `syncLayer/`, beside `transportMirror`; the publish
half MOVED there out of `syncLayer/programSync`, and `padStrips.ts` moved with it to
`src/store/padStrips.ts`. See §2 (as) and §4.

**Only the fields a side actually CHANGED are written back.** `program:<id>.pad:<idx>.amp` and
`mixer.pad:<id>:<idx>.level` are two registered §7.8 addresses for one value; copying whole
strips would carry a stale one back over the other and turn a display disagreement into data
loss. That remaining disagreement is issue #140.

**Every §9.5 bounce renders the §5.2 mixer**, because the offline graph IS the live one:
`MixerGraph`, `createAudioBridge` and `VoicePool` all take a `BaseAudioContext`, so a render
constructs the same ten-stage hierarchy rather than describing it a second time. That is the half
of the decision a new session is most likely to get wrong — see §2 (ar) and §4. `bouncePlan.ts`
owns which stages each variant carries, and the static pass and the §7.8 automation pass read the
one predicate.

**`rampParamLinear` anchors on `cancelAndHoldAtTime`, not on `param.value`.** A ramp scheduled
ahead of the playhead was anchored on a clock read up to `LOOKAHEAD_MS` old; offline, where nothing
renders until `startRendering()`, every window would have read the same value. This changed LIVE
behaviour as well as offline, deliberately.

**A §7.8 `slotN` address is 1-based over the §4.2 slot array, on BOTH sides of the graph.** The
insert chain used to be compacted and indexed 0-based, so an address reached the wrong effect or
none. `ChannelHandle.setInserts` now takes one entry per slot, `null` where empty.

**No §9.2 migration was added and `PRAGMA user_version` is unchanged.** A pad's mixer values
have always lived in the §6 payload the §9.3 `programs.payload` column holds, and the strip
existed only in memory — so nothing on disk is in a shape to correct. The payload is the SOURCE
the strip is derived from, and §4.4 hydration, a §9.6 import and a §9.8 pack all already reach
it. Before this, the §9.5 render's own values were not persisted at all.

**`SCHEDULER_PROTOCOL_VERSION` is 2** (§7.1.3), unchanged by this work. It was bumped by the
entry-index work because `songSequence` carries §7.9 entries rather than a repeat-expanded id
list, which changes an existing kind's shape rather than adding one. See §2 (ao) and §7.

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

- **(aw) — the per-voice lane closure (§6, §7.8, §9.5, §10.2).** The ⚑ items below are
  settled policy a new session should treat as binding, not as spec text:
  - **A §7.8 per-voice leaf is a PAD value, and a lane REPLACES the patch's static value.**
    `writePadLeaf` writes the §6 field, `programWithLiveGestures` builds a voice from it, the
    Grid draws it against the field's own range: a lane at 5 kHz means the pad's cutoff is
    5 kHz, and the §6 contour keeps modulating around it. The OFFSET reading is what the code
    half-did, and it was incoherent — a pad tuned +5 st under a lane saying +7 sounded at +12.
  - ⚑ **One node per pad per leaf, and every voice is BUILT against it.** A per-voice write
    reaches only the voices that exist when it lands. The voice keeps what the leaf does not
    own: its layer fine tune and static pitch mod on `source.detune`, its own static cutoff mod
    in cents on `filter.detune` beside the §6 filter envelope and cutoff LFO.
  - ⚑ **A node is seeded from the §6 payload, and RE-SEEDED when that payload has moved since
    the last trigger.** That is the only route for an edit which does not publish — a
    keygroup's `filter`, which `changedPadLeaves` skips, and a project or §9.8 pack loaded over
    the top of the one open. A §7.8 ramp does not write the store, so it never looks like such
    a move and is never undone by the next note.
  - ⚑ **A program that leaves the store takes its lanes with it** (§3.2), through
    `SyncBridge.onProgramRemoved`. They outlive the voices that borrow them, so nothing else
    would ever free them.
  - ⚑ **A bend and a pitch lane SUM**, and §10.2 is revised to say so. A bend is a performance
    gesture layered over the programmed sound; a lane IS programmed sound.
  - ⚑ **The two amp-ENVELOPE leaves are deliberately not covered** (issue #143). An AHDSR is
    applied when a voice starts, so there is no param to sum onto; a remembered value would
    work live and not offline, because a render triggers every voice before any ramp.
  - ⚑ **A lane does not re-lay the declick of a voice that has not STARTED.** A render walks
    `SCHEDULER_INTERVAL_MS` windows across the whole span, so doing so integrates the same
    contour once per (voice × window). A §10.2 bend keeps the clamp: it is one event.

- **(av) — the shared-pad-channel closure (§4.2, §5.2, §5.3, §8.5.6, §9.5).** The ⚑ items
  below are settled policy a new session should treat as binding, not as spec text:
  - **A pad channel is realised PER TRACK; the §4.2 strip that supplies it stays per program.**
    §5.2 stage 5 says "all pad outputs of the program ON A TRACK merge into the track input",
    and a `GainNode` has one output — so no single node can serve two tracks. §6 puts a pad's
    mixer values and inserts in the `Pad` record, which belongs to the program, and the §9.3
    `tracks.mixer` column holds one `ChannelStrip` for the track itself. Neither constraint
    bends, so the answer is that the two questions are different: `MixerGraph` keys a pad
    channel by (channel id, track id), and `channelsFor` resolves the id to every realisation.
  - ⚑ **A §7.8 lane saved against `mixer.pad:<prog>:<idx>.level` means what it always meant.**
    The strip it names is still per program. Nothing on disk is in a shape to correct, no §9.2
    migration was added, and there is no §14 (ap) reconciliation to make — the lane simply
    becomes audible on every track it was already describing. Same for a §10.3 binding.
  - ⚑ **§8.5.6 needs no track selector and the Pads tab is honest without one.** There is still
    exactly one set of values per pad. A selector would assert per-track pad values that §6 has
    nowhere to store and no §7.8 address could name. The control that WAS inert is the second
    track's own strip on the Tracks tab.
  - ⚑ **Choke groups and mono retrigger stay PROGRAM-scoped.** §5.4 scopes choke "within the
    program" and `VoicePool` keys both on `padKey` = `${programId}:${padIndex}`. Two tracks on
    one mono pad still cut each other off. That is the spec's own reading, deliberately left.
  - ⚑ **The cost is stated rather than hidden.** N tracks on one program build N pad chains for
    each pad they share, each with its own insert rack, and nothing is built until a track
    actually plays the pad. §11.5 has no size budget and none is being reintroduced.
  - ⚑ **A §9.5 render inherits the fix for free**, because §14 (ar) made the offline graph the
    live one. A stem of one of two tracks on a shared program now carries only that track's
    voices; `bounceService` changed only where it passes the track id through.

- **(au) — the insert-limit closure (§1.3.1, §4.2, §5.7, §8.5.1, §8.5.6, §9.3).** The ⚑ items
  below are settled policy a new session should treat as binding, not as spec text:
  - **The §1.3.1 limit bounds a CHANNEL, not the project.** §1.3.1's own wording is "4 insert
    slots per pad, per track, and on the master". The §5.2 RETURNS are bounded by the same
    rule though §1.3.1 does not name them: they have §4.2 strips, §8.5.6 edits their inserts
    on its own tab, and `insert:return:0:slot9.mix` goes dead exactly as a track's does. One
    rule for every strip — a second would be a second thing to forget.
  - **The limit applies where a slot is CREATED, which is §14 (ap)'s own two places.**
    `addInsert` FILLS the rack's first free slot and appends only while the rack is shorter
    than the limit; `replaceInsert` refuses to OCCUPY a position at or past it. A reorder
    needs no rule: it neither creates a slot nor lengthens the array.
  - **Filling, not refusing, is what keeps Add alive.** `createDefaultChannelStrip` opens the
    rack with four EMPTY slots, so a bare refusal would have made the §8.5.6 picker dead on
    every default channel — the §3.4 failure the fix exists to prevent. A filled slot keeps
    its own id, exactly as `replaceInsert` does.
  - **The refusal is SPOKEN.** Both actions return `InsertSlotResult`
    (`{ ok: true } | { ok: false, reason }`), the `AssignResult` shape, because the store is
    the only layer that knows which rule refused. §8.5.6 toasts it AND disables the Add
    picker on a full channel and the Replace select past the limit — from the exported
    `freeInsertSlot` the store refuses by, never a restatement of it.
  - **A chain already OVER the limit is admitted WHOLE and nothing is repaired.** Refusing
    makes a project unopenable over an insert slot; truncating deletes an effect the user
    made and changes what a §9.5 bounce renders. §14 (ap)'s rule, one level up. Lowering the
    limit repairs nothing either — it bounds where the NEXT effect may go.
  - **The §7.8 grammar keeps its own bound of 1–8, deliberately.** `parseParamTarget` bounds
    `slotN` by `GLOBAL_INSERT_LIMIT_RANGE`, the configurable RANGE, not the open project's
    value: the registry is pure and dependency-free (§2.5) and may not read a store, and a
    project whose limit is later raised must read back a slot-8 address it saved.
  - **`globalInsertLimit` had no way to change and now has one.** Enforcing an inert setting
    is what made the missing control matter; §8.5.1's Project panel owns it beside the two
    other §9.3 project columns it already carried.

- **(at) — the track-withdrawal closure (§7.1.3, §7.5, §7.8, §9.3).** The ⚑ items below are
  settled policy a new session should treat as binding, not as spec text:
  - **A deleted track is withdrawn from the worker by a request kind of its own,
    `removeTrack { trackId }`.** Not an `eventsDiff` listing every id in `deletes`: that kind
    is a diff of a track's EVENTS and carries the `sequenceId` a track has, `applyEventsDiff`
    would RE-CREATE the map entry a pure-delete diff was sent to empty, and it cannot reach the
    §7.5 groove, §7.6 held notes, §7.7 open capture or armed erase — none of which is an event.
  - **`SCHEDULER_PROTOCOL_VERSION` stays at 2.** Adding a kind does not move it; changing an
    existing kind's SHAPE does (§14 (ao)). An older peer that does not know `removeTrack`
    behaves exactly as this build did before the fix.
  - **The rule is the SENDER's, and this does NOT re-open §14 (aq).** (aq) settled SELECTION —
    which of the tracks the worker holds should sound now — and the sender must still ship the
    whole project, because song mode picks a different sequence per segment. A withdrawal leaves
    nothing to select: no mode plays the track again, in any segment, so it is the one thing
    about a track the worker cannot work out for itself.
  - **The subscriber watches `tracks`, not `events`.** A track deleted before it was ever played
    never entered the events map, so a removed-key loop there finds nothing to withdraw while
    the worker may still hold that track's groove. It also closes a leak nobody had filed:
    `subscribeSequencerSync` is registered once at the §5.1 start gate and survives a project
    switch, so every track of every project opened in a session used to accumulate in the map.
  - **`SchedulerCore.removeTrack` drops EVERY map keyed by the id**, because the message means
    the track does not exist rather than that one of its values changed. A groove left behind
    would shape a later track reusing the id; a held note would keep note repeat and the
    arpeggiator firing; a capture would flush a take through `commitRecordedTake`, writing the
    deleted track's events map key straight back into the store.
  - **A track deleted while the transport ROLLS still DISPATCHES what is already in the
    §7.1.4 window, and hears nothing.** The batch has left the worker, which is the same
    window a §7.7 live erase cannot reach back into; but the store no longer holds the track,
    so `resolveNote` finds no program and `triggerFallbackDemo` refuses it.
  - **A track with no PROGRAM and a track that does not EXIST are different things**, and the
    §12 demo fallback only ever meant the first. Sounding the second played the demo sample
    and, worse, `ensureTrackChannel` rebuilt the §5.2 channel `deleteTrack` had just
    destroyed — an orphan node on the master bus for the session (§3.2).
  - **`useSequenceStore.removeTrack` takes the track's §7.8 lanes and §7.5 groove assignment**,
    in the store action rather than in `projectCrud.deleteTrack`, so `deleteSequence`'s loop and
    any later caller get the same rule. Both reach the worker on the paths they already have —
    the `automation` subscriber's cleared-key loop and the `trackGrooveIds` one.
  - **A lane is the track's if the track OWNS it or if it ADDRESSES it.** Owning is track scope
    with this id as `ownerId`; addressing is any lane, of either scope, whose target names the
    track's §4.2 channel. Both halves are needed, because `recordParamGesture` writes
    SEQUENCE-scope lanes — so a captured fader ride on a track is owned by the sequence and
    would otherwise outlive its subject for ever. The registry answers which channel a target
    names (§13.6), and each emptied lane's dirty key carries its OWN scope and owner.
  - **The revert restores exactly what the delete took**, captured at the delete rather than as
    whole maps, so an unrelated lane edited between the delete and the undo stands.
  - **The §4.2 `track:<id>` strip was already correct**, and was checked rather than assumed:
    `deleteTrack` → `commitTrackStrip(id, false)` → `mixerSync`'s removed-key loop →
    `bridge.removeChannel` → `graph.removeTrackChannel`.

- **(as) — the pad-strip closure (§4.2, §4.3, §6, §9.3).** The ⚑ items below are settled
  policy a new session should treat as binding, not as spec text:
  - **A pad's §4.2 channel strip is a PROJECTION of its §6 pad, and one module maintains it
    in both directions.** `src/store/derive/padStripMirror.ts` publishes the active drum
    program's pads as strips and writes an edited strip back into the payload. Neither half
    existed: a project just loaded had no pad strip at all, so every control on §8.5.6's Pads
    tab was inert; and `flushProgram` serialised a `useProgramStore` the edit never reached.
  - **The write-back is store → store, which is why it is NOT the §4.3 sync layer.** §4.3
    exists so that ONE place touches audio nodes in response to state, and that sentence means
    less every time a store → store subscriber is filed under it. `transportMirror` is the
    precedent and says so in as many words.
  - **The PUBLISH half moved there too, and `padStrips.ts` with it.** It was already a
    store → store write (`upsertChannel`) living in `syncLayer/programSync` for want of
    anywhere else. One module now owns both directions of one mapping, so neither can be
    forgotten when §6 or §4.2 gains a field. `subscribeProgramSync` keeps only
    `bridge.onActiveProgramChanged`, which is a genuine §4.3 hook.
  - **Only the fields a side CHANGED are written back, and that is load-bearing.**
    `program:<id>.pad:<idx>.amp` and `mixer.pad:<id>:<idx>.level` are two registered §7.8
    addresses for one value — `programParamChange` maps `amp`/`pan` to `channelLevel`/
    `channelPan` — and only the mixer side writes through. Copying whole strips would carry a
    stale level back over a program-side edit: data loss, not a stale reading. Issue #140 is
    the reading that remains.
  - **Not in `useMixerStore.commit`.** A strip reaches the store through SEVEN actions plus
    `upsertChannel` (§8.5.6's insert reorder calls it directly). Writing through from the
    commit would have covered the fader and left the insert chain — the half #133 is named
    after — and the eighth route added later is the one that gets forgotten. A subscriber on
    `channels` sees all of them, which is `mixerSync`'s own argument one layer down.
  - **Not in `flushProgram` either.** That makes the column right and leaves the two stores
    disagreeing everywhere else — a §9.5 render, `ensureProgramChannel`'s seeding, a §9.6
    export's `dumpSnapshot`. §1.3 #16 makes Zustand the runtime truth precisely so nothing
    has to reconcile it at the storage boundary.
  - **The publish is driven from the MIXER side as well as the program side, and both are
    needed.** §4.4 hydration calls `setPrograms` before `setChannels`, so a program-side
    publish alone writes into the outgoing map and `setChannels` wipes it; and `loadProject`
    on the project ALREADY OPEN re-selects the same `activeProgramId`, which a
    `subscribeWithSelector` selector does not report as a change at all.
  - **`mute` and `solo` are NOT mirrored**, because §6's `Pad.mixer` defines no field for
    them. A track's mute persists because a track strip IS the persisted object; a pad's is a
    projection of a §6 record with nowhere to put one. Adding one is a §13.6 halt.
  - **A keygroup's program-scope mixer is a DIFFERENT defect.** §6 gives it one `mixer` and
    `inserts` rather than per-pad ones, and nothing publishes or renders a strip for it — so
    its values sound and nothing can edit them. Unreachable, not unpersisted: issue #139.
  - **No §9.2 migration, because the values already live in the payload.** The strip existed
    only in memory, so nothing on disk is in a shape to correct — the §14 (ap) reasoning in
    its own form.
  - **A §9.5 render's two sources now agree.** (ar)'s "a pad channel is seeded from the §6
    payload and then overwritten by the §4.2 store" is no longer moot and no longer able to
    matter: both carry the same numbers, and a bounce after a reload renders the strip the
    user set.
  - **§5.2 solo-in-place is per GROUP: pads and tracks are separate.** A pad channel feeds
    its TRACK's input (stage 5), so a solo judged across one group mutes every pad of the
    soloed track and silences it. Pre-existing and hard to reach — no pad strip existed on a
    fresh load — and permanent strips would have made it the state of every session. §8.5.3's
    two lists and §8.5.6's two tabs are the same reading. Measured: 0.00973 RMS on the
    one-group build against 0.10244 unsoloed, and 0.10244 with the fix — identical to five
    places, because a track's own pads are not its rivals.
  - **`applyPadStripEdit` marks the program dirty ITSELF.** `commit` runs `apply()` — and so
    the mirror's write — before it marks anything, and §8.5.6's insert reorder reaches the
    store through `upsertChannel`, a bare `set` that marks nothing. Not a second rule: the key
    is the same one and the §4.4 queue coalesces by key. **The same reorder on a TRACK strip
    is still unsaved**, which is the pre-existing half.
  - **`subscribeProgramSync` and `SyncBridge.onActiveProgramChanged` are GONE.** With the
    publish moved, the subscriber's whole body called a hook that is `() => {}` in both
    bridges — a speculative export in §3.4's sense. The transport and Q-Link hooks that are
    also inert stay, because their subscribers do real work beside them; `bridge.ts` says so.

- **(ar) — the bounce-mixer closure (§5.2, §9.5, §7.8, §4.3).** The ⚑ items below are settled
  policy a new session should treat as binding, not as spec text:
  - **The offline graph is the LIVE one, built by the live factories on the offline context.**
    `MixerGraph`, `createChannelStrip`, `createInsert`, `createAudioBridge` and `VoicePool` all
    take a `BaseAudioContext`, so §9.5's "reconstructs the full graph" is satisfied by
    CONSTRUCTING it. Two builders that can disagree about §5.2 is how this defect would come
    back — the §14 (ao) one-expansion rule, a layer down.
  - **A render carries §5.2 stages 1 to 10.** `prepareWorkletEffects` is called beside
    `prepareVoiceWorklets`: a §5.7 `reverb`, `limiter` or `multibandComp` is an
    `AudioWorkletNode` and THROWS on a context that has never registered `dsp-effect`.
  - **The §5.9 monitor bus and the §5.8 meter taps are out, and neither is a mix decision.**
    §5.9 merges the click and the audition PAST the master inserts precisely so they are not
    programme material; the taps write a SAB nothing offline reads and their sinks are at zero
    gain, so omitting them changes no audio.
  - **A stem is pre-master by NOT APPLYING the master strip, never by rewiring §5.2.** The bus
    stays the unity pass-through `createChannelStrip` builds, so the topology is identical in
    every variant.
  - **The static pass and the §7.8 automation pass read ONE predicate**
    (`bounceIncludesChannel`). A stem whose fader sat at unity while a master lane rode it
    would be a stem in name only.
  - **The RETURN channels stay in a stem**, and this is the one judgement rather than a reading.
    A stem set has to sum back to what the master bus was fed; each stem carries only the return
    signal its own sends drove. Exact only for a linear return chain — a compressor on a return
    responds to the whole bus — which is true of stems in any host.
  - **Resample-to-pad renders the SAME graph as a sequence bounce, master inserts included.**
    §8.5.8's Looper taps `graph.master.meterPoint`, so resampling means one thing everywhere:
    what came out of the master bus. The in-repo precedent rule (§13.6) settles it, not taste.
  - **Mute and solo are honoured, and solo is evaluated against the WHOLE mixer** even when
    `includeChannel` narrows what is written — otherwise a stem of a soloed track silences itself.
  - **A bounce is of COMMITTED state, and that now covers the mixer as well as the §6 program.**
    A §4.1 gesture in flight is on the transient channel and is not rendered; a §10.2 bend is a
    performance gesture and is never applied. A file that cannot be reproduced from the saved
    project is worse than one a moment out of date.
  - **A §7.8 lane on a PER-VOICE §6 parameter is not applied, and the bounce's bridge is given no
    voice pool to say so.** Offline every voice of the render exists from the moment it is built,
    so "the voices sounding now" is the whole span at once, and the write would land on the param
    the voice's own contour occupies — which §14 (x) forbids. Channel-scope program addresses (a
    pad's amp and pan) resolve to the pad STRIP and do render. Filed as issue #138.
  - **A render walks each segment in `SCHEDULER_INTERVAL_MS` windows.** Rendering the authored
    curve directly would be a second implementation of §7.8's curve shapes AND a mix nobody has
    heard: the staircase is what live playback sounds like.
  - **`rampParamLinear` anchors on the TIMELINE (`cancelAndHoldAtTime`), not on the clock.**
    `param.value` reads now; `ctxTime` is routinely ahead of now. Cancelling from `ctxTime` is
    the other half: a live gesture supersedes automation already queued ahead of the playhead.
  - **The §7.1.3 `rampEnd` is deliberately NOT consumed**, and `applyAutomation` says so. Pan and
    every §5.7 effect core ramp with `setTargetAtTime`, which has no arrival time; the §4.3
    dezipper is 10 ms inside a 25 ms window, so the param holds the window's own value.
  - **A §7.8 `slotN` address is 1-based over the §4.2 SLOT ARRAY, on both sides.**
    `ChannelHandle.setInserts` takes one handle per slot, `null` where empty, and only the
    non-null ones are wired. The chain used to be compacted and indexed 0-based, so the address
    reached the wrong effect or none — invisible live only because `mixerSync` rebuilds the whole
    chain at the commit.

- **(aq) — the sequence-filter closure (§7.7, §7.9).** The ⚑ items below are settled policy a new
  session should treat as binding, not as spec text:
  - **Sequence mode plays the ACTIVE sequence's tracks and no others**, and the filter lives in
    `SchedulerCore`, beside the one `emitSongPass` already had. The two are one rule stated in
    the two places that schedule — each mode selects the sequence it is playing.
  - **The sender ships the WHOLE project and must keep doing so.** The worker holds every track
    because song mode selects a different one per segment, so narrowing in `sequencerSync` would
    empty song mode. That is the decisive argument, not a preference.
  - **A sender-side filter would also breach §7.1.3.** `eventsDiff` is "incremental — never full
    re-sends during playback", and narrowing at the sender makes every switch of active sequence
    exactly that: delete one sequence's tracks, upsert another's, while the transport rolls.
  - **A track whose sequence becomes active LATER is already correct when the transport reaches
    it.** That is what the worker-side filter buys. A switch sends `sequenceMeta` and nothing
    else, and the next wake schedules the new pattern; the sender-side alternative leaves a
    window in which the worker holds no events for the pattern it has been told to play.
  - **A `null` active sequence matches nothing.** `tracksOfSequence` already answers the same
    question with the empty list, and §7.7's erase deletes what it sweeps, so the safe reading
    of "no sequence selected" is that no track is armed. Unreachable in a loaded project:
    `hydrate` activates the first sequence row and `deleteSequence` refuses to remove the last.
  - **Note repeat and the arpeggiator are NOT filtered, deliberately.** A §7.3 hit carries the
    track the input layer chose (issue #25) and `usePadTrigger` already scopes that; song mode
    does not filter them either.
  - **The implicit §7.1.4 loop is DERIVED from the active sequence, so it travels with the
    metadata.** `pushActiveSequence` sends both. Switching to a longer sequence otherwise left
    the worker looping the previous sequence's length over the new pattern.
  - **A changed loop region re-bases `lastLoopPass`, because it changes what a PASS counts.**
    Widening the brace mid-playback otherwise suppressed every `loopWrapped` — and with it the
    §7.7 per-pass overdub merge — until the longer loop caught up with the old tally.

- **(ap) — the insert-defaults closure (§3.4, §4.2, §5.7, §9.2).** The ⚑ items below are settled
  policy a new session should treat as binding, not as spec text:
  - **An insert slot's params are complete for the effect in it, and the completion sits where a
    slot ENTERS the store.** There are exactly two such places: the action that CREATES one
    (`addInsert`, `replaceInsert`) and the action that ADMITS one (`setChannels`,
    `upsertChannel`). Every route in passes through one of them — §4.4 hydration, a §9.6 import
    and a §9.8 pack read back through hydration, and a §6 pad's `inserts` through `programSync`.
  - **`createInsert` is the wrong place and always was**, though the merge lives there.
    It is downstream of the store, so completing there leaves the store holding `{}` and the
    §8.5.6 panel, the §4.1 gesture origin, an XYFX axis and a §7.8 lane all reading the range
    floor. **Its merge nonetheless STAYS**: the §11.2 offline render helpers legitimately call
    it with a partial record, and after this work it is a no-op for every slot the app builds.
  - **The §4.3 sync layer is wrong for a second reason as well.** `mixerSync` diffs on `inserts`
    IDENTITY and rebuilds the whole serial chain when it changes, so a subscriber completing
    slots on the way past would allocate a new array every pass and tear the chain down.
  - **`completeInsertParams` returns the SAME record when nothing was missing**, and
    `withCompleteInserts` the same array and the same strip. That is what lets a hydrate leave
    the §4.3 diff alone.
  - **The stored value always wins and nothing is repaired.** The completion fills what is
    ABSENT. A key the effect does not declare is left alone rather than dropped: it is inert,
    and discarding a value a project carries is not the completion's business.
  - **No §9.2 migration, because of WHERE the completion sits.** A migration would have had to
    rewrite three JSON blob columns and would still not have covered a §9.6 import or a §9.8
    pack, neither of which runs migrations at all.
  - **`defaultEffectParams` states the whole slot surface, the wrapper's `mix` included.** §5.7
    gives every insert a `mix` and the §7.8 catalogue offers it on every slot, but only three
    effects name one in the §5.7 table. `{ mix: 1, …the effect's own row }` states what
    `createInsert`'s `merged.mix ?? 1` was already doing, so no audio changed.
  - **A §11.4 probe restores the PROJECT, not just the UI.** `installAudioProbe` runs in
    production builds, so a proof that rewrites `projects.payload` puts the original back and
    reloads, and a proof that adds a slot does not leave it behind.

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
- **A `await import()` of a BARREL marks that whole module consumed for `check:orphans`.** A
  dynamic import cannot be resolved to named exports, so the checker credits every export in the
  target — which turns existing allowlist entries into "no longer orphans" failures somewhere
  else entirely. `audioProbe.ts` reaches `@/core/project/schemas` statically for that reason;
  reach a barrel dynamically only when you mean to.
- **A standalone Playwright driver reaches the probe BEFORE the DB worker has migrated.** The
  engine reports `running` while the project is still opening, so an evaluate that touches the
  stores gets `no such table: projects` or hydrates into a load that then replaces it. The smoke
  never sees this because it reaches these probes late in its run. A probe that owns its own
  arrangement should `await projectService.loadProject(projectId)` first, as `insertDefaultsProof`
  and `bounceMixProof` do.
- **`songEntryIndexProof` reads the §8.5.12 playlist on a 3 s wall-clock timer inside a 4 s
  song entry, and that margin is not always enough on a loaded machine.** It failed once with
  `row -1 ("")` — no row marked, because nothing had reported `songAdvanced` yet — and passed
  on the next run and in the same run's dev pass. Re-run before believing it; do not chase it
  into the §7.9 code without a second failure.
- **A §11.4 probe that ends on `loadProject` must sit where the NEXT step does not read the
  arrangement a previous probe left in the stores.** `sequenceFilterProof` hydrates its own
  sequences and tracks and does not restore, and the Grid step after it reads
  `activeSequenceId`'s tracks — so a probe reloading the §9.3 rows between them left the Grid
  with no canvas. `padStripProof` sits beside the two §5.7 insert-defaults steps instead,
  whose probe also ends on a fresh `loadProject`. The dev pass passed and the offline one did
  not, which is the shape this failure takes.
- **A §11.4 probe that is about a SAVE and a RELOAD must own its arrangement as real §9.3
  ROWS**, not as a `useSequenceStore.hydrate`, and must create them rather than borrow the
  project's: by the time the run reaches the late steps, earlier ones have opened imported and
  factory projects and what a track points at is no longer predictable.
- **A §11.4 probe may now give two TRACKS one PROGRAM, and `sharedPadChannelProof` is the
  one that must.** Issue #141 is closed: a pad channel is realised per track, so two tracks on
  one program no longer share a node. The note this replaces told a probe to give each track
  its own program to avoid the defect; `trackWithdrawalProof` still does, and there is no
  reason to change it. What a new probe must not do is assume ONE pad channel per id —
  `graph.channelsFor(padChannel)` returns one per track that has played it.
- **`inserts.at(-1)` is NOT "the slot an add just created".** `addInsert` fills the §1.3.1
  rack's first free slot, so a fresh effect lands at the FRONT of a default four-slot strip
  and the empty slots sit behind it. Find it by effect, or by diffing the list. Eight tests
  and two §11.4 probes carried the old assumption.
- **A §11.4 probe that measures a VOICE must NEUTRALISE the §5.2 strips first**, as
  `bounceMixProof` does. By the time the smoke reaches the late steps the project carries a
  350 ms delay at 35 % feedback on its MASTER strip, left by the §8.5.6 insert-panel step,
  which smears every hit into the next. `padLaneProof`'s first run measured a quarter-second
  hit as 0.5000 s long and read as a failed fix.
- **A probe that places its windows in SECONDS must give its sequence its own §9.3 tempo.**
  `activeSequenceSegments` falls back to the transport's bpm, and an earlier step leaves
  whatever tempo it was working at.
- **`cancelAndHoldAtTime` anchors a later ramp only when there is an event at or after the
  cancel time to rewrite.** On an otherwise-empty timeline it inserts nothing and the following
  `linearRampToValueAtTime` interpolates from the preceding event — see issue #144, which is
  what that costs the §5.4 declick.
- **The shell's working directory DRIFTS between tool calls, and a `gh` invocation resets it to
  the main checkout.** Two commits landed on `main` in the primary checkout that way and had to
  be moved with `format-patch` + `am`. Pass `git -C <abs worktree>` or `cd <abs worktree> &&`
  on every command; check `pwd` after anything that shells out.
- **Commit BEFORE a mutation experiment, not after it.** A loop that begins
  `git checkout -- <files>` to clean up the previous mutation destroys uncommitted work in
  those files on its FIRST pass, before any mutation has been applied.
- **A removed worktree can leave an EMPTY directory behind under `.claude/worktrees/`.** A
  lingering shell holds its CWD, so `git worktree remove` and `rm -rf` both fail with
  "Permission denied" / "Device or resource busy". `voicelane` is one; `padchannel`,
  `slotlimit`, `trackwithdraw`, `bouncemix` and `padstrip` were others, and both `padchannel`
  and `slotlimit` DID delete once their shells had gone, so try again before assuming
  otherwise. `git worktree list` shows only `main`, so they are not another agent's work —
  delete them if you can and ignore them if you cannot.
- **Driving the tab order in a browser needs `document.body.tabIndex = -1` first.** `body` is not
  focusable by default, so blurring alone leaves the caret where it was and Tab resumes from the
  middle of the page — which reads as "the skip link is not the first stop" when it is.

## 4. Established patterns (reuse, do not reinvent)

Everything from Phases 0–8, the §9.8 factory chain, the §14 (ag) assignment seam, the (ah)
automation seam, the (ai) voice-source/scheduler/tempo seams, the (ak) guard layer and the (al)
transient channel still stand. New this work:

**A §7.8 per-voice lane (spec §6, §7.8, §9.5):**

- **`PadLane` in `voicePool.ts` is the ONE place a §7.8 per-voice leaf's value lives** — one
  `ConstantSourceNode` per pad per leaf, which every voice of the pad is built against. The
  voice's own param holds the neutral the node sums onto: `filter.frequency.value = 0`,
  `filter.Q.value = 0`, and the pad's tune removed from `baseDetune`. A new per-voice §7.8 leaf
  gets a node there, or it reaches only the voices that happen to exist when it is written.
- **`applyPadParam` writes the NODE, and walks the voices only for `detune`** — to move their
  §5.4 declick, because detune is the playback rate. It skips a voice that has not STARTED and
  leaves it to the window that reaches it.
- **`VoicePool.seedLaneNode` owns the seeding rule**: build and seed on first use, re-seed when
  the §6 payload has moved since the last trigger. `laneNode` is the build-only half, which is
  what a §7.8 write calls when the pad has never sounded.
- **`releaseProgramLanes(programId)` is called from `SyncBridge.onProgramRemoved`**, reported by
  `subscribeProgramParamSync` from the diff it already computes. A new thing the graph hangs off
  a §6 program is released there too, or it outlives the program that owns it (§3.2).
- **`padTuneSemitones(pad)` in `programVoice.ts` says which layer's tune is the PAD's**, and
  both the voice builder and `syncLayer/programParams` read it through that function. Each
  layer's own tune travels as `ResolvedVoice.layerTuneCents`, its difference from the pad's.
- **`boundedCents` bounds each detune contribution by the §6 rule that admits IT.** The pad's
  tune and a layer's distance from it are bounded separately because they are bounded
  differently; a non-finite one contributes nothing rather than the range floor (§14 (ak)).
- **`StaticModulation.cutoffCents` replaces `cutoffFactor`**, so every §6 filter modulator —
  the envelope, the cutoff LFO and the per-voice static mod — lands on `filter.detune` in cents
  while `filter.frequency` carries only the pad's shared cutoff.
- **`DetuneSchedule.bend` models the SUM of the two nodes summed into `source.detune`**: this
  voice's §10.2 bend and its pad's §7.8 lane. `applyRetune` takes their total, and the track is
  seeded at the voice's start with the lane's value rather than at zero.
- **The §11.4 `padLaneProof` neutralises the §5.2 strips before it renders**, reads a cutoff
  lane as a LEVEL and a pitch lane as a LENGTH, and measures the live half with the transport
  stopped at the moment of each write — so the only way a write can reach the pass that follows
  is a value the next voice is built against.

**A pad channel, and what a §4.2 id resolves to (spec §4.2, §5.2, §5.3):**

- **`MixerGraph.channelsFor(channelId)` is the ONE resolution of a §4.2 id to graph channels**,
  and it returns 0..N — one for the master, a return or a track, one PER TRACK playing the
  program for a pad. `getChannel` is gone. Every §4.2 strip write, the §5.2 mute application and
  both §7.8 dispatch paths iterate it; a new writer does too, or it moves one track and not the
  other.
- **`ensurePadChannel(channelId, trackId, trackInput)` takes the track id EXPLICITLY**, because
  it is the other half of the key. Inferring it from `trackInput` would make the identity a
  property of a node reference rather than a stated fact.
- **It returns `{ channel, created }`, and `created` is the graph's answer rather than the
  caller's.** A caller's own "already seeded" set outlives `removePadChannel`, so a rebuilt
  channel would keep the §4.2 defaults `createChannelStrip` gives it. `AudioEngine` and
  `bounceService` both dropped such a set when this landed.
- **`AudioBridge.seedChannel(channel)` seeds ONE freshly built channel** — the §4.2 strip where
  the store has one, then the §5.2 effective mute, which is derived from the whole mixer and so
  is written even where the strip is absent. It is per-channel rather than a narrowed
  `resyncAll` because `applyInserts` destroys and rebuilds a chain, and rebuilding one that is
  already sounding would glitch it. **Every lazily built channel goes through it** — a track's
  on its first note, a pad realisation's on the first hit that needs it — because
  `startAudioEngine`'s one `resyncAll` runs before either exists and `mixerSync` pushes only
  what changed.
- **It wires the insert chain on a MICROTASK, and that is not an optimisation.** It runs on
  §7.6's audition path with `when` = now, and `createInsert('reverb')` synthesises an impulse
  response on the main thread — §11.5's 30 ms touch-to-sound budget is what forbids doing that
  before `voicePool.trigger`. The microtask re-asks the graph whether it still holds the
  channel, because a program change or a track delete may have destroyed it in between.
- **`applyStripParams` is the one write of a §4.2 strip's continuous params onto a channel**,
  shared by `resyncAll` and `seedChannel`; `applyInserts` is the separate half, because only
  one of the two callers defers it. A new §4.2 continuous field goes in `applyStripParams` once.
- **`AudioEngine.trackChannel(trackId)` is the one place a track group is fetched**, and it is
  what seeds a new one. Reaching `graph.ensureTrackChannel` directly from the engine skips that.
- **`removeTrackChannel(trackId)` destroys the track's own pad realisations first.** A new thing
  the graph hangs off a track goes there too, or it outlives the input it is connected to.

**Withdrawing a deleted track (spec §7.1.3, §7.5, §7.8):**

- **`SchedulerClient.removeTrack` / `SchedulerCore.removeTrack` are the one withdrawal**, and
  the core's body is "forget every map keyed by this id". A new piece of worker state keyed by
  a track goes in there too, or it outlives the track that owns it.
- **`sequencerSync`'s `tracks` subscriber is where a track's DEPARTURE is observed.** Anything
  else the worker must be told when a track goes is sent from there. The `events` subscriber
  stays about events, and still forwards a diff for every track in the project (§14 (aq)).
- **`useSequenceStore.removeTrack` is where a track's OWNED data goes with it** — its §7.8
  track-scope lanes and its §7.5 groove assignment. A new thing a track owns that the §9.3
  `tracks` row does not cascade is removed there, with its own §4.4 dirty key and a revert that
  restores exactly what the delete took.
- **A §7.8 lane whose owner is a track is nobody else's to clean up.** `automation_points`
  declares no foreign key, and `laneForTarget` lets a track lane override a sequence lane on the
  same address whatever track owns it.

**A pad's mixer strip (spec §4.2, §6, §8.5.6):**

- **`src/store/padStrips.ts` is the ONE mapping between a §6 pad and its §4.2 strip, in both
  directions.** `padStripsForProgram` forward, `padStripEdit` + `padWithStripEdit` back.
  Pure, no store or audio access. It is no longer under `syncLayer/`, because nothing about it
  is store → graph.
- **`src/store/derive/padStripMirror.ts` is the subscriber that runs both**, registered by
  `startProjectSession` beside `subscribeTransportMirror` and disposed by
  `stopProjectSession`. A new way for a §6 value to reach a strip, or a strip value to reach
  the payload, goes through it — not through a store action and not through `persist.ts`.
- **`padStripEdit` reports only what the strip MOVED**, and returns null for a strip with no
  predecessor. A strip that has just entered the store carries no edit; treating one as an edit
  writes the projection straight back over its own source.
- **`useProgramStore.applyPadStripEdit` is the write, and it records NO undo entry and marks
  NOTHING dirty.** The `useMixerStore` commit that moved the strip already did both —
  `mixerChannelDirtyKey` maps a `pad:` channel to `program:<id>`, and the commit's revert
  closure restores the strip, which the mirror then follows out again. One fader move is one
  Ctrl+Z; `padStripMirror.test.ts` pins the depth.
- **The "never clobber an existing strip" guard is what bounds the re-entrancy.** The publish
  runs from inside the `channels` subscription, so its `upsertChannel` re-enters — and finds
  every strip present.

**Building a §9.5 render (spec §5.2, §9.5):**

- **A render creates every channel it needs BEFORE its one `resyncAll` pass**, which is why it
  needs no `seedChannel` call: the §6 payload seeds each realisation as it is built, and the one
  pass then writes the §4.2 strips over the top. The live engine cannot do that, because a
  second track's first hit arrives long after start-up.
- **`bounceService.renderSegments` builds the LIVE graph on the offline context** — `MixerGraph`
  - `createAudioBridge` + `VoicePool`, all of which take a `BaseAudioContext`. A new §5.2 stage,
    a new strip parameter or a new §5.7 effect reaches every bounce for free. **Do not add a
    second, offline-only graph builder**; that is the defect this closed.
- **`src/core/audio/bouncePlan.ts` is where a render's CONTENTS are decided**, before any node
  exists. `bounceIncludesChannel` says which §5.2 strips a variant covers and
  `bounceAutomationRamps` says which §7.8 ramps it applies — both pure, both unit-tested without
  Web Audio. A new §9.5 variant states its `BounceScope` there, not in the render loop.
- **`AudioBridge.resyncAll(includeChannel?)` is the one flush of the §4.2 strips onto the graph.**
  The predicate exists for the stem; it also narrows `applyEffectiveMutes`, whose solo evaluation
  still sees the whole mixer.
- **Every channel a render needs is created BEFORE `resyncAll`**, because `resyncAll` writes onto
  the channels the graph already holds and a pad channel is built on its first voice. The order is
  §6 pad payload first, then the §4.2 store: the store is the §1.3 #16 runtime truth, and where it
  has no strip for a pad the payload is the only value there is.
- **`prepareVoiceWorklets` AND `prepareWorkletEffects` both run on the offline context.** Anything
  else a render needs from a worklet needs the same treatment; `new AudioWorkletNode` throws on a
  context that has never registered the processor.
- **The §11.4 `bounceMixProof` reads the WAV back from `/bounces/` over real OPFS**, so every
  number it reports is what is in the file the user gets. It restores the project it found —
  `installAudioProbe` runs in production builds.

**The §1.3.1 insert-slot limit (spec §1.3.1, §4.2, §8.5.6):**

- **`freeInsertSlot(inserts, limit)` in `useMixerStore.ts` is the ONE rule**, and it answers
  both questions: where an effect may go, and (as `=== null`) whether the chain is full.
  `addInsert` and `replaceInsert` apply it; §8.5.6 imports it to disable its own controls. A
  new surface that offers to add an effect asks it rather than counting slots itself.
- **`insertSlotLimit()` reads `useProjectStore.globalInsertLimit` at the moment of the edit**,
  not at strip creation, so lowering the limit takes effect on the next add with nothing to
  re-derive.
- **`InsertSlotResult` is the third store result type**, beside `AssignResult` and
  `AutomationEditResult`, and carries a finished sentence for the same reason.
- **Admission (`setChannels`, `upsertChannel`) is deliberately NOT bounded.** See §2 (au) —
  the stored value always wins. A new admission path inherits that, not the limit. The one
  consequence is that §8.5.6's REORDER, which writes through `upsertChannel`, has to decline
  to walk an effect past the limit itself; it is the only surface that can.
- **`useProjectStore.applyProject` clamps `globalInsertLimit` to `GLOBAL_INSERT_LIMIT_RANGE`.**
  The §9.3 column has no CHECK and §9.6 types it as a bare number, so the clamp is where the
  settings ENTER the store — covering hydration, an import and a pack at once. A new §4.2
  setting that BOUNDS something is clamped there too, not only in its own setter.

**Insert slots and their §7.8 addresses (spec §5.7, §7.8):**

- **`ChannelHandle.setInserts` takes one entry per §4.2 slot, `null` where the slot is empty.**
  The graph's slot list IS the store's slot list, which is what lets `setInsertParam(slot)` take
  the §7.8 grammar's own 1-based number. Only the non-null entries are wired, in order;
  `setInsertTempo` and `insertLatencySamples` skip the empty ones.
- **`insertParamPath(channelId, slotIndex + 1, param)` is how the address is built**, from the
  store's slot position. Never renumber it against the wired chain.

**Automation reaching a param (spec §4.3, §7.8):**

- **`rampParamLinear` anchors with `cancelAndHoldAtTime(ctxTime)`.** It asks the param's own
  timeline what the contour holds at the ramp's start; `param.value` answers for NOW, and `ctxTime`
  is routinely ahead of now (§7.8 schedules into the lookahead) or, offline, before anything has
  been rendered at all. A new ramp helper anchors the same way.
- **`automatedTargets` and `laneForTarget` in `core/sequencer/automation.ts` are the one
  lane-selection rule**, beside `automationRampForWindow`'s one emission rule. `SchedulerCore` and
  the §9.5 render both call them. `resolveEffectivePoints` is module-private again.
- **`applyAutomation` does not consume the §7.1.3 `rampEnd`, on purpose**, and says why at the
  call site. Do not "fix" it without answering for `setTargetAtTime`, which has no arrival time.

**Choosing the sequence to play (spec §7.7, §7.9):**

- **`SchedulerCore.playsInSequenceMode` is where sequence mode picks its tracks**, and
  `emitSongPass`'s `track.sequenceId !== segment.sequenceId` is where song mode picks its own.
  A new schedule-time decision that depends on WHICH sequence is playing goes in both, or it is
  silently mode-specific — the same trap as issue #94, and this defect was its mirror image.
- **`sequencerSync` forwards an `eventsDiff` for every track in the project, on purpose.** Do
  not "optimise" it to the active sequence: song mode needs the rest, and §7.1.3 forbids the
  full re-send a switch would then require. `sequencerSync.test.ts` pins that with a test named
  for it.
- **A switch of active sequence sends `sequenceMeta` and the §7.1.4 LOOP, and nothing else.**
  The event map needs nothing because it already holds the project; the loop does, because with
  no user brace it IS the active sequence's own length. `pushActiveSequence` is the one place
  that pairs them — a new subscriber that can change which sequence is active calls it, not
  `pushMeta`.
- **`SchedulerCore.setLoop` re-bases `lastLoopPass`.** A loop region change alters what a pass
  counts, so anything comparing pass numbers across one has to be re-based against the new
  region. `nextScheduleTick` is the reference rather than a clock reading, for the same reason
  `setTempo` defers to the next `tick(now)`: the core has no clock (§11.3).

**Insert slot parameters (spec §5.7, §4.2, §3.4):**

- **`completeInsertParams(effectType, params)` in `effectParams.ts` is the one rule**, beside
  the `defaultEffectParams` it fills from. It returns the SAME record when nothing was missing.
- **`withCompleteInserts` in `useMixerStore.ts` is where the rule is applied**, from all four
  actions a strip or a slot can enter through: `setChannels`, `upsertChannel`, `addInsert`,
  `replaceInsert`. A new way for a strip to reach the store goes through it too.
- **`defaultEffectParams` answers for the WHOLE slot surface**, so a new §5.7 parameter goes in
  `EFFECT_PARAM_RANGES`, in the label table, in the unit table AND in the defaults.
  `effectParams.test.ts` fails on any of the four being missed.
- **The range-floor fallbacks in `InsertPanel`, `readScalar` and `XyfxMode` stay.** They are
  what the types require of an index into a `Record<string, number>`; nothing reaches them for
  an occupied slot, and the tests are what say so rather than the absence of the `??`.

**From the previous work, and unchanged:**

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

**No repository method was added or changed this work.** The §11.4 insert-limit proof reaches
storage only through paths that already existed: `ProjectRepository.getById`/`update` for the
§9.3 `projects.payload` column it restores, and `projectService.loadProject`/`saveNow`.

From the previous work, and unchanged: the §11.4 bounce-mix proof reaches storage
only through paths that already existed: `importDecodedSample` for its test sample, the §9.1 OPFS
wrapper for the WAV it reads back, and `projectService.loadProject` to restore what it found.

From the previous work, and unchanged: the §11.4 insert-defaults proof reads and
writes `projects.payload` through `ProjectRepository.getById`/`update`, which is what a §9.3 payload
edit already goes through.

From the export work, and unchanged: `exportMpcweb` reads the same rows; it
simply reads each sample's bytes one at a time and hands them over rather than gathering them.

From the data-integrity work: `dumpSnapshot` reads `samples.listGlobal` as well as `listByProject`, so a §9.6 export carries
the §9.8 global-library audio its programs reference. No repository method was added.

## 6. DDL snapshot — unchanged. `PRAGMA user_version` = **1**. **No migration added.**

**No DDL column, §9.3 payload field or §6 payload shape changed this work, and no §9.2
migration was added.** The shared-pad-channel closure is a graph-topology change: a pad's
values still live in the §6 `Pad` record that the §9.3 `programs.payload` column holds, still
addressed by `mixer.pad:<prog>:<idx>.…`, so a project written before it loads unchanged and
nothing on disk is in a shape to correct (§2 (av)).

From the insert-limit work, and unchanged: the §9.3 `projects.insert_limit` column has existed with a default of 4
since the v1 DDL and was already hydrated by `mappers.ts` and written by `persist.ts` — what
changed is that something now READS it. A project carrying a chain longer than its own limit
loads unchanged and every effect in it sounds, so there is nothing on disk in a shape to
correct (§2 (au)).

From the previous work, and unchanged: a §9.5 render reads
the STORES, so nothing about the bounce-mixer closure is persisted at all.

**A slot's `params` record now arrives at the store complete, and that needed no migration.** The
§9.3 `tracks.mixer` column and the `master`/`returns` of `projects.payload` genuinely still hold
`"params":{}` on a slot written before this work; they resolve because `useMixerStore.setChannels`
completes an occupied slot on admission (§2 (ap)). `insertSlotSchema` is unchanged — `params` is
still `z.record(z.string(), z.number())` and validates an empty record exactly as before. A project
saved AFTER this work carries the parameters explicitly, so what it sounds like no longer depends
on the defaults compiled into the build.

From the data-integrity work: `projects.bpm_default` is WRITTEN as well as read (issue #93). The column has always existed
with a default of 120, so a project saved before this loads unchanged and needs no migration.

The §9.3 `projects.payload` gained three optional fields — `grooveTemplates`, `trackGrooveIds` and
`songLoopEnabled`. All three are `.optional()`, so a project written before them loads with §7.9's
own defaults and needs no migration.

## 7. Worker / worklet / message protocol versions

**Nothing in the §7.1.3 protocol changed this work** (issue #138): no request kind, no response
kind, no `ScheduledEvent` field, and no change to an existing kind's shape.
**`SCHEDULER_PROTOCOL_VERSION` stays at 2.** A §7.8 pad lane is a §5.2 graph object and never
crosses the worker boundary — the scheduler emits the same `automationRamp` for these addresses
as for any other, and what changed is where the dispatcher puts the value.

From the previous work, and unchanged: **nothing in the §7.1.3 protocol changed** (issue #141): no request kind, no response
kind, no `ScheduledEvent` field, and no change to an existing kind's shape.
**`SCHEDULER_PROTOCOL_VERSION` stays at 2.** A pad channel is a §5.2 graph object and never
crosses the worker boundary — the scheduler knows nothing about channels.

From the insert-limit work, and unchanged: **nothing in the §7.1.3 protocol changed** (issue #135): no request kind, no response
kind, no `ScheduledEvent` field, and no change to an existing kind's shape.
**`SCHEDULER_PROTOCOL_VERSION` stays at 2.** The insert limit is a §4.2 store rule and never
crosses the worker boundary — the scheduler knows nothing about insert slots.

From the previous work, and unchanged: **one §7.1.3 request KIND was added** (issue #137): `removeTrack { trackId }`, whose
`trackId` takes `schedulerIdSchema` like every other id crossing the boundary. No response kind,
no `ScheduledEvent` field, and no change to an existing kind's shape — so
**`SCHEDULER_PROTOCOL_VERSION` is unchanged at 2**, by the extend-by-adding-kinds rule. An older
peer that does not know the kind drops it at the Zod guard and behaves exactly as this build did
before the fix. `SchedulerClient.removeTrack` is driven through `parseSchedulerRequest` and
`applySchedulerRequest` by `schedulerWire.test.ts` like every other sender.

From the previous work, and unchanged: **nothing in the §7.1.3 protocol changed** (issue #132): no request kind, no response
kind, no `ScheduledEvent` field, and no change to an existing kind's shape. That fix was a
scheduling decision inside the worker, taken against `activeSequenceId`, which `sequenceMeta`
already carried.

From the previous work, and unchanged: `SCHEDULER_PROTOCOL_VERSION` is **2** as of the entry-index work (issue #130). `songSequence` now
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
context, and `prepareWorkletEffects(context)` registers `dsp-effect` — the §9.5 bounce calls
BOTH, so a warp pad bounces the way it plays and a §5.7 worklet insert builds instead of
throwing on a context that has never heard of the processor.

`WorkletKernelName` gained `granularStretch`; `DspEffectKernelName` is the subset the DSP-effect
worklet hosts, which is what keeps that processor's kernel switch exhaustive rather than defensive.

## 8. Stores — all eight implemented (§4.2)

**No store slice, field or action changed this work; the §4.3 BRIDGE gained one method.**
`SyncBridge.onProgramRemoved(programId)` is how a §6 program leaving the store reaches the
graph, and `subscribeProgramParamSync` reports it from the diff it already computes. It is a
genuine §4.3 hook — the audio bridge releases that program's §7.8 pad-lane nodes — unlike the
`onActiveProgramChanged` §14 (as) deleted, whose body was empty in both bridges.

From the previous work, and unchanged: **no store slice or field changed, but two
`useMixerStore` actions changed their
RETURN TYPE and what they may do.** `addInsert` and `replaceInsert` return `InsertSlotResult`
(`{ ok: true } | { ok: false, reason }`) where they returned `void`, and both refuse a slot
position the §1.3.1 limit forbids. `addInsert` also FILLS the rack's first free slot rather
than appending past it, so `inserts.at(-1)` is no longer the slot an add created.
`freeInsertSlot` is exported from the slice and re-exported by the barrel, because §8.5.6
disables its own controls from the same rule the store refuses by.

`useProjectStore.setGlobalInsertLimit` is unchanged and now has its first call site outside a
test: §8.5.1's Project panel.

From the previous work, and unchanged: **`useSequenceStore.removeTrack` changed what it
writes.** It now also deletes the track's §7.8 track-scope automation lanes from `automation` and
its §7.5 assignment from `trackGrooveIds`, in the same undoable commit and with a revert that
restores exactly what the delete took. Each emptied lane carries its own §4.4 dirty key, which is
what takes the orphan §9.3 `automation_points` rows; the assignment marks the project, because it
persists in `projects.payload`. Both reach the worker through the subscribers that already handle
a cleared lane and a cleared assignment.

From the previous work, and unchanged: **no store slice or field changed; `useProgramStore` gained ONE action.**
`applyPadStripEdit(programId, padIndex, edit)` writes a §4.2 pad-strip edit into the §6 pad,
with no undo entry and no autosave mark — see §4. `src/store/syncLayer/padStrips.ts` moved to
`src/store/padStrips.ts` and gained the reverse mapping; `src/store/derive/padStripMirror.ts`
is new beside `transportMirror.ts`. `subscribeProgramSync` no longer writes `useMixerStore`.

From the previous work, and unchanged: **no store slice, field or action changed.** The §9.5 render READS `useMixerStore`,
`useProgramStore` and `useSequenceStore` and writes none of them; `AudioBridge.resyncAll` gained an
optional predicate, which is a graph concern rather than a store one.

From the previous work, and unchanged: `useTransportStore.activeSequenceId` is
§4.2's own field and already reached the worker through `sequenceMeta`; what changed is that the
worker now uses it. `subscribeSequencerSync` still forwards an `eventsDiff` for every track in the
project, and must — see §2 (aq) and §4.

**No store slice or field changed this work, but four `useMixerStore` actions changed what they
write.** `setChannels`, `upsertChannel`, `addInsert` and `replaceInsert` all pass a strip through
`withCompleteInserts`, so an occupied insert slot in `channels` always carries a value for every
parameter its effect declares — §3.4's "the store value reflects the actual node state" is now true
of the slot, not only of the node. Anything reading `slot.params` may rely on that; nothing may
rely on the range-floor fallbacks still present for the type's sake.

From the previous work, and unchanged: **`useTransportStore.songEntryIndex`** (§4.2 permits adding fields with a
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

**Mode changes this work:** two, both §1.3.1. `InsertPanel` reports a store refusal as a
`warning` toast, disables its Add picker on a full channel and disables the Replace select on
a slot past the limit — the `LayersEditor` shape for a §6 cap. `ProjectsPanel` gained an
**Insert slots** select (1–8) beside Sample rate and Bit depth, the first thing that can move
the §9.3 `projects.insert_limit` column. No primitive or shell component changed.

From the previous work, and unchanged: no component, primitive or mode markup changed for the
bounce-mixer closure — the defect and its fix are both below the §4.3 sync layer, and the §8.5.6
insert panel's addresses were already right. (The same was true of the sequence-filter closure
before it.)

From the previous work, and unchanged: `InsertPanel` gained comments only — its knobs read the same
`slot.params[param] ?? range[0]` they always did, and what changed is that an occupied slot now
carries the value, so the floor is never what a fresh insert draws. No primitive, shell component
or mode markup changed.

From the previous work, and unchanged: §8.5.12's `SongMode` renders its playlist in `position`
order — the projection §7.9 numbers its entries against — and marks the entry that is playing,
with an `sr-only` "(playing)" beside the name and `aria-current` on the row. `removeEntry` and
`moveEntry` take the same sorted projection.

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

**No kernel changed this work**, and none has since the §5.6.4 set was completed. The §5.6.4 set is complete and unchanged in membership. Every wrapper now guards its parameters
per §14 (ak) — clamp in range, refuse a non-finite one, throw on a bad structural argument — and
`LIMITER_RANGES`, `FDN_REVERB_RANGES` and `MULTIBAND_RANGES` mirror the §5.7 table under the
`kernelRanges.test.ts` gate. `granularStretch` carries two entry points: the offline `render` (WSOLA, for the §8.5.4 stretch tool) and the streaming
`createStream`/`prepareStream`/`streamBlock` (fixed-grid OLA, for the §5.7.9 warp source).

## 11. Outstanding / deliberate technical debt

**`check:stubs` reports ZERO open stubs.** Outstanding work lives in GitHub issues, not in code
comments.

**A §7.8 lane on a §6 sound-design parameter now sounds and renders** (#138); the two
amp-envelope leaves do not (#143), and the §5.4 declick has never been 3 ms long (#144).

**STILL OUTSTANDING FROM PHASE 8 — READ THIS FIRST:**

- **The live hardware sign-off (§12, issue #13) is NOT done and cannot be self-certified.** It
  needs the human developer, a physical ESP32 BLE-MIDI controller and a Windows pairing.

**#138 is CLOSED by this work.** Two new issues were filed while closing it — a §7.8 lane on
`amp.attack` or `amp.release` reaches nothing (#143), and the §5.4 declick fades from the
note-on rather than from 3 ms before the region end (#144). Nothing was added to the
`check:orphans` allowlist.

**Honest scope notes for the per-voice lane work:**

- **The two amp-ENVELOPE leaves are inert** (#143). `program:<id>.pad:<idx>.amp.attack` and
  `…amp.release` are registered, offered by the Grid and named among §10.3's pad-mode defaults,
  and `programParamChange` maps neither. An AHDSR is applied when a voice STARTS, so there is
  no param to sum onto; a remembered value would work live and not offline, because a render
  triggers every voice before it applies any ramp.
- **The §5.4 declick fades across a WHOLE region** (#144), and always has. Profiling the amp
  gain of a bounced hit — rather than its start and its end, which is all any previous proof
  read — shows a straight line from the note-on to the region's end where §5.4 asks for a 3 ms
  fade at the end of it. `cancelAndHoldAtTime` anchors a ramp only when there is an event at or
  after the cancel time to rewrite, and a voice's amp timeline normally has none. Pre-existing,
  audible on every voice, and every RMS figure recorded since §14 (t) was measured under it —
  so it is its own closure, and both builds of this one were measured under it.
- **A §7.8 lane's last value survives a reload of the SAME project.** `syncLayer/programParams`
  publishes only what CHANGED between two program objects, so a reload of unchanged values
  publishes nothing and the node keeps what the last ramp put there. Loading a DIFFERENT
  project releases the lanes with the programs that leave the store. The §6 control reads the
  committed value and moving it re-asserts it.
- **No §7.8 address reaches a KEYGROUP's voices**, before or after this work: `padKeyFor`
  builds `<id>:<padIndex>` and `resolveKeygroupVoice` sets `<id>:keygroup`. Pre-existing,
  untouched, and adjacent to #139.
- **A pad whose §6 filter is off still gains no filter node mid-note**, so a cutoff or
  resonance lane reaches nothing there. Unchanged — materialising one would click.
- **A pad's lane nodes are not pruned while its program is in the store**, only released with
  that program or by `VoicePool.destroy()`. That is the trade §6's free-running LFOs already
  make, in the same map, for the same reason: the node has to outlive the note.
- **Every regression test was proven against the code it was written to catch**, by twelve
  mutations: the per-voice write — the defect as filed (7 failures); a node re-seeded from the
  §6 payload on every trigger (5); bend and lane sharing one node (1); a teardown that leaves
  the lanes connected (1); the static cutoff modulation dropped (1); a pitch lane that does not
  move the declick (1); a lane node started at the note rather than on the context clock (1);
  and the review's own five — a layer's whole tune on the pad node (1), a node never re-seeded
  (2), a program's lanes kept (1), a removal never reported (1), and the declick re-laid for
  future voices (1). One test is the anti-over-correction guard and no mutation moves it: a
  lane reaches nothing on a pad whose §6 filter is off.
- **The defect was measured in the browser too**, by giving the render no voice pool and
  restoring the per-voice write: the swept bar and the unautomated one came back the same file
  to every digit (**0.0006096859010598197 RMS** on beat 4 of both), the pitched bar and the
  unpitched one likewise (**0.248875 s** on every beat of both), and the live pass read
  **0.01043** open against **0.00557** closed — both the closed reading. The step fails on the
  cutoff assertion, which is the render half of the issue as filed and is reached first.
- **Measured in a real browser**: 80/80 smoke steps at ports 5342/5343, dev and offline, no
  console errors. A lane sweeping a pad's own lowpass 60 Hz → 12 kHz rendered **0.17299 RMS on
  beat 4 against 0.00061 unautomated (×283.73)**, and **0.00078 on beat 1 of the same bar**; a
  lane raising the pad two octaves left beat 4 sounding **0.0846 s against 0.2276 s on beat 1
  (×0.372)** at ×0.66 of beat 1's head level; and the live §5.8 master peak read **0.27707
  open against 0.01049 closed (×0.038)** in the dev pass and **0.26326 against 0.00295
  (×0.011)** offline, with each §7.8 write made while the transport was stopped.

**#141 was CLOSED by the previous work.** No new issue was filed while closing it, and nothing
was added to the `check:orphans` allowlist.

**Honest scope notes for the shared-pad-channel work:**

- **A pad's `mute` and `solo` are still session state**, because §6's `Pad.mixer` defines no
  field for them (§14 (as) item 6). A realisation is muted by the derived §5.2 result like any
  other channel, and that result is not persisted.
- **A keygroup program's program-scope strip is still unreachable** (#139) and unaffected:
  `padStripsForProgram` publishes no strip for it either way.
- **The `pad:<trackId>:<note>` channel the demo fallback builds is unchanged.** It already
  carried a track in its id, so it has exactly one realisation, and it is not a §6 pad.
- **`removeInsert` still shrinks the rack** (#142), which is why the §11.4 step BYPASSES its
  probe filter rather than removing it.
- **Choke groups and mono retrigger stay program-scoped** per §5.4 — see §2 (av).
- **`seedChannel`'s call from `AudioEngine` is proven by the browser step's lowpass reading.**
  There is no call from a §9.5 render, because a render creates every channel before its one
  `resyncAll` pass.
- **A lazily built TRACK channel had never been seeded either.** The review's first finding,
  pre-existing and no part of #141, closed with the same mechanism one line away: measured at
  a live master peak of **0.13589** against **0.27213** at unity (×0.499) with a fader set
  before the channel existed, where the unseeded build read **0.27618** against **0.27960**
  (×0.988).
- **The very first hit of a pad whose rack was edited before its realisation existed can pass a
  few milliseconds of DRY signal**, because the microtask that wires the chain is itself what
  costs. Deliberate: the alternative is a main-thread stall on §7.6's audition path.
- **Every regression test was proven against the code it was written to catch**, by six
  mutations: `ensurePadChannel` keying by the channel id alone — the defect as filed (4
  failures); the bridge writing to `channelsFor(id)[0]` (2); `seedChannel` applying no strip
  (1); `removeTrackChannel` leaving the track's pad realisations (1); `seedChannel` applying
  its chain synchronously (2); and `trackChannel` seeding nothing, which has no unit test and
  is browser-only.
- **The defect was measured in the browser too**, by the first of those mutations: 1 realisation,
  `secondFaderClosedRms` **0.061621618782488896** against a `bothTracksRms` of
  **0.061621618782488896** — identical to every digit — `firstFaderClosedRms` **0**, and a live
  peak of 0.27392 → 0.26976 (×0.985). The step's assertions are ordered so it fails on the
  second track's fader, which is the audio claim, rather than on the realisation count.
- **Measured in a real browser**: 78/78 smoke steps at ports 5342/5343, dev and offline, no
  console errors. Both tracks hit one pad on the same four beats of a bar; the bounce read
  **0.06162 RMS** with both faders at unity, **0.03081** (×0.5000) with the second closed and
  **0.03081** (×0.5000) with the first; the pad strip at 0.8 rendered ×0.2512; the live §5.8
  master peak read **0.13589** with the second track's fader at 0 against **0.27213** at unity
  (×0.499), the pad's own 80 Hz lowpass held that peak at **0.00276** (×0.020), and the graph
  held **2** channels under the one pad id. Both live edits were made BEFORE either channel
  existed, so that pass measures the seeding as well as the routing.

**#135 was CLOSED by the previous work.** One new issue was filed while closing it — `removeInsert`
drops a slot from the array rather than emptying it, shifting every §7.8 address behind it
(#142). Nothing was added to the `check:orphans` allowlist.

**Honest scope notes for the insert-limit work:**

- **A §11.4 probe restores every §9.3 COLUMN it writes.** `flushProject` writes
  `insert_limit` as well as `payload`, and the first pass put only the payload back — so a
  user who had chosen 8 slots lost them on every probe run, in a production build. The §14
  (ap) probe rule, one level up, and the second time in three entries the restore has been
  narrower than the save.
- **An out-of-range `insert_limit` is clamped in `applyProject`.** §9.3 declares no CHECK,
  `rowToProjectSettings` copies the column through and §9.6 types it as a bare number, so a
  hand-edited row or an import can carry anything. Inert before; enforcing the limit made
  `20` mean unreachable chains and `0` mean a channel locked out of inserts.
- **`removeInsert` still SHRINKS the rack**, so removing slot 2 of four moves the filter that
  was in slot 3 onto the `slot2` address and every §7.8 lane and §10.3 binding behind it with
  it. Pre-existing, the editing-side half of what §14 (ar) fixed for the wiring side, and out
  of scope here — issue #142. It is why the §11.4 insert-panel step now counts EFFECTS after
  a removal rather than slots.
- **A project already carrying a chain over the limit is left exactly as it is**, and nothing
  warns the user that the slots past the limit cannot be addressed. §8.5.6 disables the
  Replace select on them and says why in its `title`; there is no project-level notice, and
  none was added.
- **A §7.8 lane or a §10.3 binding on a slot past the limit is not cleaned up.** It addresses
  nothing and is inert, exactly as it was before; discarding a value a project carries is not
  this rule's business (§14 (ap)).
- **`replaceBeyondLimitRefused` was not exercised by the defect run.** The browser measurement
  mutated `addInsert` alone, so `replaceInsert`'s own guard read `true` on both builds; its
  regression is the unit test, which does fail against the unfixed store.
- **Every regression test was proven against the code it was written to catch**: 15 of
  `insertLimit.test.ts`'s 19 assertions fail against the unfixed store, and the 4 that pass
  are guards — the two admission cases that must keep working, the §7.8 grammar's own refusal
  of `slot9`, and the id a fill preserves. Eight EXISTING tests pinned the defect (all of them
  `inserts.at(-1)` for "the slot an add created") and were corrected rather than added to.
- **The defect was measured in the browser too**, by making `addInsert` append unconditionally
  and re-running: twelve adds left **16 slots, 12 occupied, and no refusal at all**; slots 9
  to 16 held an effect no §7.8 address could reach; and closing slot 16 through its address
  left the master peak at **1.47944235801696777**, the same number to every digit it had read
  before the write. The step fails on the COUNT assertion, which is reached first, so those
  numbers came from printing the probe's own result.
- **Measured in a real browser**: 76/76 smoke steps at ports 5342/5343, dev and offline, no
  console errors. Twelve adds left 4 slots on the master strip; no occupied slot was
  unaddressable; a looping 1 kHz tone into the §5.2 master input read **0.49939** with every
  slot opened to 20 kHz through its own §7.8 address and **0.00320** with slot 4 alone closed
  to 80 Hz; a nine-slot chain was admitted whole and `replaceInsert` still refused its slot 9.
  Re-run after the review's four fixes: the same 76/76 and the same numbers.
- **The review's own three code fixes were each proven by mutation**: `applyProject` without
  the clamp (2 failures), `replaceInsert` reusing the full-chain sentence (1), and the
  Move-later button unbounded (1). The fourth — the probe's `insert_limit` restore — has no
  unit test; it is browser-only, and the smoke re-run is its proof.

**#137 was CLOSED by the previous work.** One new issue was filed while closing it — two tracks
that play the same program share one §5.2 pad channel, wired to whichever triggered it first
(#141). Nothing was added to the `check:orphans` allowlist.

**Honest scope notes for the track-withdrawal work:**

- **Notes already in the §7.1.4 lookahead window still sound after the delete**, up to
  `LOOKAHEAD_MS`. Inherent to a lookahead scheduler, and the §7.7 live-erase precedent; nothing
  is done about it and nothing should be.
- **The worker's `tracks` map still gains an empty entry from an `eventsDiff` for a track it
  does not hold**, because that is also how a track's FIRST diff arrives. Nothing sends one for
  a withdrawn track — the store deletes the track and its events in one `set` — so this is a
  shape, not a path.
- **A lane whose target names a deleted track goes with it whatever its scope**, and that was
  the review's first finding: the first pass reclaimed only lanes the track OWNED, while
  `recordParamGesture` writes sequence-scope ones.
- **A §7.8 lane on a target that names no channel at all** — a `program:<id>.pad:<idx>.…`
  address, or a `transport.…` one — is untouched by a track delete, correctly: it addresses
  something the track does not own.
- **`commitRecordedTake` and `removeEvents` still write `events[trackId]` back if a report
  arrives for a deleted track.** The withdrawal is what stops those arriving; the store actions
  themselves have no guard, which is pre-existing and untouched here.
- **Every regression test was proven against the code it was written to catch**, by five
  mutations: no `tracks` subscriber at all — the defect as filed (3 failures); the withdrawal
  sent from the EVENTS subscriber instead (2); a core that forgets the track and nothing else
  (3); a core that ignores the withdrawal entirely (6); and a store that keeps the deleted
  track's lanes and groove (4). Two more for the review's own findings: a store that reclaims
  only the lanes the track OWNS (1), and a dirty key naming the track's scope rather than the
  lane's (1). Two of the eight core tests are GUARDS rather than regression tests and no
  mutation moves them.
- **The defect was measured in the browser too**, by removing the sender's withdrawal and
  re-running the smoke: the step fails on the WIRE assertion — the worker scheduled both track
  ids a full lookahead after the delete — which is reached before the peak, so the master peak
  under the defect was not read.
- **Measured in a real browser**: 74/74 smoke steps at ports 5342/5343, dev and offline, no
  console errors. Deleting the louder of two tracks mid-transport took the §5.8 master peak from
  0.19070 to 0.05512 (×0.289) in the dev pass and 0.16801 to 0.04800 (×0.286) offline, left the
  survivor audible, and a `saveNow()` afterwards left no `tracks` row, no `midi_events` row, no
  `automation_points` row, no `trackGrooveIds` key, no §4.2 strip and no §5.2 channel.

**#133 was CLOSED by the previous work.** Two new issues were filed while closing it — a keygroup's
program-scope mixer sounds and nothing can edit it (#139), and a §7.8 `program:….amp` edit
leaves the Mixer's own pad fader stale until a reload (#140). Nothing was added to the
`check:orphans` allowlist.

**Honest scope notes for the pad-strip work:**

- **A §7.8 `program:<id>.pad:<idx>.amp` or `.pan` edit still leaves the Mixer's fader stale**
  until a reload (#140), and that is the reason the write-back is field-diffed rather than
  whole-strip. The values themselves are correct on both sides; only the reading is old.
- **`mute` and `solo` on a pad strip are still session state**, because §6 defines no field.
- **A keygroup's program-scope strip is still unreachable** (#139).
- **The mirror writes on the COMMIT, never on a §4.1 transient**, because `setTransient` does
  not write the store at all (issue #27). A gesture in flight reaches the graph, and reaches the
  payload when it is let go.
- **Undo does not re-mark dirty**, which is true of every commit in the project and unchanged
  here. The mirror follows the strip back on an undo; whether that reaches disk depends on the
  same rule it always did.
- **`padStripProof` leaves its imported tone sample in the library**, as `bounceMixProof`
  does. It deletes the three rows it created and reloads. It also calls `saveNow()` after the
  solo measurement, because `setSolo` marks the track dirty and §14 (aj) makes `loadProject`
  REFUSE over unsaved work — the restore would otherwise throw instead of restoring.
- **An insert REORDER on a TRACK strip is still unsaved.** `InsertPanel.moveSlot` calls
  `upsertChannel`, a bare `set` that records no undo entry and marks nothing dirty. The pad
  case is covered because `applyPadStripEdit` marks the program itself; the track case is
  pre-existing and untouched here.
- **Every regression test was proven against the code it was written to catch**, by five
  mutations: no write-back at all — the defect as filed (8 failures); the pre-fix publish, on an
  active-program change alone (16, and the 5 that pass are the guards); a `padStripEdit` that
  copies the whole strip (7); a `padWithStripEdit` that never hands the same pad back (1); and
  a write-back through the undoable `updateProgram` (1, after the undo assertion was
  strengthened to read BOTH stores — it passed before, which is what said the assertion was too
  weak).

**#134 was CLOSED by the previous work.** One new issue was filed while closing it — a §7.8 lane on a §6
sound-design parameter still renders as nothing (#138), listed below. Nothing was added to the
`check:orphans` allowlist; one entry's export (`resolveEffectivePoints`) became module-private
instead.

**#141, #138, #137, #135, #134, #133, #132 and #131 are CLOSED**, and #139, #140, #142, #143
and #144 remain open.

**Nearest neighbours now, in rough order of how much they cost a musician:**

- **#144** the §5.4 end-of-buffer declick fades from the NOTE-ON rather than from 3 ms before
  the region end, so every voice decays across its whole length. `scheduleAmpDeclick` uses
  `cancelAndHoldAtTime` as an anchor and that method inserts nothing when no event stands at or
  after the cancel time. Audible on every voice, live and in every §9.5 bounce, and a fix means
  the caller supplying the level the fade departs from. Found profiling the amp gain of a
  bounced hit while closing #138.
- **#142** `removeInsert` drops the slot from the array rather than emptying it, so every §7.8
  address behind the removed one shifts onto a different effect.
- **#143** a §7.8 lane on `program:<id>.pad:<idx>.amp.attack` or `…amp.release` reaches
  nothing: `programParamChange` maps neither, so both are inert live and render as nothing.
  An AHDSR is applied at note-on, so there is no param to sum onto.
- **#140** a §7.8 `program:<id>.pad:<idx>.amp` or `.pan` edit changes the pad and the graph and
  leaves the Mixer's own fader showing the old position until a reload. Two registered §7.8
  addresses reach one value and only the mixer side writes through; the publish deliberately
  never clobbers an existing strip, which is what leaves the reading stale. No data is lost.
- **#139** a keygroup program's §6 program-scope `mixer` and `inserts` sound — `ensureProgramChannel`
  seeds the channel from the payload — and no surface can edit them: §8.5.6 renders no strip for a
  keygroup, `padStripsForProgram` publishes none, and the §7.8 address resolves to nothing.
- **#13** the Phase 8 live-hardware sign-off, which needs the human developer.

**Honest scope notes for the bounce-mixer work:**

- **A bounce is now 3 dB quieter per channel than it used to be, and that is the fix.** A mono
  sample reaching `destination` through a bare gain stayed mono; through the §5.2 pad strip it
  passes an equal-power `StereoPannerNode` at centre. Measured 0.13638 → 0.09644 RMS, exactly
  1/√2. The new number is what the live engine produces for the same hit.
- **`rampParamLinear`'s new anchor changes LIVE behaviour, deliberately.** Automation ramps now
  start from where the contour actually is rather than from a reading up to `LOOKAHEAD_MS` old,
  and a live gesture now supersedes automation queued ahead of the playhead. One existing
  assertion in `paramGuards.test.ts` pinned the scheduling call rather than the behaviour and was
  corrected rather than added to.
- **A §7.8 lane on a per-voice §6 parameter still renders as nothing** — issue #138 above.
- **A pad channel is seeded from the §6 payload and then overwritten by the §4.2 store where a
  strip exists.** For a pad of a program that is not the active one, `programSync` has published
  no strip and the payload is the only value there is. Since #133 the two carry the same numbers,
  so the order can no longer matter.
- **Nothing bounds the number of automation events a long song schedules.** The
  `OfflineAudioContext` buffer dominates long before the event count matters — a §7.9 playlist at
  `MAX_SONG_SEGMENTS` is over 55 hours, ~76 GB of float samples — so the browser's own allocation
  failure is the limit, exactly as it was before this work.
- **A stem still renders THROUGH the master bus**, at unity with no inserts, rather than tapping
  the track strip directly. That is what keeps the topology identical across variants; it costs
  three pass-through gains and a centred panner, none of which changes the signal.
- **A §7.8 lane could still address a slot the §1.3.1 limit forbids** (#135), which §14 (au)
  has since closed by bounding where a slot may be CREATED. What this work changed is that
  slots 1 to 8 mean what they say.
- **Every regression test was proven against the code it was written to catch**, by six
  mutations: a `bounceIncludesChannel` that admits everything (2 failures), a valueTick that
  ignores the song track scope (1), a `laneForTarget` that ignores lane ownership (2), the old
  stale ramp anchor (3), the compacted 0-based insert chain (3), and an `applyInserts` that
  filters empty slots out again (1).
- **Measured in a real browser**: 13/13 driver checks at port 5344 and 70/70 smoke steps at
  5342/5343 (up from 69), no console errors. Nine bounces of one bar carrying four hits of a
  1 kHz tone, each read back from `/bounces/` over real OPFS: a −12 dB fader rendered ×0.251, a
  hard-right pan left 0.00000 in the left channel, a 100 Hz lowpass insert left ×0.018, an open
  send returned 0.1508 RMS into a silent beat gap, a master lane climbed 0.0013 → 0.0485, an
  `insert:…:slot1.cutoff` lane on an `exp` curve climbed 0.0008 → 0.1330, and a master strip cut
  to −42 dB and lowpassed left ×0.0001 of the mix while the STEM rendered ×1.000 of the
  pre-master mix and kept its own send return. **Against the unfixed build every render was
  identical at 0.13638 RMS**, and the 12 checks that existed at that point failed 9 of 12; the
  three that passed are the anti-over-correction guards. The thirteenth, the insert-parameter
  lane, came from the review and was measured against the compacted insert chain instead — it
  rendered 0.0005 flat there. One smoke step is new and permanent.

**Honest scope notes for the sequence-filter work:**

- **The `null` active-sequence branch is unreachable in a loaded project**, so its two tests pin a
  decision rather than a path the user can walk. `hydrate` activates the first sequence row and
  `deleteSequence` refuses to remove the last. It is written down because the issue asked for it
  to be decided explicitly, and because the permissive reading was what made every track sound.
- **Note repeat, the arpeggiator and recording capture are unfiltered**, and that is a judgement
  rather than an oversight. Each is driven by a live gesture carrying its own `trackId`, and the
  input layer already scopes the gesture; the case a filter would change is a user switching
  sequence with a pad still held, which is not a case §7.3 or §7.7 describes.
- **Live erase still applies to the LOOKAHEAD window**, unchanged by this work — see the
  entry-index notes below. The filter narrows WHICH tracks a sweep reaches, not when.
- **The review found two defects BEHIND this one**, both fixed here and both about a switch of
  active sequence being COMPLETE rather than about which tracks it selects: the implicit loop
  was never re-derived, and `lastLoopPass` was never re-based. Neither was reachable as a
  distinct symptom while every sequence played at once. Both were measured before being fixed —
  a switch to a 4-bar sequence pushed no new loop at all, and widening a 1-bar loop to 4 bars
  after five passes reported 0 wraps over the next 32 seconds where 4 occur.
- **Every regression test was proven against the unfixed code**: 5 of the 6 assertions in
  `sequenceFilter.test.ts` fail against it, and the sixth is the anti-over-correction guard that
  must keep passing — song mode still plays every segment's own sequence. The `sequencerSync`
  assertion is the same kind of guard on the other side of the wire. The §11.4 smoke step was
  proven the same way, against a build whose predicate was mutated to return true: it failed with
  "4 tracks sounded in sequence mode — only the active sequence's may". The three review fixes
  add three more failing-first tests: two in `sequencerSync.test.ts` and one in
  `sequenceFilter.test.ts`.
- **Measured in a real browser**: 69/69 smoke steps at ports 5342/5343, no console errors, up from 67. Two one-bar sequences carrying the SAME pad on the same four beats scheduled one track of
  the two; switching the active sequence mid-transport, with `sequenceMeta` the only message sent,
  moved playback to the other track at the next window; and a held erase swept ticks 960 and 1920
  out of the active sequence and left the other sequence's bar whole. Against the mutated build
  four tracks sounded. One smoke step is new and permanent.

**Honest scope notes for the insert-defaults work:**

- **A pad's insert chain is completed in the MIXER store, not in the program payload.** §6
  `Pad.inserts` reach the graph through `programSync` → `upsertChannel`, which completes them, and
  the payload itself keeps whatever it holds. That is consistent and self-healing on every load —
  and since #133 the mirror carries the completed record into the payload with the slot.
- **`createInsert`'s merge is now dead weight for the application** and load-bearing only for the
  §11.2 offline render helpers, which legitimately pass a partial record. Removing it would break
  those; keeping it costs one object spread per insert built.
- **A key an effect does not declare survives the completion.** It is inert — the panel iterates
  `EFFECT_PARAM_RANGES` and each core reads its params by name — and dropping it would discard
  something a project carries.
- **The range-floor fallbacks are still in the source**, in `InsertPanel`, `readScalar` and
  `XyfxMode`. Nothing reaches them for an occupied slot; the tests say so, the `??` does not.
- **Every regression test was proven against the unfixed code**: 8 of `insertDefaults.test.ts`'s
  10 assertions fail there, and the two that do not are guards that pass trivially against code
  completing nothing. Three EXISTING tests pinned the defect and were corrected rather than added
  to — two asserted `params` `toEqual({})` after a replace, and `InsertPanel.test.tsx` asserted
  the three range floors as `aria-valuetext`.
- **`touchedToMs` in the §11.4 proof is a vacuity guard, not a regression assertion.** It reads
  600 ms on the unfixed build too; what it catches is a gesture that reached nothing, which is
  how the undo check could otherwise pass while proving nothing (#135).
- **Measured in a real browser**: 6/6 driver checks at port 5344 and 67/67 smoke steps at
  5342/5343 (up from 63), no console errors. A fresh delay, the same delay after a save and a real
  `loadProject`, and one whose `projects.payload` was rewritten to `params: {}` the way a build
  before this fix wrote it, all read 350.0 ms and echoed at 350.0 ms; the §8.5.6 panel announced
  "350 ms" and "35 %". **Against the unfixed store all three read 1.0 ms and echoed at 350.0 ms**,
  the first touch committed 600 ms and the undo returned the delay to **1 ms** — a value it had
  never held — and the panel announced "1 ms" and "0 %".

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

`npm run type-check` · `lint` · `test` (**1983**) · `format:check` · `verify` (**no open stubs**)
· `test:e2e` (dev + offline, **80/80 steps**, ports overridden per #105) · `build` ·
`build:wasm` · `build:factory`.
