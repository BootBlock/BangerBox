/**
 * The Grid's zoom readout and buttons (spec §8.5.2), driven by the ref-held viewport.
 *
 * Scroll and zoom live outside React (issue #28), so these are the only things left that
 * have to show a value the canvas owns. §3.3 governs how: the readout is a **continuous**
 * value during a ctrl-wheel or pinch, so it is painted by a direct ref write and never
 * re-renders. The three buttons' `disabled` flags are **discrete** — they flip only at the
 * clamp boundaries and at the default — so they go through React state, which is what React
 * is for, and change a handful of times across a whole gesture rather than every frame.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, ValueReadout } from '@/ui/primitives';
import {
  DEFAULT_TICKS_PER_PIXEL,
  MAX_TICKS_PER_PIXEL,
  MIN_TICKS_PER_PIXEL,
  zoomed,
  zoomFactor,
  type GridViewportBox,
  type GridViewportStore,
} from './gridViewport';

/**
 * One press of a zoom button. Coarser than the wheel's 1.15 because a button press is a
 * deliberate discrete step, not a continuous scroll — the whole range is then five presses
 * from end to end rather than thirty.
 */
const ZOOM_BUTTON_STEP = 1.5;

/** Which zoom controls are unavailable at a given box — the only discrete part of it. */
interface ZoomLimits {
  readonly atMinimum: boolean;
  readonly atMaximum: boolean;
  readonly atDefault: boolean;
}

function limitsOf(box: GridViewportBox): ZoomLimits {
  return {
    atMinimum: box.ticksPerPixel <= MIN_TICKS_PER_PIXEL,
    atMaximum: box.ticksPerPixel >= MAX_TICKS_PER_PIXEL,
    atDefault: box.ticksPerPixel === DEFAULT_TICKS_PER_PIXEL,
  };
}

/** The readout text for a box — "1.00×" at the default. */
function zoomText(box: GridViewportBox): string {
  return `${zoomFactor(box).toFixed(2)}×`;
}

export interface GridZoomControlsProps {
  viewport: GridViewportStore;
}

export function GridZoomControls({ viewport }: GridZoomControlsProps) {
  const readoutRef = useRef<HTMLSpanElement | null>(null);
  // Both read the store once, at mount. A remount therefore lands on whatever zoom the user
  // left, and the render body stays pure — it never reads the mutable store itself.
  const [limits, setLimits] = useState<ZoomLimits>(() => limitsOf(viewport.get()));
  const [initialText] = useState(() => zoomText(viewport.get()));

  useEffect(
    () =>
      viewport.subscribe((box) => {
        if (readoutRef.current) readoutRef.current.textContent = zoomText(box);
        const next = limitsOf(box);
        // Only a real change re-renders; a pinch crosses no boundary for most of its length.
        setLimits((current) =>
          current.atMinimum === next.atMinimum &&
          current.atMaximum === next.atMaximum &&
          current.atDefault === next.atDefault
            ? current
            : next,
        );
      }),
    [viewport],
  );

  // Re-sync after any render, because the render pass draws `initialText` and could write it
  // back over the ref-painted value — the same re-sync `Knob` performs between gestures.
  useEffect(() => {
    if (readoutRef.current) readoutRef.current.textContent = zoomText(viewport.get());
  });

  const zoom = (factor: number) => viewport.update((box) => zoomed(box, factor));

  return (
    <div className="flex items-center gap-1">
      <ValueReadout
        label="Zoom"
        value={initialText}
        valueRef={readoutRef}
        size="sm"
        data-testid="grid-zoom-readout"
      />
      <Button
        label="Zoom out"
        size="sm"
        variant="quiet"
        disabled={limits.atMaximum}
        onClick={() => zoom(ZOOM_BUTTON_STEP)}
        data-testid="grid-zoom-out"
      />
      <Button
        label="Zoom in"
        size="sm"
        variant="quiet"
        disabled={limits.atMinimum}
        onClick={() => zoom(1 / ZOOM_BUTTON_STEP)}
        data-testid="grid-zoom-in"
      />
      <Button
        label="Reset zoom"
        size="sm"
        variant="quiet"
        disabled={limits.atDefault}
        onClick={() => viewport.update((box) => ({ ...box, ticksPerPixel: DEFAULT_TICKS_PER_PIXEL }))}
        data-testid="grid-zoom-reset"
      />
    </div>
  );
}
