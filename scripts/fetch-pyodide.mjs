// Puts Pyodide and the Python packages the app offers into public/pyodide/,
// so the app (and its tests) run without reaching a CDN.
//
// The Pyodide runtime comes from the installed npm package. Packages are
// downloaded once and checked against the hashes in Pyodide's lock file:
//
// - NumPy and IPython, which Python starts with, and
// - SciPy, pandas, scikit-learn and lmfit, which are loaded the first time
//   code imports them. They are served by the app itself so that they work
//   wherever the app does (a network that blocks the CDN, a pinned copy).
//
// lmfit and two packages it needs are not part of the Pyodide distribution.
// They are pure Python, so their wheels from PyPI work as they are; they are
// pinned here by version and hash and entered in the lock file, which is
// what makes `import lmfit` find them.
//
// Every other package of the distribution stays on the CDN: the lock file
// written here points at it, so `import sympy` still works when online.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Loaded when Python starts: kept by the service worker from the first visit. */
const STARTUP = ["numpy", "ipython"];
/** Loaded on first import; "lmfit" brings SciPy with it. */
const ON_DEMAND = ["scipy", "pandas", "scikit-learn", "lmfit"];
/** Pure Python wheels from PyPI that the Pyodide distribution does not have. */
const FROM_PYPI = [
  {
    name: "lmfit",
    version: "1.3.4",
    url: "https://files.pythonhosted.org/packages/38/7e/7b91c89a4cf0f543a83be978657afb20c86af6d725253e319589dcc4ce52/lmfit-1.3.4-py3-none-any.whl",
    sha256: "afce1593b42324d37ae2908249b0c55445e2f4c1a0474ff706a8e2f7b5d949fa",
    depends: ["asteval", "numpy", "scipy", "uncertainties", "dill"],
    imports: ["lmfit"],
  },
  {
    name: "asteval",
    version: "1.0.10",
    url: "https://files.pythonhosted.org/packages/92/16/e78d6e60ecd1b3cf446fad45985ad6cda22f46ad2cffabb644d77b317bc4/asteval-1.0.10-py3-none-any.whl",
    sha256: "8d805fa8084aa12204715f799430f0012a0db38b42e997f9f11a9637ad59855f",
    depends: [],
    imports: ["asteval"],
  },
  {
    name: "dill",
    version: "0.4.1",
    url: "https://files.pythonhosted.org/packages/1e/77/dc8c558f7593132cf8fefec57c4f60c83b16941c574ac5f619abb3ae7933/dill-0.4.1-py3-none-any.whl",
    sha256: "1e1ce33e978ae97fcfcff5638477032b801c46c7c65cf717f95fbc2248f79a9d",
    depends: [],
    imports: ["dill"],
  },
];
const RUNTIME_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "pyodide");
const source = dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const cdn = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
const lock = JSON.parse(await readFile(join(source, "pyodide-lock.json"), "utf8"));
/** Where each file is downloaded from, by file name. */
const origins = new Map();
for (const wheel of FROM_PYPI) {
  if (lock.packages[wheel.name]) continue; // A later Pyodide may bring its own.
  const fileName = wheel.url.slice(wheel.url.lastIndexOf("/") + 1);
  origins.set(fileName, wheel.url);
  lock.packages[wheel.name] = {
    name: wheel.name,
    version: wheel.version,
    file_name: fileName,
    install_dir: "site",
    sha256: wheel.sha256,
    package_type: "package",
    imports: wheel.imports,
    depends: wheel.depends,
    unvendored_tests: false,
  };
}

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

const startup = closure(STARTUP);
const bundled = closure([...STARTUP, ...ON_DEMAND]);
let downloaded = 0;
for (const key of bundled) {
  const entry = lock.packages[key];
  const path = join(target, entry.file_name);
  if (await upToDate(path, entry.sha256)) continue;
  const response = await fetch(origins.get(entry.file_name) ?? cdn + entry.file_name);
  if (!response.ok)
    throw new Error(`Could not download ${entry.file_name}: HTTP ${response.status}`);
  await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  if ((await sha256(path)) !== entry.sha256) {
    throw new Error(`${entry.file_name} does not match the hash it is pinned to.`);
  }
  downloaded += 1;
}

// Bundled packages keep their relative file names; the rest are fetched from the CDN.
for (const [key, entry] of Object.entries(lock.packages)) {
  if (!bundled.has(key)) entry.file_name = cdn + entry.file_name;
}
await writeFile(join(target, "pyodide-lock.json"), JSON.stringify(lock));
const fileNames = (keys) => [...new Set([...keys].map((key) => lock.packages[key].file_name))];
// What the app needs to start Python without a network; the service worker keeps these.
await writeFile(
  join(target, "files.json"),
  JSON.stringify([...RUNTIME_FILES, "pyodide-lock.json", ...fileNames(startup)]),
);
// The packages loaded on first import, for keeping them ahead of time (Python > Keep Packages for Offline Use).
await writeFile(
  join(target, "packages.json"),
  JSON.stringify({
    names: ON_DEMAND,
    files: fileNames([...bundled].filter((key) => !startup.has(key))),
  }),
);

console.log(
  `Pyodide ${version} in public/pyodide: ${bundled.size} packages bundled` +
    (downloaded > 0 ? `, ${downloaded} downloaded.` : ", all already present."),
);
