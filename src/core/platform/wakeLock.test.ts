import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWakeLockController, type WakeLockApi } from './wakeLock';

/** Minimal fake of the Screen Wake Lock API surface the controller uses (spec §2.4). */
function fakeWakeLockApi() {
  const released: string[] = [];
  let sentinels = 0;
  const api: WakeLockApi = {
    supported: true,
    async request() {
      sentinels += 1;
      const id = `sentinel-${sentinels}`;
      return {
        released: false,
        async release() {
          released.push(id);
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    },
  };
  return { api, released, requested: () => sentinels };
}

describe('wakeLock controller (spec §2.4)', () => {
  let fake: ReturnType<typeof fakeWakeLockApi>;

  beforeEach(() => {
    fake = fakeWakeLockApi();
  });

  it('acquires a lock while the transport is active', async () => {
    const controller = createWakeLockController(fake.api);
    await controller.setActive(true);
    expect(fake.requested()).toBe(1);
  });

  it('releases the lock when the transport stops', async () => {
    const controller = createWakeLockController(fake.api);
    await controller.setActive(true);
    await controller.setActive(false);
    expect(fake.released).toEqual(['sentinel-1']);
  });

  it('is idempotent — staying active does not stack sentinels', async () => {
    const controller = createWakeLockController(fake.api);
    await controller.setActive(true);
    await controller.setActive(true);
    await controller.setActive(true);
    expect(fake.requested()).toBe(1);
  });

  it('does nothing when the capability is absent (spec §2.1 soft requirement)', async () => {
    const controller = createWakeLockController({ supported: false, request: vi.fn() });
    await controller.setActive(true);
    expect(controller.isHeld()).toBe(false);
  });

  it('survives a rejected request without throwing — the browser may refuse', async () => {
    const controller = createWakeLockController({
      supported: true,
      request: () => Promise.reject(new Error('denied')),
    });
    await expect(controller.setActive(true)).resolves.toBeUndefined();
    expect(controller.isHeld()).toBe(false);
  });

  it('releases on dispose so a lock never outlives the page (spec §3.5 lens 5)', async () => {
    const controller = createWakeLockController(fake.api);
    await controller.setActive(true);
    await controller.dispose();
    expect(fake.released).toEqual(['sentinel-1']);
    expect(controller.isHeld()).toBe(false);
  });
});
