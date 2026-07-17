/**
 * AudioEnginePanel — the Phase 3 minimal test UI (spec §12). The explicit Start button is
 * the autoplay-policy gate (spec §5.1): the first user gesture resumes the AudioContext,
 * loads the worklets, and swaps the sync layer onto the live graph. Once running it offers
 * a pad-grid stub (audible OPFS sample playback, §5.4), a metronome click (§5.9), a master
 * fader wired through the store → sync → graph path (§4.3), and a live master meter (§5.8).
 * The polished 12-mode surface is Phase 7; this proves the engine end to end.
 */
import { useEffect, useRef, useState } from 'react';
import type { AudioEngine } from '@/core/audio/engine';
import { startAudioEngine } from '@/core/project';
import { useMixerStore, useUIStore } from '@/store';
import { LEVEL_RANGE } from '@/core/project/schemas';
import { MeterCanvas } from './primitives/MeterCanvas';

type EngineStatus = 'idle' | 'starting' | 'running' | 'suspended';

const DEMO_PADS = [0, 1, 2, 3];

export function AudioEnginePanel() {
  const [status, setStatus] = useState<EngineStatus>('idle');
  const engineRef = useRef<AudioEngine | null>(null);
  const pushToast = useUIStore((state) => state.pushToast);
  const masterLevel = useMixerStore((state) => state.channels.master?.level ?? 1);

  useEffect(() => {
    // Re-surface the gate if the context is externally suspended (spec §5.1).
    const engine = engineRef.current;
    if (!engine) return;
    const onStateChange = () => setStatus(engine.context.state === 'running' ? 'running' : 'suspended');
    engine.context.addEventListener('statechange', onStateChange);
    return () => engine.context.removeEventListener('statechange', onStateChange);
  }, [status]);

  const start = async () => {
    setStatus('starting');
    try {
      engineRef.current = await startAudioEngine();
      setStatus('running');
    } catch (error) {
      setStatus('idle');
      pushToast(error instanceof Error ? error.message : 'The audio engine could not start.', 'error');
    }
  };

  const resume = () => {
    void engineRef.current?.context.resume();
  };

  const triggerPad = (index: number) => {
    void engineRef.current?.triggerDemoPad(80 + index * 12);
  };

  const setMaster = (value: number, commit: boolean) => {
    const store = useMixerStore.getState();
    if (commit) store.commit('master.level', value);
    else store.setTransient('master.level', value);
  };

  const running = status === 'running';

  return (
    <section aria-labelledby="audio-engine-heading" className="mt-6">
      <h3 id="audio-engine-heading" className="text-sm font-semibold">
        Audio engine
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        Sound out: start the engine (a user gesture is required), then tap a pad to play the bundled sample
        through the mixer graph. The meter shows the master level.
      </p>

      {status === 'idle' || status === 'starting' ? (
        <button
          type="button"
          data-testid="audio-start"
          onClick={() => void start()}
          disabled={status === 'starting'}
          className="mt-3 rounded-bb-md bg-bb-accent px-4 py-2 text-sm font-semibold text-bb-bg transition-colors duration-150 hover:bg-bb-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === 'starting' ? 'Starting…' : 'Start audio engine'}
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span
              data-testid="audio-engine-status"
              data-status={status}
              className={running ? 'text-sm font-semibold text-bb-ok' : 'text-sm font-semibold text-bb-warn'}
            >
              {running ? 'Running' : 'Suspended'}
            </span>
            {status === 'suspended' && (
              <button
                type="button"
                data-testid="audio-resume"
                onClick={resume}
                className="rounded-bb-sm border border-bb-line px-3 py-1 text-xs font-semibold hover:bg-bb-raised"
              >
                Resume
              </button>
            )}
          </div>

          <div className="flex items-end gap-4">
            <div>
              <p className="mb-2 text-xs font-semibold text-bb-muted">Pads</p>
              <div className="grid grid-cols-2 gap-2">
                {DEMO_PADS.map((index) => (
                  <button
                    key={index}
                    type="button"
                    data-testid={`pad-trigger-${index}`}
                    aria-label={`Trigger demo pad ${index + 1}`}
                    onClick={() => triggerPad(index)}
                    className="h-12 w-12 rounded-bb-md bg-bb-raised text-xs font-semibold text-bb-text transition-transform duration-75 active:scale-95 hover:bg-bb-line"
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col items-center gap-2">
              <p className="text-xs font-semibold text-bb-muted">Master</p>
              <MeterCanvas meterId="master" label="Master" />
              <input
                type="range"
                data-testid="master-fader"
                aria-label="Master level"
                min={LEVEL_RANGE[0]}
                max={LEVEL_RANGE[1]}
                step={0.01}
                value={masterLevel}
                onChange={(event) => setMaster(Number(event.target.value), false)}
                onPointerUp={(event) => setMaster(Number(event.currentTarget.value), true)}
                onBlur={(event) => setMaster(Number(event.currentTarget.value), true)}
                className="w-32 accent-bb-accent"
              />
            </div>

            <button
              type="button"
              data-testid="metronome-click"
              onClick={() => engineRef.current?.clickMetronome(true)}
              className="rounded-bb-sm border border-bb-line px-3 py-2 text-xs font-semibold hover:bg-bb-raised"
            >
              Metronome click
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
