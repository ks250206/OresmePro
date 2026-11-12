import { newWaveData, type WaveData, type WaveType } from "../doc/types";

/*
 * Reads the files of WaveMetrics Igor Pro: binary waves (.ibw), as described
 * in Igor's Technical Note TN003, and the waves of packed experiments (.pxp,
 * .pxt), as described in PTN003. Written from those descriptions.
 *
 * A binary wave is a small header (BinHeader1, 2, 3 or 5, after the version
 * number it starts with), a wave header (WaveHeader2 for versions 1 to 3,
 * WaveHeader5 for version 5), the values, and then sections whose sizes the
 * first header gives: the note, the dependency formula, long units,
 * dimension labels and, for a text wave, where each string ends. The byte
 * order is that of the computer that wrote the file; the version number
 * shows it, since it is small enough to leave one of its two bytes zero.
 *
 * A packed experiment is a sequence of records, each an 8-byte header (type,
 * version, length) and its data. A wave record holds a binary wave as it
 * would be in its own file; data folders are a start record (with the name)
 * and an end record around what they hold.
 *
 * What cannot be read as it is written is refused with a reason: a reader
 * that guesses where the file is damaged would load numbers that are wrong
 * without anyone knowing.
 */

/** Why an Igor file could not be read, in words for the person who has the file. */
export class IgorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IgorError";
  }
}

/** One dimension of a wave as Igor describes it: index i is at start + i*delta. */
export interface IgorDimension {
  size: number;
  start: number;
  delta: number;
  unit: string;
}

/** A wave read from a binary wave, with its values already in this app's layout. */
export interface IgorWave {
  /** The name in the file, as Igor wrote it (Igor allows spaces and punctuation). */
  name: string;
  version: 1 | 2 | 3 | 5;
  littleEndian: boolean;
  /** How Igor held the values, in words: "32-bit float", "16-bit unsigned integer, complex", "text". */
  igorType: string;
  /** Igor's dimensions, rows first; one for a 1-D wave. */
  dims: IgorDimension[];
  /** The type the wave has here; "float64" for a text wave. */
  type: WaveType;
  /** Values in C order with the first index outermost; empty for a text wave. */
  data: WaveData;
  imag: WaveData | null;
  /** The strings of a text wave in Igor's point order, or null. */
  text: string[] | null;
  /** The shape the wave has here: Igor's dimension sizes, or the number of strings of a text wave. */
  shape: number[];
  unit: string;
  /** Igor's own note, with its line ends made "\n". */
  note: string;
  /** The dependency formula, or "" for a wave that has none. */
  formula: string;
  /**
   * The values are not in the file: Igor saves a wave that depends on a
   * formula without them, to compute them again when it opens the file.
   */
  missingValues: boolean;
  /** What could not be carried over as Igor had it, for the wave's note. */
  remarks: string[];
}

const NATIVE_LITTLE = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

/**
 * Igor's number types (TN003, the "NT_" constants): a size (0x02 float32,
 * 0x04 float64, 0x08, 0x10, 0x20 and 0x80 for integers of 8 to 64 bits),
 * 0x40 added for an unsigned integer, 0x01 for a complex number.
 */
const NT_COMPLEX = 0x01;

interface ElementKind {
  size: number;
  words: string;
  /** The array that holds one part of a value as it lies in the file. */
  array:
    | Float32ArrayConstructor
    | Float64ArrayConstructor
    | Int8ArrayConstructor
    | Uint8ArrayConstructor
    | Int16ArrayConstructor
    | Uint16ArrayConstructor
    | Int32ArrayConstructor
    | Uint32ArrayConstructor
    | BigInt64ArrayConstructor
    | BigUint64ArrayConstructor;
  /** The type of a real wave here, and of a complex one. */
  real: WaveType;
  complex: WaveType;
}

