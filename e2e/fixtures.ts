import { readFile } from "node:fs/promises";
import { test as base, expect, type Download, type Locator, type Page } from "@playwright/test";
import type { Doc } from "../src/core/doc/doc";
import type { FileStore } from "../src/core/files/files";
import type { History } from "../src/core/history/history";
import type { KernelClient } from "../src/kernel/client";

declare global {
  /** The debugging handle the app puts on the page (see src/App.tsx). */
  var oresme: {
    doc: Doc;
    history: History;
    kernel: KernelClient;
    files: FileStore;
    /** How many files the service worker holds for starting offline, once it has them. */
    offlineFiles?: number;
  };
}

export interface Entry {
  code: string;
  source: string;
  status: string;
  /** All output of the entry as one string. */
  output: string;
}

/** Helpers for driving the app and looking at its state. */
export class App {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  get commandLine(): Locator {
    return this.page.getByRole("textbox", { name: "Command line" });
  }

  /** Waits until Python has nothing left to run. */
  async idle(): Promise<void> {
    await this.page.waitForFunction(
      () => globalThis.oresme.kernel.getState().status === "ready",
      null,
      {
        timeout: 60_000,
      },
    );
  }

  /** Runs Python and waits for it to finish. */
  async run(code: string): Promise<Entry> {
    await this.page.evaluate((text) => globalThis.oresme.kernel.execute(text), code);
    await this.idle();
    return this.lastEntry();
  }

  /** Types into the command line as a user would and presses a key. */
  async type(text: string, press?: string): Promise<void> {
    await this.commandLine.click();
    await this.page.keyboard.type(text);
    if (press) await this.page.keyboard.press(press);
  }

  /** What is in the command line, without the placeholder or the greyed suggestion. */
  typed(): Promise<string> {
    return this.page.evaluate(() => {
      const content = document.querySelector(".cm-content")!.cloneNode(true) as HTMLElement;
      for (const extra of content.querySelectorAll(".cm-ghost, .cm-placeholder")) extra.remove();
      return content.innerText.replace(/\n$/, "");
    });
  }

  suggestion(): Promise<string | null> {
    return this.page.evaluate(() => document.querySelector(".cm-ghost")?.textContent ?? null);
  }

  entries(): Promise<Entry[]> {
    return this.page.evaluate(() =>
      globalThis.oresme.history.getEntries().map((entry) => ({
        code: entry.code,
        source: entry.source,
        status: entry.status,
        output: entry.outputs
          .map((output) => (output.kind === "error" ? output.traceback : output.text))
          .join(""),
      })),
    );
  }

  async lastEntry(): Promise<Entry> {
    return (await this.entries()).at(-1)!;
  }

  /** The document, as plain data (wave values are left out; see `wave`). */
  doc() {
    return this.page.evaluate(() => {
      const state = globalThis.oresme.doc.getState();
      return JSON.parse(
        JSON.stringify({
          order: state.waveOrder,
          folders: state.folders,
          graphs: state.graphs,
          tables: state.tables,
          procedures: state.procedures,
          pages: state.pages,
          results: state.results,
          windows: state.windows,
        }),
      ) as {
        order: string[];
        folders: string[];
        graphs: typeof state.graphs;
        tables: typeof state.tables;
        procedures: typeof state.procedures;
        pages: typeof state.pages;
        results: typeof state.results;
        windows: typeof state.windows;
      };
    });
  }

  wave(name: string) {
    return this.page.evaluate((key) => {
      const wave = globalThis.oresme.doc.getState().waves[key];
      if (!wave) return null;
      return {
        data: Array.from(wave.data.slice(0, 64)),
        length: wave.data.length,
        text: wave.text ? [...wave.text] : null,
        shape: [...wave.shape],
        unit: wave.unit,
      };
    }, name);
  }

  /** The experiment's files: path and contents (as text). */
  files(): Promise<Record<string, string>> {
    return this.page.evaluate(() =>
      Object.fromEntries(
        globalThis.oresme.files
          .list()
          .map((file) => [file.path, new TextDecoder().decode(file.bytes)]),
      ),
    );
  }

