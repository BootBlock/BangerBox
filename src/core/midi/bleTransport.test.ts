/**
 * BLE transport tests — spec §10.1 (service/characteristic, notifications) and §10.4
 * (connection lifecycle, auto-reconnect with backoff). These are the §12 Phase 8
 * "simulated-stream jitter/reconnect tests": a fake GATT stack stands in for
 * `navigator.bluetooth`, so the whole lifecycle is exercised without hardware.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BLE_MIDI_CHARACTERISTIC_UUID,
  BLE_MIDI_SERVICE_UUID,
  BleMidiTransport,
  RECONNECT_ATTEMPTS,
} from './bleTransport';
import type {
  BluetoothCharacteristicLike,
  BluetoothDeviceLike,
  BluetoothLike,
  BluetoothServerLike,
  BluetoothServiceLike,
} from './bleTypes';
import type { MidiMessage } from './parser';

/** A fake BLE-MIDI peripheral: notifies characteristic values and can drop its link. */
function fakeDevice(name = 'ESP32 Pad Controller') {
  const characteristic = new EventTarget() as EventTarget & BluetoothCharacteristicLike;
  Object.assign(characteristic, {
    startNotifications: vi.fn(async () => characteristic),
    stopNotifications: vi.fn(async () => characteristic),
  });

  const requestedServices: string[] = [];
  const requestedCharacteristics: string[] = [];
  const service: BluetoothServiceLike = {
    getCharacteristic: async (uuid) => {
      requestedCharacteristics.push(uuid);
      return characteristic;
    },
  };

  let connected = false;
  let connectShouldFail = 0;
  const device = new EventTarget() as EventTarget & { id: string; name: string; gatt: BluetoothServerLike };
  const server: BluetoothServerLike = {
    get connected() {
      return connected;
    },
    connect: async () => {
      if (connectShouldFail > 0) {
        connectShouldFail--;
        throw new Error('GATT connect failed');
      }
      connected = true;
      return server;
    },
    disconnect: () => {
      connected = false;
    },
    getPrimaryService: async (uuid) => {
      requestedServices.push(uuid);
      return service;
    },
  };
  Object.assign(device, { id: 'dev-1', name, gatt: server });

  return {
    device: device as unknown as BluetoothDeviceLike,
    characteristic,
    requestedServices,
    requestedCharacteristics,
    isConnected: () => connected,
    failNextConnects(count: number) {
      connectShouldFail = count;
    },
    /** Push one BLE packet to the subscriber, as the peripheral would. */
    notify(bytes: number[]) {
      Object.defineProperty(characteristic, 'value', {
        value: new DataView(new Uint8Array(bytes).buffer),
        configurable: true,
      });
      characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
    },
    /** Simulate the link dropping (spec §10.4 `gattserverdisconnected`). */
    drop() {
      connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
}

function harness(options: { autoConnect?: boolean } = {}) {
  const peripheral = fakeDevice();
  const bluetooth: BluetoothLike = { requestDevice: vi.fn(async () => peripheral.device) };
  const messages: MidiMessage[] = [];
  const states: string[] = [];
  const transport = new BleMidiTransport({
    bluetooth,
    // Backoff resolves immediately so the reconnect ladder runs without real waiting.
    delay: async () => {},
    onMessages: (batch) => messages.push(...batch),
    onStateChange: (state) => states.push(state),
  });
  void options;
  return { peripheral, bluetooth, messages, states, transport };
}

/** A note-on packet at BLE timestamp `ts`. */
const notePacket = (ts: number, note: number) => [0x80 | (ts >> 7), 0x80 | (ts & 0x7f), 0x90, note, 100];

describe('connection (spec §10.1)', () => {
  it('requests the BLE-MIDI service and characteristic by their specified UUIDs', async () => {
    const rig = harness();
    await rig.transport.connect();
    expect(rig.bluetooth.requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ services: [BLE_MIDI_SERVICE_UUID] }] }),
    );
    expect(rig.peripheral.requestedServices).toEqual([BLE_MIDI_SERVICE_UUID]);
    expect(rig.peripheral.requestedCharacteristics).toEqual([BLE_MIDI_CHARACTERISTIC_UUID]);
  });

  it('subscribes to notifications and reports the connected state and device name', async () => {
    const rig = harness();
    await rig.transport.connect();
    expect(rig.peripheral.characteristic.startNotifications).toHaveBeenCalled();
    expect(rig.states).toEqual(['connecting', 'connected']);
    expect(rig.transport.deviceName).toBe('ESP32 Pad Controller');
    expect(rig.transport.state).toBe('connected');
  });

  it('parses notified packets into MIDI messages', async () => {
    const rig = harness();
    await rig.transport.connect();
    rig.peripheral.notify(notePacket(10, 60));
    expect(rig.messages).toHaveLength(1);
    expect(rig.messages[0]).toMatchObject({ kind: 'noteOn', note: 60, velocity: 100 });
  });

  it('returns to idle when the user dismisses the chooser', async () => {
    const rig = harness();
    (rig.bluetooth.requestDevice as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('User cancelled'),
    );
    await expect(rig.transport.connect()).rejects.toThrow();
    expect(rig.transport.state).toBe('idle');
  });

  it('reports idle and does not throw when Web Bluetooth is unavailable', async () => {
    const transport = new BleMidiTransport({ bluetooth: null });
    await expect(transport.connect()).rejects.toThrow(/Web Bluetooth/i);
    expect(transport.state).toBe('idle');
  });

  it('disconnects cleanly and stops notifications', async () => {
    const rig = harness();
    await rig.transport.connect();
    await rig.transport.disconnect();
    expect(rig.peripheral.characteristic.stopNotifications).toHaveBeenCalled();
    expect(rig.peripheral.isConnected()).toBe(false);
    expect(rig.transport.state).toBe('idle');
  });

  it('delivers no further messages after disconnecting', async () => {
    const rig = harness();
    await rig.transport.connect();
    await rig.transport.disconnect();
    rig.peripheral.notify(notePacket(10, 60));
    expect(rig.messages).toEqual([]);
  });
});

