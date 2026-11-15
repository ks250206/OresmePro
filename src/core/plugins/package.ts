import {
  CONTRIBUTION_KINDS,
  MANIFEST_FILE,
  PACKAGE_LIMITS,
  parseManifest,
  PluginError,
  type PluginManifest,
  type PluginSource,
} from "./manifest";

/**
 * A plugin package as it is installed: its manifest, every file with its
 * SHA-256, and one digest over all of it. The digest names the package: an
 * approval is given to a digest, and the files are checked against their
 * hashes whenever they are read back.
 */

export interface LockedFile {
  path: string;
  sha256: string;
  size: number;
}

export interface PluginLock {
  /** Where it came from, and the commit for GitHub: everything is fetched from that one commit. */
  source: PluginSource;
  commit: string | null;
  manifestSha256: string;
  files: LockedFile[];
  /** SHA-256 over the manifest's hash and the list of files with theirs. */
  digest: string;
}

export interface VerifiedPackage {
  manifest: PluginManifest;
  manifestBytes: Uint8Array;
  files: Map<string, Uint8Array>;
  lock: PluginLock;
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function digestOf(manifestSha256: string, files: readonly LockedFile[]): Promise<string> {
  const listing = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.sha256} ${file.size} ${file.path}`)
    .join("\n");
  return sha256(new TextEncoder().encode(`${MANIFEST_FILE} ${manifestSha256}\n${listing}\n`));
}

/**
 * Checks a package fetched from somewhere: the manifest, that every listed
 * file is there (and nothing else is), sizes, the hashes the manifest gives,
 * and that the files it contributes as data are JSON. Returns the package
 * with its lock, or throws and nothing is installed.
 */
export async function verifyPackage(
  manifestBytes: Uint8Array,
  files: ReadonlyMap<string, Uint8Array>,
  source: PluginSource,
  commit: string | null,
): Promise<VerifiedPackage> {
  const manifest = parseManifest(manifestBytes);
  const listed = new Set(manifest.files.map((entry) => entry.path));
  for (const path of files.keys()) {
    if (!listed.has(path))
      throw new PluginError(`${path} is in the package but not in its list of files.`);
  }
  let total = manifestBytes.byteLength;
  const locked: LockedFile[] = [];
  const kept = new Map<string, Uint8Array>();
  for (const entry of manifest.files) {
    const bytes = files.get(entry.path);
    if (!bytes) throw new PluginError(`${entry.path} is missing from the package.`);
    if (bytes.byteLength > PACKAGE_LIMITS.fileBytes) {
      throw new PluginError(
        `${entry.path} is larger than ${PACKAGE_LIMITS.fileBytes / 1024 / 1024} MiB.`,
      );
    }
    total += bytes.byteLength;
    if (total > PACKAGE_LIMITS.totalBytes) {
      throw new PluginError(
        `The package is larger than ${PACKAGE_LIMITS.totalBytes / 1024 / 1024} MiB.`,
      );
    }
    const hash = await sha256(bytes);
    if (entry.sha256 !== null && entry.sha256 !== hash) {
      throw new PluginError(
        `${entry.path} is not the file the manifest describes (its SHA-256 differs).`,
      );
    }
    locked.push({ path: entry.path, sha256: hash, size: bytes.byteLength });
    kept.set(entry.path, bytes);
  }
  for (const kind of CONTRIBUTION_KINDS) {
    for (const path of manifest.contributes[kind]) {
      try {
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(kept.get(path)!));
      } catch {
        throw new PluginError(`${path} is not valid JSON.`);
      }
    }
  }
  const manifestSha256 = await sha256(manifestBytes);
  return {
    manifest,
    manifestBytes,
    files: kept,
    lock: {
      source,
      commit,
      manifestSha256,
      files: locked,
      digest: await digestOf(manifestSha256, locked),
    },
  };
}

/** Checks files read back from storage against the lock: anything changed or missing refuses them all. */
export async function checkAgainstLock(
  lock: PluginLock,
  manifestBytes: Uint8Array,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  if ((await sha256(manifestBytes)) !== lock.manifestSha256) {
    throw new PluginError("The plugin's manifest has changed since it was installed.");
  }
  for (const file of lock.files) {
    const bytes = files.get(file.path);
    if (!bytes || bytes.byteLength !== file.size || (await sha256(bytes)) !== file.sha256) {
      throw new PluginError(`${file.path} has changed since the plugin was installed.`);
    }
  }
  if ((await digestOf(lock.manifestSha256, lock.files)) !== lock.digest) {
    throw new PluginError("The plugin's record does not match its files.");
  }
}
