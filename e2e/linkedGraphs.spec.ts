import { expect, test } from "./fixtures";

test.describe("linked graphs", () => {
  test("linked in the dialog, zooming one zooms the other", async ({ app, page }) => {
    await app.run(`op.display(op.make("lg_a", np.sin(np.linspace(0, 10, 101))), name="GA")
op.display(op.make("lg_b", np.cos(np.linspace(0, 10, 201)), dx=0.5), name="GB")`);
    await app.place("GA", 20, 16, 420, 280);
    await app.place("GB", 460, 16, 420, 280);
    await app
      .window("GA")
      .locator("canvas")
      .click({ button: "right", position: { x: 200, y: 120 } });
    await page.getByRole("menuitem", { name: "Link Graphs…" }).click();
    const dialog = page.getByRole("dialog", { name: "Link Graphs" });
    await dialog.getByRole("option", { name: "GB" }).click({ modifiers: ["ControlOrMeta"] });
    await dialog.getByRole("button", { name: "Link", exact: true }).click();
    expect((await app.lastEntry()).code).toBe('op.link_graphs("GA", "GB")');
    await expect(app.window("GA").getByText(/linked/)).toBeVisible();

    const box = (await app.window("GA").locator("canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => (await app.doc()).graphs.GA!.axes.bottom!.min).not.toBeNull();
    const doc = await app.doc();
    const [a, b] = [doc.graphs.GA!.axes.bottom!, doc.graphs.GB!.axes.bottom!];
    expect([b.min, b.max]).toEqual([a.min, a.max]);
  });
});
