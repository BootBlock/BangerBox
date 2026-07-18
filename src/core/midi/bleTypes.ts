/**
 * Minimal Web Bluetooth surface — spec §10.1. TypeScript's `lib.dom.d.ts` does not
 * describe Web Bluetooth, so the parts BangerBox actually uses are declared here rather
 * than adding a dependency (the same approach as `worklet-globals.d.ts`). Declaring only
 * the used surface also gives the transport its test seam: {@link BluetoothLike} is what
 * the simulated-stream and reconnect tests substitute for `navigator.bluetooth`.
 */

export interface BluetoothCharacteristicLike extends EventTarget {
  readonly value?: DataView;
  startNotifications(): Promise<BluetoothCharacteristicLike>;
  stopNotifications(): Promise<BluetoothCharacteristicLike>;
}

export interface BluetoothServiceLike {
  getCharacteristic(uuid: string): Promise<BluetoothCharacteristicLike>;
}

export interface BluetoothServerLike {
  readonly connected: boolean;
  connect(): Promise<BluetoothServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothServiceLike>;
}

export interface BluetoothDeviceLike extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothServerLike;
}

export interface BluetoothRequestOptions {
  readonly filters?: readonly { readonly services: readonly string[] }[];
  readonly optionalServices?: readonly string[];
}

export interface BluetoothLike {
  requestDevice(options: BluetoothRequestOptions): Promise<BluetoothDeviceLike>;
}

/** `navigator.bluetooth` when the browser exposes it (spec §2.1 soft capability). */
export function browserBluetooth(): BluetoothLike | null {
  const candidate = (navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth;
  return candidate ?? null;
}
