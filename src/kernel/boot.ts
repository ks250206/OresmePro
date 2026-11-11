import type { PyodideAPI } from "pyodide";
import analysisSource from "./python/_oresme_analysis.py?raw";
import kernelSource from "./python/oresme_kernel.py?raw";
import oresmeSource from "./python/oresme.py?raw";

/** What the Python side can call. All of these must return synchronously. */
export interface KernelHooks {
  rpc(
    method: string,
    paramsJson: string,
    data: Float64Array | null,
  ): { json: string; data: Float64Array | null };
  stream(name: "stdout" | "stderr", text: string): void;
  /** A MIME bundle (JSON) for an expression result or display() call. */
  display(bundleJson: string): void;
  error(name: string, message: string, traceback: string): void;
}

export interface CompletionItem {
  text: string;
  start: number;
  end: number;
  type: string;
}

export interface PythonKernel {
  /** Resolves to true if the code ran without raising. */
  execute(code: string): Promise<boolean>;
  complete(code: string, cursor: number): CompletionItem[];
  /** Cancels the running input if it is waiting on `await`. */
  interrupt(): void;
}

const SITE = "/oresme_site";

/** Installs the `oresme` package into a Pyodide instance and starts IPython. */
export async function bootPython(
  pyodide: PyodideAPI,
  hooks: KernelHooks,
  onProgress: (message: string) => void = () => {},
): Promise<PythonKernel> {
  onProgress("Loading NumPy and IPython…");
  await pyodide.loadPackage(["numpy", "ipython"], {
    messageCallback: () => {},
    errorCallback: (message) => onProgress(message),
  });

  pyodide.FS.mkdirTree(SITE);
  pyodide.FS.writeFile(`${SITE}/oresme.py`, oresmeSource);
  pyodide.FS.writeFile(`${SITE}/_oresme_analysis.py`, analysisSource);
  pyodide.FS.writeFile(`${SITE}/oresme_kernel.py`, kernelSource);

  pyodide.registerJsModule("_oresme_js", {
    rpc: (method: string, paramsJson: string, data?: Float64Array | null) => {
      const reply = hooks.rpc(method, paramsJson, data ?? null);
      return [reply.json, reply.data ?? undefined];
    },
    stream: (name: "stdout" | "stderr", text: string) => hooks.stream(name, text),
    display: (bundleJson: string) => hooks.display(bundleJson),
    error: (name: string, message: string, traceback: string) =>
      hooks.error(name, message, traceback),
  });

  onProgress("Starting Python…");
  pyodide.runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(SITE)})`);
  const kernel = pyodide.pyimport("oresme_kernel");
  return {
    execute: async (code) => {
      // `import scipy` just works: packages from the Pyodide distribution are
      // fetched the first time the code imports them.
      try {
        await pyodide.loadPackagesFromImports(code, { messageCallback: () => {} });
      } catch {
        // Not fatal: the import itself will report what is missing.
      }
      return Boolean(await kernel.execute(code));
    },
    complete: (code, cursor) => JSON.parse(kernel.complete(code, cursor)) as CompletionItem[],
    interrupt: () => {
      kernel.interrupt();
    },
  };
}
