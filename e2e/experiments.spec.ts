import { App, expect, test } from "./fixtures";

const saving = (app: App) => app.page.getByRole("group", { name: "Saving" });

test.describe("experiments kept in the browser", () => {
  test("the status bar says when the experiment was saved, and a reload brings it back", async ({
    app,
    page,
  }) => {
    await expect(saving(app)).toHaveText("");
    await app.run('op.make("w", [1, 2, 3])');
    await expect(saving(app)).toHaveText(/^Saved \d/);
    await expect(page).toHaveTitle("Experiment — OresmePro");
    await page.reload();
    await expect.poll(async () => (await app.doc()).order).toEqual(["w"]);
    await expect(saving(app)).toHaveText(/^Saved \d/);
  });

  test("a second tab does not save until it is told to take over", async ({ app, page }) => {
    await app.run('op.make("first", [1])');
    await expect(saving(app)).toHaveText(/^Saved \d/);

    const second = new App(await page.context().newPage());
    await second.page.goto("/");
    await expect.poll(async () => (await second.doc()).order).toEqual(["first"]);
    await expect(saving(second)).toContainText("Open in another tab: not saved here");
    await expect(second.page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await second.run('op.make("second", [2])');
    // The first tab goes on saving, and the second tab's wave is not in what is saved.
    await app.run('op.make("more", [3])');
    await expect(saving(app)).toHaveText(/^Saved \d/);
    const third = new App(await page.context().newPage());
    await third.page.goto("/");
    await expect.poll(async () => (await third.doc()).order).toEqual(["first", "more"]);
    await third.page.close();

    // Told to, the second tab saves the experiment as it has it, and the first stops.
    await saving(second).getByRole("button", { name: "Save Here Instead" }).click();
    await expect(saving(second)).toHaveText(/^Saved \d/);
    await expect(saving(app)).toContainText("Open in another tab: not saved here");
    await second.page.reload();
    await expect.poll(async () => (await second.doc()).order).toEqual(["first", "second"]);
    await second.page.close();
  });

  test("a new experiment leaves the old one to be opened again, renamed or deleted", async ({
    app,
    page,
  }) => {
    await app.run('op.make("old", [1])');
    await expect(saving(app)).toHaveText(/^Saved \d/);
    await app.menu("File", "New Experiment");
    await expect(page).toHaveTitle("Untitled — OresmePro");
    await expect(page).toHaveURL(/#e=[a-z0-9]+$/);
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    expect((await app.doc()).order).toEqual([]);
    await app.run('op.make("new", [2])');
    await expect(saving(app)).toHaveText(/^Saved \d/);

    await app.menu("File", "Experiments…");
    const dialog = page.getByRole("dialog", { name: "Experiments" });
    await dialog.getByLabel("Name of this experiment").fill("Cell 3");
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(page).toHaveTitle("Cell 3 — OresmePro");
    const items = dialog.getByRole("listitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("Cell 3");
    await expect(items.nth(0)).toContainText("open in this tab");
    // The first experiment is as it was left.
    await items.filter({ hasText: "Experiment" }).getByRole("button", { name: "Open" }).click();
    await expect(page).toHaveTitle("Experiment — OresmePro");
    await expect.poll(async () => (await app.doc()).order).toEqual(["old"]);

    // A tab that names no experiment opens the one opened last.
    await page.goto("/");
    await expect.poll(async () => (await app.doc()).order).toEqual(["old"]);
    await app.menu("File", "Experiments…");
    const renamed = dialog.getByRole("listitem").filter({ hasText: "Cell 3" });
    page.once("dialog", (confirm) => void confirm.accept());
    await renamed.getByRole("button", { name: "Delete" }).click();
    await expect(dialog.getByRole("listitem")).toHaveCount(1);
  });

  test("the experiment can be taken back to the state it was opened in", async ({ app, page }) => {
    await app.run('op.make("kept", [1])');
    await expect(saving(app)).toHaveText(/^Saved \d/);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await app.run('op.wave("kept").kill(); op.make("mistake", [2])');
    await expect.poll(async () => (await app.doc()).order).toEqual(["mistake"]);
    await expect(saving(app)).toHaveText(/^Saved \d/);

    page.once("dialog", (confirm) => void confirm.accept());
    await app.menu("File", "Go Back to Opening State…");
    await expect.poll(async () => (await app.doc()).order).toEqual(["kept"]);
    expect((await app.wave("kept"))!.data).toEqual([1]);
    // What was gone back to is what is saved now.
    await expect(saving(app)).toHaveText(/^Saved \d/);
    await page.reload();
    await expect.poll(async () => (await app.doc()).order).toEqual(["kept"]);
  });
});
