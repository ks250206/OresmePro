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
      .getByRole("listbox", { name: "Y waves" })
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

  test("an axis label is made larger and italic, and its words formatted with buttons", async ({
    app,
    page,
  }) => {
    await sineGraph(app);
    await app.run('g.left.label = "Amplitude"');
    /** How long the left axis label is drawn: the outermost dark pixels, upwards. */
    const labelLength = () =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-window="Graph0"] canvas')!;
        const { width, height } = canvas;
        const scale = width / canvas.clientWidth;
        const pixels = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
        const dark = (x: number, y: number) => pixels[(y * width + x) * 4]! < 128;
        let left = width;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < left; x += 1) if (dark(x, y)) left = x;
        }
        // The label reads upwards in a band of its own, outside the tick labels.
        let top = height;
        let bottom = -1;
        for (let y = 0; y < height; y += 1) {
          for (let x = left; x < left + 6 * scale; x += 1) {
            if (dark(x, y)) {
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
          }
        }
        return (bottom - top) / scale;
      });
    const before = await labelLength();

    const box = (await app.window("Graph0").boundingBox())!;
    await page.mouse.dblclick(box.x + 20, box.y + 150);
    const dialog = page.getByRole("dialog", { name: /Modify Axis/ });
    await expect(dialog.getByLabel("Axis", { exact: true })).toHaveValue("left");
    await dialog.getByLabel("Label size", { exact: true }).fill("22");
    await dialog.getByLabel("Label style").selectOption("italic");
    await dialog.getByLabel("Tick label size").fill("9");
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.axes.left).toMatchObject({
      label: "Amplitude",
      labelSize: 22,
      labelStyle: "italic",
      tickLabelSize: 9,
    });
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").axis("left").set(label_style="italic", label_size=22, tick_label_size=9)',
    );
    const after = await labelLength();
    expect(after / before).toBeGreaterThan(1.6);
    expect(after / before).toBeLessThan(2.2);
    const svg = (await app.run("print(g.svg())")).output;
    expect(svg).toMatch(/font-size="22" font-style="italic"[^>]*>Amplitude</);
    expect(svg).toMatch(/font-size="9" fill[^>]*>0\.5</);

    // Formatting buttons write the codes around what is selected, or at the caret.
    await app.menu("Graph", "Modify Axis…");
    await dialog.getByLabel("Axis", { exact: true }).selectOption("bottom");
    await dialog.getByLabel("Auto").uncheck();
    const label = dialog.getByLabel("Label", { exact: true });
    await label.fill("Time");
    await label.selectText();
    await dialog.getByRole("button", { name: "Bold" }).click();
    await expect(label).toHaveValue("\\f01Time\\f00");
    await label.press("End");
    await label.pressSequentially(" (");
    await dialog.getByRole("button", { name: "Italic" }).click();
    await label.pressSequentially("t");
    await dialog.getByRole("button", { name: "Subscript" }).click();
    await label.pressSequentially("0");
    await expect(label).toHaveValue("\\f01Time\\f00 (\\f02t_{0}\\f00");
    await label.press("End");
    await label.pressSequentially(")");
    await app.doIt();
    const code = "\\f01Time\\f00 (\\f02t_{0}\\f00)";
    expect((await app.doc()).graphs.Graph0!.axes.bottom!.label).toBe(code);
    expect((await app.lastEntry()).code).toBe(
      `op.graph("Graph0").axis("bottom").set(label=${JSON.stringify(code)})`,
    );
    const drawn = (await app.run("print(g.svg())")).output;
    expect(drawn).toMatch(/font-weight="bold"[^>]*>Time</);
    expect(drawn).toMatch(/font-style="italic"[^>]*>t</);
    expect(drawn).toMatch(/font-size="8.4" font-style="italic"[^>]*>0</);
    expect(drawn).not.toContain("\\f0");
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
    const cross = (await app.findInGraph("Graph0", { color: "black", minRun: 15, maxRun: 21 }))!;
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