describe('auto-reconnect (spec §10.4)', () => {
  it('moves to reconnecting and recovers when the link drops', async () => {
    const rig = harness();
    await rig.transport.connect();
    rig.peripheral.drop();
    await rig.transport.settled();
    expect(rig.states).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
    expect(rig.transport.state).toBe('connected');
  });

  it('retries with backoff and succeeds within the attempt budget', async () => {
    const rig = harness();
    await rig.transport.connect();
    rig.peripheral.failNextConnects(RECONNECT_ATTEMPTS - 1);
    rig.peripheral.drop();
    await rig.transport.settled();
    expect(rig.transport.state).toBe('connected');
  });

  it('gives up after the attempt budget and returns to idle for a user prompt', async () => {
    const rig = harness();
    await rig.transport.connect();
    rig.peripheral.failNextConnects(RECONNECT_ATTEMPTS + 5);
    rig.peripheral.drop();
    await rig.transport.settled();
    expect(rig.transport.state).toBe('idle');
    expect(rig.states.filter((state) => state === 'reconnecting')).toHaveLength(1);
  });

  it('backs off for longer on each successive attempt', async () => {
    const peripheral = fakeDevice();
    const waits: number[] = [];
    const transport = new BleMidiTransport({
      bluetooth: { requestDevice: async () => peripheral.device },
      delay: async (ms) => void waits.push(ms),
    });
    await transport.connect();
    peripheral.failNextConnects(RECONNECT_ATTEMPTS + 5);
    peripheral.drop();
    await transport.settled();
    expect(waits).toHaveLength(RECONNECT_ATTEMPTS);
    expect(waits[1]).toBeGreaterThan(waits[0]!);
    expect(waits[2]).toBeGreaterThan(waits[1]!);
  });

  it('resumes parsing cleanly after a reconnect (running status is reset)', async () => {
    const rig = harness();
    await rig.transport.connect();
    // Establish running status, then drop the link mid-stream.
    rig.peripheral.notify(notePacket(10, 60));
    rig.peripheral.drop();
    await rig.transport.settled();
    rig.messages.length = 0;
    // Bare data bytes must NOT be interpreted against the pre-drop running status.
    rig.peripheral.notify([0x80, 0x80 | 20, 64, 90]);
    expect(rig.messages).toEqual([]);
  });

  it('does not attempt to reconnect after a deliberate disconnect', async () => {
    const rig = harness();
    await rig.transport.connect();
    await rig.transport.disconnect();
    rig.peripheral.drop();
    await rig.transport.settled();
    expect(rig.states).toEqual(['connecting', 'connected', 'idle']);
  });
});

describe('stream robustness (spec §10.4 jitter)', () => {
  it('survives a dense, jittery burst without losing messages', async () => {
    const rig = harness();
    await rig.transport.connect();
    // 200 notes with irregular inter-packet timestamps, including a 13-bit wrap.
    let ts = 8_000;
    for (let index = 0; index < 200; index++) {
      ts = (ts + ((index * 37) % 23)) % 8_192;
      rig.peripheral.notify(notePacket(ts, 36 + (index % 12)));
    }
    expect(rig.messages).toHaveLength(200);
    expect(rig.messages.every((message) => message.kind === 'noteOn')).toBe(true);
  });

  it('ignores a notification with no value', async () => {
    const rig = harness();
    await rig.transport.connect();
    Object.defineProperty(rig.peripheral.characteristic, 'value', {
      value: undefined,
      configurable: true,
    });
    expect(() =>
      rig.peripheral.characteristic.dispatchEvent(new Event('characteristicvaluechanged')),
    ).not.toThrow();
    expect(rig.messages).toEqual([]);
  });

  it('keeps delivering after a malformed packet', async () => {
    const rig = harness();
    await rig.transport.connect();
    rig.peripheral.notify([0x00, 0x01, 0x02]);
    rig.peripheral.notify(notePacket(30, 62));
    expect(rig.messages).toHaveLength(1);
    expect(rig.messages[0]).toMatchObject({ note: 62 });
  });

  it('survives a consumer callback that throws', async () => {
    const peripheral = fakeDevice();
    const transport = new BleMidiTransport({
      bluetooth: { requestDevice: async () => peripheral.device },
      delay: async () => {},
      onMessages: () => {
        throw new Error('consumer blew up');
      },
    });
    await transport.connect();
    expect(() => peripheral.notify(notePacket(10, 60))).not.toThrow();
    expect(transport.state).toBe('connected');
  });
});
