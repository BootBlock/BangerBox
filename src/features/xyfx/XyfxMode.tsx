/**
 * XYFX mode — spec §8.5.10: a full-screen touch surface mapping X and Y to any two
 * registered automatable parameters, with a per-axis picker, a latch toggle (hold versus
 * release-return), and crosshair + trail rendering.
 *
 * Movements are *transient* store updates (spec §8.5.10), so dragging the surface drives
 * the graph continuously without flooding the undo stack; the gesture end commits once.
 * Only parameters the registry marks automatable can be picked (spec §7.8).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useMixerStore } from '@/store';
import {
  channelLevelPath,
  channelPanPath,
  channelSendPath,
  isAutomatable,
  parseParamTarget,
  targetRange,
} from '@/core/audio/params/registry';
import { FieldLabel, Toggle, XYSurface } from '@/ui/primitives';
import { Panel } from '@/ui/shell/Panel';

/** Fallback when a path has no registry range — the surface still stays operable. */
const UNIT_RANGE = [0, 1] as const;

interface AxisChoice {
  readonly path: string;
  readonly label: string;
}

/**
 * Assignable parameter paths, built from the live mixer channels through the registry's
 * own path builders — so the picker can only offer addresses the registry recognises
 * (spec §7.8), never a hand-written string.
 */
function assignableParams(channelIds: readonly string[]): AxisChoice[] {
  const choices: AxisChoice[] = [];
  for (const channelId of channelIds) {
    const candidates: AxisChoice[] = [
      { path: channelLevelPath(channelId), label: `${channelId} level` },
      { path: channelPanPath(channelId), label: `${channelId} pan` },
      { path: channelSendPath(channelId, 0), label: `${channelId} send 1` },
      { path: channelSendPath(channelId, 1), label: `${channelId} send 2` },
    ];
    for (const candidate of candidates) {
      if (isAutomatable(candidate.path)) choices.push(candidate);
    }
  }
  return choices;
}

export function XyfxMode() {
  const channels = useMixerStore((s) => s.channels);
  const [latch, setLatch] = useState(false);
  const [xPath, setXPath] = useState<string | null>(null);
  const [yPath, setYPath] = useState<string | null>(null);
  /** Values the axes rested at before the gesture, for the release-return behaviour. */
  const restingValues = useRef<{ x: number | null; y: number | null }>({ x: null, y: null });

  const channelIds = useMemo(() => Object.keys(channels).sort(), [channels]);
  const choices = useMemo(() => assignableParams(channelIds), [channelIds]);

  const effectiveX = xPath ?? choices[0]?.path ?? null;
  const effectiveY = yPath ?? choices[1]?.path ?? choices[0]?.path ?? null;

  /** Current value at a registry path, read from the mixer store. */
  const valueAt = useCallback(
    (path: string | null): number => {
      if (!path) return 0;
      const [, channelId, field] = path.split('.');
      const strip = channelId ? channels[channelId] : undefined;
      if (!strip || !field) return 0;
      if (field === 'level') return strip.level;
      if (field === 'pan') return strip.pan;
      if (field.startsWith('sendLevels')) {
        const index = Number(path.split('.').pop());
        return strip.sendLevels[index] ?? 0;
      }
      return 0;
    },
    [channels],
  );

  /** Range for a path, taken from the registry rather than assumed (spec §7.8). */
  const rangeAt = (path: string | null): readonly [number, number] => {
    const target = path ? parseParamTarget(path) : null;
    return (target && targetRange(target)) ?? UNIT_RANGE;
  };

  const applyTransient = useCallback(
    (xValue: number, yValue: number) => {
      const store = useMixerStore.getState();
      if (effectiveX) store.setTransient(effectiveX, xValue);
      if (effectiveY) store.setTransient(effectiveY, yValue);
    },
    [effectiveX, effectiveY],
  );

  const applyCommit = useCallback(
    (xValue: number, yValue: number) => {
      const store = useMixerStore.getState();
      if (latch) {
        // Latched: the surface holds where it was released, so commit that position.
        if (effectiveX) store.commit(effectiveX, xValue);
        if (effectiveY) store.commit(effectiveY, yValue);
      } else {
        // Release-return: snap back to where the axes rested before the gesture.
        if (effectiveX) store.commit(effectiveX, restingValues.current.x ?? xValue);
        if (effectiveY) store.commit(effectiveY, restingValues.current.y ?? yValue);
      }
      restingValues.current = { x: null, y: null };
    },
    [effectiveX, effectiveY, latch],
  );

  /** Fires for pointer *and* keyboard gestures alike, so latch behaves the same for both. */
  const beginGesture = useCallback(() => {
    restingValues.current = { x: valueAt(effectiveX), y: valueAt(effectiveY) };
  }, [effectiveX, effectiveY, valueAt]);

  const axisPicker = (id: string, label: string, value: string | null, onChange: (path: string) => void) => (
    <FieldLabel>
      {label}
      <select
        aria-label={`${label} parameter`}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        data-testid={id}
        className="max-w-56 rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 text-xs font-normal text-bb-text normal-case"
      >
        {choices.length === 0 && <option value="">No automatable parameters</option>}
        {choices.map((choice) => (
          <option key={choice.path} value={choice.path}>
            {choice.label}
          </option>
        ))}
      </select>
    </FieldLabel>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Panel
        title="XY assignment"
        actions={
          <Toggle
            label="Latch"
            pressed={latch}
            onChange={setLatch}
            size="sm"
            title="Hold the released position instead of returning to rest"
            data-testid="xyfx-latch"
          />
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          {axisPicker('xyfx-x-param', 'X axis', effectiveX, setXPath)}
          {axisPicker('xyfx-y-param', 'Y axis', effectiveY, setYPath)}
        </div>
      </Panel>

      <Panel title="XY surface" fill>
        {choices.length === 0 ? (
          <p className="text-xs text-bb-muted">
            No automatable parameters yet — start the audio engine to build the mixer graph.
          </p>
        ) : (
          <div data-testid="xyfx-surface-wrapper" className="flex min-h-0 flex-1 flex-col">
            <XYSurface
              x={{
                label: choices.find((c) => c.path === effectiveX)?.label ?? 'X',
                value: valueAt(effectiveX),
                range: rangeAt(effectiveX),
              }}
              y={{
                label: choices.find((c) => c.path === effectiveY)?.label ?? 'Y',
                value: valueAt(effectiveY),
                range: rangeAt(effectiveY),
              }}
              onTransient={applyTransient}
              onCommit={applyCommit}
              onGestureStart={beginGesture}
              fill
              data-testid="xyfx-surface"
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
