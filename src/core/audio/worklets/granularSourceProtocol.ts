/**
 * Shared protocol for the §5.7.9 warp source worklet — the processor-options and port
 * message shapes exchanged between the voice pool and {@link granularSource.worklet.ts}.
 * Kept in a plain module so both sides import one definition (spec §2.5) and the names
 * never drift (naming freeze, §13.6), exactly as `dspEffectProtocol` does for the inserts.
 */

export const GRANULAR_SOURCE_PROCESSOR = 'granular-source';

/** The §6 `detune` parameter, in cents — the same units an `AudioBufferSourceNode` uses. */
export const GRANULAR_SOURCE_DETUNE = 'detune';

export interface GranularSourceProcessorOptions {
  /** Precompiled `granularStretch` module transferred via processorOptions (spec §5.6.2). */
  module: WebAssembly.Module;
  /**
   * The region to play, one array per channel, ALREADY trimmed and (if the §6 layer asks
   * for it) reversed. Passing the trimmed region rather than the whole sample keeps the
   * structured clone — and the kernel's own copy of it — to what the voice actually sounds.
   */
  channels: Float32Array[];
  /** Time-stretch factor (spec §5.7.9): 1 keeps the region's own duration. */
  rate: number;
  /**
   * Context time the voice begins, resolved to a frame inside the processor so a scheduled
   * note starts on its exact sample rather than on the next quantum boundary. A worklet
   * source has no `start(when)` of its own, and the scheduler routinely places a note up to
   * `LOOKAHEAD_MS` ahead (spec §7.1.4) — without this the kernel would have consumed the
   * first tenth of a second of the region before the note was due to sound.
   */
  startTime: number;
  /** Render-quantum size the per-channel kernel pre-allocates for (spec §5.5). */
  maxBlock: number;
}

/** Free the per-channel kernel memory before the node is disconnected (spec §5.6.3). */
export interface GranularSourceDisposeMessage {
  kind: 'dispose';
}

/**
 * Cut the source short at a context time — the §5.4 steal, choke and release paths, which
 * on an `AudioBufferSourceNode` are `stop(when)`. Without it a stolen warp voice would keep
 * its processor running (and its kernel memory alive) until its region ran out.
 */
export interface GranularSourceStopMessage {
  kind: 'stop';
  /** Context seconds; anything at or before now stops on this quantum. */
  when: number;
}

/**
 * The region has run out, or the stop time has passed. A worklet source has no `ended`
 * event of its own, so this stands in for `AudioBufferSourceNode.onended` and drives the
 * pool's voice teardown (spec §3.2). One message per voice, at its end — well inside
 * §5.5's telemetry allowance.
 */
export interface GranularSourceEndedMessage {
  kind: 'ended';
}

export type GranularSourceMessage =
  GranularSourceDisposeMessage | GranularSourceStopMessage | GranularSourceEndedMessage;
