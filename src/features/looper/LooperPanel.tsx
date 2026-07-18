/**
 * Looper mode (spec §8.5, mode 8) — the Phase 6 functional capture surface (unpolished; the
 * bar-locked length, overdub, live meter ring and mic source are Phase 7 polish). It resamples
 * the master bus through the recorder worklet → ring buffer → WAV worker → OPFS (spec §8.5.8),
 * producing a sample assignable to pads/tracks. Every control is wired end to end (§3.4).
 */
import { useEffect, useRef, useState } from 'react';
import { getAudioEngine } from '@/core/project';
import type { Looper } from '@/core/audio/looper';
import { useProjectStore, useUIStore } from '@/store';
import { refreshSamples, sampleEditContext } from '../sample-edit/sampleContext';

export function LooperPanel() {
  const looperRef = useRef<Looper | null>(null);
  const [recording, setRecording] = useState(false);
  const pushToast = useUIStore((state) => state.pushToast);
  const sampleRate = useProjectStore((state) => state.sampleRate);

  useEffect(() => {
    return () => {
      looperRef.current?.destroy();
      looperRef.current = null;
    };
  }, []);

  const start = () => {
    const engine = getAudioEngine();
    if (!engine) {
      pushToast('Start the audio engine before recording the Looper.', 'warning');
      return;
    }
    looperRef.current ??= engine.createLooper();
    looperRef.current.startRecording();
    setRecording(true);
  };

  const stop = async () => {
    const looper = looperRef.current;
    if (!looper) return;
    setRecording(false);
    try {
      const row = await looper.stopRecording(sampleRate, sampleEditContext());
      await refreshSamples();
      pushToast(
        row ? 'Looper take saved as a sample.' : 'Nothing was captured.',
        row ? 'success' : 'warning',
      );
    } catch (error) {
      pushToast(error instanceof Error ? error.message : 'Looper capture failed.', 'error');
    }
  };

  return (
    <section aria-labelledby="looper-heading" className="mt-6">
      <h3 id="looper-heading" className="text-lg font-bold">
        Looper
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        Resample the master output into a new sample. Start the engine and play something, then record.
      </p>
      <div className="mt-3">
        {recording ? (
          <button
            type="button"
            data-testid="looper-stop"
            onClick={() => void stop()}
            className="rounded-bb-sm border border-bb-line bg-bb-accent/30 px-4 py-1.5 text-xs font-semibold"
          >
            Stop &amp; save
          </button>
        ) : (
          <button
            type="button"
            data-testid="looper-record"
            onClick={start}
            className="rounded-bb-sm border border-bb-line bg-bb-raised px-4 py-1.5 text-xs font-semibold"
          >
            Record
          </button>
        )}
      </div>
    </section>
  );
}
