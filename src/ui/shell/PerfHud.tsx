/**
 * PerfHud — the dev-only performance HUD (spec §11.5): frame time, an audio underrun
 * counter derived from `audioContext.outputLatency` monitoring, and the live voice count,
 * toggled with a keyboard shortcut.
 *
 * The HUD is the one place in the app that legitimately samples per-frame data, so it
 * follows the same discipline it exists to police: the rAF loop writes text straight into
 * refs and React re-renders only when the HUD is shown or hidden (spec §3.3).
 *
 * It is compiled out of production builds — `import.meta.env.DEV` is statically false
 * there, so the component tree-shakes away rather than shipping dead diagnostics.
 */
import { useEffect, useRef, useState } from 'react';
import { getAudioEngine } from '@/core/project/session';
import { IconPerf } from '@/ui/icons';

/** Toggle shortcut — Ctrl+Shift+P, chosen to avoid clashing with browser shortcuts. */
const TOGGLE_KEY = 'p';
/** A frame slower than this is counted as a dropped frame against the 60 fps budget. */
const FRAME_BUDGET_MS = 1000 / 60;
/** Output latency rising by more than this between samples suggests an underrun. */
const UNDERRUN_LATENCY_JUMP = 0.005;

export function PerfHud() {
  const [visible, setVisible] = useState(false);
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const droppedRef = useRef<HTMLSpanElement | null>(null);
  const underrunRef = useRef<HTMLSpanElement | null>(null);
  const voicesRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey) return;
      if (event.key.toLowerCase() !== TOGGLE_KEY) return;
      event.preventDefault();
      setVisible((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let frame = 0;
    let last = performance.now();
    let dropped = 0;
    let underruns = 0;
    let lastLatency = getAudioEngine()?.context.outputLatency ?? 0;
    let accumulated = 0;
    let samples = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const delta = now - last;
      last = now;
      accumulated += delta;
      samples += 1;
      if (delta > FRAME_BUDGET_MS * 1.5) dropped += 1;

      const engine = getAudioEngine();
      if (engine) {
        const latency = engine.context.outputLatency ?? 0;
        // A sudden jump in reported output latency is the observable signature of the
        // audio thread having missed its deadline (spec §11.5 underrun counter).
        if (latency - lastLatency > UNDERRUN_LATENCY_JUMP) underruns += 1;
        lastLatency = latency;
      }

      // Update the text ~5×/second; a per-frame DOM write would itself cost frames.
      if (accumulated >= 200) {
        const average = accumulated / samples;
        if (frameRef.current) frameRef.current.textContent = `${average.toFixed(1)} ms`;
        if (droppedRef.current) droppedRef.current.textContent = String(dropped);
        if (underrunRef.current) underrunRef.current.textContent = String(underruns);
        if (voicesRef.current) {
          voicesRef.current.textContent = String(engine?.voicePool.activeVoiceCount() ?? 0);
        }
        accumulated = 0;
        samples = 0;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  if (!import.meta.env.DEV || !visible) return null;

  return (
    <aside
      aria-label="Performance heads-up display"
      data-testid="perf-hud"
      className="pointer-events-none fixed right-3 bottom-3 z-40 flex flex-col gap-1 rounded-bb-md border border-bb-line bg-bb-surface/95 px-3 py-2 font-mono text-[0.625rem] text-bb-text shadow-bb-raised"
    >
      <span className="flex items-center gap-1.5 font-sans font-bold text-bb-accent">
        <IconPerf size={12} aria-hidden="true" />
        Performance
      </span>
      <span>
        Frame: <span ref={frameRef}>—</span>
      </span>
      <span>
        Dropped: <span ref={droppedRef}>0</span>
      </span>
      <span>
        Underruns: <span ref={underrunRef}>0</span>
      </span>
      <span>
        Voices: <span ref={voicesRef}>0</span>
      </span>
      <span className="font-sans text-bb-muted">Ctrl+Shift+P to hide</span>
    </aside>
  );
}