test.describe("New Graph and Append Traces dialogs", () => {
  /** Waves of two lengths, with an X wave for each length. */
  async function someWaves(app: App): Promise<void> {
    await app.run(`op.make("a", [1.0, 2.0, 3.0], unit="V")
op.make("b", [3.0, 2.0, 1.0], unit="V")
op.make("t", [0.0, 0.5, 2.0], unit="s")
op.make("c", [5.0, 6.0])
op.make("t2", [10.0, 20.0])
op.make("d", [1.0, 1.0, 2.0, 3.0])`);
  }

  async function newGraph(app: App) {
    await app.menu("Windows", "New Graph…");
    const dialog = app.page.getByRole("dialog", { name: "New Graph" });
    return {
      dialog,
      y: dialog.getByRole("listbox", { name: "Y waves" }),
      x: dialog.getByRole("listbox", { name: "X waves" }),
      traces: dialog.getByRole("listbox", { name: "Traces to add" }),
    };
  }

  test("two Y waves selected and Do It make a graph at once", async ({ app, page }) => {
    await someWaves(app);
    const { y, traces } = await newGraph(app);
    await y.getByRole("option", { name: "a", exact: true }).click();
    await y.getByRole("option", { name: "b", exact: true }).click({ modifiers: ["Control"] });
    // With nothing added yet, the list below shows what Do It will make.
    await expect(traces.getByRole("option")).toHaveText([/^a\s*3\s*float64\s*0 to 2\s*V/, /^b/]);
    await expect(page.getByRole("status", { name: "Pairing" })).toHaveText(
      "Each of the 2 Y waves against its own X scaling.",
    );
    await app.doIt();
    const graph = (await app.doc()).graphs.Graph0!;
    expect(graph.traces.map((trace) => [trace.y, trace.x])).toEqual([
      ["a", null],
      ["b", null],
    ]);
    expect((await app.lastEntry()).code).toBe('op.display("a", "b")');
  });

  test("the lists work from the keyboard and Return is Do It", async ({ app, page }) => {
    await someWaves(app);
    const { y } = await newGraph(app);
    await expect(y).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(y.getByRole("option", { selected: true })).toHaveText([/^a/, /^b/]);
    // Typing a name jumps to it.
    await page.keyboard.type("d");
    await expect(y.getByRole("option", { selected: true })).toHaveText([/^d/]);
    await page.keyboard.press("Control+a");
    await expect(y.getByRole("option", { selected: true })).toHaveCount(6);
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    expect((await app.lastEntry()).code).toBe('op.display("a")');
  });

  test("an X wave is paired with the Y waves, and To Cmd Line writes the Python", async ({
    app,
  }) => {
    await someWaves(app);
    const { dialog, y, x } = await newGraph(app);
    await y.getByRole("option", { name: "a", exact: true }).click();
    await x.getByRole("option", { name: "t", exact: true }).click();
    await expect(dialog.getByLabel("Wave details")).toHaveText(
      "t: 3 points · float64 · X 0 to 2 (step 1) · unit s",
    );
    await dialog.getByRole("button", { name: "To Cmd Line" }).click();
    await expect(dialog).toBeHidden();
    expect(await app.typed()).toBe('op.display("a", x="t")');
    expect((await app.doc()).graphs).toEqual({});
    await app.commandLine.press("Enter");
    await app.idle();
    expect((await app.doc()).graphs.Graph0!.traces[0]).toMatchObject({ y: "a", x: "t" });
  });

  test("traces added in groups with other X waves and axes make one graph in one step", async ({
    app,
    page,
  }) => {
    await someWaves(app);
    const { dialog, y, x, traces } = await newGraph(app);
    await y.getByRole("option", { name: "a", exact: true }).click();
    await y.getByRole("option", { name: "b", exact: true }).click({ modifiers: ["Shift"] });
    await x.getByRole("option", { name: "t", exact: true }).click();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();

    await y.getByRole("option", { name: "c", exact: true }).click();
    await x.getByRole("option", { name: "t2", exact: true }).click();
    await dialog.getByLabel("Vertical axis").selectOption("right");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    // A double-click adds a Y wave at once, against the X selected (none fits d).
    await x.getByRole("option", { name: "_calculated_" }).click();
    await y.getByRole("option", { name: "d", exact: true }).dblclick();
    await expect(traces.getByRole("option")).toHaveText([
      /^a vs t/,
      /^b vs t/,
      /^c vs t2\s*2\s*float64\s*10 to 20\s*right, bottom$/,
      /^d\s*4/,
    ]);

    await traces.getByRole("option", { name: "d", exact: true }).click();
    await page.keyboard.press("Delete");
    await traces.getByRole("option", { name: "b vs t" }).click();
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(traces.getByRole("option")).toHaveText([/^a vs t/, /^c vs t2/]);
    await dialog.getByLabel("Graph name").fill("Pairs");
    await app.doIt();

    const graph = (await app.doc()).graphs.Pairs!;
    expect(graph.traces.map(({ y, x, vAxis, hAxis }) => ({ y, x, vAxis, hAxis }))).toEqual([
      { y: "a", x: "t", vAxis: "left", hAxis: "bottom" },
      { y: "c", x: "t2", vAxis: "right", hAxis: "bottom" },
    ]);
    expect((await app.lastEntry()).code).toBe(
      'g = op.display("a", x="t", name="Pairs")\ng.append("c", x="t2", axis="right")',
    );
    // One Do It, one undo.
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Undo/ }).click();
    expect((await app.doc()).graphs.Pairs).toBeUndefined();
  });

  test("a Y and an X wave of different lengths cannot be paired, and the dialog says so", async ({
    app,
  }) => {
    await someWaves(app);
    const { dialog, y, x } = await newGraph(app);
    await y.getByRole("option", { name: "a", exact: true }).click();
    await x.getByRole("option", { name: "t2", exact: true }).click();
    await expect(dialog.getByRole("status", { name: "Pairing" })).toHaveText(
      "a has 3 points but t2 has 2: a Y and an X wave must have as many points.",
    );
    await expect(dialog.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Do It" })).toBeDisabled();
    await x.getByRole("option", { name: "t", exact: true }).click({ modifiers: ["Control"] });
    await expect(dialog.getByRole("status", { name: "Pairing" })).toHaveText(
      /^2 X waves for 1 Y wave: select one X wave/,
    );
  });

  test("Append Traces shows what the graph has and appends to it", async ({ app }) => {
    await someWaves(app);
    await app.run('op.display("a", x="t")');
    await app.menu("Graph", "Append Traces…");
    const dialog = app.page.getByRole("dialog", { name: "Append Traces to Graph0" });
    const traces = dialog.getByRole("listbox", { name: "Traces to add" });
    const existing = traces.getByRole("option", { name: "a vs t" });
    await expect(existing).toHaveAttribute("aria-disabled", "true");
    await dialog
      .getByRole("listbox", { name: "Y waves" })
      .getByRole("option", { name: "b", exact: true })
      .click();
    await dialog.getByLabel("Vertical axis").selectOption("right");
    await expect(traces.getByRole("option")).toHaveText([/^a vs t/, /^b\s*3.*right, bottom$/]);
    // What the graph has cannot be removed.
    await existing.click({ force: true });
    await expect(existing).toHaveAttribute("aria-selected", "false");
    await expect(dialog.getByRole("button", { name: "Remove" })).toBeDisabled();
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.traces.map((trace) => trace.y)).toEqual(["a", "b"]);
    expect((await app.lastEntry()).code).toBe('op.graph("Graph0").append("b", axis="right")');
  });
});
