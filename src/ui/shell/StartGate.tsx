/**
 * StartGate — the autoplay-policy gate (spec §5.1): "the UI presents an explicit styled
 * Start screen/button; `audioContext.resume()` is called from that user gesture before any
 * audio code runs". Worklet modules and DSP wasm load during the gate with a progress
 * indicator, and failures render actionable errors rather than console noise.
 *
 * The gate also listens for `statechange` and re-surfaces if the context is externally
 * suspended (spec §5.1) — the browser can suspend a context when a device changes or the
 * page is backgrounded, and the app must not silently go mute.
 *
 * Children mount only once the engine is running, so no mode can touch the graph before
 * the worklets exist.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AudioEngine } from '@/core/audio/engine';
import { startAudioEngine } from '@/core/project';
import { installAudioProbe } from '@/ui/audioProbe';
import { IconPlay, IconPower, IconWarning } from '@/ui/icons';

type GateStatus = 'idle' | 'starting' | 'running' | 'suspended' | 'failed';

export function StartGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);

  // Re-surface the gate whenever the context leaves the running state (spec §5.1).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const onStateChange = () => {
      setStatus(engine.context.state === 'running' ? 'running' : 'suspended');
    };
    engine.context.addEventListener('statechange', onStateChange);
    return () => engine.context.removeEventListener('statechange', onStateChange);
  }, [status]);

  const start = useCallback(async () => {
    setStatus('starting');
    setError(null);
    try {
      const engine = await startAudioEngine();
      engineRef.current = engine;
      installAudioProbe(engine); // the smoke's §11.4 test seam
      setStatus('running');
    } catch (cause) {
      // Actionable error, not console noise (spec §5.1).
      setError(cause instanceof Error ? cause.message : 'The audio engine could not start.');
      setStatus('failed');
    }
  }, []);

  const resume = useCallback(() => {
    void engineRef.current?.context.resume();
  }, []);

  if (status === 'running') return <>{children}</>;

  const suspended = status === 'suspended';
  const busy = status === 'starting';

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-bb-bg p-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-3xl font-bold tracking-tight">
          Banger<span className="text-bb-accent">Box</span>
        </h1>
        <p className="text-xs text-bb-muted">v{__APP_VERSION__}</p>
      </div>

      <p className="max-w-md text-sm leading-relaxed text-bb-muted">
        {suspended
          ? 'Audio was suspended by the browser or the system. Resume to continue playing.'
          : 'Browsers require a tap before audio can start. Starting loads the audio worklets and DSP modules.'}
      </p>

      <button
        type="button"
        data-testid={suspended ? 'audio-resume' : 'audio-start'}
        disabled={busy}
        onClick={() => (suspended ? resume() : void start())}
        className="inline-flex items-center gap-2 rounded-bb-md bg-bb-accent px-6 py-3 text-sm font-bold text-bb-bg transition-colors duration-150 ease-bb-snap hover:bg-bb-accent-strong disabled:opacity-60"
      >
        {suspended ? <IconPower size={18} aria-hidden="true" /> : <IconPlay size={18} aria-hidden="true" />}
        {busy ? 'Starting…' : suspended ? 'Resume audio' : 'Start BangerBox'}
      </button>

      {/* Progress/status indicator for the gate's loading work (spec §5.1). */}
      <p
        data-testid="audio-engine-status"
        data-status={status}
        aria-live="polite"
        className="text-xs text-bb-muted"
      >
        {busy ? 'Loading worklets and DSP kernels…' : suspended ? 'Suspended' : 'Ready to start'}
      </p>

      {error && (
        <p
          role="alert"
          className="flex max-w-md items-start gap-2 rounded-bb-md border border-bb-danger bg-bb-surface px-4 py-3 text-left text-xs text-bb-text"
        >
          <IconWarning size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-bb-danger" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
