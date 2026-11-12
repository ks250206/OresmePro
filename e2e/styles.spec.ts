import { expect, test, type App } from "./fixtures";

/** Two graphs: Graph0 in a look of its own, Graph1 plain, side by side. */
async function twoGraphs(app: App): Promise<void> {
  await app.run(`a = op.make("a", np.sin(np.linspace(0, 6, 200)))
b = op.make("b", np.cos(np.linspace(0, 6, 200)))
g0 = op.display(a)
g0.set(font_size=18)
g0.trace().set(line_size=3, color="red")
g0.left.set(ticks="inside", mirror="on")
g1 = op.display(b)`);
  await app.place("Graph0", 20, 16, 420, 300);
  await app.place("Graph1", 460, 16, 420, 300);
}

/** The styles of the experiment, the default, and the look of one trace and graph. */
function looks(app: App) {
  return app.page.evaluate(() => {
    const state = globalThis.oresme.doc.getState();
    const graph = (name: string) => {
      const spec = state.graphs[name];
      return spec
        ? {
            fontSize: spec.fontSize,
            lineSize: spec.traces[0]?.lineSize,
            color: spec.traces[0]?.color,
            leftTicks: spec.axes.left?.ticks,
            style: spec.style,
          }
        : null;
    };
    return {
      styles: Object.keys(state.styles),
      defaultStyle: state.defaultStyle,
      Graph0: graph("Graph0"),
      Graph1: graph("Graph1"),
    };
  });
}

/** Opens the Styles dialog from a graph's context menu. */
async function stylesOf(app: App, graph: string) {
  await app
    .window(graph)
    .locator("canvas")
    .click({ button: "right", position: { x: 200, y: 40 } });
  await app.page.getByRole("menuitem", { name: "Styles…", exact: true }).click();
  return app.page.getByRole("dialog", { name: "Graph Styles" });
}

