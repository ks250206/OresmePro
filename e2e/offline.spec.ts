import { expect, test } from "./fixtures";

test.describe("installed app", () => {
  test("starts and runs Python without a network after the first visit", async ({
    app,
    page,
    context,
  }) => {
    await app.run('w = op.make("kept", [1, 2, 3]); g = op.display(w)');
    // The service worker has everything a start needs: the app and Python.
    await expect
      .poll(() => page.evaluate(() => globalThis.oresme.offlineFiles ?? 0), { timeout: 60_000 })
      .toBeGreaterThan(20);
    await page.waitForTimeout(1500);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    expect((await app.doc()).order).toEqual(["kept"]);
    expect((await app.run('print(op.wave("kept").data.sum(), np.__version__ > "2")')).output).toBe(
      "6.0 True\n",
    );
    // What needs the network says so, and nothing else breaks.
    const missing = await app.run("import scipy");
    expect(missing.status).toBe("error");
    expect((await app.run("print(1 + 1)")).output).toBe("2\n");
    await context.setOffline(false);
  });

  test("can be installed: it has a manifest with icons", async ({ app, page }) => {
    void app;
    const manifest = await page.evaluate(async () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
      const data = (await (await fetch(link.href)).json()) as {
        name: string;
        display: string;
        icons: { src: string; sizes: string }[];
      };
      const sizes = await Promise.all(
        data.icons
          .filter((icon) => icon.src.endsWith(".png"))
          .map(async (icon) => {
            const bitmap = await createImageBitmap(
              await (await fetch(new URL(icon.src, link.href))).blob(),
            );
            return `${bitmap.width}x${bitmap.height}`;
          }),
      );
      return { name: data.name, display: data.display, sizes };
    });
    expect(manifest).toEqual({
      name: "OresmePro",
      display: "standalone",
      sizes: ["192x192", "512x512"],
    });
  });
});
