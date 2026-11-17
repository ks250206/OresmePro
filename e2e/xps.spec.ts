import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

/** The example plugin of the repository: XPS peak fits and quantification. */
const XPS = fileURLToPath(new URL("../examples/plugins/xps", import.meta.url));

test.describe("the example plugin xps", () => {
  test.describe.configure({ timeout: 240_000 });

  test("fits a C 1s region from its form and draws it on a reversed axis, then quantifies", async ({
    app,
    page,
  }) => {
    // Two GL(30) peaks 1.5 eV apart on a step, binding energies 280–294 eV by 0.05 eV.
    const made = await app.run(
      [
        "import numpy as np",
        "be = 280 + 0.05 * np.arange(281)",
        "gl = lambda u: np.exp(-4 * np.log(2) * 0.7 * u**2) / (1 + 1.2 * u**2)",
        "y = 1000 + 600 / (1 + np.exp(-(be - 285.5) / 0.4)) + 3000 * gl((be - 284.8) / 1.1) + 900 * gl((be - 286.3) / 1.1)",
        'op.make("c1s", y, x0=280, dx=0.05, x_unit="eV", unit="cps")',
        "print(len(y))",
      ].join("\n"),
    );
    expect(made.output).toBe("281\n");

    await app.menu("Python", "Plugins…");
    await page.getByLabel("Plugin folder").setInputFiles(XPS);
    const approval = page.getByRole("dialog", { name: "Install Plugin" });
    await expect(approval).toContainText("XPS Peak Fitting 0.1.0");
    await expect(approval).toContainText("plugin.xps.xps_fit");
    await expect(approval).toContainText("plugin.xps.quantify");
    await expect(approval).toContainText("Python packages: numpy, scipy");
    await expect(approval).toContainText("6 files");
    await approval.getByRole("button", { name: "Install" }).click();

    const dialog = page.getByRole("dialog", { name: "Plugins" });
    await dialog.getByRole("button", { name: "Open XPS Peak Fit" }).click();
    const form = page.getByRole("dialog", { name: "XPS Peak Fit" });
    await form.getByRole("combobox", { name: /^Spectrum/ }).selectOption("c1s");
    await form
      .getByRole("textbox", { name: /^Components/ })
      .fill("C-C: GL(30) pos=284.6; C-O: GL(30) pos=A+1.5 fwhm=A");
    await form.getByRole("button", { name: "Run" }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().results)), {
        timeout: 150_000,
      })
      .toEqual(["Plugin0"]);
    await expect(form.getByRole("alert")).toHaveCount(0);
    await form.getByRole("button", { name: "Close XPS Peak Fit" }).click();

    const outcome = await page.evaluate(() => {
      const state = globalThis.oresme.doc.getState();
      const result = state.results.Plugin0!;
      const graph = state.graphs.XPSFit0;
      return {
        names: result.names.slice(0, 4),
        coef: result.coef,
        converged: result.converged,
        outputs: Object.keys(result.outputs).sort(),
        traces: graph?.traces.map((trace) => [trace.y, trace.vAxis]),
        reverse: graph?.axes.bottom?.reverse,
        label: graph?.axes.bottom?.label,
      };
    });
    expect(outcome).toMatchObject({
      names: ["A_position", "A_fwhm", "A_area", "A_percent"],
      converged: true,
      outputs: ["background", "comp_A", "comp_B", "envelope", "region", "residual"],
      traces: [
        ["c1s_region", "left"],
        ["c1s_background", "left"],
        ["c1s_comp_A", "left"],
        ["c1s_comp_B", "left"],
        ["c1s_envelope", "left"],
        ["c1s_residual", "right"],
      ],
      reverse: true,
      label: "Binding Energy (eV)",
    });
    // B is tied 1.5 eV above A.
    expect(outcome.coef[4]! - outcome.coef[0]!).toBeCloseTo(1.5, 9);
    expect(Math.abs(outcome.coef[0]! - 284.8)).toBeLessThan(0.05);

    // From Python too: C 1s and a narrow scan of O 1s on a flat background, by their RSFs.
    const quantified = await app.run(
      [
        "o = 526 + 0.05 * np.arange(241)",
        'op.make("o1s", 800 + 2000 * gl((o - 532) / 1.4), x0=526, dx=0.05, x_unit="eV")',
        'r = op.invoke("plugin.xps.quantify", {"spectra": ["c1s", "o1s"], "regions": "C 1s: 281 293 rsf=1; O 1s: 527 537 rsf=2.93", "background": "Shirley"})',
        'rows = {row["name"]: row for row in r["values"]["regions"]}',
        "c = np.trapezoid(3000 * gl((be - 284.8) / 1.1) + 900 * gl((be - 286.3) / 1.1), be)",
        "ox = np.trapezoid(2000 * gl((o - 532) / 1.4), o) / 2.93",
        'print(round(rows["O 1s"]["percent"], 1), round(100 * ox / (c + ox), 1), rows["O 1s"]["spectrum"])',
      ].join("\n"),
    );
    expect(quantified.status, quantified.output).not.toBe("error");
    const [found, expected, spectrum] = quantified.output.trim().split(" ");
    expect(Math.abs(Number(found) - Number(expected))).toBeLessThan(1);
    expect(spectrum).toBe("o1s");
    expect(
      await page.evaluate(() =>
        globalThis.oresme.doc.getState().waveOrder.includes("c1s_background2"),
      ),
    ).toBe(true);
  });
});
