/**
 * `.mpcweb` pack/unpack worker (spec §9.6) — runs fflate off the main thread so a large
 * project export/import never janks the UI. It is a thin message shell over the pure
 * {@link createMpcwebPacker}/{@link unpackMpcweb} functions (which carry the tested
 * round-trip, §11.1).
 *
 * **Packing is a session, not a call** (issue #99). A single `pack` message would have to
 * carry every sample's bytes at once, which is the memory peak that issue is about: the main
 * thread holds the whole project's audio to build the message, the worker holds it again to
 * zip it, and `zipSync` holds the finished archive on top. Instead the main thread opens a
 * session, transfers one sample at a time — the buffer is detached by the transfer, so its
 * memory is genuinely handed over rather than copied — and receives compressed chunks back
 * as they are produced. The peak on either side is one sample plus one chunk.
 *
 * `id` correlates a request with its reply, exactly as the DB bridge does (spec §1.3 #7);
 * `session` names the archive being built. They are separate fields because a session spans
 * many requests, and because `packChunk` is not a reply to any of them — it is output the
 * worker pushes while handling whichever request happened to produce it.
 */
import { createMpcwebPacker, unpackMpcweb, type UnpackedProject, type MpcwebPacker } from './mpcwebZip';
import type { ProjectSnapshot } from './mpcweb';

type PackBeginRequest = { id: number; kind: 'packBegin'; session: number; appVersion: string };
type PackSampleRequest = {
  id: number;
  kind: 'packSample';
  session: number;
  sampleId: string;
  bytes: Uint8Array;
};
type PackEndRequest = { id: number; kind: 'packEnd'; session: number; snapshot: ProjectSnapshot };
type PackAbortRequest = { id: number; kind: 'packAbort'; session: number };
type UnpackRequest = { id: number; kind: 'unpack'; bytes: Uint8Array };

export type PackWorkerRequest =
  PackBeginRequest | PackSampleRequest | PackEndRequest | PackAbortRequest | UnpackRequest;

/**
 * A request without its correlation id, which the client stamps on as it sends.
 *
 * The `Omit` is distributed over each member by hand rather than written as
 * `Omit<PackWorkerRequest, 'id'>`: `Omit` collapses a union into one object type, which loses
 * `kind` as a discriminant and takes every other member's fields with it.
 */
export type PackWorkerRequestBody =
  | Omit<PackBeginRequest, 'id'>
  | Omit<PackSampleRequest, 'id'>
  | Omit<PackEndRequest, 'id'>
  | Omit<PackAbortRequest, 'id'>
  | Omit<UnpackRequest, 'id'>;

export type PackWorkerResponse =
  /** One compressed chunk of a session's archive; `final` marks the last of them. */
  | { session: number; ok: true; kind: 'packChunk'; chunk: Uint8Array; final: boolean }
  /** The request completed with nothing to return. */
  | { id: number; ok: true; kind: 'ack' }
  | { id: number; ok: true; kind: 'unpack'; result: UnpackedProject }
  | { id: number; ok: false; error: string };

/** Live pack sessions. A map rather than one variable, so two exports cannot interleave. */
const sessions = new Map<number, MpcwebPacker>();

function post(response: PackWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(response, transfer);
}

/** The packer for `session`, or a message naming what went wrong. */
function sessionFor(session: number): MpcwebPacker {
  const packer = sessions.get(session);
  if (!packer) throw new Error(`No pack session ${session} is open.`);
  return packer;
}

self.onmessage = (event: MessageEvent<PackWorkerRequest>) => {
  const message = event.data;
  try {
    switch (message.kind) {
      case 'packBegin': {
        const { session } = message;
        sessions.set(
          session,
          createMpcwebPacker({
            appVersion: message.appVersion,
            // Copied into a fresh buffer and transferred, so the worker keeps no reference:
            // fflate reuses its output buffer, and a retained view would alias the next chunk.
            onChunk: (chunk, final) => {
              const copy = new Uint8Array(chunk);
              post({ session, ok: true, kind: 'packChunk', chunk: copy, final }, [copy.buffer]);
            },
          }),
        );
        post({ id: message.id, ok: true, kind: 'ack' });
        return;
      }
      case 'packSample': {
        sessionFor(message.session).addSample({ sampleId: message.sampleId, bytes: message.bytes });
        post({ id: message.id, ok: true, kind: 'ack' });
        return;
      }
      case 'packEnd': {
        const packer = sessionFor(message.session);
        // Dropped before `finish` rather than after: a throw there must still release the
        // session, or a failed export would leak its packer for the life of the worker.
        sessions.delete(message.session);
        packer.finish(message.snapshot);
        post({ id: message.id, ok: true, kind: 'ack' });
        return;
      }
      case 'packAbort': {
        // A caller that gave up part-way — a failed OPFS read, a mode torn down. Dropping the
        // packer is the whole of the clean-up: fflate holds nothing outside it.
        sessions.delete(message.session);
        post({ id: message.id, ok: true, kind: 'ack' });
        return;
      }
      case 'unpack': {
        post({ id: message.id, ok: true, kind: 'unpack', result: unpackMpcweb(message.bytes) });
        return;
      }
    }
  } catch (error) {
    // A failed step ends the session: the archive it was building is unusable either way,
    // and leaving the packer behind would let a later message append to a broken file.
    if (message.kind !== 'unpack') sessions.delete(message.session);
    post({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
