import { DocError } from "./errors";

/*
 * The Python packages an experiment uses beyond those Python starts with:
 * what `%pip install` (op.install) put in, recorded so that opening the
 * experiment again, in this browser or another, puts the same in again.
 *
 * What is kept is the list, not the installed files: each package by name
 * and the exact version it was, the wheel it came from and that wheel's
 * SHA-256, and what it depends on. A package of the Pyodide distribution
 * comes from the distribution the app ships; one from PyPI from its wheel's
 * address, which never changes, so the browser can keep the file and put it
 * in again offline.
 */

/** Where a package comes from: the Pyodide distribution, or PyPI (or another address). */
export const PACKAGE_SOURCES = ["pyodide", "pypi"] as const;
export type PackageSource = (typeof PACKAGE_SOURCES)[number];

export interface PythonPackage {
  /** Its name as Python packaging normalizes it: lower case, "-" for runs of "-", "_" and ".". */
  name: string;
  version: string;
  source: PackageSource;
  /** The wheel it was installed from. */
  url: string;
  /** The wheel's SHA-256, where it is known. */
  sha256: string;
  /** The names of the packages it needs (normalized). */
  depends: string[];
  /** Asked for by the user, rather than brought in as what another needs. */
  requested: boolean;
}

export interface PythonEnv {
  /** The Pyodide version the packages were installed under, or null when there are none. */
  pyodide: string | null;
  packages: readonly PythonPackage[];
}

export const emptyPythonEnv = (): PythonEnv => ({ pyodide: null, packages: [] });

/** A package's name as Python packaging normalizes it (PEP 503). */
export const normalizePackageName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");

const text = (value: unknown, what: string, limit = 2000): string => {
  if (typeof value !== "string" || value.length > limit) {
    throw new DocError(`${what} must be text.`, "INVALID_ARGUMENT", { field: what });
  }
  return value;
};

/** One package as Python records it, checked. */
export function checkPackage(value: unknown): PythonPackage {
  if (typeof value !== "object" || value === null) throw new DocError("A package is a dict.");
  const given = value as Record<string, unknown>;
  const name = normalizePackageName(text(given.name, "A package's name", 200));
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new DocError(`${JSON.stringify(given.name)} is not the name of a package.`);
  }
  const source = given.source;
  if (!PACKAGE_SOURCES.includes(source as PackageSource)) {
    throw new DocError(`A package's source must be one of: ${PACKAGE_SOURCES.join(", ")}.`);
  }
  const depends = Array.isArray(given.depends) ? given.depends : [];
  return {
    name,
    version: text(given.version, `${name}'s version`, 100),
    source: source as PackageSource,
    url: given.url === undefined ? "" : text(given.url, `${name}'s url`),
    sha256:
      given.sha256 === undefined || given.sha256 === null ? "" : text(given.sha256, "sha256", 64),
    depends: depends.map((item) => normalizePackageName(text(item, `${name}'s depends`, 200))),
    requested: given.requested === true,
  };
}

/**
 * The environment with packages recorded: one of a name already there is
 * replaced (a package asked for stays asked for), the others are added, in
 * order of name.
 */
export function withPackages(
  env: PythonEnv,
  added: readonly PythonPackage[],
  pyodide: string,
): PythonEnv {
  const byName = new Map(env.packages.map((item) => [item.name, item]));
  for (const item of added) {
    const before = byName.get(item.name);
    byName.set(item.name, { ...item, requested: item.requested || (before?.requested ?? false) });
  }
  return {
    pyodide,
    packages: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The names of the packages that `roots` need, themselves included, at any depth. */
export function neededBy(env: PythonEnv, roots: Iterable<string>): Set<string> {
  const byName = new Map(env.packages.map((item) => [item.name, item]));
  const needed = new Set<string>();
  const visit = (name: string) => {
    if (needed.has(name)) return;
    needed.add(name);
    for (const next of byName.get(name)?.depends ?? []) visit(next);
  };
  for (const name of roots) visit(name);
  return needed;
}

/**
 * The environment without the packages named: they are no longer asked
 * for, and every package that nothing asked for needs any more goes too.
 */
export function withoutPackages(env: PythonEnv, names: readonly string[]): PythonEnv {
  const gone = new Set(names.map(normalizePackageName));
  for (const name of gone) {
    if (!env.packages.some((item) => item.name === name)) {
      throw new DocError(
        `The experiment does not use a package named ${JSON.stringify(name)}.`,
        "NOT_FOUND",
        { kind: "package", name },
      );
    }
  }
  const requested = env.packages
    .filter((item) => item.requested && !gone.has(item.name))
    .map((item) => item.name);
  const kept = neededBy(env, requested);
  const packages = env.packages.filter((item) => kept.has(item.name));
  return { pyodide: packages.length > 0 ? env.pyodide : null, packages };
}

/** An environment as saved in a file, checked; what cannot be read is left out. */
export function savedPythonEnv(value: unknown): PythonEnv {
  if (typeof value !== "object" || value === null) return emptyPythonEnv();
  const given = value as Record<string, unknown>;
  const packages: PythonPackage[] = [];
  for (const item of Array.isArray(given.packages) ? given.packages : []) {
    try {
      packages.push(checkPackage(item));
    } catch {
      continue;
    }
  }
  return {
    pyodide: typeof given.pyodide === "string" && packages.length > 0 ? given.pyodide : null,
    packages,
  };
}

/** The packages from PyPI (or another address than the distribution): code from outside the app. */
export const fromOutside = (env: PythonEnv): PythonPackage[] =>
  env.packages.filter((item) => item.source !== "pyodide");

/** The environment as a requirements list: a line `name==version` for each package asked for. */
export const requirementsText = (env: PythonEnv): string =>
  env.packages
    .filter((item) => item.requested)
    .map((item) => `${item.name}==${item.version}\n`)
    .join("");
