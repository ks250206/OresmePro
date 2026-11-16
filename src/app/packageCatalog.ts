import { createStore } from "./store";

/**
 * What the Pyodide distribution has, as the app's copy of its lock file
 * says: every package by normalized name with its version, and which of
 * them the app serves itself (SciPy, pandas, scikit-learn, lmfit and what
 * they need), which load the first time they are imported, without a
 * network.
 */
export interface PackageCatalog {
  /** Every package of the distribution: its version. */
  distribution: Record<string, string>;
  /** Those the app ships with itself. */
  bundled: Record<string, string>;
}

interface LockEntry {
  file_name: string;
  version: string;
  package_type?: string;
}

/** The catalog from a lock file: bundled packages are those whose file is not on the CDN. */
export function catalogFromLock(lock: { packages: Record<string, LockEntry> }): PackageCatalog {
  const distribution: Record<string, string> = {};
  const bundled: Record<string, string> = {};
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (entry.package_type && entry.package_type !== "package") continue;
    if (name.endsWith("-tests")) continue;
    const key = name.toLowerCase().replace(/[-_.]+/g, "-");
    distribution[key] = entry.version;
    if (!/^https?:/.test(entry.file_name)) bundled[key] = entry.version;
  }
  return { distribution, bundled };
}

export const packageCatalog = createStore<{ catalog: PackageCatalog | null }>({ catalog: null });

let loading: Promise<void> | null = null;

/** Reads the catalog once, from the lock file the app serves beside Python. */
export function loadPackageCatalog(pyodideUrl: string): Promise<void> {
  loading ??= fetch(new URL("pyodide-lock.json", new URL(pyodideUrl, location.href)))
    .then((response) => response.json() as Promise<{ packages: Record<string, LockEntry> }>)
    .then((lock) => packageCatalog.set({ catalog: catalogFromLock(lock) }))
    .catch(() => {
      // Without it the table shows what Python has, as before.
      loading = null;
    });
  return loading;
}
