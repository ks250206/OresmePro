import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

/** A plugin made for these tests: it multiplies a wave by a number, in its sandbox. */
const SCALE = fileURLToPath(new URL("./plugins/scale", import.meta.url));

test.describe("plugins", () => {
  test.describe.configure({ timeout: 180_000 });
  // The app's service worker would answer the page's requests before the routes below could.
  test.use({ serviceWorkers: "block" });

  test("are installed from a folder after approval, run in their sandbox, and leave their results when removed", async ({
    app,
    page,
  }) => {
    await app.run('op.make("signal", [1.0, 2.0, 3.0], dx=0.5)');
    await app.menu("Python", "Plugins…");
    await page.getByLabel("Plugin folder").setInputFiles(SCALE);

    // Nothing is installed until the user has seen what it is and does.
    const approval = page.getByRole("dialog", { name: "Install Plugin" });
    await expect(approval).toContainText("Scale 1.0.0");
    await expect(approval).toContainText("It runs apart from the app, in a sandbox of its own");
    await expect(approval).toContainText("plugin.scale.scale");
    await expect(approval).toContainText("2 files");
    await approval.getByRole("button", { name: "Install" }).click();

    const dialog = page.getByRole("dialog", { name: "Plugins" });
    await expect(dialog.getByRole("option", { name: "Scale", exact: true })).toBeVisible();
    // The action's form opens in a window that is not modal and can be moved.
    await dialog.getByRole("button", { name: "Open Scale a wave" }).click();
    await expect(dialog).toHaveCount(0);
    const form = page.getByRole("dialog", { name: "Scale a wave" });
    const before = (await form.boundingBox())!;
    const bar = (await form.getByText("Scale a wave", { exact: true }).boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2 + 140, bar.y + bar.height / 2 + 90, { steps: 4 });
    await page.mouse.up();
    const after = (await form.boundingBox())!;
    expect(Math.round(after.x - before.x)).toBeGreaterThan(80);
    expect(Math.round(after.y - before.y)).toBeGreaterThan(40);
    // Run without the wave it needs: refused, with the row of that argument marked in red.
    await form.getByRole("button", { name: "Run" }).click();
    await expect(form.getByRole("alert")).toContainText('plugin.scale.scale needs "y".');
    await expect(form.locator("[data-invalid]")).toContainText("Wave");
    expect((await app.lastEntry()).output).toBe(
      'InvalidArgumentError: plugin.scale.scale needs "y".',
    );
    // Choosing a value takes the mark away.
    await form.getByRole("combobox", { name: /^Wave/ }).selectOption("signal");
    await expect(form.locator("[data-invalid]")).toHaveCount(0);
    await form.getByLabel("Factor", { exact: true }).fill("3");
    await form.getByRole("button", { name: "Run" }).click();
    await expect(form.getByRole("button", { name: "Run" })).toBeEnabled({ timeout: 90_000 });

    const made = await page.evaluate(() => {
      const state = globalThis.oresme.doc.getState();
      const result = Object.values(state.results)[0];
      return {
        values: Array.from(state.waves.signal_scaled?.data ?? []),
        dx: state.waves.signal_scaled?.dx,
        result: result && { kind: result.kind, coef: result.coef, source: result.source },
      };
    });
    expect(made).toEqual({
      values: [3, 6, 9],
      dx: 0.5,
      result: {
        kind: "plugin",
        coef: [3],
        source: expect.objectContaining({
          action: "plugin.scale.scale",
          origin: "local:scale",
          commit: null,
        }),
      },
    });
    // The call is in the history as the Python that does the same, with what the plugin printed.
    const entry = await app.lastEntry();
    expect(entry.code).toBe('op.invoke("plugin.scale.scale", {"y": "signal", "factor": 3})');
    expect(entry.output).toContain("scaling signal by 3");

    // Python calls it the same way, inside its own atomic block.
    const fromPython = await app.run(
      'r = op.invoke("plugin.scale.scale", {"y": op.wave("signal"), "factor": 10})\nprint(r["waves"], r["result"])',
    );
    expect(fromPython.output).toContain("scaling signal by 10");
    expect(fromPython.output).toContain("{'scaled': 'signal_scaled_1'} Plugin1");

    // The rest of the app works while it is open, and the menu opens it again.
    await app.run('op.make("other", [5.0])');
    await expect(form.getByRole("combobox", { name: /^Wave/ })).toHaveValue("signal");
    await form.getByRole("button", { name: "Close Scale a wave" }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Python", exact: true }).click();
    await page.getByRole("menuitem", { name: "Plugin Actions" }).hover();
    await page.getByRole("menuitem", { name: "Scale a wave", exact: true }).click();
    await expect(form).toBeVisible();

    // Its style comes into the experiment on request.
    await app.menu("Python", "Plugins…");
    await dialog.getByRole("button", { name: "Add Styles to Experiment" }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().styles)))
      .toContain("scale_paper");

    // Turned off, its actions are gone; removed, what it made stays and running it again says what is needed.
    await dialog.getByRole("button", { name: "Turn Off" }).click();
    await expect(dialog.getByText("Scale (off)")).toBeVisible();
    page.once("dialog", (confirm) => void confirm.accept());
    await dialog.getByRole("button", { name: "Remove…" }).click();
    await expect(dialog.getByText("No plugins installed yet.")).toBeVisible();
    // Its windows go with it.
    await expect(form).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();

    const rerun = await app.run('op.result("Plugin0").rerun()');
    expect(rerun.status).toBe("error");
    expect(rerun.output).toContain("No installed plugin has the action plugin.scale.scale");
    const kept = await page.evaluate(() => {
      const state = globalThis.oresme.doc.getState();
      return [Boolean(state.waves.signal_scaled), Object.keys(state.results)];
    });
    expect(kept).toEqual([true, ["Plugin0", "Plugin1"]]);
  });

  test("are installed from GitHub at one commit, and refused when a file is missing", async ({
    app,
    page,
  }) => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const files: Record<string, Buffer> = {
      "oresme-plugin.json": await readFile(`${SCALE}/oresme-plugin.json`),
      "scale.py": await readFile(`${SCALE}/scale.py`),
      "styles/paper.json": await readFile(`${SCALE}/styles/paper.json`),
    };
    const cors = { "Access-Control-Allow-Origin": "*" };
    let missing = false;
    await page.route("https://api.github.com/**", (route) =>
      route.fulfill({ status: 200, headers: cors, body: commit }),
    );
    await page.route("https://raw.githubusercontent.com/**", (route) => {
      const prefix = `https://raw.githubusercontent.com/lab/tools/${commit}/plugins/scale/`;
      const url = route.request().url();
      const path = url.startsWith(prefix) ? decodeURIComponent(url.slice(prefix.length)) : "";
      const body = files[path];
      if (!body || (missing && path === "scale.py"))
        return route.fulfill({ status: 404, headers: cors, body: "" });
      return route.fulfill({ status: 200, headers: cors, body });
    });

    await app.menu("Python", "Plugins…");
    const dialog = page.getByRole("dialog", { name: "Plugins" });
    await dialog.getByRole("button", { name: "Install from GitHub…" }).click();
    const form = page.getByRole("dialog", { name: "Install Plugin from GitHub" });

    missing = true;
    await form
      .getByLabel("Repository")
      .fill("https://github.com/lab/tools/tree/main/plugins/scale");
    await form.getByRole("button", { name: "Fetch" }).click();
    await expect(form.getByRole("alert")).toContainText("Could not fetch scale.py (404)");

    missing = false;
    await form.getByRole("button", { name: "Fetch" }).click();
    const approval = page.getByRole("dialog", { name: "Install Plugin" });
    await expect(approval).toContainText("github:lab/tools/plugins/scale at 0123456789ab");
    await approval.getByRole("button", { name: "Install" }).click();
    await expect(dialog.getByRole("option", { name: "Scale", exact: true })).toBeVisible();
    const lock = await page.evaluate(
      () =>
        (
          globalThis.oresme as unknown as { plugins: { list(): { lock: unknown }[] } }
        ).plugins.list()[0]!.lock,
    );
    expect(lock).toMatchObject({
      source: { kind: "github", owner: "lab", repo: "tools", ref: "main", path: "plugins/scale" },
      commit,
    });
  });
});