const KINDS: Record<number, ElementKind> = {
  0x02: {
    size: 4,
    words: "32-bit float",
    array: Float32Array,
    real: "float32",
    complex: "complex64",
  },
  0x04: {
    size: 8,
    words: "64-bit float",
    array: Float64Array,
    real: "float64",
    complex: "complex128",
  },
  // Complex integers do not exist here; the float type that holds every value
  // of the integer type exactly takes their place.
  0x08: { size: 1, words: "8-bit integer", array: Int8Array, real: "int8", complex: "complex64" },
  0x48: {
    size: 1,
    words: "8-bit unsigned integer",
    array: Uint8Array,
    real: "uint8",
    complex: "complex64",
  },
  0x10: {
    size: 2,
    words: "16-bit integer",
    array: Int16Array,
    real: "int16",
    complex: "complex64",
  },
  0x50: {
    size: 2,
    words: "16-bit unsigned integer",
    array: Uint16Array,
    real: "uint16",
    complex: "complex64",
  },
  0x20: {
    size: 4,
    words: "32-bit integer",
    array: Int32Array,
    real: "int32",
    complex: "complex128",
  },
  0x60: {
    size: 4,
    words: "32-bit unsigned integer",
    array: Uint32Array,
    real: "uint32",
    complex: "complex128",
  },
  // There is no 64-bit integer type here: float64 holds integers up to 2^53 exactly.
  0x80: {
    size: 8,
    words: "64-bit integer",
    array: BigInt64Array,
    real: "float64",
    complex: "complex128",
  },
  0xc0: {
    size: 8,
    words: "64-bit unsigned integer",
    array: BigUint64Array,
    real: "float64",
    complex: "complex128",
  },
};

const DIMENSION_WORDS = ["rows", "columns", "layers", "chunks"] as const;

