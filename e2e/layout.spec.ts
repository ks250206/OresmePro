import { expect, test } from "./fixtures";

test.describe("page layouts", () => {
  test("graphs are placed on a page, moved, resized and saved as PDF", async ({ app, page }) => {
    await app.run(
      [
        "t = np.linspace(0, 10, 200)",
        'a = op.make("a", np.sin(t), dx=t[1] - t[0]); b = op.make("b", np.cos(t), dx=t[1] - t[0])',
        'g1 = op.display(a, name="PanelA"); g2 = op.display(b, name="PanelB")',
      ].join("\n"),
    );
    await app.menu("Windows", "New Page Layout");
    expect((await app.lastEntry()).code).toBe("op.new_layout()");
    await app.place("Layout0", 520, 10, 420, 560);
    const window = app.window("Layout0");
    await window.getByLabel("Add graph").selectOption("PanelA");
    expect((await app.lastEntry()).code).toBe('op.layout("Layout0").add_graph("PanelA")');
    await window.getByLabel("Add graph").selectOption("PanelB");
    let items = (await app.doc()).pages.Layout0!.items;
    expect(items.map((item) => [item.name, item.graph])).toEqual([
      ["graph0", "PanelA"],
      ["graph1", "PanelB"],
    ]);
    // The second goes below the first.
    expect(items[1]!.y).toBeGreaterThan(items[0]!.y + items[0]!.h);

    // Drag the first panel: it moves by the same distance on paper.
    const box = (await window.locator('[data-item="graph0"]').boundingBox())!;
    const scale = box.width / items[0]!.w;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 45, { steps: 6 });
    await page.mouse.up();
    let moved = (await app.doc()).pages.Layout0!.items[0]!;
    expect(moved.x).toBeCloseTo(items[0]!.x + 30 / scale, 0);
    expect(moved.y).toBeCloseTo(items[0]!.y + 45 / scale, 0);
    await expect
      .poll(async () => (await app.lastEntry()).code)
      .toBe(`op.layout("Layout0").item("graph0").set(x=${moved.x}, y=${moved.y})`);

    // Its bottom right corner resizes it; the top left stays.
    const handle = window.locator('[data-item="graph0"] [data-handle="se"]');
    const corner = (await handle.boundingBox())!;
    await page.mouse.move(corner.x + 4, corner.y + 4);
    await page.mouse.down();
    await page.mouse.move(corner.x + 4 - 60, corner.y + 4 - 40, { steps: 6 });
    await page.mouse.up();
    const resized = (await app.doc()).pages.Layout0!.items[0]!;
    expect([resized.x, resized.y]).toEqual([moved.x, moved.y]);
    expect(resized.w).toBeCloseTo(moved.w - 60 / scale, 0);
    expect(resized.h).toBeCloseTo(moved.h - 40 / scale, 0);

    // The arrow keys nudge the selected item a point at a time; Delete removes it.
    await page.keyboard.press("ArrowRight");
    moved = (await app.doc()).pages.Layout0!.items[0]!;
    expect(moved.x).toBe(resized.x + 1);

    await window.getByRole("button", { name: "Add Text…" }).click();
    await page.getByRole("dialog").getByLabel("Text").fill("Figure 1. Sine and cosine");
    await page.getByRole("dialog").getByLabel("Size").fill("9");
    await app.doIt();
    items = (await app.doc()).pages.Layout0!.items;
    expect(items.at(-1)).toMatchObject({
      kind: "text",
      text: "Figure 1. Sine and cosine",
      size: 9,
    });

    await window.getByLabel("Orientation").selectOption("landscape");
    expect((await app.doc()).pages.Layout0).toMatchObject({ width: 842, height: 595 });
    expect((await app.lastEntry()).code).toBe('op.layout("Layout0").set(width=842, height=595)');

    // The PDF is the size of the paper: A4 on its side.
    const saved = await app.download(() =>
      window.getByRole("button", { name: "Save PDF" }).click(),
    );
    expect(saved.file.suggestedFilename()).toBe("Layout0.pdf");
    const pdf = saved.bytes.toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/MediaBox [0 0 842 595]");

    // A graph that changes is redrawn on the page; one that is closed leaves it.
    await app.run('g2.trace("b").color = "#0000ff"; print("#0000ff" in op.layout().svg())');
    expect((await app.lastEntry()).output).toBe("True\n");
    await app.run("g2.kill()");
    expect((await app.doc()).pages.Layout0!.items.map((item) => item.name)).toEqual([
      "graph0",
      "text0",
    ]);

    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    expect((await app.doc()).pages.Layout0!.items).toHaveLength(2);
    await expect(app.window("Layout0").locator("canvas")).toBeVisible();
  });
});

