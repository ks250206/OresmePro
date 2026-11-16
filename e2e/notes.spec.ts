import { expect, test } from "./fixtures";

test.describe("note windows", () => {
  test("a note is typed in Markdown and shown formatted as it is typed", async ({ app, page }) => {
    await app.menu("Windows", "New Note");
    expect((await app.lastEntry()).code).toBe("op.new_note()");
    const note = app.window("Note0");
    await expect(note.getByRole("radio", { name: "Split" })).toBeChecked();
    await note.getByRole("textbox", { name: "Note0 text" }).click();
    await page.keyboard.type("# Run 12\n\nPeak at **1.5** eV\n\n- baseline");
    const preview = note.getByRole("document", { name: "Note0 preview" });
    await expect(preview.getByRole("heading", { name: "Run 12" })).toBeVisible();
    await expect(preview.locator("strong")).toHaveText("1.5");
    await expect(preview.getByRole("listitem")).toHaveText("baseline");
    expect((await app.doc()).notes.Note0!.text).toBe(
      "# Run 12\n\nPeak at **1.5** eV\n\n- baseline",
    );

    await note.getByRole("radio", { name: "View" }).click();
    await expect(note.getByRole("textbox", { name: "Note0 text" })).toBeHidden();
    await note.getByRole("radio", { name: "Edit" }).click();
    await expect(preview).toBeHidden();

    // Python sees and changes the same text.
    await app.run('op.note("Note0").append("Fit by [lmfit](https://lmfit.github.io/)")');
    await note.getByRole("radio", { name: "View" }).click();
    const link = preview.getByRole("link", { name: "lmfit" });
    await expect(link).toHaveAttribute("href", "https://lmfit.github.io/");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("nothing in a note runs, restyles the app or loads from elsewhere", async ({
    app,
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("evil.example")) requests.push(request.url());
    });
    const text = [
      "<script>window.pwned = 1</script>",
      '<img src="https://evil.example/a.png" onerror="window.pwned = 2">',
      '<style>body { display: none }</style><div style="position:fixed;inset:0">cover</div>',
      "",
      "[js](javascript:window.pwned=3) [local](#top)",
      "",
      "![pixel](https://evil.example/pixel.png)",
      "",
      "![dot](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)",
    ].join("\n");
    await app.run(`op.new_note("evil", ${JSON.stringify(text)})`);
    const preview = app.window("evil").getByRole("document", { name: "evil preview" });
    await expect(preview).toContainText("<script>window.pwned = 1</script>");
    await expect(preview.getByRole("link", { name: "Picture: pixel" })).toHaveAttribute(
      "href",
      "https://evil.example/pixel.png",
    );
    // Only the picture whose data is in the text is shown.
    await expect(preview.locator("img")).toHaveCount(1);
    await expect(preview.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
    expect(
      await preview.evaluate((element) => ({
        tags: [...new Set([...element.querySelectorAll("*")].map((node) => node.tagName))].sort(),
        handlers: [...element.querySelectorAll("*")].flatMap((node) =>
          [...node.attributes]
            .map((attribute) => attribute.name)
            .filter((name) => name.startsWith("on")),
        ),
        styled: element.querySelectorAll("[style]").length,
        hrefs: [...element.querySelectorAll("a")].map((node) => node.getAttribute("href")),
      })),
    ).toEqual({
      tags: ["A", "IMG", "P"],
      handlers: [],
      styled: 0,
      // The address written in the <img> is text, made a link like any other address.
      hrefs: ["https://evil.example/a.png", "https://evil.example/pixel.png"],
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined();
    expect(requests).toEqual([]);
    await expect(page.locator("body")).toBeVisible();
  });

  test("a note is saved with the experiment and exported as Markdown", async ({ app, page }) => {
    await app.run('op.new_note("log", "# Kept")');
    const { bytes } = await app.download(() =>
      app
        .window("log")
        .getByRole("document", { name: "log preview" })
        .click({ button: "right" })
        .then(() => page.getByRole("menuitem", { name: "Export as log.md" }).click()),
    );
    expect(bytes.toString("utf8")).toBe("# Kept");
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    await expect(app.window("log").getByRole("heading", { name: "Kept" })).toBeVisible();
  });
});
