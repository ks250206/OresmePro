/**
 * The files of an experiment: whatever Python wrote into its working
 * directory, and files the user added for Python to read. They are saved
 * with the experiment and put back when it is opened.
 *
 * The store lives on the main thread, outside the document: writing a file
 * is a side effect of running code, not something undo can take back.
 */
export interface StoredFile {
  /** Path below the working directory, with "/" between folders. */
  path: string;
  bytes: Uint8Array;
  /** Changes whenever the file is written; unique across all files. */
  version: number;
}

/** Files larger than this are left out of the experiment. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export class FileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileError";
  }
}

/** Checks a path from outside and returns it in its normal form. */
export function checkFilePath(path: unknown): string {
  if (typeof path !== "string") throw new FileError("A file path must be text.");
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..") || path.includes("\0") || path.length > 1024) {
    throw new FileError(`${JSON.stringify(path)} is not a file path inside the experiment.`);
  }
  return parts.join("/");
}

export class FileStore {
  private files: ReadonlyMap<string, StoredFile> = new Map();
  private nextVersion = 1;
  private readonly listeners = new Set<() => void>();

  /** All files, sorted by path. The same array until something changes. */
  readonly list = (): readonly StoredFile[] => this.sorted;
  private sorted: readonly StoredFile[] = [];

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(path: string): StoredFile | undefined {
    return this.files.get(path);
  }

  /** Stores a file, replacing any at the same path, and returns its new version. */
  put(path: string, bytes: Uint8Array): number {
    const key = checkFilePath(path);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new FileError(`${key} is too large to keep with the experiment.`);
    }
    const version = this.nextVersion;
    this.nextVersion += 1;
    this.replace(new Map(this.files).set(key, { path: key, bytes, version }));
    return version;
  }

  remove(path: string): boolean {
    if (!this.files.has(path)) return false;
    const files = new Map(this.files);
    files.delete(path);
    this.replace(files);
    return true;
  }

  /** Replaces everything, for opening an experiment. Every file gets a new version. */
  load(files: Iterable<readonly [string, Uint8Array]>): void {
    const next = new Map<string, StoredFile>();
    for (const [path, bytes] of files) {
      const key = checkFilePath(path);
      next.set(key, { path: key, bytes, version: this.nextVersion });
      this.nextVersion += 1;
    }
    this.replace(next);
  }

  private replace(files: Map<string, StoredFile>): void {
    this.files = files;
    this.sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const listener of this.listeners) listener();
  }
}

/**
 * Bytes travel between Python and the application in the channel made for
 * wave data, which carries float64 values. Copies between arrays of one type
 * keep every bit, so the bytes are padded to a whole number of values and
 * sent as they are; the true length goes alongside.
 */
export function bytesToWords(bytes: Uint8Array): Float64Array {
  const padded = new Uint8Array(Math.ceil(bytes.byteLength / 8) * 8);
  padded.set(bytes);
  return new Float64Array(padded.buffer);
}

export function wordsToBytes(words: Float64Array | null, size: number): Uint8Array {
  if (size === 0) return new Uint8Array(0);
  if (!words || !Number.isInteger(size) || size < 0 || size > words.byteLength) {
    throw new FileError("The file's contents did not arrive whole.");
  }
  return new Uint8Array(words.buffer, words.byteOffset, size).slice();
}
