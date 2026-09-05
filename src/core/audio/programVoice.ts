/**
 * Program voice resolution — spec §6. Pure, dependency-free resolution of a MIDI
 * note + velocity against a Program (Drum or Keygroup) into the parameters needed to
 * sound one voice, independent of any audio node. This is the seam the engine dispatch
 * (spec §7.1.4) uses to turn a scheduled note into a real voice, and the surface the
 * §12 exit tests exercise (velocity-layer switching; keygroup pitch accuracy). All
 * maths lives here so it is exhaustively unit-testable (spec §11.1).
 *
 * Drum programs are velocity-switched: `note` is the pad index (spec §6), the layer is
 * chosen by velocity band. Keygroup programs pick a zone by key + velocity range and
 * repitch it (coupled repitch is correct by design here, spec §6):
 *   playbackRate = 2^((note − rootNote + tuneCents/100) / 12)
 * expressed as `AudioBufferSourceNode.detune` cents (1 semitone = 100 cents).
 */
import type {
  DrumProgram,
  Envelopes,
  KeygroupProgram,
  KeygroupZone,
  LfoConfig,
  ModRoute,
  Pad,
  PadFilter,
  PlaybackMode,
  Program,
  VelocityLayer,
} from '@/core/project/schemas';
import type { VoiceTriggerSpec } from './voicePool';
import { mirroredTrim } from './voiceBuffer';

/** The pad-channel mixer sub-object shared by pads and keygroup programs (spec §6). */
interface VoiceMixer {
  readonly level: number;
  readonly pan: number;
  readonly sendLevels: readonly [number, number, number, number];
}

/** Everything the voice pool needs to sound one hit, resolved from the program (spec §6). */
export interface ResolvedVoice {
  /** FK → samples table; the engine resolves it to an OPFS path (spec §9.1). */
  readonly sampleId: string;
  /**
   * The §7.8 `pitch` leaf's own value in semitones — see {@link padTuneSemitones}. It is kept
   * apart from the rest of the repitch because a §7.8 lane and a §6 edit both address exactly
   * this quantity, and the voice pool gives it a summing input of its own that every voice of
   * the pad shares (spec §6, §7.8, issue #138). Always 0 for a keygroup: no §7.8 address names
   * a keygroup's voices (its pad key is `<id>:keygroup`, which `voiceParams.padKeyFor` cannot
   * build).
   */
  readonly padTuneSemitones: number;
  /**
   * How far THIS layer's tune sits from the pad's, in cents (spec §6). §6 stores
   * `tuneSemitones` per layer and §8.5.5's layer editor sets them independently, while the
   * §7.8 leaf names one value for the pad — so the difference stays with the voice, and a lane
   * moves every layer together instead of flattening them onto each other. Always 0 for a
   * keygroup, which has no layers.
   */
  readonly layerTuneCents: number;
  /**
   * The rest of the coupled repitch in cents — a drum layer's fine tune, or a keygroup's
   * key distance plus zone tune (spec §6). This is what the §7.8 `pitch` leaf does NOT own.
   */
  readonly detuneCents: number;
  readonly gainDb: number;
  /** Non-destructive per-layer trim; 0/0 = whole sample (spec §6). */
  readonly startFrame: number;
  readonly endFrame: number;
  readonly reverse: boolean;
  readonly playbackMode: PlaybackMode;
  readonly chokeGroup: number;
  readonly warp: boolean;
  readonly filter: PadFilter;
  readonly envelopes: Envelopes;
  readonly pitchEnvSemitones: number;
  readonly lfos: readonly [LfoConfig, LfoConfig];
  readonly modMatrix: readonly ModRoute[];
  readonly mixer: VoiceMixer;
  /** Graph channel the voice merges into (spec §4.2 / §5.2 stage 5). */
  readonly channelId: string;
  /** Pad channel key `${programId}:${padIndex}` for choke/mono grouping (spec §5.4). */
  readonly padKey: string;
  readonly note: number;
  readonly velocity: number;
  /** Keygroup-only: voices this program may sound at once (spec §6); undefined for drums. */
  readonly polyphony?: number;
  /** Keygroup-only: mono glide time in ms (0 = off, spec §6); undefined for drums. */
  readonly glideMs?: number;
}

