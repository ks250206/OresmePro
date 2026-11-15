import { unzipSync } from "fflate";
import {
  checkPath,
  MANIFEST_FILE,
  PACKAGE_LIMITS,
  parseManifest,
  PluginError,
  type PluginSource,
} from "../../core/plugins/manifest";
import { verifyPackage, type VerifiedPackage } from "../../core/plugins/package";

/**
 * Getting a plugin package: from a GitHub repository at one commit, or from
 * files the user picks (a folder or a zip). Either way nothing in it runs
 * here; what comes back is checked (src/core/plugins/package.ts) and goes
 * to the user to approve before it is installed.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function bytesOf(response: Response, what: string, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new PluginError(`Could not fetch ${what} (${response.status}).`);
  const size = Number(response.headers.get("Content-Length") ?? "0");
  if (size > limit)
    throw new PluginError(`${what} is larger than ${Math.round(limit / 1024 / 1024)} MiB.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit)
    throw new PluginError(`${what} is larger than ${Math.round(limit / 1024 / 1024)} MiB.`);
  return bytes;
}

/**
 * Fetches a package from GitHub. The branch or tag is first turned into a
 * commit, and every file is then fetched from that commit: what is
 * installed is one state of the repository, whatever is pushed meanwhile.
 */
export async function fetchFromGitHub(
  source: Extract<PluginSource, { kind: "github" }>,
  fetchImpl: Fetch = (url, init) => fetch(url, init),
): Promise<VerifiedPackage> {
  const { owner, repo, ref, path } = source;
  const api = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    { headers: { Accept: "application/vnd.github.sha" } },
  );
  if (api.status === 404 || api.status === 422) {
    throw new PluginError(`GitHub has no ${owner}/${repo} with a branch, tag or commit ${ref}.`);
  }
  if (!api.ok) throw new PluginError(`GitHub did not answer (${api.status}). Try again later.`);
  const commit = (await api.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new PluginError("GitHub did not give a commit.");
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path ? `${path}/` : ""}`;
  const manifestBytes = await bytesOf(
    await fetchImpl(`${base}${MANIFEST_FILE}`),
    MANIFEST_FILE,
    PACKAGE_LIMITS.manifestBytes,
  );
  const manifest = parseManifest(manifestBytes);
  const files = new Map<string, Uint8Array>();
  // A few at a time: enough to be quick, not so many as to be refused.
  const queue = [...manifest.files];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const url = `${base}${entry.path.split("/").map(encodeURIComponent).join("/")}`;
      files.set(
        entry.path,
        await bytesOf(await fetchImpl(url), entry.path, PACKAGE_LIMITS.fileBytes),
      );
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return verifyPackage(manifestBytes, files, { ...source, ref }, commit);
}

/**
 * Reads a package from files the user picked: the files of a folder (with
 * their paths in it) or one zip. The package is the folder that holds
 * oresme-plugin.json; files outside it are not part of it.
 */
export async function readLocalPackage(
  picked: readonly { path: string; bytes: () => Promise<Uint8Array> }[],
): Promise<VerifiedPackage> {
  let entries = picked;
  if (picked.length === 1 && /\.zip$/i.test(picked[0]!.path)) {
    entries = unzipPackage(await picked[0]!.bytes());
  }
  const manifests = entries
    .filter((entry) => entry.path === MANIFEST_FILE || entry.path.endsWith(`/${MANIFEST_FILE}`))
    .sort((a, b) => a.path.length - b.path.length);
  const found = manifests[0];
  if (!found) throw new PluginError(`There is no ${MANIFEST_FILE} among the files.`);
  const root = found.path.slice(0, found.path.length - MANIFEST_FILE.length);
  const manifestBytes = await found.bytes();
  const manifest = parseManifest(manifestBytes);
  const listed = new Set(manifest.files.map((entry) => entry.path));
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!entry.path.startsWith(root) || entry === found) continue;
    const path = entry.path.slice(root.length);
    // Files the manifest does not list (a README, tests) are not part of the package.
    if (!listed.has(path)) continue;
    files.set(checkPath(path), await entry.bytes());
  }
  return verifyPackage(manifestBytes, files, { kind: "local", label: manifest.name }, null);
}

/**
 * The files of a zip, refusing one that would unpack to more than a package
 * may hold: sizes are read from the zip's directory before anything is
 * unpacked, so a small file that unpacks to gigabytes is caught first.
 */
export function unzipPackage(
  bytes: Uint8Array,
): { path: string; bytes: () => Promise<Uint8Array> }[] {
  let total = 0;
  let count = 0;
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith("/")) return false;
        count += 1;
        total += file.originalSize;
        if (count > PACKAGE_LIMITS.files * 4 || file.originalSize > PACKAGE_LIMITS.fileBytes) {
          throw new PluginError("The zip holds more than a plugin package may.");
        }
        if (total > PACKAGE_LIMITS.totalBytes * 2) {
          throw new PluginError("The zip unpacks to more than a plugin package may hold.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError("The file is not a zip that can be read.");
  }
  return Object.entries(unpacked).map(([path, content]) => ({
    path,
    bytes: () => Promise.resolve(content),
  }));
}
