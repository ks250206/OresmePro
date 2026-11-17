import { expect, test } from "./fixtures";

test.describe("drawing tools", () => {
  test("draw, move, change, pin and remove shapes and text on a graph", async ({ app, page }) => {
    await app.run(`y = op.make("y", np.sin(np.linspace(0, 6, 61)))
g = op.display(y)`);
    await app.place("Graph0", 20, 16, 560, 400);
    const window = app.window("Graph0");
    await page.getByRole("menuitem", { name: "Graph", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Show Tools/ }).click();
    const palette = window.getByRole("toolbar", { name: "Drawing tools" });
    await expect(palette).toBeVisible();
    const area = window.getByLabel("Graph0 drawing area");
    const box = (await area.boundingBox())!;
    const drawings = async () => (await app.doc()).graphs.Graph0!.drawings;
    const drag = async (x0: number, y0: number, x1: number, y1: number) => {
      await page.mouse.move(box.x + x0, box.y + y0);
      await page.mouse.down();
      await page.mouse.move(box.x + (x0 + x1) / 2, box.y + (y0 + y1) / 2, { steps: 3 });
      await page.mouse.move(box.x + x1, box.y + y1, { steps: 3 });
      await page.mouse.up();
    };

    // An arrow, dragged from its tail to its head; the tool goes back to Select.
    await palette.getByRole("button", { name: "Draw arrow" }).click();
    await drag(150, 100, 300, 180);
    expect(await drawings()).toMatchObject([
      { name: "draw0", kind: "arrow", arrow: "end", coords: "plot" },
    ]);
    expect((await app.lastEntry()).code).toMatch(/^op\.graph\("Graph0"\)\.draw\("arrow", \[/);
    await expect(palette.getByRole("button", { name: "Select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Dragging it moves it, as one step.
    const before = (await drawings())[0]!.points;
    await drag(225, 140, 245, 160);
    const after = (await drawings())[0]!.points;
    expect(after[0]).toBeGreaterThan(before[0]!);
    expect(after[1]).toBeGreaterThan(before[1]!);

    // Double-click: how it looks.
    await page.mouse.dblclick(box.x + 245, box.y + 160);
    const dialog = page.getByRole("dialog", { name: /Modify draw0/ });
    await dialog.getByLabel("Arrowheads").selectOption("both");
    await dialog.getByLabel("Line size").fill("3");
    await app.doIt();
    expect((await drawings())[0]).toMatchObject({ arrow: "both", lineSize: 3 });

    // Right-click: pinned to the axes, it moves with the data.
    await page.mouse.click(box.x + 245, box.y + 160, { button: "right" });
    await page.getByRole("menuitem", { name: /Pin to the Axes/ }).click();
    expect((await drawings())[0]).toMatchObject({ coords: "axes", hAxis: "bottom", vAxis: "left" });

    // A rectangle behind the traces, a polygon of three corners, and text.
    await palette.getByRole("button", { name: "Draw rect" }).click();
    await drag(60, 40, 140, 90);
    await palette.getByRole("button", { name: "Draw polygon" }).click();
    await page.mouse.click(box.x + 350, box.y + 60);
    await page.mouse.click(box.x + 420, box.y + 60);
    await page.mouse.dblclick(box.x + 390, box.y + 120);
    await palette.getByRole("button", { name: "Draw text" }).click();
    await page.mouse.click(box.x + 380, box.y + 250);
    await page
      .getByRole("dialog", { name: /Draw Text/ })
      .getByLabel("Text")
      .fill("Peak A");
    await app.doIt();
    expect((await drawings()).map((item) => [item.name, item.kind, item.points.length])).toEqual([
      ["draw0", "arrow", 4],
      ["draw1", "rect", 4],
      ["draw2", "polygon", 6],
      ["draw3", "text", 2],
    ]);
    expect((await app.run("print(g.svg())")).output).toContain(">Peak A<");

    // Delete takes the drawing selected away; hiding the tools leaves the drawings.
    await page.mouse.click(box.x + 100, box.y + 65);
    await page.keyboard.press("Delete");
    expect((await drawings()).map((item) => item.name)).toEqual(["draw0", "draw2", "draw3"]);

    // Select All takes every drawing (not the axes' autoscale); Delete removes them, as one step.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    expect(await drawings()).toEqual([]);
    await page.keyboard.press("ControlOrMeta+z");
    expect(await drawings()).toHaveLength(3);

    // Shift-click adds to the selection; dragging one of them moves both.
    const [arrow, , text] = await drawings();
    await page.keyboard.press("Escape");
    await page.mouse.click(box.x + 380, box.y + 255);
    await page.keyboard.down("Shift");
    await page.mouse.click(box.x + 395, box.y + 75);
    await page.keyboard.up("Shift");
    await drag(380, 255, 400, 275);
    const [movedArrow, , movedText] = await drawings();
    expect(movedText!.points[0]).toBeGreaterThan(text!.points[0]!);
    expect(movedArrow!.points).toEqual(arrow!.points);

    // ⌥T / Alt+T hides the tools and shows them again; the drawings stay.
    await page.keyboard.press("Alt+KeyT");
    await expect(palette).toBeHidden();
    await page.keyboard.press("Alt+KeyT");
    await expect(palette).toBeVisible();
    await palette.getByRole("button", { name: "Hide the drawing tools" }).click();
    await expect(palette).toBeHidden();
    expect(await drawings()).toHaveLength(3);
  });
});
