/**
 * Browser micro-preview (spec §8.5.7) — the small waveform beside a sample row.
 *
 * It reads the cached §8.5.4 peak pyramid rather than decoding the sample itself, and only asks
 * for it once the row is actually near the viewport. Both matter: a library directory can hold
 * hundreds of samples, and eagerly decoding every one to draw a 64 px thumbnail would breach §3.3
 * (heavy work off the main thread) and the §11.5 runtime budgets. Once a pyramid is cached, a
 * re-scroll past the same row costs nothing.
 */
import { useEffect, useRef, useState } from 'react';
import type { PeakPyramid } from '@/core/audio/peakPyramid';
import { getPeakPyramid } from '@/core/audio/peakPyramidCache';
import { WaveformCanvas } from '@/ui/primitives/WaveformCanvas';

/** How far outside the viewport a row starts loading, so scrolling reveals a drawn waveform. */
const PRELOAD_MARGIN = '128px';

const THUMB_HEIGHT = 20;

interface SampleWaveformThumbProps {
  readonly opfsPath: string;
}

export function SampleWaveformThumb({ opfsPath }: SampleWaveformThumbProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [pyramid, setPyramid] = useState<PeakPyramid | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    setPyramid(null);

    const load = () => {
      void getPeakPyramid(opfsPath)
        .then((built) => {
          if (!cancelled) setPyramid(built);
        })
        // A thumbnail is an affordance, not data — the row still works without it.
        .catch(() => {});
    };

    // Environments without IntersectionObserver (jsdom) just load; correctness over laziness.
    if (typeof IntersectionObserver !== 'function') {
      load();
      return () => {
        cancelled = true;
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect(); // one shot — the pyramid is cached from here on
        load();
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [opfsPath]);

  return (
    <span ref={hostRef} className="shrink-0" data-testid="sample-waveform-thumb">
      <WaveformCanvas
        pyramid={pyramid}
        height={THUMB_HEIGHT}
        decorative
        className="w-16 rounded-bb-sm border border-bb-line"
      />
    </span>
  );
}
