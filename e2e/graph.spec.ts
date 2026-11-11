import { expect, test, type App } from "./fixtures";

/** A graph of a damped sine, at a known place and size. */
async function sineGraph(app: App): Promise<void> {
  await app.run(`x = np.linspace(0, 10, 2000)
signal = op.make("signal", np.sin(2 * np.pi * x) * np.exp(-x / 3), dx=x[1] - x[0], x_unit="s", unit="V")
noise = op.make("noise", np.random.default_rng(1).normal(scale=0.05, size=40), dx=0.25, x_unit="s", unit="V")
g = op.display(signal)`);
  await app.place("Graph0", 20, 16, 480, 340);
}

test.describe("graph interaction", () => {
  test("a marquee zooms, Ctrl+A autoscales, and both can be undone", async ({ app, page }) => {
    await sineGraph(app);
    const box = (await app.window("Graph0").boundingBox())!;
    await page.mouse.move(box.x + 120, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 200, { steps: 6 });
    await page.mouse.up();
    await page.getByRole("menuitem", { name: "Expand", exact: true }).click();

    let axes = (await app.doc()).graphs.Graph0!.axes;
    expect(axes.bottom!.min).not.toBeNull();
    expect(axes.bottom!.max!).toBeGreaterThan(axes.bottom!.min!);
    expect(axes.left!.min).not.toBeNull();
    const echo = await app.lastEntry();
    expect(echo.source).toBe("gui");
    expect(echo.code).toMatch(/^op\.graph\("Graph0"\)\.axis\("left"\)\.set\(range=\(/);

    await app
      .window("Graph0")
      .locator("canvas")
      .click({ position: { x: 200, y: 150 } });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+a");
    axes = (await app.doc()).graphs.Graph0!.axes;
    expect([axes.bottom!.min, axes.left!.max]).toEqual([null, null]);
    expect((await app.lastEntry()).code).toContain(".autoscale()");

    await page.keyboard.press("Control+z");
    expect((await app.doc()).graphs.Graph0!.axes.bottom!.min).not.toBeNull();
    await page.keyboard.press("Control+y");
    expect((await app.doc()).graphs.Graph0!.axes.bottom!.min).toBeNull();
  });

  test("wheel zooming is recorded once, not once per notch", async ({ app, page }) => {
    await sineGraph(app);
    const box = (await app.window("Graph0").boundingBox())!;
    const before = (await app.entries()).length;
    await page.mouse.move(box.x + 200, box.y + 150);
    for (let notch = 0; notch < 5; notch += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(30);
    }
    await expect.poll(async () => (await app.entries()).length).toBe(before + 1);
    expect((await app.lastEntry()).code).toMatch(/axis\("bottom"\)\.set\(range=/);
  });

  test("dialogs modify axes and traces and echo Python", async ({ app, page }) => {
    await sineGraph(app);
    const box = (await app.window("Graph0").boundingBox())!;
    // Double-click on the left axis.
    await page.mouse.dblclick(box.x + 20, box.y + 150);
    const dialog = page.getByRole("dialog", { name: /Modify Axis/ });
    await expect(dialog.getByLabel("Axis", { exact: true })).toHaveValue("left");
    await dialog.getByLabel("Auto").uncheck();
    await dialog.getByLabel("Label", { exact: true }).fill("Amplitude");
    await dialog.getByLabel("Minor ticks").check();
    await dialog.getByLabel("Mirror").selectOption("ticks");
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.axes.left).toMatchObject({
      label: "Amplitude",
      minor: true,
      mirror: "ticks",
    });
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").axis("left").set(label="Amplitude", minor=True, mirror="ticks")',
    );

    await app.menu("Graph", "Append Traces…");
    await page
      .getByRole("dialog")
      .getByRole("listbox")
      .getByRole("option", { name: "noise" })
      .click();
    await app.doIt();
    await app.menu("Graph", "Modify Trace Appearance…");
    await page
      .getByRole("dialog")
      .getByRole("listbox")
      .getByRole("option", { name: "noise" })
      .click();
    await page.getByLabel("Mode").selectOption("markers");
    await page.getByLabel("Marker", { exact: true }).selectOption("square");
    await page.getByLabel("Marker size").fill("3.5");
    await page.getByRole("button", { name: "#0000ff" }).click();
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.traces[1]).toMatchObject({
      name: "noise",
      mode: "markers",
      marker: "square",
      markerSize: 3.5,
      color: "#0000ff",
    });
  });

  test("cursors are placed from the trace menu, moved with keys, and dragged", async ({
    app,
    page,
  }) => {
    await sineGraph(app);
    const canvas = app.window("Graph0").locator("canvas");
    const box = (await canvas.boundingBox())!;
    const onTrace = (await app.findInGraph("Graph0", { color: "red", minRun: 0.4, maxRun: 3 }))!;
    await page.mouse.click(box.x + onTrace.x, box.y + onTrace.y, { button: "right" });
    await page.getByRole("menuitem", { name: /^Put Cursor A on signal\[/ }).click();

    let graph = (await app.doc()).graphs.Graph0!;
    expect(graph.cursors.A).toMatchObject({ trace: "signal" });
    // Placing a cursor by hand also shows the readout.
    expect(graph.showInfo).toBe(true);
    await expect(page.getByRole("status", { name: "Cursor info" })).toContainText("signal[");

    const start = graph.cursors.A!.point;
    await canvas.click({ position: { x: 300, y: 20 } });
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    graph = (await app.doc()).graphs.Graph0!;
    expect(graph.cursors.A!.point).toBe(start + 11);

    // The cursor's cross is a short black horizontal line; grab it and drag.
    const cross = (await app.findInGraph("Graph0", { color: "black", minRun: 15, maxRun: 19 }))!;
    await page.mouse.move(box.x + cross.x, box.y + cross.y);
    await page.mouse.down();
    await page.mouse.move(box.x + cross.x + 100, box.y + cross.y + 5, { steps: 8 });
    await page.mouse.up();
    const moved = (await app.doc()).graphs.Graph0!.cursors.A!.point;
    expect(moved).toBeGreaterThan(start + 100);
    await expect
      .poll(async () => (await app.lastEntry()).code)
      .toBe(`op.graph("Graph0").cursor("A", "signal", ${moved})`);
  });

  test("an axis can be added and given part of the plot area", async ({ app, page }) => {
    await sineGraph(app);
    await app
      .window("Graph0")
      .locator("canvas")
      .click({ button: "right", position: { x: 300, y: 30 } });
    await page.getByRole("menuitem", { name: "Add Axis…" }).click();
    await page.getByLabel("Axis name").fill("R2");
    await page.getByLabel("Side").selectOption("right");
    await app.doIt();
    // Adding an axis leads straight to its settings.
    const dialog = page.getByRole("dialog", { name: /Modify Axis/ });
    await expect(dialog.getByLabel("Axis", { exact: true })).toHaveValue("R2");
    await dialog.getByLabel("Span start").fill("50");
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.axes.R2).toMatchObject({
      side: "right",
      span: [0.5, 1],
    });
  });

  test("images take a color table and a layer; contours are labelled", async ({ app, page }) => {
    await app.run(`xs = np.linspace(-3, 3, 40); ys = np.linspace(-2, 2, 30)
X, Y = np.meshgrid(xs, ys, indexing="ij")
cube = op.make("cube", np.stack([np.exp(-(X**2 + Y**2)), X * 0 + 0.5], axis=2), x0=xs[0], dx=xs[1]-xs[0], y0=ys[0], dy=ys[1]-ys[0])
gc = op.contour(cube, levels=5)
gc.append_image(cube)`);
    await app.place("Graph0", 20, 16, 460, 320);
    const canvas = app.window("Graph0").locator("canvas");
    await canvas.click({ button: "right", position: { x: 200, y: 20 } });
    await page.getByRole("menuitem", { name: "Modify Image cube…" }).click();
    await page.getByLabel("Color table").selectOption("plasma");
    await page.getByLabel("Layer").fill("1");
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.images[0]).toMatchObject({
      colorTable: "plasma",
      layer: 1,
    });
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").image("cube").set(color_table="plasma", layer=1)',
    );

    await canvas.click({ button: "right", position: { x: 200, y: 20 } });
    await page.getByRole("menuitem", { name: "Modify Contour cube…" }).click();
    await expect(page.getByLabel("Write each level's value on its line")).toBeChecked();
  });

  test("a graph shown as a result appears in the history as a picture", async ({ app, page }) => {
    await sineGraph(app);
    await app.run("g");
    const picture = page
      .getByRole("log", { name: "Command history" })
      .getByRole("img", { name: "Graph('Graph0')" });
    await expect(picture).toBeVisible();
  });
});
