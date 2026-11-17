import type { PyodideAPI } from "pyodide";
import analysisSource from "./python/_oresme_analysis.py?raw";
import packagesSource from "./python/_oresme_packages.py?raw";
import variablesSource from "./python/_oresme_variables.py?raw";
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
  /** `info` is the JSON `{code, details}` of a refusal (an OresmeError), or "". */
  error(name: string, message: string, traceback: string, info: string): void;
  /** The registered actions (JSON), once Python is up and again whenever they change. */
  actions?(catalogJson: string): void;
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
  /**
   * Calls a registered action with arguments given as JSON. `onChecked`
   * gets the Python that does the same once the call is accepted; a refused
   * call never runs. Resolves to the JSON `{"result": ...}`, or null if the
   * call was refused or raised (the error went to `hooks.error`).
   */
  invoke(
    action: string,
    version: number | null,
    argsJson: string,
    onChecked: (code: string) => void,
  ): Promise<string | null>;
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
  pyodide.FS.writeFile(`${SITE}/_oresme_packages.py`, packagesSource);
  pyodide.FS.writeFile(`${SITE}/_oresme_variables.py`, variablesSource);
  pyodide.FS.writeFile(`${SITE}/oresme_kernel.py`, kernelSource);

  pyodide.registerJsModule("_oresme_js", {
    rpc: (method: string, paramsJson: string, data?: Float64Array | null) => {
      const reply = hooks.rpc(method, paramsJson, data ?? null);
      return [reply.json, reply.data ?? undefined];
    },
    stream: (name: "stdout" | "stderr", text: string) => hooks.stream(name, text),
    display: (bundleJson: string) => hooks.display(bundleJson),
    error: (name: string, message: string, traceback: string, info?: string) =>
      hooks.error(name, message, traceback, info ?? ""),
    // What Python is busy with besides the user's code (loading a package); "" when done.
    progress: (message: string) => onProgress(message),
  });

  onProgress("Starting Python…");
  pyodide.runPython(`import sys\nsys.path.insert(0, ${JSON.stringify(SITE)})`);
  const kernel = pyodide.pyimport("oresme_kernel");
  // Code that runs may register actions (a procedure, say): the main thread
  // is told the new list after it ends.
  let actionsRevision = Number(kernel.actions_revision());
  hooks.actions?.(String(kernel.actions()));
  const reportActions = () => {
    const revision = Number(kernel.actions_revision());
    if (revision === actionsRevision) return;
    actionsRevision = revision;
    hooks.actions?.(String(kernel.actions()));
  };
  return {
    // Packages the code imports are installed by the Python side before it
    // runs (see _load_packages in oresme_kernel.py), where an interrupt can
    // cancel the wait like any other.
    execute: async (code) => {
      kernel.prepare();
      try {
        return Boolean(await kernel.execute(code));
      } finally {
        reportActions();
      }
    },
    invoke: async (action, version, argsJson, onChecked) => {
      kernel.prepare();
      try {
        // undefined, not null, reaches Python as None (null is pyodide's jsnull).
        const code = kernel.check_action(action, version ?? undefined, argsJson) as
          | string
          | undefined;
        if (code === undefined || code === null) return null;
        onChecked(code);
        const result = (await kernel.run_action()) as string | undefined;
        return result ?? null;
      } finally {
        reportActions();
      }
    },
    complete: (code, cursor) => JSON.parse(kernel.complete(code, cursor)) as CompletionItem[],
    interrupt: () => kernel.interrupt(),
  };
}