  window(name: string): Locator {
    return this.page.locator(`[data-window="${name}"]`);
  }

  /** Places and sizes a window, so tests do not depend on the default layout. */
  async place(name: string, x: number, y: number, w: number, h: number): Promise<void> {
    await this.page.evaluate(
      (move) => globalThis.oresme.doc.dispatch({ op: "moveWindow", ...move }),
      { name, x, y, w, h },
    );
  }

  async menu(menu: string, item: string): Promise<void> {
    await this.page.getByRole("menuitem", { name: menu, exact: true }).click();
    await this.page.getByRole("menuitem", { name: item, exact: true }).click();
  }

  async doIt(): Promise<void> {
    await this.page.getByRole("button", { name: "Do It" }).click();
  }

  /**
   * Drops files onto the app, as from the desktop. Files of data come up in
   * the Load Data dialog; unless `load` is false they are loaded as detected.
   */
  async drop(
    files: { name: string; content: string | number[] }[],
    { load = true }: { load?: boolean } = {},
  ): Promise<void> {
    await this.page.evaluate((list) => {
      const data = new DataTransfer();
      for (const { name, content } of list) {
        const body = typeof content === "string" ? content : Uint8Array.from(content);
        data.items.add(new File([body], name));
      }
      document
        .querySelector("[data-desktop]")!
        .dispatchEvent(
          new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
        );
    }, files);
    if (!load) return;
    for (const { name } of files) {
      if (name.endsWith(".oresme")) continue;
      const dialog = this.page.getByRole("dialog", { name: `Load Data: ${name}` });
      await dialog.getByRole("button", { name: /^Load/ }).click();
      await dialog.waitFor({ state: "detached" });
    }
  }

  /** Pastes text into the focused table. */
  async paste(text: string): Promise<void> {
    await this.page.evaluate((value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      document.activeElement!.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
  }

  /** What copying (or cutting) in the focused table puts on the clipboard. */
  copy(kind: "copy" | "cut" = "copy"): Promise<string> {
    return this.page.evaluate((type) => {
      const data = new DataTransfer();
      document.activeElement!.dispatchEvent(
        new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return data.getData("text/plain");
    }, kind);
  }

  /** Performs an action that downloads a file and returns the file's bytes. */
  async download(action: () => Promise<unknown>): Promise<{ file: Download; bytes: Buffer }> {
    const [file] = await Promise.all([this.page.waitForEvent("download"), action()]);
    return { file, bytes: await readFile(await file.path()) };
  }

  /**
   * Finds something drawn in a graph by its color: the middle of the first
   * horizontal run of matching pixels whose length (in CSS pixels) is within
   * the given bounds. Returns a position relative to the graph's canvas.
   */
  async findInGraph(
    name: string,
    options: { color: "red" | "black"; minRun: number; maxRun: number },
  ): Promise<{ x: number; y: number } | null> {
    return this.page.evaluate(
      ({ graph, color, minRun, maxRun }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          `[data-window="${graph}"] canvas`,
        )!;
        const { width, height } = canvas;
        const pixels = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
        const scale = width / canvas.clientWidth;
        const matches = (x: number, y: number) => {
          const at = (y * width + x) * 4;
          const [r, g, b, a] = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!, pixels[at + 3]!];
          if (a !== 255) return false;
          return color === "red" ? r > 240 && g < 40 && b < 40 : r < 70 && g < 70 && b < 70;
        };
        for (let y = 0; y < height; y += 1) {
          let start = -1;
          for (let x = 0; x <= width; x += 1) {
            if (x < width && matches(x, y)) {
              if (start < 0) start = x;
              continue;
            }
            if (start >= 0) {
              const length = (x - start) / scale;
              if (length >= minRun && length <= maxRun) {
                return { x: (start + (x - start) / 2) / scale, y: y / scale };
              }
              start = -1;
            }
          }
        }
        return null;
      },
      { graph: name, ...options },
    );
  }
}

export const test = base.extend<{ app: App }>({
  app: async ({ page }, use) => {
    await page.goto("/");
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await use(new App(page));
  },
});

export { expect };
