import { expect, test, type App } from "./fixtures";

/**
 * Three samples, each a current against a voltage (the third in mA), and a
 * graph of the first with a legend, a text box naming the sample and a range
 * set on the bottom axis.
 */
async function samples(app: App): Promise<void> {
  await app.run(`for s in ("s1", "s2", "s3"):
    op.make(f"{s}_V", np.linspace(-1, 1, 50), unit="V")
    op.make(f"{s}_I", np.linspace(-1, 1, 50) ** 3, unit="mA" if s == "s3" else "A")
g = op.display("s1_I", x="s1_V")
g.trace().set(color="green", line_size=2)
g.legend()
g.textbox("Sample s1_I")
g.bottom.range = (-1, 1)`);
  await app.place("Graph0", 20, 16, 460, 320);
}

/** The graphs made from the template: their traces, text, range and look. */
function made(app: App) {
  return app.page.evaluate(() => {
    const state = globalThis.oresme.doc.getState();
    return Object.values(state.graphs)
      .filter((graph) => graph.name !== "Graph0")
      .map((graph) => ({
        name: graph.name,
        trace: [graph.traces[0]?.y, graph.traces[0]?.x, graph.traces[0]?.color],
        text: graph.annotations.map((item) => item.text),
        bottom: [graph.axes.bottom?.min, graph.axes.bottom?.max],
      }));
  });
}

test.describe("graph templates", () => {
  test("a template saved from a graph makes a graph for each of three samples", async ({
    app,
    page,
  }) => {
    await samples(app);
    await app
      .window("Graph0")
      .locator("canvas")
      .click({ button: "right", position: { x: 200, y: 60 } });
    await page.getByRole("menuitem", { name: "Save as Template…" }).click();
    const save = page.getByRole("dialog", { name: "Save Graph as Template" });
    await expect(save.getByRole("list", { name: "Slots" })).toContainText(
      "y Y wave, from s1_I (A)",
    );
    await expect(save.getByRole("list", { name: "Slots" })).toContainText(
      "x X wave, from s1_V (V)",
    );
    await save.getByLabel("Template name").fill("IV");
    await save.getByLabel("Keep bottom at -1 to 1").check();
    await expect(save.getByLabel("Keep left at automatic")).toBeDisabled();
    await save.getByRole("button", { name: "Save", exact: true }).click();
    await expect(save).toBeHidden();
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").save_template("IV", fixed=["bottom"])',
    );

    await app.menu("Graph", "Make Graphs from Template…");
    const dialog = page.getByRole("dialog", { name: "Make Graphs from Template" });
    await expect(
      dialog.getByRole("listbox", { name: "In this experiment" }).getByRole("option", {
        name: "IV",
      }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("status", { name: "Problem" })).toHaveText(
      "No wave for slot y, which is plotted.",
    );
    const make = dialog.getByRole("button", { name: "Make Graph", exact: true });
    await expect(make).toBeDisabled();

    // The first row, then two more that start as copies of it.
    await dialog.getByLabel("y of graph 1").selectOption("s2_I");
    await dialog.getByLabel("x of graph 1").selectOption("s2_V");
    await dialog.getByRole("button", { name: "Add Row" }).click();
    await dialog.getByRole("button", { name: "Add Row" }).click();
    await expect(dialog.getByLabel("y of graph 3")).toHaveValue("s2_I");
    await dialog.getByLabel("y of graph 2").selectOption("s3_I");
    await dialog.getByLabel("x of graph 2").selectOption("s3_V");
    await dialog.getByLabel("y of graph 3").selectOption("s1_I");
    await dialog.getByLabel("x of graph 3").selectOption("s1_V");
    // Different units are warned of, and do not stop the graphs being made.
    await expect(dialog.getByRole("list", { name: "Warnings" })).toHaveText(
      'Sample 2: s3_I in slot y has values in "mA"; the template was made with "A".',
    );
    await expect(dialog.getByRole("status", { name: "Problem" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Make 3 Graphs" }).click();
    await expect(dialog).toBeHidden();

    expect(await made(app)).toEqual(
      ["s2", "s3", "s1"].map((sample, index) => ({
        name: `Graph${index + 1}`,
        trace: [`${sample}_I`, `${sample}_V`, "#009900"],
        text: ["", `Sample ${sample}_I`],
        bottom: [-1, 1],
      })),
    );
    expect((await app.lastEntry()).code).toBe(
      'op.graph_template("IV").make(y=["s2_I", "s3_I", "s1_I"], x=["s2_V", "s3_V", "s1_V"])',
    );
    // The new graph draws the new sample's name.
    await expect(app.window("Graph2")).toBeVisible();

    // One undo takes all three away.
    await page.keyboard.press("Control+z");
    expect(await made(app)).toEqual([]);
  });

  test("a template kept in the library makes graphs in any experiment", async ({ app, page }) => {
    await samples(app);
    await app.run('g.save_template("IV")');
    await app.menu("Graph", "Make Graphs from Template…");
    const dialog = page.getByRole("dialog", { name: "Make Graphs from Template" });
    await dialog
      .getByRole("group", { name: "In this experiment" })
      .getByRole("button", { name: "To Library" })
      .click();
    await expect(
      dialog.getByRole("listbox", { name: "Library (this browser)" }).getByRole("option", {
        name: "IV",
      }),
    ).toBeVisible();
    await dialog
      .getByRole("group", { name: "In this experiment" })
      .getByRole("button", { name: "Delete" })
      .click();
    expect((await app.lastEntry()).code).toBe('op.graph_template("IV").remove()');

    await dialog
      .getByRole("listbox", { name: "Library (this browser)" })
      .getByRole("option", { name: "IV" })
      .click();
    await dialog.getByLabel("y of graph 1").selectOption("s2_I");
    // X may be left empty: the graph is then drawn against the wave's own scaling.
    await dialog.getByRole("button", { name: "Make Graph", exact: true }).click();
    await expect(dialog).toBeHidden();
    // The template comes into the experiment first, so the history runs anywhere.
    const code = (await app.lastEntry()).code.split("\n");
    expect(code[0]).toMatch(/^op\.set_graph_template\("IV", \{"style": /);
    expect(code[1]).toBe('op.graph_template("IV").make(y="s2_I")');
    expect(await made(app)).toEqual([
      {
        name: "Graph1",
        trace: ["s2_I", null, "#009900"],
        text: ["", "Sample s2_I"],
        bottom: [null, null],
      },
    ]);
  });
});
