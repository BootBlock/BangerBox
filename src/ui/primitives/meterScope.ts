/**
 * Shared meter rAF loop — spec §5.8 / §3.3. ONE requestAnimationFrame loop drives every
 * meter canvas (never one loop per component); it reads the meter SAB through the
 * engine's {@link MeterRegistry} and hands each subscriber its slot reading to paint.
 * Zero React re-renders: subscribers draw straight to canvas. The loop runs only while
 * both a registry is set and at least one meter is subscribed.
 */
import type { MeterReading, MeterRegistry } from '@/core/audio/metering';

type DrawFn = (reading: MeterReading) => void;

interface Subscriber {
  meterId: string;
  draw: DrawFn;
}

class MeterScope {
  private registry: MeterRegistry | null = null;
  private readonly subscribers = new Map<symbol, Subscriber>();
  private rafId: number | null = null;
  private readonly reading: MeterReading = { peakL: 0, rmsL: 0, peakR: 0, rmsR: 0 };

  /** The engine publishes its registry here on start, and null on teardown. */
  setRegistry(registry: MeterRegistry | null): void {
    this.registry = registry;
    this.updateLoop();
  }

  /** Subscribe a canvas to its meter; returns an unsubscribe (spec §3.5 lens 5). */
  subscribe(meterId: string, draw: DrawFn): () => void {
    const key = Symbol(meterId);
    this.subscribers.set(key, { meterId, draw });
    this.updateLoop();
    return () => {
      this.subscribers.delete(key);
      this.updateLoop();
    };
  }

  private updateLoop(): void {
    const shouldRun = this.registry !== null && this.subscribers.size > 0;
    if (shouldRun && this.rafId === null) {
      this.rafId = requestAnimationFrame(this.tick);
    } else if (!shouldRun && this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private readonly tick = (): void => {
    const registry = this.registry;
    if (registry) {
      for (const { meterId, draw } of this.subscribers.values()) {
        const slot = registry.slotOf(meterId);
        if (slot === undefined) continue;
        draw(registry.read(slot, this.reading));
      }
    }
    this.rafId = this.subscribers.size > 0 ? requestAnimationFrame(this.tick) : null;
  };
}

/** The single application-wide meter loop. */
export const meterScope = new MeterScope();
