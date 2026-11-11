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
});
