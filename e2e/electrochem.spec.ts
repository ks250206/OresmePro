import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

/** The example plugin of the repository: CV peaks, Tafel slopes and impedance fits. */
const ELECTROCHEM = fileURLToPath(new URL("../examples/plugins/electrochem", import.meta.url));

/** A Randles spectrum made in the app's Python: the parameters the fit must find. */
const TRUE = { R0: 20, R1: 100, Q1: 2e-5, n1: 0.9, sigma: 50 };

test.describe("the example plugin electrochem", () => {
  test.describe.configure({ timeout: 240_000 });

  test("fits an impedance spectrum from the Plugins dialog, and its result stays when it is removed", async ({
    app,
    page,
  }) => {
    const made = await app.run(
      [
        "import numpy as np",
        "f = np.logspace(5, -2, 71)",
        "w = 2 * np.pi * f",
        `R0, R1, Q1, n1, sigma = ${TRUE.R0}, ${TRUE.R1}, ${TRUE.Q1}, ${TRUE.n1}, ${TRUE.sigma}`,
        "Z = R0 + 1 / (Q1 * (1j * w) ** n1 + 1 / (R1 + sigma * (1 - 1j) / np.sqrt(w)))",
        'op.make("eis_f", f, unit="Hz")',
        'op.make("eis_re", Z.real, unit="Ω")',
        'op.make("eis_im", -Z.imag, unit="Ω")',
        "print(len(f))",
      ].join("\n"),
    );
    expect(made.output).toBe("71\n");

    await app.menu("Analysis", "Plugins…");
    await page.getByLabel("Plugin folder").setInputFiles(ELECTROCHEM);
    const approval = page.getByRole("dialog", { name: "Install Plugin" });
    await expect(approval).toContainText("Electrochemistry 0.1.0");
    await expect(approval).toContainText("plugin.electrochem.eis_fit");
    await expect(approval).toContainText("Python packages: numpy, scipy");
    // The manifest's files only: not the README or the tests next to them.
    await expect(approval).toContainText("6 files");
    await approval.getByRole("button", { name: "Install" }).click();

    const dialog = page.getByRole("dialog", { name: "Plugins" });
    await expect(
      dialog.getByRole("option", { name: "Electrochemistry", exact: true }),
    ).toBeVisible();
    await dialog.getByRole("combobox", { name: /^Action/ }).selectOption("eis_fit");
    await dialog.getByRole("combobox", { name: /^Frequency/ }).selectOption("eis_f");
    await dialog.getByRole("combobox", { name: /^Z′/ }).selectOption("eis_re");
    await dialog.getByRole("combobox", { name: /^Z″/ }).selectOption("eis_im");
    await dialog.getByRole("button", { name: "Run" }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().results)), {
        timeout: 150_000,
      })
      .toEqual(["Plugin0"]);
    await expect(dialog.getByRole("alert")).toHaveCount(0);

    const outcome = await page.evaluate(() => {
      const state = globalThis.oresme.doc.getState();
      const result = state.results.Plugin0!;
      const fitted = state.waves.eis_f_zre_fit;
      return {
        kind: result.kind,
        names: result.names,
        coef: result.coef,
        sigma: result.sigma,
        converged: result.converged,
        outputs: result.outputs,
        source: result.source,
        settings: result.settings,
        fitted: fitted ? Array.from(fitted.data) : null,
        measured: Array.from(state.waves.eis_re!.data),
        unit: state.waves.eis_f_zim_fit?.unit,
      };
    });
    expect(outcome).toMatchObject({
      kind: "plugin",
      names: ["R0", "R1", "Q1", "n1", "sigma"],
      converged: true,
      outputs: { zre_fit: "eis_f_zre_fit", zim_fit: "eis_f_zim_fit" },
      source: {
        action: "plugin.electrochem.eis_fit",
        plugin: "electrochem",
        origin: "local:electrochem",
      },
      settings: {
        inputs: { frequency: "eis_f", zre: "eis_re", zim: "eis_im" },
        params: { model: "Randles", imaginary: "-Z''", weighting: "modulus" },
      },
      unit: "Ω",
    });
    Object.values(TRUE).forEach((value, at) => {
      expect(Math.abs(outcome.coef[at]! / value - 1)).toBeLessThan(1e-6);
    });
    expect(outcome.fitted).toHaveLength(71);
    outcome.fitted!.forEach((value, at) => {
      expect(Math.abs(value / outcome.measured[at]! - 1)).toBeLessThan(1e-6);
    });
    // The call is in the history as the Python that does the same.
    expect((await app.lastEntry()).code).toBe(
      'op.invoke("plugin.electrochem.eis_fit", {"frequency": "eis_f", "zre": "eis_re", "zim": "eis_im", "model": "Randles", "imaginary": "-Z\'\'", "weighting": "modulus"})',
    );

    // Its Nyquist template comes into the experiment, and makes a graph of the data and the fit.
    await dialog.getByRole("button", { name: "Add Graph Templates to Experiment" }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().graphTemplates)))
      .toEqual(["Nyquist"]);

    // Removed, the plugin leaves its result, waves and template; running it again says what is needed.
    page.once("dialog", (confirm) => void confirm.accept());
    await dialog.getByRole("button", { name: "Remove…" }).click();
    await expect(dialog.getByText("No plugins installed yet.")).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();

    const graph = await app.run(
      'op.graph_template("Nyquist").make(zre="eis_re", zim="eis_im", zre_fit="eis_f_zre_fit", zim_fit="eis_f_zim_fit")',
    );
    expect(graph.status).not.toBe("error");
    const rerun = await app.run('op.result("Plugin0").rerun()');
    expect(rerun.status).toBe("error");
    expect(rerun.output).toContain("No installed plugin has the action plugin.electrochem.eis_fit");
    expect(rerun.output).toContain(
      "This result was made by the plugin electrochem 0.1.0 from local:electrochem",
    );
    const kept = await page.evaluate(() => {
      const state = globalThis.oresme.doc.getState();
      return {
        results: Object.keys(state.results),
        waves: state.waveOrder,
        traces: Object.values(state.graphs).map((graph) =>
          graph.traces.map((trace) => [trace.y, trace.x]),
        ),
      };
    });
    expect(kept).toEqual({
      results: ["Plugin0"],
      waves: ["eis_f", "eis_re", "eis_im", "eis_f_zre_fit", "eis_f_zim_fit"],
      traces: [
        [
          ["eis_im", "eis_re"],
          ["eis_f_zim_fit", "eis_f_zre_fit"],
        ],
      ],
    });
  });
});
