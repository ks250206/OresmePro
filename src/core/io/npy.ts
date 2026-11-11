import { WAVE_TYPES, isComplexType, newWaveData, type WaveData, type WaveType } from "../doc/types";

/**
 * Reads and writes wave data in NumPy's .npy format (version 1.0, C order),
 * in the wave's own number type. A complex wave is kept as two arrays in
 * memory and as interleaved (real, imaginary) pairs in the file.
 */
const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];

/** NumPy's name for each type, little-endian. */
const DESCR: Record<WaveType, string> = {
  float64: "<f8",
  float32: "<f4",
  int8: "|i1",
  uint8: "|u1",
  int16: "<i2",
  uint16: "<u2",
  int32: "<i4",
  uint32: "<u4",
  complex128: "<c16",
  complex64: "<c8",
};

const bytesOf = (array: WaveData): Uint8Array =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

export function encodeNpy(
  data: WaveData,
  shape: readonly number[] = [data.length],
  type: WaveType = "float64",
  imag: WaveData | null = null,
): Uint8Array<ArrayBuffer> {
  let values = data;
  if (imag) {
    values = newWaveData(type, data.length * 2);
    for (let index = 0; index < data.length; index += 1) {
      values[index * 2] = data[index]!;
      values[index * 2 + 1] = imag[index]!;
    }
  }
  const dims = shape.length === 1 ? `${shape[0]},` : shape.join(", ");
  let header = `{'descr': '${DESCR[type]}', 'fortran_order': False, 'shape': (${dims}), }`;
  // The data must start on a 64-byte boundary; the header ends with a newline.
  const unpadded = MAGIC.length + 4 + header.length + 1;
  header += " ".repeat((64 - (unpadded % 64)) % 64) + "\n";
  const bytes = new Uint8Array(MAGIC.length + 4 + header.length + values.byteLength);
  bytes.set(MAGIC);
  bytes[6] = 1;
  bytes[7] = 0;
  bytes[8] = header.length & 0xff;
  bytes[9] = header.length >> 8;
  for (let index = 0; index < header.length; index += 1) {
    bytes[10 + index] = header.charCodeAt(index);
  }
  bytes.set(bytesOf(values), 10 + header.length);
  return bytes;
}

export function decodeNpy(bytes: Uint8Array): {
  data: WaveData;
  imag?: WaveData;
  type: WaveType;
  shape: number[];
} {
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
  // One-byte types have no byte order; NumPy writes them with "|" or "<".
  const type = WAVE_TYPES.find(
    (candidate) => DESCR[candidate] === descr || DESCR[candidate] === descr?.replace("<", "|"),
  );
  if (!type || /'fortran_order':\s*True/.test(header)) {
    throw new Error(`Unsupported .npy layout (${descr ?? "unknown dtype"}).`);
  }
  let shape = (dims ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  if (shape.length === 0) shape = [1];
  const count = shape.reduce((product, size) => product * size, 1);
  const complex = isComplexType(type);
  const stored = newWaveData(type, complex ? count * 2 : count);
  const start = headerStart + headerLength;
  if (bytes.length < start + stored.byteLength) throw new Error("Truncated .npy file.");
  // Copied, so the result is aligned and independent of the file buffer.
  bytesOf(stored).set(bytes.subarray(start, start + stored.byteLength));
  if (!complex) return { data: stored, type, shape };
  const data = newWaveData(type, count);
  const imag = newWaveData(type, count);
  for (let index = 0; index < count; index += 1) {
    data[index] = stored[index * 2]!;
    imag[index] = stored[index * 2 + 1]!;
  }
  return { data, imag, type, shape };
}
