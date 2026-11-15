import { expect, test, type App } from "./fixtures";

/** The title bar above a graph (TITLE_BAR_HEIGHT). */
const TITLE = 24;

/**
 * The plot area and the figure of a graph as its SVG draws them: the major
 * grid lines of the left axis run across the plot area, those of the bottom
 * axis down it.
 */
async function drawn(app: App, graph = "g") {
  const svg = (await app.run(`print(${graph}.svg())`)).output;
  const figure = /<svg[^>]* width="([\d.]+)" height="([\d.]+)"/.exec(svg)!;
  const grid = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#c4c4c4"/g)].flatMap(
    (match) => [...match[1]!.matchAll(/M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)/g)],
  );
  const across = grid.find((line) => line[2] === line[4])!;
  const down = grid.find((line) => line[1] === line[3])!;
  return {
    width: Number(figure[1]),
    height: Number(figure[2]),
    plot: {
      w: Math.round(Number(across[3]) - Number(across[1])),
      h: Math.round(Number(down[4]) - Number(down[2])),
    },
  };
}

async function windowSize(app: App) {
  const window = (await app.doc()).windows.find((item) => item.name === "Graph0")!;
  return { w: window.w, h: window.h };
}

test.describe("the size of the plot area", () => {
  test.beforeEach(async ({ app }) => {
    await app.run(`re = op.make("re", np.linspace(0, 40, 41))
im = op.make("im", 10 * np.sin(np.linspace(0, 3, 41)))
g = op.display(im, x=re)
g.left.set(grid="major")
g.bottom.set(grid="major")`);
    await app.place("Graph0", 20, 16, 520, 380);
  });

  test("8 cm by 6 cm from the dialog draws that plot area, and the window fits it", async ({
    app,
    page,
  }) => {
    await app
      .window("Graph0")
      .locator("canvas")
      .click({ button: "right", position: { x: 200, y: 100 } });
    await page.getByRole("menuitem", { name: "Modify Graph…" }).click();
    const dialog = page.getByRole("dialog", { name: /Modify Graph/ });
    await dialog.getByLabel("Plot width mode").selectOption("Absolute");
    await dialog.getByLabel("Plot width value").fill("8");
    await dialog.getByLabel("Plot width unit").selectOption("cm");
    await dialog.getByLabel("Plot height mode").selectOption("Absolute");
    await dialog.getByLabel("Plot height value").fill("6");
    await dialog.getByLabel("Plot height unit").selectOption("cm");
    // Both sides from each other is refused before it is tried.
    await dialog.getByLabel("Plot height mode").selectOption("Aspect");
    await dialog.getByLabel("Plot width mode").selectOption("Plan");
    await expect(dialog.getByText("cannot both be Aspect or Plan")).toBeVisible();
    await expect(page.getByRole("button", { name: "Do It" })).toBeDisabled();
    await dialog.getByLabel("Plot width mode").selectOption("Absolute");
    await dialog.getByLabel("Plot height mode").selectOption("Absolute");
    await app.doIt();
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").set(width=op.cm(8), height=op.cm(6))',
    );

    // 8 cm and 6 cm are 302 and 227 CSS pixels; a PDF draws 0.75 pt to the pixel.
    const figure = await drawn(app);
    expect(figure.plot).toEqual({ w: 302, h: 227 });
    await expect.poll(() => windowSize(app)).toEqual({ w: figure.width, h: figure.height + TITLE });
    const canvas = (await app.window("Graph0").locator("canvas").boundingBox())!;
    expect([Math.round(canvas.width), Math.round(canvas.height)]).toEqual([
      figure.width,
      figure.height,
    ]);

    // Dragging the corner does not change the figure.
    const box = (await app.window("Graph0").boundingBox())!;
    await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 120, box.y + box.height + 90, { steps: 4 });
    await page.mouse.up();
    expect(await windowSize(app)).toEqual({ w: figure.width, h: figure.height + TITLE });

    // The cursor bar adds to the window, not taking from the graph.
    await app.run("g.show_info = True");
    await expect.poll(async () => (await windowSize(app)).h).toBe(figure.height + TITLE + 56);
    expect((await drawn(app)).plot).toEqual({ w: 302, h: 227 });
  });

  test("aspect 1 is square, plan 1 scales both axes alike, and per unit follows the range", async ({
    app,
  }) => {
    await app.run('g.set(width=op.cm(7), height=("aspect", 1))');
    const square = await drawn(app);
    expect(square.plot.h).toBe(square.plot.w);

    // 40 units across and 20 up: equal units make the width twice the height.
    await app.run(
      'g.bottom.range = (0, 40); g.left.range = (0, 20)\ng.set(width=("plan", 1), height=op.cm(6))',
    );
    expect((await drawn(app)).plot).toEqual({ w: 454, h: 227 });

    await app.run('g.set(width=("per_unit", 0.25, "cm", "bottom"))');
    const before = (await drawn(app)).plot.w;
    await app.run("g.bottom.range = (0, 20)");
    const after = await drawn(app);
    expect(after.plot.w).toBe(Math.round(before / 2));
    // The window follows a size that changes with the range.
    await expect.poll(async () => (await windowSize(app)).w).toBe(after.width);
  });

  test("the size comes back after a reload", async ({ app, page }) => {
    await app.run('g.set(width=op.inch(3), height=("aspect", 0.5))');
    const figure = await drawn(app);
    await expect(page.getByRole("group", { name: "Saving" })).toHaveText(/^Saved \d/);
    await page.reload();
    await expect
      .poll(async () => (await app.doc()).graphs.Graph0?.width)
      .toEqual({ mode: "absolute", value: 3, unit: "inch" });
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    expect((await app.run('print(op.graph("Graph0").height)')).output).toBe("('aspect', 0.5)\n");
    expect(await drawn(app, 'op.graph("Graph0")')).toEqual(figure);
    expect(figure.plot).toEqual({ w: 288, h: 144 });
  });
});