test.describe("arranging page layouts", () => {
  /** Where a point of the page is on the screen. */
  const onScreen = async (
    canvas: import("@playwright/test").Locator,
    width: number,
    x: number,
    y: number,
  ) => {
    const box = (await canvas.boundingBox())!;
    const scale = box.width / width;
    return { x: box.x + x * scale, y: box.y + y * scale, scale };
  };

  test("items are selected with Shift-click and a rubber band, lined up and moved together", async ({
    app,
    page,
  }) => {
    await app.run(
      [
        'w = op.make("w", np.sin(np.linspace(0, 6, 100)))',
        'gs = [op.display(w, name=f"Panel{i}") for i in range(4)]',
        'fig = op.new_layout("Fig")',
        "for g, (x, y) in zip(gs, [(40, 40), (300, 100), (60, 400), (320, 450)]): fig.add_graph(g, x=x, y=y, w=200, h=150)",
        'fig.add_text("Figure 1", x=40, y=700)',
      ].join("\n"),
    );
    await app.place("Fig", 300, 10, 700, 760);
    const window = app.window("Fig");
    const canvas = window.locator("canvas");
    const selected = () =>
      window
        .locator("[data-item][data-selected]")
        .evaluateAll((items) => items.map((item) => item.getAttribute("data-item")));

    // A click selects one item; Shift-click adds another.
    let at = await onScreen(canvas, 595, 140, 115);
    await page.mouse.click(at.x, at.y);
    at = await onScreen(canvas, 595, 400, 175);
    await page.keyboard.down("Shift");
    await page.mouse.click(at.x, at.y);
    await page.keyboard.up("Shift");
    expect(await selected()).toEqual(["graph0", "graph1"]);

    await app.menu("Layout", "Align Top Edges");
    let items = (await app.doc()).pages.Fig!.items;
    expect(items.map((item) => item.y)).toEqual([40, 40, 400, 450, 700]);
    expect((await app.lastEntry()).code).toBe(
      'op.layout("Fig").align(["graph0", "graph1"], "top")',
    );
    // One step to undo, and back again.
    await page.keyboard.press("Control+z");
    expect((await app.doc()).pages.Fig!.items[1]!.y).toBe(100);
    await page.keyboard.press("Control+y");
    expect((await app.doc()).pages.Fig!.items[1]!.y).toBe(40);

    // Dragging one of the selected items moves both by the same distance.
    at = await onScreen(canvas, 595, 140, 115);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 30, at.y + 20, { steps: 6 });
    await page.mouse.up();
    items = (await app.doc()).pages.Fig!.items;
    const dx = items[0]!.x - 40;
    const dy = items[0]!.y - 40;
    expect(dx).toBeCloseTo(30 / at.scale, 0);
    expect(dy).toBeCloseTo(20 / at.scale, 0);
    expect([items[1]!.x - 300, items[1]!.y - 40]).toEqual([dx, dy]);
    expect(items.slice(2).map((item) => [item.x, item.y])).toEqual([
      [60, 400],
      [320, 450],
      [40, 700],
    ]);
    await expect
      .poll(async () => (await app.lastEntry()).code)
      .toBe(
        [
          `op.layout("Fig").item("graph0").set(x=${items[0]!.x}, y=${items[0]!.y})`,
          `op.layout("Fig").item("graph1").set(x=${items[1]!.x}, y=${items[1]!.y})`,
        ].join("\n"),
      );
    // The arrow keys nudge the whole selection.
    await page.keyboard.press("ArrowLeft");
    items = (await app.doc()).pages.Fig!.items;
    expect([items[0]!.x, items[1]!.x]).toEqual([40 + dx - 1, 300 + dx - 1]);

    // A rubber band from empty paper selects what it touches, and only that.
    const from = await onScreen(canvas, 595, 10, 390);
    const to = await onScreen(canvas, 595, 330, 460);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await expect(window.locator("[data-band]")).toBeVisible();
    await page.mouse.up();
    await expect(window.locator("[data-band]")).toHaveCount(0);
    expect(await selected()).toEqual(["graph2", "graph3"]);
    await app.menu("Layout", "Align Left Edges");
    expect((await app.doc()).pages.Fig!.items.map((item) => item.x).slice(2)).toEqual([60, 60, 40]);

    // Select All takes everything, Escape lets go of it; Delete removes what is selected.
    await page.keyboard.press("Control+a");
    expect(await selected()).toEqual(["graph0", "graph1", "graph2", "graph3", "text0"]);
    await page.keyboard.press("Escape");
    expect(await selected()).toEqual([]);
    at = await onScreen(canvas, 595, 100, 420);
    await page.mouse.click(at.x, at.y);
    at = await onScreen(canvas, 595, 100, 580);
    await page.keyboard.down("Shift");
    await page.mouse.click(at.x, at.y);
    await page.keyboard.up("Shift");
    expect(await selected()).toEqual(["graph2", "graph3"]);
    await page.keyboard.press("Delete");
    expect((await app.doc()).pages.Fig!.items.map((item) => item.name)).toEqual([
      "graph0",
      "graph1",
      "text0",
    ]);
    await page.keyboard.press("Control+z");
    expect((await app.doc()).pages.Fig!.items).toHaveLength(5);
  });

  test("graphs are arranged in a 2 × 2 grid", async ({ app, page }) => {
    await app.run(
      [
        'w = op.make("w", np.cos(np.linspace(0, 6, 100)))',
        'grid = op.new_layout("Grid")',
        'for i in range(4): grid.add_graph(op.display(w, name=f"Cell{i}"), w=200, h=150)',
        'grid.add_text("Figure 2", x=40, y=780)',
      ].join("\n"),
    );
    await app.place("Grid", 300, 10, 700, 760);
    const window = app.window("Grid");
    // Stacked one below the other, as added.
    const before = (await app.doc()).pages.Grid!.items;
    expect(before.map((item) => item.y)).toEqual([36, 198, 360, 522, 780]);

    await window.getByRole("button", { name: "Arrange ▾" }).click();
    await page.getByRole("menuitem", { name: "Arrange in Grid…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("All 4 graphs of the page");
    await dialog.getByRole("button", { name: "1 × 2" }).click();
    await expect(dialog).toContainText("graph2, graph3 do not fit");
    await dialog.getByRole("button", { name: "2 × 2" }).click();
    await expect(dialog).not.toContainText("do not fit");
    await app.doIt();
    await expect(dialog).toHaveCount(0);

    // A4 inside 36-point margins with 12-point gaps: cells 255.5 by 379, in reading order.
    const items = (await app.doc()).pages.Grid!.items;
    expect(items.map(({ name, x, y, w, h }) => [name, x, y, w, h])).toEqual([
      ["graph0", 36, 36, 255.5, 379],
      ["graph1", 303.5, 36, 255.5, 379],
      ["graph2", 36, 427, 255.5, 379],
      ["graph3", 303.5, 427, 255.5, 379],
      ["text0", 40, 780, 0, 0],
    ]);
    expect((await app.lastEntry()).code).toBe('op.layout("Grid").arrange(2, 2, margin=36, gap=12)');
    await page.keyboard.press("Control+z");
    expect((await app.doc()).pages.Grid!.items).toEqual(before);
  });
});
