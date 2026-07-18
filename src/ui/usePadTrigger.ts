/**
 * usePadTrigger — the one way a UI surface sounds a pad (spec §7.6). Modes with pads
 * (Main, Mute, Pad Perform, Program Edit) all route through this hook so the dual-path
 * rule lives in a single place: immediate audition plus a `liveNote` to the scheduler
 * worker for note repeat and record capture.
 *
 * Resolving *which* track receives the note is shared here too: the active sequence's
 * track for the active program, falling back to its first track. Without a resolvable
 * track there is nothing to sound, and the hook reports that so callers can disable their
 * pads rather than presenting dead controls (spec §3.4).
 */
import { useCallback } from 'react';
import { getAudioEngine } from '@/core/project/session';
import { useProgramStore, useSequenceStore, useTransportStore } from '@/store';

export interface PadTriggerApi {
  /** Sound a note on the resolved track. `padIndex` is the MIDI note (spec §1.3.1). */
  trigger: (note: number, velocity: number) => void;
  /** Note-off — closes the note's duration during recording (spec §7.7). */
  release: (note: number) => void;
  /** The track notes are routed to, or null when nothing can sound. */
  trackId: string | null;
}

/** The track a live note targets: the active program's track in the active sequence. */
export function resolveLiveTrackId(): string | null {
  const { activeSequenceId } = useTransportStore.getState();
  const { tracks } = useSequenceStore.getState();
  const { activeProgramId } = useProgramStore.getState();
  const inSequence = Object.values(tracks).filter(
    (track) => activeSequenceId === null || track.sequenceId === activeSequenceId,
  );
  const forProgram = inSequence.find((track) => track.programId === activeProgramId);
  return forProgram?.id ?? inSequence[0]?.id ?? null;
}

export function usePadTrigger(): PadTriggerApi {
  const activeSequenceId = useTransportStore((s) => s.activeSequenceId);
  const activeProgramId = useProgramStore((s) => s.activeProgramId);
  const tracks = useSequenceStore((s) => s.tracks);

  // Recomputed only when the routing inputs change — not per hit (spec §3.3).
  const trackId = (() => {
    const inSequence = Object.values(tracks).filter(
      (track) => activeSequenceId === null || track.sequenceId === activeSequenceId,
    );
    return inSequence.find((track) => track.programId === activeProgramId)?.id ?? inSequence[0]?.id ?? null;
  })();

  const trigger = useCallback((note: number, velocity: number) => {
    const engine = getAudioEngine();
    const target = resolveLiveTrackId();
    if (!engine || target === null) return;
    engine.triggerLiveNote(target, note, velocity, true);
  }, []);

  const release = useCallback((note: number) => {
    const engine = getAudioEngine();
    const target = resolveLiveTrackId();
    if (!engine || target === null) return;
    engine.triggerLiveNote(target, note, 0, false);
  }, []);

  return { trigger, release, trackId };
}
