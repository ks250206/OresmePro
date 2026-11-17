/**
 * Puts what plugins' editors and views hold into the experiment
 * (DocState.editors), a moment after it last changed: a drag changes it at
 * every step, and the experiment need not take each one. What is waiting is
 * put in at once when the page is hidden or left, before the experiment is
 * saved (src/app/persist.ts saves it then too), so a reload loses nothing.
 */

/** How long a window's state has to stay unchanged to be kept. */
export const KEEP_DELAY = 400;

const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; keep: () => void }>();

/** Keeps a window's state after the delay, or sooner if the page goes; again replaces the one waiting. */
export function keepLater(key: string, keep: () => void): void {
  const before = waiting.get(key);
  if (before) clearTimeout(before.timer);
  const timer = setTimeout(() => {
    waiting.delete(key);
    keep();
  }, KEEP_DELAY);
  waiting.set(key, { timer, keep });
}

/** Keeps every state waiting, now. */
export function keepWaiting(): void {
  const all = [...waiting.values()];
  waiting.clear();
  for (const { timer, keep } of all) {
    clearTimeout(timer);
    keep();
  }
}

/** Forgets the states waiting whose keys start so: another experiment was opened. */
export function dropWaiting(prefix = ""): void {
  for (const [key, { timer }] of waiting)
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      waiting.delete(key);
    }
}

// Capturing listeners run before those persist.ts adds, so the experiment it saves has them.
if (typeof window !== "undefined" && typeof window.addEventListener === "function")
  window.addEventListener("pagehide", keepWaiting, { capture: true });
if (typeof document !== "undefined" && typeof document.addEventListener === "function")
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") keepWaiting();
    },
    { capture: true },
  );