/**
 * The §7.8 `pitch` leaf's value for a pad, in semitones (spec §6, §7.8).
 *
 * `writePadLeaf` moves `tuneSemitones` on EVERY layer together, so the leaf names a value that
 * belongs to the pad; §6 nonetheless stores one per layer and §8.5.5's layer editor sets them
 * independently. The FIRST layer is the pad's, which is what `syncLayer/programParams`
 * publishes as the leaf's current value — this is the one place that rule is written down, so
 * the value a lane moves and the value a voice is built against cannot disagree.
 */
export function padTuneSemitones(pad: Pad): number {
  return pad.layers[0]?.tuneSemitones ?? 0;
}

/** Graph channel id for a program's pad (drum) or program-scope voice (keygroup) — spec §4.2. */
export function programChannelId(programId: string, padIndex: number): string {
  return `pad:${programId}:${padIndex}`;
}

/**
 * The velocity layer for `velocity`, or null if none matches (spec §6: layers are
 * velocity-switched and may not overlap). The first band containing the velocity wins.
 */
export function selectVelocityLayer(
  layers: readonly VelocityLayer[],
  velocity: number,
): VelocityLayer | null {
  for (const layer of layers) {
    if (velocity >= layer.velocityStart && velocity <= layer.velocityEnd) return layer;
  }
  return null;
}

/**
 * The keygroup zone covering `note` + `velocity`, or null if none matches (spec §6:
 * zones extend the layer idea across the keyboard). The first covering zone wins.
 */
export function selectKeygroupZone(
  zones: readonly KeygroupZone[],
  note: number,
  velocity: number,
): KeygroupZone | null {
  for (const zone of zones) {
    if (
      note >= zone.lowNote &&
      note <= zone.highNote &&
      velocity >= zone.lowVelocity &&
      velocity <= zone.highVelocity
    ) {
      return zone;
    }
  }
  return null;
}

/** Coupled-repitch detune for a keygroup note in cents (spec §6). */
export function keygroupDetuneCents(note: number, zone: KeygroupZone): number {
  return (note - zone.rootNote) * 100 + zone.tuneCents;
}

/** Resolve a drum-program hit (note = pad index, spec §6), or null if nothing sounds. */
export function resolveDrumVoice(program: DrumProgram, note: number, velocity: number): ResolvedVoice | null {
  const pad = program.pads.find((candidate) => candidate.padIndex === note);
  if (pad === undefined) return null;
  const layer = selectVelocityLayer(pad.layers, velocity);
  if (layer === null) return null;
  return drumVoice(program.id, pad, layer, note, velocity);
}

function drumVoice(
  programId: string,
  pad: Pad,
  layer: VelocityLayer,
  note: number,
  velocity: number,
): ResolvedVoice {
  const padTune = padTuneSemitones(pad);
  return {
    sampleId: layer.sampleId,
    padTuneSemitones: padTune,
    layerTuneCents: (layer.tuneSemitones - padTune) * 100,
    detuneCents: layer.tuneCents,
    gainDb: layer.gainDb,
    startFrame: layer.startFrame,
    endFrame: layer.endFrame,
    reverse: layer.reverse,
    playbackMode: pad.playbackMode,
    chokeGroup: pad.chokeGroup,
    warp: pad.warp,
    filter: pad.filter,
    envelopes: pad.envelopes,
    pitchEnvSemitones: pad.pitchEnvSemitones,
    lfos: pad.lfos,
    modMatrix: pad.modMatrix,
    mixer: pad.mixer,
    channelId: programChannelId(programId, pad.padIndex),
    padKey: `${programId}:${pad.padIndex}`,
    note,
    velocity,
  };
}