/** Reads numbers in either byte order from a file's bytes. */
class Reader {
  readonly bytes: Uint8Array;
  readonly little: boolean;
  readonly view: DataView;
  constructor(bytes: Uint8Array, little: boolean) {
    this.bytes = bytes;
    this.little = little;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  int16 = (at: number) => this.view.getInt16(at, this.little);
  uint16 = (at: number) => this.view.getUint16(at, this.little);
  int32 = (at: number) => this.view.getInt32(at, this.little);
  uint32 = (at: number) => this.view.getUint32(at, this.little);
  float64 = (at: number) => this.view.getFloat64(at, this.little);
}

/** The bytes up to the first zero byte. */
function cString(bytes: Uint8Array): Uint8Array {
  const end = bytes.indexOf(0);
  return end === -1 ? bytes : bytes.subarray(0, end);
}

/** The bytes without the zero bytes at their end. */
function trimZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const shiftJis = new TextDecoder("shift_jis", { fatal: true });
const macRoman = new TextDecoder("macintosh");
const windows1252 = new TextDecoder("windows-1252");

/**
 * The text that bytes written by Igor spell. Igor 7 and later write UTF-8;
 * earlier versions wrote the system's encoding, which the file does not
 * name: MacRoman or Windows-1252 for Western systems, Shift_JIS for Japanese
 * ones. Bytes that are valid UTF-8 are read as UTF-8. Otherwise bytes that
 * are valid Shift_JIS and use its two-byte characters are read as Shift_JIS;
 * anything else as MacRoman when the file is in the byte order of a Mac
 * (big-endian) and as Windows-1252 when it is in that of Windows. Those two
 * give a character for every byte, so nothing is dropped: at worst a
 * character is the wrong one. `used` collects the encodings other than
 * UTF-8 that were needed, for the wave's note.
 */
export function igorText(bytes: Uint8Array, little: boolean, used?: Set<string>): string {
  if (bytes.every((byte) => byte < 0x80)) return windows1252.decode(bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    // Not UTF-8: an older Igor's system encoding.
  }
  if (hasDoubleByteJapanese(bytes)) {
    try {
      const text = shiftJis.decode(bytes);
      used?.add("Shift_JIS");
      return text;
    } catch {
      // Not Shift_JIS either.
    }
  }
  used?.add(little ? "Windows-1252" : "MacRoman");
  return (little ? windows1252 : macRoman).decode(bytes);
}

/**
 * Whether bytes have a lead byte of a two-byte Shift_JIS character. Without
 * one, bytes above 0x7f would be read as half-width katakana, which is what
 * "µm" and "°C" from a Western system would become.
 */
function hasDoubleByteJapanese(bytes: Uint8Array): boolean {
  return bytes.some((byte) => (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc));
}

/** Igor's notes end lines with CR (from the classic Mac OS) or CRLF. */
const unixLines = (text: string): string => text.replace(/\r\n?/g, "\n");

/** Swaps the bytes of each element in place. */
function swapBytes(bytes: Uint8Array, size: number): void {
  for (let at = 0; at + size <= bytes.length; at += size) {
    for (let low = at, high = at + size - 1; low < high; low += 1, high -= 1) {
      const byte = bytes[low]!;
      bytes[low] = bytes[high]!;
      bytes[high] = byte;
    }
  }
}

type FileArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;

/**
 * The elements as they lie in the file, as a typed array in this computer's
 * byte order. Where the file's byte order is this computer's and the values
 * start at a multiple of their size, the array is a view of the file's own
 * buffer: a wave of 100 MB is then not copied at all. Otherwise it is copied
 * once.
 */
function fileElements(
  bytes: Uint8Array,
  offset: number,
  count: number,
  kind: ElementKind,
  little: boolean,
): FileArray {
  const start = bytes.byteOffset + offset;
  const swap = kind.size > 1 && little !== NATIVE_LITTLE;
  if (!swap && start % kind.size === 0) {
    return new kind.array(bytes.buffer as ArrayBuffer, start, count);
  }
  const copy = bytes.slice(offset, offset + count * kind.size);
  if (swap) swapBytes(copy, kind.size);
  return new kind.array(copy.buffer, 0, count);
}

/**
 * Igor keeps the first index fastest (rows of a column next to each other);
 * here the last index is. Copies one part (0 real, 1 imaginary, of `parts`
 * interleaved parts) of `source` into `target` in this app's order.
 */
function reorder(
  source: ArrayLike<number>,
  target: { [index: number]: number },
  shape: readonly number[],
  parts: 1 | 2,
  part: 0 | 1,
): void {
  const [n0 = 1, n1 = 1, n2 = 1, n3 = 1] = shape;
  const s1 = n0 * parts;
  const s2 = s1 * n1;
  const s3 = s2 * n2;
  let out = 0;
  for (let i0 = 0; i0 < n0; i0 += 1) {
    const a0 = i0 * parts + part;
    for (let i1 = 0; i1 < n1; i1 += 1) {
      const a1 = a0 + i1 * s1;
      for (let i2 = 0; i2 < n2; i2 += 1) {
        const a2 = a1 + i2 * s2;
        for (let i3 = 0; i3 < n3; i3 += 1) target[out++] = source[a2 + i3 * s3]!;
      }
    }
  }
}

/** The values of a numeric wave, in this app's order and type. */
function numericValues(
  bytes: Uint8Array,
  offset: number,
  shape: readonly number[],
  kind: ElementKind,
  complex: boolean,
  little: boolean,
  remarks: string[],
): { data: WaveData; imag: WaveData | null } {
  const count = shape.reduce((product, size) => product * size, 1);
  const parts = complex ? 2 : 1;
  const elements = fileElements(bytes, offset, count * parts, kind, little);
  let source: Exclude<FileArray, BigInt64Array | BigUint64Array>;
  if (elements instanceof BigInt64Array || elements instanceof BigUint64Array) {
    // 64-bit integers: float64 holds them exactly up to 2^53.
    const values = new Float64Array(elements.length);
    let inexact = 0;
    for (let index = 0; index < elements.length; index += 1) {
      const value = elements[index]!;
      values[index] = Number(value);
      if (value > 9007199254740992n || value < -9007199254740992n) {
        if (BigInt(values[index]!) !== value) inexact += 1;
      }
    }
    if (inexact > 0) {
      remarks.push(
        `${inexact} of the ${kind.words} values ${inexact === 1 ? "is" : "are"} beyond 2^53 and ${inexact === 1 ? "was" : "were"} rounded to the nearest float64.`,
      );
    }
    source = values;
  } else {
    source = elements;
  }
  const type = complex ? kind.complex : kind.real;
  if (!complex) {
    // A 1-D wave is in the same order here: the array is used as it is.
    if (shape.length === 1) return { data: source, imag: null };
    const data = newWaveData(type, count);
    reorder(source, data, shape, 1, 0);
    return { data, imag: null };
  }
  const data = newWaveData(type, count);
  const imag = newWaveData(type, count);
  reorder(source, data, shape, 2, 0);
  reorder(source, imag, shape, 2, 1);
  return { data, imag };
}

/** What a binary wave's first header says, whatever its version. */
interface BinHeader {
  version: 1 | 2 | 3 | 5;
  /** Bytes of the first header, and of the wave header that the checksum covers too. */
  headerSize: number;
  checksumSize: number;
  wfmSize: number;
  noteSize: number;
  formulaSize: number;
  dataEUnitsSize: number;
  dimEUnitsSize: number[];
  dimLabelsSize: number[];
  sIndicesSize: number;
}

/** The byte order of a file that starts with an Igor version number, or null if it does not. */
function versionOrder(bytes: Uint8Array): { little: boolean; version: number } | null {
  if (bytes.length < 2) return null;
  const [first, second] = [bytes[0]!, bytes[1]!];
  // The version is small: in one byte order its high byte is zero.
  if (first === 0 && second !== 0) return { little: false, version: second };
  if (first !== 0 && second === 0) return { little: true, version: first };
  return null;
}

/** The size of the first header and the wave header together, by version: what the checksum covers. */
const HEADERS_SIZE: Record<number, number> = { 1: 8 + 126, 2: 16 + 126, 3: 20 + 126, 5: 64 + 320 };

function binHeader(read: Reader, version: number): BinHeader {
  const none = [0, 0, 0, 0];
  switch (version) {
    case 1:
      return {
        version,
        headerSize: 8,
        checksumSize: HEADERS_SIZE[1]!,
        wfmSize: read.int32(2),
        noteSize: 0,
        formulaSize: 0,
        dataEUnitsSize: 0,
        dimEUnitsSize: none,
        dimLabelsSize: none,
        sIndicesSize: 0,
      };
    case 2:
      return {
        version,
        headerSize: 16,
        checksumSize: HEADERS_SIZE[2]!,
        wfmSize: read.int32(2),
        noteSize: read.int32(6),
        formulaSize: 0,
        dataEUnitsSize: 0,
        dimEUnitsSize: none,
        dimLabelsSize: none,
        sIndicesSize: 0,
      };
    case 3:
      return {
        version,
        headerSize: 20,
        checksumSize: HEADERS_SIZE[3]!,
        wfmSize: read.int32(2),
        noteSize: read.int32(6),
        formulaSize: read.int32(10),
        dataEUnitsSize: 0,
        dimEUnitsSize: none,
        dimLabelsSize: none,
        sIndicesSize: 0,
      };
    case 5:
      return {
        version,
        headerSize: 64,
        checksumSize: HEADERS_SIZE[5]!,
        wfmSize: read.int32(4),
        formulaSize: read.int32(8),
        noteSize: read.int32(12),
        dataEUnitsSize: read.int32(16),
        dimEUnitsSize: [0, 1, 2, 3].map((d) => read.int32(20 + 4 * d)),
        dimLabelsSize: [0, 1, 2, 3].map((d) => read.int32(36 + 4 * d)),
        sIndicesSize: read.int32(52),
      };
    default:
      throw new IgorError(
        `This is a binary wave of version ${version}, which this reader does not know (it reads versions 1, 2, 3 and 5).`,
      );
  }
}

/** Sizes of WaveHeader2 and WaveHeader5 up to where the values start. */
const WAVE2_DATA = 110;
const WAVE5_DATA = 320;
/** WaveHeader2 ends with room for 16 bytes of values, which the file always has. */
const WAVE2_SIZE = 126;

/**
 * Reads a binary wave: an .ibw file, or the data of a wave record of a
 * packed experiment.
 */
export function readBinaryWave(bytes: Uint8Array): IgorWave {
  const order = versionOrder(bytes);
  // Versions after 5 would start the same way; anything else is not from Igor.
  if (!order || order.version > 15) {
    throw new IgorError(
      "This is not an Igor binary wave: it does not start with a version number Igor writes (1, 2, 3 or 5).",
    );
  }
  const { little } = order;
  const read = new Reader(bytes, little);
  // Both headers must be there before anything in them is read.
  const headers = HEADERS_SIZE[order.version];
  if (headers !== undefined && bytes.length < headers) throw cutShort("the header");
  const header = binHeader(read, order.version);
  // The 16-bit words of both headers add up to zero.
  let sum = 0;
  for (let at = 0; at < header.checksumSize; at += 2) sum += read.int16(at);
  if ((sum & 0xffff) !== 0) {
    if (isPackedExperiment(bytes)) {
      throw new IgorError(
        "This is an Igor packed experiment, not a binary wave: give the file the extension .pxp.",
      );
    }
    throw new IgorError(
      "The file is damaged, or not an Igor binary wave: the checksum of its header does not match. Copy the file again from where it was saved, as a binary file, or save the wave again from Igor.",
    );
  }
  const sizes = [
    header.wfmSize,
    header.noteSize,
    header.formulaSize,
    header.dataEUnitsSize,
    ...header.dimEUnitsSize,
    ...header.dimLabelsSize,
    header.sIndicesSize,
  ];
  if (sizes.some((size) => size < 0)) {
    throw new IgorError("The file is damaged: its header gives a section a negative size.");
  }
  return header.version === 5 ? readWave5(read, header) : readWave2(read, header);
}

function cutShort(what: string): IgorError {
  return new IgorError(
    `The file is cut short: it ends inside ${what}. Copy it again from where it was saved.`,
  );
}

/** Takes the sections that follow the wave, in order, checking that each is there. */
class Sections {
  private readonly bytes: Uint8Array;
  private at: number;
  constructor(bytes: Uint8Array, at: number) {
    this.bytes = bytes;
    this.at = at;
  }
  take(size: number, what: string): Uint8Array {
    if (this.at + size > this.bytes.length) throw cutShort(what);
    const section = this.bytes.subarray(this.at, this.at + size);
    this.at += size;
    return section;
  }
}

function typeOf(code: number): { kind: ElementKind | null; complex: boolean; words: string } {
  if (code === 0) return { kind: null, complex: false, words: "text" };
  const complex = (code & NT_COMPLEX) !== 0;
  const kind = KINDS[code & ~NT_COMPLEX];
  if (!kind) {
    throw new IgorError(
      `The wave has number type ${code}, which is not one of Igor's. The file is damaged or not from Igor.`,
    );
  }
  return { kind, complex, words: complex ? `${kind.words}, complex` : kind.words };
}

/** Checks a scaling, which must be finite with a step that is not zero to be used here. */
function scaling(
  start: number,
  delta: number,
  dimension: number,
  remarks: string[],
): { start: number; delta: number } {
  if (Number.isFinite(start) && Number.isFinite(delta) && delta !== 0) return { start, delta };
  remarks.push(
    `Igor's scaling of the ${DIMENSION_WORDS[dimension]} (start ${start}, step ${delta}) cannot be used here; they start at 0 with step 1.`,
  );
  return { start: 0, delta: 1 };
}

function readWave2(read: Reader, header: BinHeader): IgorWave {
  const { bytes, little } = read;
  const wave = header.headerSize;
  const used = new Set<string>();
  const remarks: string[] = [];
  const type = typeOf(read.int16(wave));
  if (!type.kind) {
    throw new IgorError(
      "The wave says it is a text wave, which binary waves before version 5 cannot hold. The file is damaged.",
    );
  }
  const npnts = read.int32(wave + 42);
  const name = igorText(cString(bytes.subarray(wave + 6, wave + 26)), little, used);
  const dataUnit = igorText(cString(bytes.subarray(wave + 34, wave + 38)), little, used);
  const xUnit = igorText(cString(bytes.subarray(wave + 38, wave + 42)), little, used);
  const x = scaling(read.float64(wave + 56), read.float64(wave + 48), 0, remarks);
  if (npnts < 0) throw new IgorError("The file is damaged: it gives the wave a negative length.");
  const dataBytes = npnts * type.kind.size * (type.complex ? 2 : 1);
  const stored = header.wfmSize - WAVE2_SIZE;
  const missingValues = stored === 0 && npnts > 0 && header.formulaSize > 0;
  if (!missingValues && stored < dataBytes) {
    throw new IgorError(
      `The file is damaged: the wave has ${npnts} points but the file has room for ${Math.max(0, Math.floor(stored / type.kind.size))}.`,
    );
  }
  if (header.headerSize + header.wfmSize > bytes.length) throw cutShort("the values");
  const sections = new Sections(bytes, header.headerSize + header.wfmSize);
  const note = sections.take(header.noteSize, "the note");
  const formula = sections.take(header.formulaSize, "the dependency formula");
  const values = missingValues
    ? { data: newWaveData(type.complex ? type.kind.complex : type.kind.real, 0), imag: null }
    : numericValues(bytes, wave + WAVE2_DATA, [npnts], type.kind, type.complex, little, remarks);
  return finish({
    name,
    version: header.version as 1 | 2 | 3,
    littleEndian: little,
    igorType: type.words,
    dims: [{ size: npnts, ...x, unit: xUnit }],
    type: type.complex ? type.kind.complex : type.kind.real,
    ...values,
    text: null,
    shape: [missingValues ? 0 : npnts],
    unit: dataUnit,
    note: unixLines(igorText(note, little, used)),
    formula: igorText(cString(formula), little, used),
    missingValues,
    remarks,
    used,
  });
}

function readWave5(read: Reader, header: BinHeader): IgorWave {
  const { bytes, little } = read;
  const wave = header.headerSize;
  const used = new Set<string>();
  const remarks: string[] = [];
  const type = typeOf(read.int16(wave + 16));
  const npnts = read.int32(wave + 12);
  const name = igorText(cString(bytes.subarray(wave + 28, wave + 60)), little, used);
  if (npnts < 0) throw new IgorError("The file is damaged: it gives the wave a negative length.");
  const sizes: number[] = [];
  for (let d = 0; d < 4; d += 1) {
    const size = read.int32(wave + 68 + 4 * d);
    if (size === 0) break;
    if (size < 0) throw new IgorError("The file is damaged: it gives a dimension a negative size.");
    sizes.push(size);
  }
  if (sizes.length === 0) sizes.push(npnts);
  const product = sizes.reduce((total, size) => total * size, 1);
  if (product !== npnts) {
    throw new IgorError(
      `The file is damaged: the wave's dimensions (${sizes.join("×")}) do not make its ${npnts} points.`,
    );
  }

  const stored = header.wfmSize - WAVE5_DATA;
  if (stored < 0)
    throw new IgorError("The file is damaged: the size it gives the wave is too small.");
  if (header.headerSize + header.wfmSize > bytes.length) throw cutShort("the values");
  const sections = new Sections(bytes, header.headerSize + header.wfmSize);
  const formula = sections.take(header.formulaSize, "the dependency formula");
  const note = sections.take(header.noteSize, "the note");
  const dataEUnits = sections.take(header.dataEUnitsSize, "the unit of the values");
  const dimEUnits = header.dimEUnitsSize.map((size) => sections.take(size, "the dimension units"));
  const labels = header.dimLabelsSize.map((size) => sections.take(size, "the dimension labels"));
  const sIndices = sections.take(header.sIndicesSize, "the text wave's string index");

  const shortUnit = (at: number) => cString(bytes.subarray(at, at + 4));
  // A unit too long for its 4 bytes in the header is in the sections after the wave.
  const unitOf = (long: Uint8Array, short: Uint8Array) =>
    igorText(long.length > 0 ? cString(long) : short, little, used);
  const dims = sizes.map((size, d) => {
    const scale = scaling(
      read.float64(wave + 116 + 8 * d),
      read.float64(wave + 84 + 8 * d),
      d,
      remarks,
    );
    return { size, ...scale, unit: unitOf(dimEUnits[d]!, shortUnit(wave + 152 + 4 * d)) };
  });
  if (labels.some((label) => label.some((byte) => byte !== 0))) {
    remarks.push("Igor's dimension labels are not loaded.");
  }

  let values: { data: WaveData; imag: WaveData | null; text: string[] | null; type: WaveType };
  let missingValues = false;
  if (!type.kind) {
    values = { data: new Float64Array(0), imag: null, type: "float64", text: [] };
    values.text = textValues(read, wave + WAVE5_DATA, stored, sIndices, npnts, used);
    if (sizes.length > 1) {
      remarks.push(
        `Igor's text wave is ${sizes.join("×")}; a text wave here has one dimension, so its strings are in Igor's point order (the first index fastest).`,
      );
    }
  } else {
    const dataBytes = npnts * type.kind.size * (type.complex ? 2 : 1);
    missingValues = stored === 0 && npnts > 0 && header.formulaSize > 0;
    if (!missingValues && stored < dataBytes) {
      throw new IgorError(
        `The file is damaged: the wave has ${npnts} points but the file has room for ${Math.floor(stored / type.kind.size / (type.complex ? 2 : 1))}.`,
      );
    }
    const waveType = type.complex ? type.kind.complex : type.kind.real;
    values = missingValues
      ? { data: newWaveData(waveType, 0), imag: null, text: null, type: waveType }
      : {
          ...numericValues(
            bytes,
            wave + WAVE5_DATA,
            sizes,
            type.kind,
            type.complex,
            little,
            remarks,
          ),
          text: null,
          type: waveType,
        };
  }

  for (let d = 2; d < dims.length; d += 1) {
    const { start, delta, unit } = dims[d]!;
    if (start !== 0 || delta !== 1 || unit) {
      remarks.push(
        `Igor's scaling of the ${DIMENSION_WORDS[d]}: start ${start}, step ${delta}${unit ? `, unit ${JSON.stringify(unit)}` : ""} (a wave here has scaling for its rows and columns only).`,
      );
    }
  }
  return finish({
    name,
    version: 5,
    littleEndian: little,
    igorType: type.words,
    dims,
    ...values,
    shape: missingValues ? [0] : values.text ? [values.text.length] : sizes,
    unit: unitOf(dataEUnits, shortUnit(wave + 148)),
    note: unixLines(igorText(note, little, used)),
    formula: igorText(cString(formula), little, used),
    missingValues,
    remarks,
    used,
  });
}

/**
 * The strings of a version 5 text wave: the values are the strings one after
 * another, and the string index says where each ends.
 */
function textValues(
  read: Reader,
  start: number,
  stored: number,
  sIndices: Uint8Array,
  npnts: number,
  used: Set<string>,
): string[] {
  if (sIndices.length !== npnts * 4) {
    throw new IgorError(
      `The file is damaged: the text wave has ${npnts} strings but an index for ${Math.floor(sIndices.length / 4)}.`,
    );
  }
  const index = new Reader(sIndices, read.little);
  const content = read.bytes.subarray(start, start + stored);
  const text: string[] = [];
  let from = 0;
  for (let point = 0; point < npnts; point += 1) {
    const end = index.int32(point * 4);
    if (end < from || end > stored) {
      throw new IgorError(
        "The file is damaged: the index of the text wave points outside its strings.",
      );
    }
    text.push(igorText(content.subarray(from, end), read.little, used));
    from = end;
  }
  return text;
}

/** Notes what was needed to read text that is not UTF-8. */
function finish(wave: IgorWave & { used: Set<string> }): IgorWave {
  const { used, ...rest } = wave;
  if (used.size > 0) {
    rest.remarks.push(
      `Text that is not UTF-8 was read as ${[...used].join(" and ")} (the encoding of an older Igor on ${rest.littleEndian ? "Windows" : "a Mac"}).`,
    );
  }
  if (rest.formula) {
    rest.remarks.push(
      rest.missingValues
        ? `Igor computes this wave from the formula ${JSON.stringify(rest.formula)} and did not save its values.`
        : `Igor computed this wave from the formula ${JSON.stringify(rest.formula)}; the values are those saved, and the formula is not kept.`,
    );
  }
  return rest;
}

/** Record types of a packed experiment (PTN003), with the superseded flag removed. */
const RECORD = {
  variables: 1,
  history: 2,
  wave: 3,
  recreation: 4,
  procedure: 5,
  getHistory: 7,
  packedFile: 8,
  folderStart: 9,
  folderEnd: 10,
  /** Igor 8 and later: a data folder whose name does not fit in 31 bytes. */
  longFolderStart: 101,
} as const;
const SUPERSEDED = 0x8000;

/** A wave of a packed experiment and the data folders it is in, below root. */
export interface PackedWave {
  folder: string[];
  wave: IgorWave;
}

/** What a packed experiment holds besides its waves, none of which is loaded. */
export interface PackedRest {
  /** Numeric and string variables, counted over all data folders. */
  variables: number;
  strings: number;
  /** Window recreation macros, by kind of window ("Graph", "Table", "Layout", ...). */
  windows: Record<string, number>;
  procedure: boolean;
  history: boolean;
  /** Notebooks and procedure files packed into the experiment. */
  packedFiles: number;
  /** Records of types this reader does not know (Igor writes several kinds of its own settings). */
  other: number;
}

export interface PackedExperiment {
  littleEndian: boolean;
  waves: PackedWave[];
  /** Every data folder in the file, as paths of names below root. */
  folders: string[][];
  rest: PackedRest;
}

interface RecordHeader {
  type: number;
  superseded: boolean;
  at: number;
  size: number;
}

/**
 * The records of a packed file in one byte order, as far as they follow one
 * another without running past the end.
 */
function recordsIn(bytes: Uint8Array, little: boolean): { records: RecordHeader[]; end: number } {
  const read = new Reader(bytes, little);
  const records: RecordHeader[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    const type = read.uint16(at);
    const size = read.int32(at + 4);
    if (size < 0 || at + 8 + size > bytes.length) break;
    records.push({
      type: type & ~SUPERSEDED,
      superseded: (type & SUPERSEDED) !== 0,
      at: at + 8,
      size,
    });
    at += 8 + size;
  }
  return { records, end: at };
}

const RECORD_WORDS: Record<number, string> = {
  [RECORD.variables]: "variables",
  [RECORD.history]: "history",
  [RECORD.wave]: "wave",
  [RECORD.recreation]: "window recreation",
  [RECORD.procedure]: "procedure",
  [RECORD.packedFile]: "packed file",
  [RECORD.folderStart]: "data folder",
  [RECORD.longFolderStart]: "data folder",
};

/** Whether bytes are a binary wave that reads without a fault. */
function isBinaryWave(bytes: Uint8Array): boolean {
  try {
    readBinaryWave(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Whether bytes are records of a packed experiment from start to end. */
function isPackedExperiment(bytes: Uint8Array): boolean {
  return [true, false].some((little) => {
    const found = recordsIn(bytes, little);
    return found.end === bytes.length && found.records.some((item) => RECORD_WORDS[item.type]);
  });
}

/** Reads the waves and data folders of a packed experiment (.pxp) or template (.pxt). */
export function readPackedExperiment(bytes: Uint8Array): PackedExperiment {
  // The checksum and the sizes of a binary wave all fit only by design, so a
  // file that reads as one is one, even if its first bytes pass for records.
  if (isBinaryWave(bytes)) {
    throw new IgorError(
      "This is an Igor binary wave, not a packed experiment: give the file the extension .ibw.",
    );
  }
  // The file does not say its byte order outright; in the right one the
  // records follow one another to the very end of the file.
  const big = recordsIn(bytes, false);
  const small = recordsIn(bytes, true);
  // Should both reach the end, the one with more records of known kinds is right.
  const known = (found: { records: RecordHeader[] }) =>
    found.records.filter((record) => RECORD_WORDS[record.type]).length;
  const score = (found: { records: RecordHeader[]; end: number }) =>
    found.end === bytes.length ? known(found) : 0;
  if (score(small) === 0 && score(big) === 0) {
    const longer = small.end >= big.end ? small : big;
    if (known(longer) === 0) {
      throw new IgorError(
        "This is not an Igor packed experiment: it is not made of the records Igor writes.",
      );
    }
    throw new IgorError(
      `The file is cut short or damaged: after ${longer.records.length} records it ends inside the next (at byte ${longer.end} of ${bytes.length}). Copy it again from where it was saved.`,
    );
  }
  const little = score(small) >= score(big);
  const { records } = little ? small : big;

  const read = new Reader(bytes, little);
  const waves: PackedWave[] = [];
  const folders: string[][] = [];
  const path: string[] = [];
  const rest: PackedRest = {
    variables: 0,
    strings: 0,
    windows: {},
    procedure: false,
    history: false,
    packedFiles: 0,
    other: 0,
  };
  records.forEach((record, number) => {
    if (record.superseded) return;
    const data = bytes.subarray(record.at, record.at + record.size);
    const where = () =>
      `record ${number + 1} (a ${RECORD_WORDS[record.type] ?? "kind of"} record at byte ${record.at - 8}${path.length > 0 ? `, in data folder ${path.join(":")}` : ""})`;
    switch (record.type) {
      case RECORD.wave:
        try {
          waves.push({ folder: [...path], wave: readBinaryWave(data) });
        } catch (error) {
          throw new IgorError(
            `In ${where()}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      case RECORD.folderStart:
      case RECORD.longFolderStart: {
        let name: Uint8Array;
        if (record.type === RECORD.longFolderStart) {
          const length = record.size >= 4 ? read.uint32(record.at) : -1;
          if (length !== record.size - 4) {
            throw new IgorError(
              `The file is damaged: the name in ${where()} has the wrong length.`,
            );
          }
          name = data.subarray(4);
        } else {
          name = cString(data);
        }
        path.push(igorText(name, little));
        folders.push([...path]);
        break;
      }
      case RECORD.folderEnd:
        if (path.length === 0) {
          throw new IgorError(
            `The file is damaged: ${where()} closes a data folder that was never opened.`,
          );
        }
        path.pop();
        break;
      case RECORD.variables:
        countVariables(read, record, rest);
        break;
      case RECORD.history:
      case RECORD.getHistory:
        if (trimZeros(data).some((byte) => byte > 0x20)) rest.history = true;
        break;
      case RECORD.recreation:
        countWindows(data, rest);
        break;
      case RECORD.procedure:
        if (trimZeros(data).some((byte) => byte > 0x20)) rest.procedure = true;
        break;
      case RECORD.packedFile:
        rest.packedFiles += 1;
        break;
      default:
        rest.other += 1;
    }
  });
  if (path.length > 0) {
    throw new IgorError(
      `The file is cut short or damaged: it ends inside data folder ${path.join(":")}.`,
    );
  }
  return { littleEndian: little, waves, folders, rest };
}

/**
 * Counts the variables a variables record holds, from its header: a
 * version, then the numbers of system variables, user variables and user
 * strings, and in version 2 the numbers of dependent variables and strings.
 */
function countVariables(read: Reader, record: RecordHeader, rest: PackedRest): void {
  if (record.size < 8) return;
  const version = read.int16(record.at);
  rest.variables += Math.max(0, read.int16(record.at + 4));
  rest.strings += Math.max(0, read.int16(record.at + 6));
  if (version >= 2 && record.size >= 12) {
    rest.variables += Math.max(0, read.int16(record.at + 8));
    rest.strings += Math.max(0, read.int16(record.at + 10));
  }
}

/** Counts the windows whose recreation macros a record holds ("Window Graph0() : Graph"). */
function countWindows(data: Uint8Array, rest: PackedRest): void {
  const text = new TextDecoder("latin1").decode(data);
  for (const match of text.matchAll(/^Window\s+\w+\s*\([^)]*\)\s*:\s*(\w+)/gm)) {
    const kind = match[1]!;
    rest.windows[kind] = (rest.windows[kind] ?? 0) + 1;
  }
}
