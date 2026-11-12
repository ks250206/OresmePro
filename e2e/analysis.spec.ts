import { expect, test } from "./fixtures";

test.describe("analysis", () => {
  test("the curve fitting dialog runs a fit and adds the curve to the graph", async ({
    app,
    page,
  }) => {
    await app.run(`xf = np.linspace(-5, 5, 201); rng = np.random.default_rng(2)
pk = op.make("pk", 0.5 + 3 * np.exp(-((xf - 1.2) / 0.8) ** 2) + rng.normal(scale=0.05, size=xf.size), x0=xf[0], dx=xf[1] - xf[0])
pk_err = op.make("pk_err", np.full(xf.size, 0.05))
g = op.display(pk)`);
    await app.menu("Analysis", "Curve Fitting…");
    await page.getByLabel("Y data").selectOption("pk");
    await page.getByLabel("Weighting").selectOption("pk_err");
    await page.getByLabel("Hold").fill("y0=0.5");
    await page.getByLabel("Constraints").fill("A > 0, 0 < x0 < 3");
    await app.doIt();
    await app.idle();

    const fit = await app.lastEntry();
    expect(fit.code).toBe(
      'op.fit("gauss", "pk", hold={"y0": 0.5}, bounds={"A": (0, None), "x0": (0, 3)}, sigma="pk_err")',
    );
    expect(fit.status).toBe("ok");
    expect(fit.output).toMatch(/y0 += 0\.5 \(held\)/);
    expect(fit.output).toMatch(/x0 += 1\.[12]\d* ±/);
    expect((await app.doc()).graphs.Graph0!.traces.map((trace) => trace.name)).toEqual([
      "pk",
      "fit_pk",
    ]);
    expect((await app.wave("W_coef"))!.length).toBe(4);
  });

  test("the hold field must be readable before the fit can run", async ({ app, page }) => {
    await app.run('op.make("pk", [1, 2, 3, 2, 1])');
    await app.menu("Analysis", "Curve Fitting…");
    await page.getByLabel("Hold").fill("y0");
    await expect(page.getByRole("button", { name: "Do It" })).toBeDisabled();
    await page.getByLabel("Hold").fill("y0=1");
    await expect(page.getByRole("button", { name: "Do It" })).toBeEnabled();
  });

  test("an analysis menu item makes a new wave through Python", async ({ app, page }) => {
    await app.run('op.make("sig", np.sin(np.linspace(0, 10, 200)), dx=0.05, x_unit="s")');
    await app.menu("Analysis", "Smooth…");
    await page.getByLabel("Points").fill("7");
    await app.doIt();
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.smooth("sig", n=7)');
    expect((await app.doc()).order).toEqual(["sig", "sig_smth"]);
  });

  test("integrate takes an X wave from the dialog", async ({ app, page }) => {
    await app.run(`op.make("current", [2.0, 2.0, 2.0, 2.0], unit="A")
op.make("time", [0.0, 1.0, 3.0, 6.0], unit="s")`);
    await app.menu("Analysis", "Integrate…");
    const dialog = page.getByRole("dialog", { name: "Integrate" });
    await dialog.getByLabel("Wave").selectOption("current");
    await dialog.getByLabel("X wave").selectOption("time");
    await app.doIt();
    await app.idle();
    const entry = await app.lastEntry();
    expect(entry.code).toBe('op.integrate("current", x="time")');
    expect(entry.status).toBe("ok");
    const charge = (await app.wave("current_INT"))!;
    expect(charge.data).toEqual([0, 2, 6, 12]);
    expect(charge.unit).toBe("A·s");

    // Without an X wave the call is what it always was.
    await app.menu("Analysis", "Differentiate…");
    await page
      .getByRole("dialog", { name: "Differentiate" })
      .getByLabel("Wave")
      .selectOption("time");
    await app.doIt();
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.differentiate("time")');
  });

  test("a fit can add residuals and a confidence band to the graph", async ({ app, page }) => {
    await app.run(`xl = np.linspace(0, 10, 80)
line = op.make("line", 1 + 2 * xl + np.random.default_rng(4).normal(scale=0.3, size=80), dx=xl[1] - xl[0])
g = op.display(line)`);
    await app.menu("Analysis", "Curve Fitting…");
    await page.getByLabel("Function").selectOption("line");
    await page.getByLabel("Residuals").check();
    await page.getByLabel("95% confidence band").check();
    await app.doIt();
    await app.idle();
    const fit = await app.lastEntry();
    expect(fit.code).toBe('op.fit("line", "line", residuals=True, band=0.95)');
    expect(fit.status).toBe("ok");
    const graph = (await app.doc()).graphs.Graph0!;
    expect(graph.traces.map((trace) => [trace.name, trace.vAxis])).toEqual([
      ["line", "left"],
      ["fit_line_hi", "left"],
      ["fit_line_lo", "left"],
      ["fit_line", "left"],
      ["res_line", "res_left"],
    ]);
    expect(graph.traces[1]!.fill).toBe("next");
    // The residuals have an axis of their own above the data.
    expect(graph.axes.res_left!.span[0]).toBeGreaterThan(graph.axes.left!.span[1]);
    expect((await app.wave("res_line"))!.length).toBe(80);
  });

  test("several peaks are found and fitted from the menu", async ({ app, page }) => {
    await app.run(`xp = np.linspace(0, 20, 600)
spectrum = op.make("spectrum", 1 + 4 * np.exp(-((xp - 5) / 0.7) ** 2) + 2.5 * np.exp(-((xp - 12) / 1.1) ** 2) + np.random.default_rng(8).normal(scale=0.03, size=600), dx=xp[1] - xp[0])
g = op.display(spectrum)`);
    await app.menu("Analysis", "Multi-peak Fit…");
    const dialog = page.getByRole("dialog", { name: "Multi-peak Fit" });
    await dialog.getByLabel("Baseline").selectOption("linear");
    await dialog.getByLabel("Smooth first").fill("5");
    await app.doIt();
    await app.idle();
    const fit = await app.lastEntry();
    expect(fit.code).toBe('op.fit_peaks("spectrum", shape="gauss", baseline="linear", smooth=5)');
    expect(fit.output).toContain("Multi-peak fit: 2 gauss peaks");
    // One row per peak: position, height, FWHM, area.
    const peaks = await page.evaluate(() =>
      Array.from(globalThis.oresme.doc.getState().waves.W_peaks!.data),
    );
    expect(peaks[0]).toBeCloseTo(5, 1);
    expect(peaks[1]).toBeCloseTo(4, 1);
    expect(peaks[4]).toBeCloseTo(12, 1);
    expect((await app.doc()).graphs.Graph0!.traces.map((trace) => trace.name)).toEqual([
      "spectrum",
      "fit_spectrum_p1",
      "fit_spectrum_p2",
      "fit_spectrum",
    ]);
  });

  test("Voigt and pseudo-Voigt peaks are fitted from the menus", async ({ app, page }) => {
    await app.run(`import _oresme_analysis as oa
xv = np.linspace(0, 20, 801)
vs = op.make("vs", 0.4 + 2 * oa._voigt(xv - 6, 0.5, 0.3) + 1.5 * oa._voigt(xv - 13, 0.4, 0.5), dx=xv[1] - xv[0])
pv = op.make("pv", 0.1 + 3 * oa._pseudo_voigt(xv - 9, 0.8, 0.4), dx=xv[1] - xv[0])
g = op.display(vs)`);
    await app.menu("Analysis", "Curve Fitting…");
    await page.getByLabel("Function").selectOption("pseudo_voigt");
    // eta means something only between 0 and 1: the dialog starts with that constraint.
    await expect(page.getByLabel("Constraints")).toHaveValue("0 <= eta <= 1");
    await page.getByLabel("Y data").selectOption("pv");
    await app.doIt();
    await app.idle();
    const fit = await app.lastEntry();
    expect(fit.code).toBe('op.fit("pseudo_voigt", "pv", bounds={"eta": (0, 1)})');
    expect(fit.output).toMatch(/eta += 0\.4\d* ±/);

    await app.menu("Analysis", "Multi-peak Fit…");
    const dialog = page.getByRole("dialog", { name: "Multi-peak Fit" });
    await dialog.getByLabel("Wave").selectOption("vs");
    await dialog.getByLabel("Peak shape").selectOption("voigt");
    await app.doIt();
    await app.idle();
    const peaks = await app.lastEntry();
    expect(peaks.code).toBe('op.fit_peaks("vs", shape="voigt", baseline="constant")');
    expect(peaks.output).toContain("Multi-peak fit: 2 voigt peaks");
    expect(peaks.output).toContain("Gauss FWHM");
    // Position, height, FWHM, area, Gaussian FWHM and Lorentzian FWHM of each peak.
    const table = (await app.wave("W_peaks"))!;
    expect(table.shape).toEqual([2, 6]);
    expect(table.data[0]).toBeCloseTo(6, 3);
    expect(table.data[5]).toBeCloseTo(0.6, 3);
  });

  test("an image is filtered from the menu", async ({ app, page }) => {
    await app.run('img = op.make("img", np.random.default_rng(1).normal(size=(40, 30)))');
    await app.menu("Analysis", "Filter Image…");
    const dialog = page.getByRole("dialog", { name: "Filter Image" });
    await dialog.getByLabel("Filter").selectOption("median");
    await dialog.getByLabel("Size").fill("4");
    // An even window has no middle pixel: the Python side says so.
    await app.doIt();
    await app.idle();
    expect((await app.lastEntry()).output).toContain("size must be an odd number");
    await app.menu("Analysis", "Filter Image…");
    await page.getByRole("dialog").getByLabel("Filter").selectOption("gauss");
    await page.getByRole("dialog").getByLabel("Size").fill("1.5");
    await app.doIt();
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.filter_image("img", kind="gauss", size=1.5)');
    expect((await app.wave("img_filt"))!.shape).toEqual([40, 30]);
  });
});
