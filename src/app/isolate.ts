const RELOADED = "oresme-isolation-reloaded";

/**
 * Registers the service worker (public/sw.js) and makes sure the page is
 * cross-origin isolated, which Python needs.
 *
 * The worker keeps the app's files, so that an installed OresmePro starts
 * without a network, and on servers that do not send the isolation headers
 * it adds them. In that last case the page has to be reloaded once for the
 * headers to take effect: this then returns false, and start-up can be
 * skipped.
 *
 * Under the development server nothing is registered unless isolation needs
 * it: a worker that keeps files would serve stale modules.
 */
export async function ensureIsolated(): Promise<boolean> {
  const isolated = globalThis.crossOriginIsolated;
  if (isolated) sessionStorage.removeItem(RELOADED);
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return true;
  if (isolated && !import.meta.env.PROD) return true;
  try {
    const url = `${import.meta.env.BASE_URL}sw.js?app=${__BUILD_ID__}&python=${__PYODIDE_VERSION__}`;
    const registering = navigator.serviceWorker.register(url);
    // With isolation in place already, the worker is only for working offline: no need to wait.
    if (isolated) {
      registering.catch(() => {});
      return true;
    }
    const registration = await registering;
    await navigator.serviceWorker.ready;
    // Reload at most once per tab: if isolation still fails, carry on without Python.
    if (sessionStorage.getItem(RELOADED)) return true;
    sessionStorage.setItem(RELOADED, "1");
    if (registration.active && !navigator.serviceWorker.controller) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    window.location.reload();
    return false;
  } catch {
    return true;
  }
}

/**
 * Has the service worker keep everything the app has loaded and everything
 * Python is made of, so that the next start needs no network. Resolves to
 * the number of files kept, or 0 if there is no worker to keep them.
 */
export async function keepForOffline(pyodideUrl: string): Promise<number> {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return 0;
  try {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) return 0;
    const loaded = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => url.startsWith(location.origin));
    const list = (await (await fetch(`${pyodideUrl}files.json`)).json()) as string[];
    const urls = [
      location.href,
      new URL(import.meta.env.BASE_URL, location.href).href,
      ...loaded,
      `${pyodideUrl}files.json`,
      ...list.map((file) => new URL(file, pyodideUrl).href),
    ];
    return await new Promise<number>((resolve) => {
      const done = (event: MessageEvent<{ type?: string; count?: number }>) => {
        if (event.data?.type !== "kept") return;
        navigator.serviceWorker.removeEventListener("message", done);
        resolve(event.data.count ?? 0);
      };
      navigator.serviceWorker.addEventListener("message", done);
      worker.postMessage({ type: "keep", urls: [...new Set(urls)] });
    });
  } catch {
    return 0;
  }
}

/**
 * Has the service worker keep the packages that Python otherwise fetches the
 * first time they are imported (SciPy, pandas, scikit-learn, lmfit), so that
 * they are there without a network. Resolves to the names of the packages
 * kept, or null if there is no worker to keep them.
 */
export async function keepPackagesForOffline(pyodideUrl: string): Promise<string[] | null> {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return null;
  try {
    const worker = (await navigator.serviceWorker.ready).active;
    if (!worker) return null;
    const list = (await (await fetch(`${pyodideUrl}packages.json`)).json()) as {
      names: string[];
      files: string[];
    };
    const urls = list.files.map((file) => new URL(file, new URL(pyodideUrl, location.href)).href);
    const kept = await new Promise<number>((resolve) => {
      const done = (event: MessageEvent<{ type?: string; count?: number }>) => {
        if (event.data?.type !== "kept") return;
        navigator.serviceWorker.removeEventListener("message", done);
        resolve(event.data.count ?? 0);
      };
      navigator.serviceWorker.addEventListener("message", done);
      worker.postMessage({ type: "keep", urls });
    });
    return kept >= urls.length ? list.names : null;
  } catch {
    return null;
  }
}

interface LaunchQueue {
  setConsumer(consumer: (params: { files?: { getFile(): Promise<File> }[] }) => void): void;
}

/**
 * Opens files the operating system hands to the installed app: an experiment
 * double-clicked in the file manager, say.
 */
export function openLaunchedFiles(load: (files: File[]) => void): void {
  const queue = (globalThis as { launchQueue?: LaunchQueue }).launchQueue;
  queue?.setConsumer((params) => {
    void Promise.all((params.files ?? []).map((handle) => handle.getFile())).then((files) => {
      if (files.length > 0) load(files);
    });
  });
}
