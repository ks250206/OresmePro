/** Reads and writes float64 arrays in NumPy's .npy format (version 1.0, C order). */

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];

export function encodeNpy(
  data: Float64Array,
  shape: readonly number[] = [data.length],
): Uint8Array<ArrayBuffer> {
  const dims = shape.length === 1 ? `${shape[0]},` : shape.join(", ");
  let header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${dims}), }`;
  // The data must start on a 64-byte boundary; the header ends with a newline.
  const unpadded = MAGIC.length + 4 + header.length + 1;
  header += " ".repeat((64 - (unpadded % 64)) % 64) + "\n";
  const bytes = new Uint8Array(MAGIC.length + 4 + header.length + data.byteLength);
  bytes.set(MAGIC);
  bytes[6] = 1;
  bytes[7] = 0;
  bytes[8] = header.length & 0xff;
  bytes[9] = header.length >> 8;
  for (let index = 0; index < header.length; index += 1) {
    bytes[10 + index] = header.charCodeAt(index);
  }
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 10 + header.length);
  return bytes;
}

export function decodeNpy(bytes: Uint8Array): { data: Float64Array; shape: number[] } {
  if (bytes.length < 10 || MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("Not a .npy file.");
  }
  const major = bytes[6]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const dims = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (descr !== "<f8" || /'fortran_order':\s*True/.test(header)) {
    throw new Error(`Unsupported .npy layout (${descr ?? "unknown dtype"}).`);
  }
  let shape = (dims ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  if (shape.length === 0) shape = [1];
  const count = shape.reduce((product, size) => product * size, 1);
  const start = headerStart + headerLength;
  if (bytes.length < start + count * 8) throw new Error("Truncated .npy file.");
  // Copy so the result is aligned and independent of the file buffer.
  return { data: new Float64Array(bytes.slice(start, start + count * 8).buffer), shape };
}
