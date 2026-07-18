import { describe, expect, it } from 'vitest';
import {
  MIN_VISIBLE_FRAMES,
  clampView,
  frameToX,
  fullView,
  markerAtX,
  scrollView,
  selectionFromDrag,
  xToFrame,
  zoomView,
} from './waveformView';

describe('waveformView — editor viewport maths (spec §8.5.4 zoom, §8.4)', () => {
  describe('fullView / clampView', () => {
    it('opens on the whole sample', () => {
      expect(fullView(1000)).toEqual({ startFrame: 0, visibleFrames: 1000 });
    });

    it('never lets the window run past the end of the sample', () => {
      expect(clampView({ startFrame: 900, visibleFrames: 400 }, 1000)).toEqual({
        startFrame: 600,
        visibleFrames: 400,
      });
    });

    it('caps the span at the file length and floors it at the sample-level limit', () => {
      expect(clampView({ startFrame: 0, visibleFrames: 99_999 }, 1000).visibleFrames).toBe(1000);
      expect(clampView({ startFrame: 0, visibleFrames: 1 }, 1000).visibleFrames).toBe(MIN_VISIBLE_FRAMES);
    });

    it('does not floor the span above the length of a sample shorter than the limit', () => {
      // An 8-frame sample cannot show 16 frames; the floor must yield to the file length.
      expect(clampView({ startFrame: 0, visibleFrames: 1 }, 8)).toEqual({
        startFrame: 0,
        visibleFrames: 8,
      });
    });
  });

  describe('frameToX / xToFrame', () => {
    it('maps the window across the canvas width and back', () => {
      const view = { startFrame: 200, visibleFrames: 400 };
      expect(frameToX(200, view, 800)).toBe(0);
      expect(frameToX(400, view, 800)).toBe(400);
      expect(frameToX(600, view, 800)).toBe(800);
      expect(xToFrame(400, view, 800)).toBe(400);
    });

    it('round-trips an arbitrary frame through the pixel mapping', () => {
      const view = { startFrame: 137, visibleFrames: 913 };
      expect(xToFrame(frameToX(500, view, 640), view, 640)).toBeCloseTo(500, 6);
    });

    it('degrades to the window start on a zero-width canvas rather than dividing by zero', () => {
      expect(xToFrame(10, { startFrame: 50, visibleFrames: 100 }, 0)).toBe(50);
    });
  });

  describe('zoomView', () => {
    it('keeps the anchor frame under the same pixel column', () => {
      const view = { startFrame: 0, visibleFrames: 1000 };
      const width = 500;
      const anchor = 750;
      const before = frameToX(anchor, view, width);
      const zoomed = zoomView(view, 10_000, 0.5, anchor);
      expect(frameToX(anchor, zoomed, width)).toBeCloseTo(before, 6);
    });

    it('clamps at the ends instead of scrolling past them', () => {
      // Zooming out about a frame near the start cannot produce a negative start.
      expect(zoomView({ startFrame: 0, visibleFrames: 500 }, 1000, 4, 10).startFrame).toBe(0);
      // Nor can zooming about the final frame push the window off the end.
      const atEnd = zoomView({ startFrame: 500, visibleFrames: 500 }, 1000, 0.5, 1000);
      expect(atEnd.startFrame + atEnd.visibleFrames).toBeLessThanOrEqual(1000);
    });

    it('will not zoom in past the sample-level limit', () => {
      expect(zoomView({ startFrame: 0, visibleFrames: 32 }, 1000, 0.01, 0).visibleFrames).toBe(
        MIN_VISIBLE_FRAMES,
      );
    });
  });

  describe('scrollView', () => {
    it('translates the window and clamps at both ends', () => {
      const view = { startFrame: 400, visibleFrames: 200 };
      expect(scrollView(view, 1000, 100).startFrame).toBe(500);
      expect(scrollView(view, 1000, -9999).startFrame).toBe(0);
      expect(scrollView(view, 1000, 9999).startFrame).toBe(800);
    });
  });

  describe('selectionFromDrag', () => {
    it('orders the ends so a right-to-left drag selects the same region', () => {
      expect(selectionFromDrag(800, 200, 1000)).toEqual({ startFrame: 200, endFrame: 800 });
      expect(selectionFromDrag(200, 800, 1000)).toEqual({ startFrame: 200, endFrame: 800 });
    });

    it('clamps the ends into the sample', () => {
      expect(selectionFromDrag(-50, 5000, 1000)).toEqual({ startFrame: 0, endFrame: 1000 });
    });

    it('treats a sub-frame drag as no selection rather than an empty region', () => {
      expect(selectionFromDrag(300, 300.2, 1000)).toBeNull();
    });
  });

  describe('markerAtX', () => {
    const view = { startFrame: 0, visibleFrames: 1000 };

    it('finds the marker under the cursor within the pixel tolerance', () => {
      // 1000 frames across 500 px — marker 500 sits at x=250.
      expect(markerAtX([100, 500, 900], 252, view, 500, 6)).toBe(1);
    });

    it('returns −1 when nothing is close enough', () => {
      expect(markerAtX([100, 500, 900], 300, view, 500, 6)).toBe(-1);
    });

    it('picks the nearest when two markers are both in tolerance', () => {
      // Frames 500 and 520 land at x=250 and x=260; a press at 258 is nearer the second.
      expect(markerAtX([500, 520], 258, view, 500, 12)).toBe(1);
    });

    it('keeps the grab target a fixed pixel size as the zoom changes', () => {
      // The same 20-frame gap is far apart when zoomed in, so only one marker is in tolerance.
      const zoomed = { startFrame: 480, visibleFrames: 100 };
      expect(markerAtX([500, 520], 100, zoomed, 500, 12)).toBe(0);
    });
  });
});
