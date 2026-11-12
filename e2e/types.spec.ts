import { readFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

/** A wave's type and both parts of its values, read from the document. */
const waveOf = (page: import("@playwright/test").Page, name: string) =>
  page.evaluate((key) => {
    const wave = globalThis.oresme.doc.getState().waves[key]!;
    return {
      type: wave.type,
      array: wave.data.constructor.name,
      data: Array.from(wave.data),
      imag: wave.imag ? Array.from(wave.imag) : null,
    };
  }, name);

test.describe("wave types", () => {
  test("waves keep their number type through edits, a reload and a type change", async ({
    app,
    page,
  }) => {
    await app.run(
      [
        'counts = op.make("counts", np.array([10, 20, 30], dtype=np.uint16))',
        'z = op.make("z", np.array([1 + 2j, 3 - 4j]))',
        "t = op.edit(counts, z)",
      ].join("\n"),
    );
    expect(await waveOf(page, "counts")).toMatchObject({ type: "uint16", array: "Uint16Array" });
    const grid = page.getByRole("grid", { name: "Table0" });
    // A complex wave has a column for each part.
    await expect(grid.getByRole("columnheader")).toHaveText([
      "Point",
      "counts",
      "z.real",
      "z.imag",
    ]);
    const cells = grid.getByRole("gridcell");
    await expect(cells.nth(2)).toHaveText("2");

    // Typing into the imaginary column changes only that part.
    await cells.nth(2).click();
    await page.keyboard.type("7.5");
    await page.keyboard.press("Enter");
    expect(await waveOf(page, "z")).toMatchObject({ data: [1, 3], imag: [7.5, -4] });
    expect((await app.lastEntry()).code).toBe('op.wave("z")[0] = complex(1, 7.5)');
    expect((await app.run("print(z.data.tolist(), z.dtype)")).output).toBe(
      "[(1+7.5j), (3-4j)] complex128\n",
    );

    // What is typed into an integer wave is rounded, and held within its range.
    await cells.nth(0).click();
    await page.keyboard.type("70000.4");
    await page.keyboard.press("Enter");
    expect((await waveOf(page, "counts")).data).toEqual([65535, 20, 30]);

    await page.getByRole("option", { name: "counts", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Data Browser" })).toContainText(
      "Typeuint16",
    );
    await app.menu("Data", "Change Wave Type…");
    const dialog = page.getByRole("dialog", { name: /Change Wave Type/ });
    await dialog.getByLabel("Type").selectOption("float32");
    await app.doIt();
    expect((await app.lastEntry()).code).toBe('op.wave("counts").redimension("float32")');
    expect(await waveOf(page, "counts")).toMatchObject({ type: "float32", array: "Float32Array" });

    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByText("Python ready")).toBeVisible({ timeout: 60_000 });
    expect(await waveOf(page, "counts")).toMatchObject({ type: "float32", data: [65535, 20, 30] });
    expect(await waveOf(page, "z")).toMatchObject({ type: "complex128", imag: [7.5, -4] });
    expect(
      (await app.run('print(op.wave("z").data.tolist(), op.wave("counts").dtype)')).output,
    ).toBe("[(1+7.5j), (3-4j)] float32\n");
  });

  test("a spectrum is kept complex and plotted by magnitude", async ({ app, page }) => {
    await app.run(
      'tt = np.arange(256) / 256\nsig = op.make("sig", np.sin(2 * np.pi * 8 * tt), x0=0, dx=1 / 256, x_unit="s")',
    );
    await app.menu("Analysis", "FFT…");
    await page.getByRole("dialog", { name: "FFT" }).getByLabel("Result").selectOption("complex");
    await app.doIt();
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.fft("sig", output="complex")');
    const spectrum = await waveOf(page, "sig_FFT");
    expect(spectrum.type).toBe("complex128");
    expect(spectrum.data).toHaveLength(129);
    // A sine is all in the imaginary part of its own frequency.
    expect(spectrum.imag![8]).toBeCloseTo(-128, 6);

    await app.run('g = op.display("sig_FFT")');
    await app.menu("Graph", "Modify Trace Appearance…");
    const dialog = page.getByRole("dialog", { name: /Modify Trace Appearance/ });
    await dialog.getByLabel("Complex part").selectOption("magnitude");
    await app.doIt();
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").trace("sig_FFT").set(part="magnitude")',
    );
    // The axis now runs to the height of the peak.
    expect(
      (await app.run("print(round(max(float(v) for v in abs(op.wave('sig_FFT').data))))")).output,
    ).toBe("128\n");
    expect((await app.run('print(np.allclose(op.ifft("sig_FFT").data, sig.data))')).output).toBe(
      "True\n",
    );
  });
});

test.describe("Excel workbooks", () => {
  test("a dropped workbook becomes waves and a table for each sheet", async ({ app, page }) => {
    const bytes = await readFile(new URL("../src/core/io/testdata/excel.xlsx", import.meta.url));
    await app.drop([{ name: "bench.xlsx", content: [...bytes] }]);
    await expect
      .poll(async () => (await app.doc()).order)
      .toEqual([
        "time",
        "temp_C",
        "sample",
        "count",
        "ok",
        "double",
        "day",
        "column0",
        "column1",
        "column2",
      ]);
    const doc = await app.doc();
    expect(Object.keys(doc.tables)).toEqual(["Table0", "Table1"]);
    expect(doc.tables.Table0!.columns).toHaveLength(7);
    expect((await app.wave("temp_C"))!.data).toEqual([20.5, 21.25, 0.3]);
    expect((await app.wave("sample"))!.text).toEqual(["alpha", "β & <tag>", "試料 3"]);
    expect((await app.wave("time"))!).toMatchObject({
      unit: "dat",
      data: [9, 9.5, 10].map((hour) => Date.UTC(2026, 0, 15) / 1000 + hour * 3600),
    });
    expect((await app.wave("column1"))!.data).toEqual([2, 5]);
    await expect(
      page.getByRole("grid", { name: "Table0" }).getByRole("gridcell").first(),
    ).toHaveText("2026-01-15 09:00:00");
    expect((await app.lastEntry()).code).toContain("Run 1: time, temp_C, sample");
    // The whole workbook is one step to undo.
    await page.getByRole("complementary", { name: "Data Browser" }).getByText("root").click();
    await page.keyboard.press("Control+z");
    expect((await app.doc()).order).toEqual([]);
  });

  test("a file that is not a workbook is refused with a reason", async ({ app, page }) => {
    await app.drop([{ name: "old.xls", content: [0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3] }]);
    await expect(page.getByRole("alert")).toContainText("have to be saved as .xlsx");
  });
});
