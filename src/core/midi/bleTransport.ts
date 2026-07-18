/**
 * BLE-MIDI transport — spec §10.1 (device selection, notifications) and §10.4 (connection
 * lifecycle, auto-reconnect with backoff). This owns the Web Bluetooth objects and nothing
 * else: incoming packets go straight to the pure parser (spec §10.1) and out through
 * `onMessages`, so routing them into stores is the router's job (spec §10.2), not this
 * module's.
 *
 * `navigator.bluetooth` is injected rather than reached for, which is what makes the §12
 * simulated-stream jitter and reconnect tests possible without hardware (spec §11.3 mocking
 * discipline).
 */
import { createMidiParser, type MidiMessage } from './parser';
import { browserBluetooth, type BluetoothCharacteristicLike, type BluetoothDeviceLike, type BluetoothLike } from './bleTypes';

/** BLE-MIDI GATT service UUID — spec §10.1 (binding value). */
export const BLE_MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
/** BLE-MIDI data I/O characteristic UUID — spec §10.1 (binding value). */
export const BLE_MIDI_CHARACTERISTIC_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';

/** Automatic `gatt.connect()` retries before prompting the user — spec §10.4 ("3 attempts"). */
export const RECONNECT_ATTEMPTS = 3;

/** First backoff wait; each attempt doubles it (spec §10.4 "retries with backoff"). */
const RECONNECT_BASE_DELAY_MS = 250;

export type BleConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export interface BleTransportOptions {
  /** Injected for testability; defaults to `navigator.bluetooth` (spec §2.1 soft capability). */
  readonly bluetooth?: BluetoothLike | null;
  readonly onMessages?: (messages: MidiMessage[]) => void;
  readonly onStateChange?: (state: BleConnectionState, deviceName: string | null) => void;
  /** Injected so the reconnect ladder can be tested without real waiting. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BleMidiTransport {
  private readonly parser = createMidiParser();
  private readonly bluetooth: BluetoothLike | null;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private device: BluetoothDeviceLike | null = null;
  private characteristic: BluetoothCharacteristicLike | null = null;
  private connectionState: BleConnectionState = 'idle';
  /** True while a user-initiated disconnect is in effect — suppresses auto-reconnect. */
  private deliberatelyClosed = false;
  /** The in-flight reconnect ladder, awaited by {@link settled} in tests. */
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: BleTransportOptions = {}) {
    this.bluetooth = options.bluetooth === undefined ? browserBluetooth() : options.bluetooth;
    this.delay = options.delay ?? sleep;
    this.now = options.now ?? (() => performance.now());
  }

  get state(): BleConnectionState {
    return this.connectionState;
  }

  get deviceName(): string | null {
    return this.device?.name ?? null;
  }

  /** Resolves once any in-flight reconnect ladder has finished (test seam). */
  async settled(): Promise<void> {
    await this.pending;
  }

  /**
   * Pick a device and subscribe (spec §10.1). Must be called from a user gesture — Web
   * Bluetooth's chooser requires one, which is why the UI drives this from a button.
   */
  async connect(): Promise<void> {
    if (!this.bluetooth) {
      throw new Error('Web Bluetooth is unavailable in this browser.');
    }
    this.deliberatelyClosed = false;
    this.setState('connecting');
    try {
      const device = await this.bluetooth.requestDevice({
        filters: [{ services: [BLE_MIDI_SERVICE_UUID] }],
      });
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.handleDisconnected);
      await this.openGatt();
      this.setState('connected');
    } catch (error) {
      this.teardown();
      this.setState('idle');
      throw error;
    }
  }

  /** Deliberate disconnect — no auto-reconnect follows (spec §10.4). */
  async disconnect(): Promise<void> {
    this.deliberatelyClosed = true;
    await this.stopNotifications();
    this.device?.gatt?.disconnect();
    this.teardown();
    this.setState('idle');
  }

  // --------------------------------------------------------------- internals ---

  /** Connect GATT, resolve the BLE-MIDI characteristic, and subscribe to notifications. */
  private async openGatt(): Promise<void> {
    const gatt = this.device?.gatt;
    if (!gatt) throw new Error('The selected device exposes no GATT server.');
    await gatt.connect();
    const service = await gatt.getPrimaryService(BLE_MIDI_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(BLE_MIDI_CHARACTERISTIC_UUID);
    // A fresh link starts a fresh MIDI stream: running status and any partial SysEx from
    // before the drop must not be applied to the new one (spec §10.1).
    this.parser.reset();
    characteristic.addEventListener('characteristicvaluechanged', this.handlePacket);
    await characteristic.startNotifications();
    this.characteristic = characteristic;
  }

  private readonly handlePacket = (event: Event): void => {
    const target = event.target as BluetoothCharacteristicLike | null;
    const value = target?.value ?? this.characteristic?.value;
    if (!value) return;
    // A packet is never allowed to break the stream, so parse and delivery are both
    // guarded — a bad byte or a throwing consumer must not kill the subscription
    // (spec §10.4: a drop must not crash the graph; the same holds for a bad packet).
    try {
      const messages = this.parser.parse(value, this.now());
      if (messages.length > 0) this.options.onMessages?.(messages);
    } catch {
      // Dropped: the next packet re-synchronises on its own header byte (spec §10.1).
    }
  };

  /**
   * The link dropped (spec §10.4). Playback, the graph, and the Q-Link bindings are all
   * untouched — only this transport's own state moves — and reconnection is attempted
   * automatically before the user is asked to do anything.
   */
  private readonly handleDisconnected = (): void => {
    if (this.deliberatelyClosed) return;
    this.characteristic = null;
    this.setState('reconnecting');
    this.pending = this.reconnect();
  };

  private async reconnect(): Promise<void> {
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt++) {
      // Backoff doubles per attempt so a controller that is briefly out of range is not
      // hammered (spec §10.4).
      await this.delay(RECONNECT_BASE_DELAY_MS * 2 ** attempt);
      if (this.deliberatelyClosed) return;
      try {
        await this.openGatt();
        this.setState('connected');
        return;
      } catch {
        // Try again until the budget is spent.
      }
    }
    // Budget spent — fall back to idle so the UI can prompt for a manual reconnect.
    this.teardown();
    this.setState('idle');
  }

  private async stopNotifications(): Promise<void> {
    const characteristic = this.characteristic;
    if (!characteristic) return;
    characteristic.removeEventListener('characteristicvaluechanged', this.handlePacket);
    try {
      await characteristic.stopNotifications();
    } catch {
      // The link may already be gone; nothing to unsubscribe from.
    }
  }

  private teardown(): void {
    this.characteristic?.removeEventListener('characteristicvaluechanged', this.handlePacket);
    this.characteristic = null;
    this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnected);
    this.device = null;
    this.parser.reset();
  }

  private setState(state: BleConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.options.onStateChange?.(state, this.deviceName);
  }
}