test.describe("graph styles", () => {
  test("a style saved from one graph gives another its fonts, lines and ticks", async ({
    app,
    page,
  }) => {
    await twoGraphs(app);
    expect((await looks(app)).Graph1).toMatchObject({ fontSize: 12, lineSize: 1 });

    let dialog = await stylesOf(app, "Graph0");
    await dialog.getByLabel("Style name").fill("paper");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await looks(app)).styles).toEqual(["paper"]);
    expect((await app.lastEntry()).code).toBe('op.graph("Graph0").save_style("paper")');

    // Apply it to the other graph, chosen in the dialog's list of graphs.
    await dialog
      .getByRole("listbox", { name: "Graphs" })
      .getByRole("option", { name: "Graph1", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Apply to Selected Graphs" }).click();
    expect((await looks(app)).Graph1).toEqual({
      fontSize: 18,
      lineSize: 3,
      color: "#ff0000",
      leftTicks: "inside",
      style: "paper",
    });
    expect((await app.lastEntry()).code).toBe('op.graph("Graph1").apply_style("paper")');
    await dialog.getByRole("button", { name: "Close" }).click();

    // One undo takes the whole look back.
    await page.keyboard.press("Control+z");
    expect((await looks(app)).Graph1).toMatchObject({ fontSize: 12, lineSize: 1, style: null });

    // The graph's context menu applies a style in two clicks.
    await app
      .window("Graph1")
      .locator("canvas")
      .click({ button: "right", position: { x: 200, y: 40 } });
    await page.getByRole("menuitem", { name: "Apply Style" }).hover();
    await page.getByRole("menuitem", { name: "paper", exact: true }).click();
    expect((await looks(app)).Graph1).toMatchObject({ fontSize: 18, lineSize: 3 });

    // Renaming the style in the dialog keeps the graph pointing at it.
    dialog = await stylesOf(app, "Graph1");
    await dialog
      .getByRole("group", { name: "In this experiment" })
      .getByRole("button", { name: "Rename…" })
      .click();
    await dialog.getByLabel("New name").fill("journal");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    expect(await looks(app)).toMatchObject({ styles: ["journal"], Graph1: { style: "journal" } });
    expect((await app.lastEntry()).code).toBe('op.style("paper").rename("journal")');
  });

  test("new graphs get the default style", async ({ app, page }) => {
    await twoGraphs(app);
    await app.run('g0.save_style("big"); op.make("c", np.linspace(0, 1, 50))');
    await app.menu("Graph", "Styles…");
    const dialog = page.getByRole("dialog", { name: "Graph Styles" });
    await dialog.getByLabel("Default style").selectOption("big");
    expect((await looks(app)).defaultStyle).toBe("big");
    expect((await app.lastEntry()).code).toBe('op.set_default_style("big")');
    await dialog.getByRole("button", { name: "Close" }).click();

    await app.menu("Windows", "New Graph…");
    await page
      .getByRole("dialog", { name: "New Graph" })
      .getByRole("listbox")
      .getByRole("option", { name: "c", exact: true })
      .click();
    await app.doIt();
    const made = await page.evaluate(() => {
      const graph = globalThis.oresme.doc.getState().graphs.Graph2!;
      return { fontSize: graph.fontSize, lineSize: graph.traces[0]!.lineSize, style: graph.style };
    });
    expect(made).toEqual({ fontSize: 18, lineSize: 3, style: "big" });
  });

  test("a style kept in the library is copied into the experiment as it is applied", async ({
    app,
    page,
  }) => {
    await twoGraphs(app);
    const dialog = await stylesOf(app, "Graph0");
    await dialog.getByLabel("Style name").fill("lab");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const experiment = dialog.getByRole("group", { name: "In this experiment" });
    await experiment.getByRole("option", { name: "lab", exact: true }).click();
    await experiment.getByRole("button", { name: "To Library" }).click();
    await expect(
      dialog
        .getByRole("group", { name: "Library (this browser)" })
        .getByRole("option", { name: "lab", exact: true }),
    ).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem("oresme.styles"));
    expect(JSON.parse(stored!).styles.lab.graph.fontSize).toBe(18);

    // Gone from the experiment, it is still in the library.
    await experiment.getByRole("option", { name: "lab", exact: true }).click();
    await experiment.getByRole("button", { name: "Delete" }).click();
    expect((await looks(app)).styles).toEqual([]);
    await dialog.getByRole("button", { name: "Close" }).click();

    await app
      .window("Graph1")
      .locator("canvas")
      .click({ button: "right", position: { x: 200, y: 40 } });
    await page.getByRole("menuitem", { name: "Apply Style" }).hover();
    await page.getByRole("menuitem", { name: "lab (library)" }).click();
    expect(await looks(app)).toMatchObject({
      styles: ["lab"],
      Graph1: { fontSize: 18, lineSize: 3, style: "lab" },
    });
    const code = (await app.lastEntry()).code.split("\n");
    expect(code[0]).toMatch(/^op\.set_style\("lab", \{"graph": \{"font_size": 18, /);
    expect(code[1]).toBe('op.graph("Graph1").apply_style("lab")');
  });

  test("styles are exported to a file and imported into the library", async ({ app, page }) => {
    await twoGraphs(app);
    await app.run('g0.save_style("one"); op.set_style("two", {"traces": [{"line_size": 5}]})');
    const dialog = await stylesOf(app, "Graph0");
    const experiment = dialog.getByRole("group", { name: "In this experiment" });
    await experiment.getByRole("option", { name: "one", exact: true }).click();
    await experiment.getByRole("option", { name: "two", exact: true }).click({
      modifiers: ["ControlOrMeta"],
    });
    const { file, bytes } = await app.download(() =>
      experiment.getByRole("button", { name: "Export…" }).click(),
    );
    expect(file.suggestedFilename()).toBe("styles.json");
    const saved = JSON.parse(bytes.toString("utf8")) as { styles: Record<string, unknown> };
    expect(Object.keys(saved.styles)).toEqual(["one", "two"]);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      dialog.getByRole("button", { name: "Import…" }).click(),
    ]);
    await chooser.setFiles({ name: "styles.json", mimeType: "application/json", buffer: bytes });
    const library = dialog.getByRole("group", { name: "Library (this browser)" });
    await expect(library.getByRole("option", { name: "two", exact: true })).toBeVisible();
    await expect(library.getByRole("option")).toHaveCount(2);
  });
});
