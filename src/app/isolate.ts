const RELOADED = "oresme-isolation-reloaded";

/**
 * Makes sure the page is cross-origin isolated, which Python needs.
 *
 * If the server already sends the isolation headers there is nothing to do.
 * Otherwise a service worker that adds them is installed and the page is
 * reloaded once so it takes effect. Returns false if the page is about to
 * reload, so start-up can be skipped.
 */
export async function ensureIsolated(): Promise<boolean> {
  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem(RELOADED);
    return true;
  }
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return true;
  try {
    const registration = await navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}isolate-sw.js`,
    );
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
