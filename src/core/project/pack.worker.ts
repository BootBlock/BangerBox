/**
 * `.mpcweb` pack/unpack worker (spec §9.6) — runs fflate zipping off the main thread so a large
 * project export/import never janks the UI. It is a thin message shell over the pure
 * {@link packMpcweb}/{@link unpackMpcweb} functions (which carry the tested round-trip, §11.1).
 */
import { packMpcweb, unpackMpcweb, type PackInput, type UnpackedProject } from './mpcwebZip';

type PackRequest = { id: number; kind: 'pack'; input: PackInput };
type UnpackRequest = { id: number; kind: 'unpack'; bytes: Uint8Array };
export type PackWorkerRequest = PackRequest | UnpackRequest;

export type PackWorkerResponse =
  | { id: number; ok: true; kind: 'pack'; bytes: Uint8Array }
  | { id: number; ok: true; kind: 'unpack'; result: UnpackedProject }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<PackWorkerRequest>) => {
  const message = event.data;
  try {
    if (message.kind === 'pack') {
      const bytes = packMpcweb(message.input);
      const response: PackWorkerResponse = { id: message.id, ok: true, kind: 'pack', bytes };
      (self as unknown as Worker).postMessage(response, [bytes.buffer]);
    } else {
      const result = unpackMpcweb(message.bytes);
      const response: PackWorkerResponse = { id: message.id, ok: true, kind: 'unpack', result };
      (self as unknown as Worker).postMessage(response);
    }
  } catch (error) {
    const response: PackWorkerResponse = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
