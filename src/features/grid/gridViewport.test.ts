/**
 * The Grid viewport (spec §3.3, §8.5.2 — issue #28). Scroll and zoom live outside React, so
 * their clamps are pure functions here rather than inline `setState` updaters, and the store
 * itself is what a wheel event writes.
 *
 * The clamps are the same arithmetic `GridMode` used to inline; these pin them so they can be
 * asserted without a canvas, a pointer, or a rendered mode (spec §2.5).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createGridViewportStore,
  DEFAULT_TICKS_PER_PIXEL,
  MAX_TICKS_PER_PIXEL,
  MIN_TICKS_PER_PIXEL,
  scrolled,
  zoomed,
  zoomFactor,
} from './gridViewport';

describe('scroll clamps (spec §8.5.2)', () => {
  it('pans the timeline and the note rows together', () => {
    const box = createGridViewportStore().get();
    const next = scrolled(box, 960, 2);
    expect(next.scrollTicks).toBe(box.scrollTicks + 960);
    expect(next.topNote).toBe(box.topNote - 2);
  });

  it('stops at the start of the timeline — there is no negative region', () => {
    const box = createGridViewportStore().get();
    expect(scrolled(box, -100_000, 0).scrollTicks).toBe(0);
  });

  it('holds the note range inside the drawable span', () => {
    const box = createGridViewportStore().get();
    expect(scrolled(box, 0, 500).topNote).toBe(11);
    expect(scrolled(box, 0, -500).topNote).toBe(127);
  });
});

describe('zoom clamps (spec §8.5.2)', () => {
  it('multiplies the zoom', () => {
    const box = createGridViewportStore().get();
    expect(zoomed(box, 2).ticksPerPixel).toBe(box.ticksPerPixel * 2);
  });

  it('stops at both ends of the legible range', () => {
    const box = createGridViewportStore().get();
    expect(zoomed(box, 1_000).ticksPerPixel).toBe(MAX_TICKS_PER_PIXEL);
    expect(zoomed(box, 1 / 1_000).ticksPerPixel).toBe(MIN_TICKS_PER_PIXEL);
  });

  it('reads as 1× at the default, which is what the readout shows', () => {
    const box = createGridViewportStore().get();
    expect(box.ticksPerPixel).toBe(DEFAULT_TICKS_PER_PIXEL);
    expect(zoomFactor(box)).toBe(1);
    expect(zoomFactor(zoomed(box, 2))).toBe(0.5);
  });
});

/**
 * Issue #28: every wheel event used to re-render `GridMode`, including the unmemoised note
 * sort in its render body, to move a canvas that painted from a ref of its own.
 */
describe('the viewport store notifies only on a real change (issue #28)', () => {
  it('carries a pan to its subscribers', () => {
    const store = createGridViewportStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.update((box) => scrolled(box, 480, 0));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().scrollTicks).toBe(480);
  });

  it('says nothing when a pan is already at the edge it is pushing against', () => {
    // A wheel held against the start of the timeline produces a stream of these. Waking every
    // subscriber for each of them is the cost this store exists to avoid.
    const store = createGridViewportStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (let event = 0; event < 20; event += 1) store.update((box) => scrolled(box, -100, 0));
    expect(listener).not.toHaveBeenCalled();
    expect(store.get().scrollTicks).toBe(0);
  });

  it('says nothing when a zoom is already at the ceiling', () => {
    const store = createGridViewportStore();
    store.update((box) => zoomed(box, 1_000));
    const listener = vi.fn();
    store.subscribe(listener);
    store.update((box) => zoomed(box, 1.5));
    expect(listener).not.toHaveBeenCalled();
  });

  it('drops a subscriber that has unsubscribed (spec §3.5 lens 5)', () => {
    const store = createGridViewportStore();
    const listener = vi.fn();
    store.subscribe(listener)();
    store.update((box) => scrolled(box, 480, 0));
    expect(listener).not.toHaveBeenCalled();
  });
});
