/**
 * A blocking request/reply channel between the Python worker and the main
 * thread, built on SharedArrayBuffer.
 *
 * Python code such as `w.data` needs its answer before the next line runs,
 * but the document lives on the main thread, and a worker cannot receive a
 * message while it is in the middle of running Python. So the worker posts
 * its request, then sleeps on a shared buffer with Atomics.wait; the main
 * thread writes the reply into that buffer and wakes it.
 *
 * Buffer layout: four int32 header fields, then the payload.
 *   [0] state   [1] JSON byte length (or required size)   [2] float64 count
 * Payload: UTF-8 JSON, padded to 8 bytes, then the float64 data.
 */
const HEADER_BYTES = 16;
const WAITING = 0;
const DONE = 1;
const TOO_SMALL = 2;

const align8 = (value: number): number => (value + 7) & ~7;

export function createSyncBuffer(payloadBytes = 1 << 20): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + align8(payloadBytes));
}

/** Worker side: mark the buffer as awaiting a reply. Call before posting the request. */
export function armSyncBuffer(buffer: SharedArrayBuffer): void {
  Atomics.store(new Int32Array(buffer, 0, 4), 0, WAITING);
}

/**
 * Main side: write a reply and wake the worker. Returns false if the buffer
 * is too small; the worker then retries with a bigger one.
 */
export function writeSyncReply(
  buffer: SharedArrayBuffer,
  json: string,
  data: Float64Array | null,
): boolean {
  const header = new Int32Array(buffer, 0, 4);
  const text = new TextEncoder().encode(json);
  const dataOffset = HEADER_BYTES + align8(text.length);
  const needed = dataOffset + (data ? data.byteLength : 0);
  if (needed > buffer.byteLength) {
    Atomics.store(header, 1, needed);
    Atomics.store(header, 0, TOO_SMALL);
    Atomics.notify(header, 0);
    return false;
  }
  new Uint8Array(buffer, HEADER_BYTES, text.length).set(text);
  if (data) new Float64Array(buffer, dataOffset, data.length).set(data);
  Atomics.store(header, 1, text.length);
  Atomics.store(header, 2, data ? data.length : -1);
  Atomics.store(header, 0, DONE);
  Atomics.notify(header, 0);
  return true;
}

/**
 * Worker side: block until the main thread replies. Returns the reply, or
 * the buffer size needed if this buffer was too small.
 */
export function waitSyncReply(
  buffer: SharedArrayBuffer,
): { json: string; data: Float64Array | null } | { needed: number } {
  const header = new Int32Array(buffer, 0, 4);
  Atomics.wait(header, 0, WAITING);
  if (Atomics.load(header, 0) === TOO_SMALL) return { needed: Atomics.load(header, 1) };
  const length = Atomics.load(header, 1);
  const count = Atomics.load(header, 2);
  // slice() copies out of shared memory; TextDecoder rejects shared views.
  const json = new TextDecoder().decode(new Uint8Array(buffer, HEADER_BYTES, length).slice());
  const data =
    count < 0 ? null : new Float64Array(buffer, HEADER_BYTES + align8(length), count).slice();
  return { json, data };
}
