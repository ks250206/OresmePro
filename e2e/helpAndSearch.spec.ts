import { expect, test } from "./fixtures";

test.describe("help and finding waves", () => {
  test("the GitHub link sits at the top right, and Help opens the documentation", async ({
    app,
    page,
  }) => {
    await expect(app.page.getByRole("menubar")).toBeVisible();
    const github = page.getByRole("link", { name: "OresmePro on GitHub" });
    await expect(github).toHaveAttribute("href", "https://github.com/ks250206/OresmePro");
    await expect(github).toHaveAttribute("target", "_blank");
    const box = (await github.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan((page.viewportSize()?.width ?? 0) - 40);

    await page.getByRole("menuitem", { name: "Help", exact: true }).click();
    const [docs] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("menuitem", { name: "Documentation" }).click(),
    ]);
    expect(docs.url()).toMatch(/^https:\/\/ks250206\.github\.io\/OresmePro\/docs\//);
    await docs.close();
  });

  test("a dialog links its page of the documentation", async ({ app, page }) => {
    await app.run('op.display(op.make("y", [1.0, 2.0]))');
    await app.menu("Graph", "Modify Graph…");
    const help = page.getByRole("dialog", { name: /Modify Graph/ }).getByRole("link", {
      name: "Help",
    });
    await expect(help).toHaveAttribute(
      "href",
      "https://ks250206.github.io/OresmePro/docs/en/guides/graphs/",
    );
  });

  test("the search box narrows the waves, and the arrow keys walk them", async ({ app, page }) => {
    await app.run(`op.new_folder("run1")
op.make("run1:voltage", [1.0, 2.0], unit="V")
op.make("run1:current", [1.0, 2.0], unit="A")
op.make("temperature", [20.0], unit="K")`);
    const list = page.getByRole("listbox", { name: "Waves" });
    const rows = list.getByRole("option");
    await expect(rows).toHaveCount(3);

    const find = page.getByLabel("Find waves");
    await find.fill("run1");
    await expect(rows).toHaveCount(2);
    await find.fill("V");
    await expect(rows).toHaveText([/voltage/]);
    await find.fill("nothing");
    await expect(list).toContainText("No wave matches");
    await find.press("Escape");
    await expect(rows).toHaveCount(3);

    // Down from the box goes into the list at the first wave; the arrows move on.
    await find.fill("run1");
    await find.press("ArrowDown");
    await expect(list).toBeFocused();
    const selected = list.getByRole("option", { selected: true });
    await expect(selected).toHaveCount(1);
    const first = await selected.getAttribute("aria-label");
    await page.keyboard.press("ArrowDown");
    await expect(selected).not.toHaveAttribute("aria-label", first!);
    await page.keyboard.press("Shift+ArrowUp");
    await expect(selected).toHaveCount(2);
    await page.keyboard.press("Enter");
    await expect(app.window("Table0")).toBeVisible();
  });
});