/** Resolve a keygroup-program hit (zone + coupled repitch, spec §6), or null. */
export function resolveKeygroupVoice(
  program: KeygroupProgram,
  note: number,
  velocity: number,
): ResolvedVoice | null {
  const zone = selectKeygroupZone(program.zones, note, velocity);
  if (zone === null) return null;
  return {
    sampleId: zone.sampleId,
    padTuneSemitones: 0,
    layerTuneCents: 0,
    detuneCents: keygroupDetuneCents(note, zone),
    gainDb: zone.gainDb,
    startFrame: 0,
    endFrame: 0,
    reverse: false,
    // Glide implies monophonic legato retrigger; without glide a keygroup is polyphonic.
    playbackMode: program.glideMs > 0 ? 'mono' : 'poly',
    chokeGroup: 0,
    warp: false,
    filter: program.filter,
    envelopes: program.envelopes,
    pitchEnvSemitones: 0,
    lfos: program.lfos,
    modMatrix: program.modMatrix,
    mixer: program.mixer,
    // A keygroup has one program-scope voice channel (index 0) — spec §4.2.
    channelId: programChannelId(program.id, 0),
    padKey: `${program.id}:keygroup`,
    note,
    velocity,
    polyphony: program.polyphony,
    glideMs: program.glideMs,
  };
}

/** Resolve any program hit to its voice parameters, or null if nothing sounds (spec §6). */
export function resolveVoice(program: Program, note: number, velocity: number): ResolvedVoice | null {
  return program.type === 'drum'
    ? resolveDrumVoice(program, note, velocity)
    : resolveKeygroupVoice(program, note, velocity);
}

/** Runtime particulars a {@link ResolvedVoice} needs to become a voice-pool trigger (spec §6). */
export interface VoiceTriggerParams {
  readonly id: string;
  /**
   * The decoded sample, ALREADY reversed when `resolved.reverse` is set (spec §6). Web Audio
   * has no reverse flag, so a reversed layer plays a reversed copy of its buffer and the trim
   * is mirrored to match — see {@link mirroredTrim}. `voiceBuffer.ReversedBufferCache` is the
   * one place that reversal happens, so both the live engine and the §9.5 bounce share it.
   */
  readonly buffer: AudioBuffer;
  readonly destination: AudioNode;
  readonly when: number;
  readonly velocity: number;
  readonly programId: string;
  /** Transport tempo a §6 tempo-synced LFO locks to (spec §7.2); omitted = project default. */
  readonly bpm?: number;
}

/**
 * Map a resolved §6 voice + runtime particulars to a voice-pool trigger spec (spec §5.4).
 * The §7.8 `pitch` leaf's own share of the repitch travels in `tuneSemitones` and the rest in
 * `tuneCents`, because the pool puts the first on a summing input the whole pad shares and
 * the second inside the voice (issue #138); the layer trim and the §6 sound-design
 * surface (filter, envelopes, LFOs, mod matrix, polyphony, glide, warp) are forwarded so the
 * pool builds the voice.
 *
 * A reversed layer arrives here as a reversed BUFFER plus its original trim, and the trim is
 * mirrored into that buffer's own frame numbering. Reversing the whole sample and then
 * applying the trim unchanged would play a different part of it entirely.
 * Shared by the engine dispatcher and the offline pitch renders so they never diverge.
 */
export function resolvedVoiceToTrigger(
  resolved: ResolvedVoice,
  params: VoiceTriggerParams,
): VoiceTriggerSpec {
  const trim = resolved.reverse
    ? mirroredTrim(params.buffer.length, resolved.startFrame, resolved.endFrame)
    : { startFrame: resolved.startFrame, endFrame: resolved.endFrame };
  return {
    id: params.id,
    buffer: params.buffer,
    destination: params.destination,
    when: params.when,
    velocity: params.velocity,
    playbackMode: resolved.playbackMode,
    chokeGroup: resolved.chokeGroup,
    programId: params.programId,
    padKey: resolved.padKey,
    amp: resolved.envelopes.amp,
    gainDb: resolved.gainDb,
    tuneSemitones: resolved.padTuneSemitones,
    layerTuneCents: resolved.layerTuneCents,
    tuneCents: resolved.detuneCents,
    startFrame: trim.startFrame,
    endFrame: trim.endFrame,
    warp: resolved.warp,
    filter: resolved.filter,
    pitchEnv: resolved.envelopes.pitch,
    filterEnv: resolved.envelopes.filter,
    pitchEnvSemitones: resolved.pitchEnvSemitones,
    lfos: resolved.lfos,
    modMatrix: resolved.modMatrix,
    programPolyphony: resolved.polyphony,
    glideMs: resolved.glideMs,
    bpm: params.bpm,
  };
}
