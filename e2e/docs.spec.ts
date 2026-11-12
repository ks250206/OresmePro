import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

test("the Python examples in the documentation run in the app", async ({ app }) => {
  const examples = {
    "first-graph": "FirstGraph",
    "import-csv": "Measurement",
    sine: "Sine",
    overlay: "Overlay",
    gaussian: "Gaussian",
    exponential: "Exponential",
    fft: "Spectrum",
    histogram: "Histogram",
    "image-contour": "Field",
    "multiple-axes": "TwoAxes",
  };

  for (const [example, graph] of Object.entries(examples)) {
    const path = new URL(`../docs/src/snippets/${example}.py`, import.meta.url);
    const entry = await app.run(await readFile(path, "utf-8"));
    expect(entry.status, `${example}: ${entry.output}`).toBe("ok");
    await expect(app.window(graph).locator("canvas")).toBeVisible();
  }
});
