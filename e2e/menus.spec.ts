import { expect, test } from "./fixtures";

const TITLES = ["File", "Edit", "Data", "Analysis", "Graph", "Layout", "Windows", "Python", "Help"];

test.describe("the desktop's context menu", () => {
  test("gives the menu bar's commands; a graph keeps its own menu", async ({ app, page }) => {
    await app.run("g = op.display(np.sin(np.linspace(0, 6, 50)))");
    await app.place("Graph0", 20, 16, 360, 260);
    // Something to keep the keyboard focus on while the menu is used.
    await app.commandLine.click();
    const desktop = page.locator("[data-desktop]");
    const box = (await desktop.boundingBox())!;

    await desktop.click({ button: "right", position: { x: box.width - 60, y: box.height - 40 } });
    const menu = page.getByRole("menu").first();
    for (const title of TITLES) {
      await expect(menu.getByRole("menuitem", { name: title, exact: true })).toBeVisible();
    }
    await expect(app.commandLine).toBeFocused();

    // Hovering opens a menu with the menu bar's states and shortcuts.
    await menu.getByRole("menuitem", { name: "Graph", exact: true }).hover();
    const graphMenu = page.getByRole("menu").nth(1);
    await expect(graphMenu.getByRole("menuitem", { name: /^Autoscale Axes/ })).toContainText(/A$/);
    await expect(graphMenu.getByRole("menuitem", { name: /^Add Color Scale/ })).toBeDisabled();
    // Opened near the bottom right corner, it is kept inside the window.
    const viewport = page.viewportSize()!;
    const shown = (await graphMenu.boundingBox())!;
    expect(shown.x + shown.width).toBeLessThanOrEqual(viewport.width);
    expect(shown.y + shown.height).toBeLessThanOrEqual(viewport.height);

    // Clicking a menu that hovering has opened keeps it open.
    const data = menu.getByRole("menuitem", { name: "Data", exact: true });
    await data.hover();
    await data.click();
    await page.getByRole("menuitem", { name: "Make Waves…" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    const dialog = page.getByRole("dialog", { name: "Make Waves" });
    await dialog.getByLabel("Names").fill("fromDesktop");
    await app.doIt();
    expect((await app.doc()).order).toContain("fromDesktop");
    expect((await app.lastEntry()).code).toBe('op.make("fromDesktop")');

    await app
      .window("Graph0")
      .locator("canvas")
      .click({ button: "right", position: { x: 200, y: 100 } });
    const graphOwn = page.getByRole("menu").first();
    await expect(graphOwn.getByRole("menuitem", { name: "Modify Graph…" })).toBeVisible();
    await expect(graphOwn.getByRole("menuitem", { name: "Data", exact: true })).toHaveCount(0);
  });

  test("a submenu near the right edge opens to the left", async ({ app, page }) => {
    await app.run("g = op.display(np.sin(np.linspace(0, 6, 50)))");
    const viewport = page.viewportSize()!;
    const desktop = (await page.locator("[data-desktop]").boundingBox())!;
    // The graph's right edge at the right of the window.
    await app.place("Graph0", desktop.width - 380, 16, 370, 280);
    await app
      .window("Graph0")
      .locator("canvas")
      .click({ button: "right", position: { x: 330, y: 100 } });
    const menu = page.getByRole("menu").first();
    await menu.getByRole("menuitem", { name: "Apply Style" }).hover();
    const styles = (await page.getByRole("menu").nth(1).boundingBox())!;
    const parent = (await menu.boundingBox())!;
    expect(styles.x + styles.width).toBeLessThanOrEqual(viewport.width);
    expect(styles.x).toBeLessThan(parent.x);
  });
});
