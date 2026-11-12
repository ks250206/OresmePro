// Puts Pyodide and the Python packages the app starts with into
// public/pyodide/, so the app (and its tests) run without reaching a CDN.
//
// The Pyodide runtime comes from the installed npm package. NumPy, IPython
// and what they depend on are downloaded once and checked against the hashes
// in Pyodide's lock file. Every other package stays on the CDN: the lock file
// written here points at it, so `import scipy` still works when online.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED = ["numpy", "ipython"];
const RUNTIME_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "pyodide");
const source = dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const cdn = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
const lock = JSON.parse(await readFile(join(source, "pyodide-lock.json"), "utf8"));

/** The named packages and everything they depend on. */
function closure(names) {
  const seen = new Set();
  const visit = (name) => {
    // Lock file keys are normalized names: lower case, with "-" for "_" and ".".
    const key = name.toLowerCase().replace(/[._]+/g, "-");
    if (seen.has(key)) return;
    const entry = lock.packages[key];
    if (!entry) throw new Error(`Pyodide ${version} has no package named ${name}.`);
    seen.add(key);
    for (const dependency of entry.depends) visit(dependency);
  };
  for (const name of names) visit(name);
  return seen;
}

const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function upToDate(path, expected) {
  try {
    await stat(path);
    return (await sha256(path)) === expected;
  } catch {
    return false;
  }
}

await mkdir(target, { recursive: true });
for (const file of RUNTIME_FILES) await copyFile(join(source, file), join(target, file));

const bundled = closure(BUNDLED);
let downloaded = 0;
for (const key of bundled) {
  const entry = lock.packages[key];
  const path = join(target, entry.file_name);
  if (await upToDate(path, entry.sha256)) continue;
  const response = await fetch(cdn + entry.file_name);
  if (!response.ok)
    throw new Error(`Could not download ${entry.file_name}: HTTP ${response.status}`);
  await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  if ((await sha256(path)) !== entry.sha256) {
    throw new Error(`${entry.file_name} does not match the hash in Pyodide's lock file.`);
  }
  downloaded += 1;
}

// Bundled packages keep their relative file names; the rest are fetched from the CDN.
for (const [key, entry] of Object.entries(lock.packages)) {
  if (!bundled.has(key)) entry.file_name = cdn + entry.file_name;
}
await writeFile(join(target, "pyodide-lock.json"), JSON.stringify(lock));
// What the app needs to start Python without a network; the service worker keeps these.
const files = [
  ...RUNTIME_FILES,
  "pyodide-lock.json",
  ...[...bundled].map((key) => lock.packages[key].file_name),
];
await writeFile(join(target, "files.json"), JSON.stringify([...new Set(files)]));

console.log(
  `Pyodide ${version} in public/pyodide: ${bundled.size} packages bundled` +
    (downloaded > 0 ? `, ${downloaded} downloaded.` : ", all already present."),
);
