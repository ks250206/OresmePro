import type { Page } from "@playwright/test";
import { expect, test, type App } from "./fixtures";

/** The title bar above a graph (TITLE_BAR_HEIGHT). */
const TITLE = 24;

async function windowSize(app: App) {
  const window = (await app.doc()).windows.find((item) => item.name === "Graph0")!;
  return { w: window.w, h: window.h };
}

async function openModifyGraph(app: App, page: Page) {
  await app
    .window("Graph0")
    .locator("canvas")
    .click({ button: "right", position: { x: 200, y: 100 } });
  await page.getByRole("menuitem", { name: "Modify Graph…" }).click();
  return page.getByRole("dialog", { name: /Modify Graph/ });
}

test.describe("labels, margins and magnification", () => {
  test.beforeEach(async ({ app }) => {
    await app.run(`y = op.make("y", 1000 * np.sin(np.linspace(0, 6, 61)), x_unit="s", unit="V")
g = op.display(y)`);
    await app.place("Graph0", 20, 16, 520, 380);
  });

  test("Show labels in Modify Axis hides the tick labels, then the axis label", async ({
    app,
    page,
  }) => {
    const svg = async () => (await app.run("print(g.svg())")).output;
    expect(await svg()).toMatch(/>V</);
    expect(await svg()).toMatch(/>500</);

    await app.menu("Graph", "Modify Axis…");
    const dialog = page.getByRole("dialog", { name: /Modify Axis/ });
    await expect(dialog.getByLabel("Show labels")).toHaveValue("on");
    await dialog.getByLabel("Show labels").selectOption("axis only");
    await expect(dialog.getByText("the axis label, no tick labels")).toBeVisible();
    await app.doIt();
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").axis("left").set(labels="axis only")',
    );
    expect(await svg()).toMatch(/>V</);
    expect(await svg()).not.toMatch(/>500</);

    await app.run('g.left.labels = "off"');
    expect(await svg()).not.toMatch(/>V</);
  });

  test("turned … ° in Modify Axis turns the axis label round", async ({ app, page }) => {
    await app.run(`g.append(op.make("z", np.arange(61.0), unit="A"), axis="right")`);
    const svg = async () => (await app.run("print(g.svg())")).output;
    expect(await svg()).toMatch(/rotate\(-90 [^"]*"[^>]*>V</);
    expect(await svg()).toMatch(/rotate\(90 [^"]*"[^>]*>A</);

    await app.menu("Graph", "Modify Axis…");
    const dialog = page.getByRole("dialog", { name: /Modify Axis/ });
    await expect(dialog.getByLabel("Label rotation")).toHaveValue("0");
    await dialog.getByLabel("Label rotation").fill("180");
    await app.doIt();
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").axis("left").set(label_rotation=180)',
    );
    expect(await svg()).toMatch(/rotate\(90 [^"]*"[^>]*>V</);

    await app.run('g.axis("right").label_rotation = 180');
    expect(await svg()).toMatch(/rotate\(270 [^"]*"[^>]*>A</);
  });

  test("Margins in Modify Graph fix a side in points and go back to auto", async ({
    app,
    page,
  }) => {
    const dialog = await openModifyGraph(app, page);
    const left = dialog.getByLabel("Left margin", { exact: true });
    await expect(left).toBeDisabled();
    await expect(left).toHaveAttribute("placeholder", "auto");
    // Unticking Auto starts from the margin there is now, so nothing changes yet.
    await dialog.getByLabel("Left margin auto").uncheck();
    await expect(left).toHaveValue(/^\d+$/);
    await left.fill("90");
    await dialog.getByLabel("Top margin auto").uncheck();
    await dialog.getByLabel("Top margin", { exact: true }).fill("-4");
    await expect(page.getByRole("button", { name: "Do It" })).toBeDisabled();
    await expect(dialog.getByText("A margin is a number of points from 0 to 360.")).toBeVisible();
    await dialog.getByLabel("Top margin auto").check();
    await app.doIt();
    expect((await app.lastEntry()).code).toBe('op.graph("Graph0").set(margin_left=90)');
    expect((await app.run("print(g.margin_left, g.margin_top)")).output).toBe("90 None\n");
    // 90 pt is 120 CSS pixels: the grid lines across the plot area start there.
    await app.run('g.left.set(grid="major")');
    const svg = (await app.run("print(g.svg())")).output;
    const grid = /<path d="M([\d.]+) [\d.]+L[\d.]+ [\d.]+[^"]*" fill="none" stroke="#c4c4c4"/.exec(
      svg,
    )!;
    expect(Number(grid[1])).toBe(120);

    const again = await openModifyGraph(app, page);
    await expect(again.getByLabel("Left margin", { exact: true })).toHaveValue("90");
    await again.getByLabel("Left margin auto").check();
    await app.doIt();
    expect((await app.lastEntry()).code).toBe('op.graph("Graph0").set(margin_left=None)');
  });

  test("Magnification in Modify Graph draws the graph bigger in a bigger window", async ({
    app,
    page,
  }) => {
    const before = await windowSize(app);
    const canvas = app.window("Graph0").locator("canvas");
    const width = async () => Math.round((await canvas.boundingBox())!.width);
    const figureWidth = async () => {
      const svg = (await app.run("print(g.svg())")).output;
      return Number(/<svg[^>]* width="([\d.]+)"/.exec(svg)![1]);
    };
    // The canvas fills the window inside its border.
    await expect.poll(width).toBeGreaterThan(before.w - 4);
    const small = await width();
    const figure = await figureWidth();
    const dialog = await openModifyGraph(app, page);
    const select = dialog.getByLabel("Magnification");
    await expect(select).toHaveValue("1");
    await expect(select.locator("option")).toHaveText([
      "0.125",
      "0.25",
      "0.5",
      "0.667",
      "0.75",
      "None",
      "1.333",
      "1.5",
      "1.75",
      "2",
      "3",
      "4",
      "5",
      "8",
    ]);
    await select.selectOption("2");
    await app.doIt();
    expect((await app.lastEntry()).code).toBe('op.graph("Graph0").set(magnification=2)');
    await expect
      .poll(() => windowSize(app))
      .toEqual({ w: before.w * 2, h: (before.h - TITLE) * 2 + TITLE });
    // The window is twice as big, and the canvas in it; within the border.
    await expect.poll(width).toBeGreaterThan(small * 2 - 6);
    const big = (await canvas.boundingBox())!;
    expect(big.width).toBeLessThanOrEqual(small * 2 + 2);

    // The figure, as exported, keeps its own size.
    expect(await figureWidth()).toBe(figure);

    // Right-clicking the magnified graph still finds what is under the pointer.
    await canvas.click({ button: "right", position: { x: 20, y: big.height / 2 } });
    await expect(page.getByRole("menuitem", { name: "Modify left Axis…" })).toBeVisible();
    await page.keyboard.press("Escape");

    await app.run("g.magnification = 1");
    await expect.poll(() => windowSize(app)).toEqual(before);
  });
});
