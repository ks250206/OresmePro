import { expect, test } from "./fixtures";

test.describe("scientific packages", () => {
  test("SciPy, pandas, scikit-learn and lmfit are installed when code first imports them", async ({
    app,
    page,
  }) => {
    // In a procedure: it runs inside the input that calls it, so what it imports
    // has to be there before the input starts.
    await app.run(
      `op.new_procedure("Fits", """from scipy.optimize import curve_fit
import lmfit

def decay(x, a, tau):
    return a * np.exp(-x / tau)

x = np.linspace(0, 4, 40)
popt, _ = curve_fit(decay, x, decay(x, 2.5, 0.7), p0=[1, 1])
print("scipy", np.round(popt, 4).tolist(), "lmfit", lmfit.__version__[:2])
""")`,
    );
    const run = await app.run('op.procedure("Fits").run()');
    expect(run.status).toBe("ok");
    expect(run.output).toBe("scipy [2.5, 0.7] lmfit 1.\n");

    // In the command line, and a wave handed to them as an array.
    const frame = await app.run(
      [
        "import pandas as pd",
        "from sklearn.linear_model import LinearRegression",
        'w = op.make("w", 3 * np.arange(10.0) + 1)',
        "lr = LinearRegression().fit(w.x.reshape(-1, 1), w)",
        'print(round(float(lr.coef_[0]), 6), list(op.to_dataframe(w).columns), pd.__version__ >= "2")',
      ].join("\n"),
    );
    expect(frame.output).toBe("3.0 ['w'] True\n");
    // An lmfit model fitted through the app's own fit: drawn and kept like any other.
    const fit = await app.run(
      [
        "from lmfit.models import GaussianModel",
        "gx = np.linspace(-5, 5, 201)",
        'g = op.make("g", 2 * np.exp(-((gx - 1) ** 2) / 2), x0=-5, dx=0.05); op.display(g)',
        "r = op.fit(GaussianModel(), g, quiet=True); print(round(r['center'], 3), r.name)",
      ].join("\n"),
    );
    expect(fit.output).toBe("1.0 Fit0\n");
    const doc = await app.doc();
    expect(doc.graphs.Graph0!.traces.map((trace) => trace.name)).toEqual(["g", "fit_g"]);
    expect(doc.results.Fit0!.label).toBe("lmfit Model(gaussian)(g)");
    await expect(page.getByText("Python ready")).toBeVisible();
  });
});
