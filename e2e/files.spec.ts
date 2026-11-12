import { expect, test, type App } from "./fixtures";

async function sample(app: App): Promise<void> {
  await app.run(`t = np.linspace(0, 10, 300)
sig = op.make("run1:signal", np.sin(t) * 1e-3, dx=t[1] - t[0], x_unit="s", unit="V")
m = op.make("surface", np.outer(np.arange(30.0), np.arange(20.0)))
labels = op.make("labels", ["alpha", "beta"])
g = op.display(sig)
g.left.label = "Signal \\u03b1^{2} \\u6642\\u9593"
g.append_image(m, axis="right", haxis="top", color_table="hot")
g.legend()
g.cursor("A", "signal", 40)
tb = op.edit(labels, m)`);
}

test.describe("exporting graphs", () => {
  test("a graph is saved as PDF, SVG and PNG", async ({ app }) => {
    await sample(app);
    await app.window("Graph0").locator("header").click();

    const pdf = await app.download(() => app.menu("File", "Save Graph as PDF"));
    expect(pdf.file.suggestedFilename()).toBe("Graph0.pdf");
    const text = pdf.bytes.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // Latin and Greek text use built-in fonts; the image is embedded.
    expect(text).toContain("/BaseFont /Helvetica");
    expect(text).toContain("/BaseFont /Symbol");
    expect(text).toContain("/Subtype /Image");

    const svg = await app.download(() => app.menu("File", "Save Graph as SVG"));
    const markup = svg.bytes.toString("utf8");
    expect(markup).toContain("data:image/png;base64,");
    // Cursors stay out of exported files unless asked for.
    expect(markup).not.toContain(">A</text>");

    const png = await app.download(() => app.run('g.save("figure.png", cursors=True)'));
    expect(png.file.suggestedFilename()).toBe("figure.png");
    expect(png.bytes.subarray(1, 4).toString()).toBe("PNG");
  });
});

test.describe("experiments", () => {
  test("an experiment is saved to a file and opened again", async ({ app, page }) => {
    await sample(app);
    const before = await app.doc();
    const saved = await app.download(() => page.keyboard.press("Control+s"));
    expect(saved.file.suggestedFilename()).toBe("Experiment.oresme");
    expect(saved.bytes.subarray(0, 2).toString()).toBe("PK");

    // A new experiment opens in the tab; the old one stays among the browser's experiments.
    await app.menu("File", "New Experiment");
    await expect(page).toHaveTitle("Untitled — OresmePro");
    await expect.poll(async () => (await app.doc()).order).toEqual([]);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      app.menu("File", "Open Experiment…"),
    ]);
    await chooser.setFiles({
      name: "saved.oresme",
      mimeType: "application/zip",
      buffer: saved.bytes,
    });
    await expect.poll(async () => (await app.doc()).order).toEqual(before.order);
    const after = await app.doc();
    expect(after.folders).toEqual(["run1"]);
    expect(after.graphs).toEqual(before.graphs);
    expect(after.tables).toEqual(before.tables);
    expect((await app.wave("surface"))!.shape).toEqual([30, 20]);
    expect((await app.wave("labels"))!.text).toEqual(["alpha", "beta"]);
  });

  test("an experiment file dropped on the window replaces the current one", async ({
    app,
    page,
  }) => {
    await sample(app);
    const saved = await app.download(() => page.keyboard.press("Control+s"));
    await app.run('op.make("extra", [1, 2, 3])');
    page.once("dialog", (dialog) => void dialog.accept());
    await app.drop([{ name: "saved.oresme", content: [...saved.bytes] }]);
    await expect.poll(async () => (await app.doc()).order).not.toContain("extra");
    expect((await app.doc()).graphs.Graph0!.images).toHaveLength(1);
  });

  test("the experiment is restored after a reload", async ({ app, page }) => {
    await sample(app);
    // Saving is debounced; give it time to reach storage.
    await page.waitForTimeout(1500);
    await page.reload();
    await expect
      .poll(async () => (await app.doc()).order)
      .toEqual(["run1:signal", "surface", "labels"]);
    const graph = (await app.doc()).graphs.Graph0!;
    expect(graph.images).toHaveLength(1);
    expect(graph.cursors.A).toEqual({ trace: "signal", point: 40 });
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    // Python starts fresh but sees the restored document.
    expect((await app.run('print(op.wave("labels").data.tolist(), op.graphs())')).output).toBe(
      "['alpha', 'beta'] [Graph('Graph0')]\n",
    );
  });
});
