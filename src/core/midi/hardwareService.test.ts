/**
 * Hardware service — the join between the BLE transport and the stores (spec §10.2).
 * These assertions are about *observable store state*, because that is exactly what the
 * spec constrains: a CC must reach a store action, and a connection change must be visible
 * to the UI without the transport rendering anything itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelLevelPath } from '@/core/audio/params/registry';
import { createDefaultChannelStrip, type QLinkBinding } from '@/core/project/schemas';
import { useHardwareStore, useMixerStore, useUIStore } from '@/store';
import { createHardwareService } from './hardwareService';
import type { BluetoothDeviceLike, BluetoothLike, BluetoothServerLike } from './bleTypes';

/** A minimal connectable fake peripheral (the transport's own suite covers the lifecycle). */
function fakePeripheral(name = 'ESP32 Pad Controller') {
  const characteristic = Object.assign(new EventTarget(), {
    startNotifications: vi.fn(async () => characteristic),
    stopNotifications: vi.fn(async () => characteristic),
  });
  let connected = false;
  const server: BluetoothServerLike = {
    get connected() {
      return connected;
    },
    connect: async () => {
      connected = true;
      return server;
    },
    disconnect: () => void (connected = false),
    getPrimaryService: async () => ({ getCharacteristic: async () => characteristic }),
  };
  const device = Object.assign(new EventTarget(), { id: 'dev-1', name, gatt: server });
  return {
    device: device as unknown as BluetoothDeviceLike,
    notify(bytes: number[]) {
      Object.defineProperty(characteristic, 'value', {
        value: new DataView(new Uint8Array(bytes).buffer),
        configurable: true,
      });
      characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
    },
    drop() {
      connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
}

function binding(patch: Partial<QLinkBinding> = {}): QLinkBinding {
  return {
    encoderIndex: 0,
    cc: 70,
    targetStore: 'mixer',
    targetParameterPath: channelLevelPath('master'),
    minValue: 0,
    maxValue: 1,
    curve: 'linear',
    mode: 'absolute',
    ...patch,
  };
}

function harness() {
  const peripheral = fakePeripheral();
  const bluetooth: BluetoothLike = { requestDevice: async () => peripheral.device };
  const frames: (() => void)[] = [];
  const service = createHardwareService({ bluetooth, delay: async () => {} });
  return {
    peripheral,
    service,
    frames,
    pump: () => frames.splice(0).forEach((callback) => callback()),
  };
}

/** A CC packet: header, timestamp, CC status, controller, value. */
const ccPacket = (controller: number, value: number) => [0x80, 0x80, 0xb0, controller, value];

describe('hardware service (spec §10.2)', () => {
  beforeEach(() => {
    useMixerStore.getState().setChannels({ master: createDefaultChannelStrip('master') });
    useHardwareStore.getState().setBindings([]);
    useHardwareStore.getState().setQLinkMode('project');
    useHardwareStore.getState().setConnectionState('idle');
    useUIStore.setState({ toasts: [] });
  });

  it('mirrors the connection state and device name into the hardware store', async () => {
    const rig = harness();
    await rig.service.connect();
    expect(useHardwareStore.getState().connectionState).toBe('connected');
    expect(useHardwareStore.getState().bleDeviceName).toBe('ESP32 Pad Controller');
    expect(useHardwareStore.getState().bleDeviceConnected).toBe(true);
    rig.service.dispose();
  });

  it('drives a bound mixer parameter from a real CC packet', async () => {
    useHardwareStore.getState().setBindings([binding()]);
    const rig = harness();
    await rig.service.connect();
    rig.peripheral.notify(ccPacket(70, 0));
    // The CC throttle is rAF-aligned (spec §10.4), so let a frame pass.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(useMixerStore.getState().channels.master!.level).toBe(0);
    rig.service.dispose();
  });

  it('reports a drop to the user and moves to reconnecting (spec §10.4)', async () => {
    const rig = harness();
    await rig.service.connect();
    rig.peripheral.drop();
    expect(useHardwareStore.getState().connectionState).toBe('reconnecting');
    expect(useUIStore.getState().toasts.some((toast) => toast.tone === 'warning')).toBe(true);
    rig.service.dispose();
  });

  it('notifies learn-flow listeners of the raw CC number', async () => {
    const seen: number[] = [];
    const rig = harness();
    await rig.service.connect();
    const unsubscribe = rig.service.onNextControlChange((cc) => seen.push(cc));
    rig.peripheral.notify(ccPacket(77, 64));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(seen).toEqual([77]);
    unsubscribe();
    rig.service.dispose();
  });

  it('stops notifying a learn listener once it unsubscribes', async () => {
    const seen: number[] = [];
    const rig = harness();
    await rig.service.connect();
    rig.service.onNextControlChange((cc) => seen.push(cc))();
    rig.peripheral.notify(ccPacket(77, 64));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(seen).toEqual([]);
    rig.service.dispose();
  });

  it('exposes the Q-Link runtime for the edit surface', () => {
    const rig = harness();
    expect(typeof rig.service.qLink.effectiveBindings).toBe('function');
    rig.service.dispose();
  });
});
