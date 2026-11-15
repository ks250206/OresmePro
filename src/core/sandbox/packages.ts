import { SandboxError } from "./validate";

/** A package as Pyodide's lock file lists it. */
export interface LockPackage {
  file_name: string;
  depends: string[];
}

/** Pyodide's lock file: the packages there are, by name. */
export interface Lock {
  packages: Record<string, LockPackage>;
}

/** The packages asked for and all they depend on, by the lock file. */
export function packageClosure(lock: Lock, names: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (name: string) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    const entry = lock.packages[key];
    if (!entry) throw new SandboxError(`Python has no package ${name}.`);
    seen.add(key);
    for (const dependency of entry.depends) visit(dependency);
  };
  for (const name of names) visit(name);
  return [...seen];
}
