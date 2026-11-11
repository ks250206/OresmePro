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
