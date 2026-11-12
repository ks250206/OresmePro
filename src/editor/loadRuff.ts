import wasmUrl from "@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm?url";
import type { Ruff } from "./ruff";

let loading: Promise<Ruff> | null = null;

/**
 * Ruff, loaded the first time a procedure window asks for it: it is several
 * megabytes, which the start of the app should not wait for. Should loading
 * fail, the next window to ask tries again.
 */
export function loadRuff(): Promise<Ruff> {
  loading ??= import("./ruff")
    .then(({ Ruff }) => Ruff.load(wasmUrl))
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

/**
 * The files Ruff is made of, for the service worker to keep (see
 * keepForOffline): procedure windows lint offline even when none was opened
 * while there was a network. Only fetches the script; the WebAssembly is not
 * started.
 */
export async function ruffFiles(): Promise<string[]> {
  const { MODULE_URL } = await import("./ruff");
  return [MODULE_URL, new URL(wasmUrl, location.href).href];
}
