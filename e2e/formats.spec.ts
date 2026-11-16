import { expect, test, type App } from "./fixtures";

/**
 * Has Python write a file with the package that reads it (pyarrow, h5py) and
 * hands back its bytes, leaving nothing behind in the experiment: the test
 * then brings the file in as a user would.
 */
async function written(app: App, code: string, path: string): Promise<number[]> {
  const entry = await app.run(code);
  expect(entry.status, entry.output).toBe("ok");
  const bytes = await app.page.evaluate(
    (name) => Array.from(globalThis.oresme.files.get(name)!.bytes),
    path,
  );
  await app.run(`import os; os.remove(${JSON.stringify(path)})`);
  return bytes;
}

test.describe("loading Parquet and HDF5 files", () => {
  test("a dropped Parquet file loads with Python, kept with the experiment, as one step", async ({
    app,
    page,
  }) => {
    const content = await written(
      app,
      [
        "import pyarrow as pa, pyarrow.parquet as pq",
        'pq.write_table(pa.table({"t (s)": [0.0, 0.5, 1.0], "n": pa.array([1, None, 3], type=pa.int16()), "tag": ["a", "b", None]}), "made.parquet")',
      ].join("\n"),
      "made.parquet",
    );
    await app.drop([{ name: "run.parquet", content }]);
    await expect.poll(async () => (await app.doc()).order).toEqual(["t_s", "n", "tag"]);
    await app.idle();
    // The history has the line that loads it again, and the file is kept for it.
    expect((await app.lastEntry()).code).toBe('op.load_parquet("run.parquet")');
    expect(Object.keys(await app.files())).toEqual(["run.parquet"]);
    expect((await app.wave("n"))!.data).toEqual([1, Number.NaN, 3]);
    expect((await app.wave("tag"))!.text).toEqual(["a", "b", ""]);
    const note = await page.evaluate(() => globalThis.oresme.doc.getState().waves.n!.note);
    expect(note).toMatch(
      /^Loaded from run\.parquet \(SHA-256 [0-9a-f]{64}\): Parquet column 'n', int16\./,
    );
    expect(note).toContain("1 missing value (null) is NaN.");
    expect(Object.keys((await app.doc()).tables)).toEqual(["Table0"]);

    await page.getByRole("complementary", { name: "Data Browser" }).getByText("root").click();
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await app.doc()).order).toEqual([]);
    expect((await app.doc()).tables).toEqual({});
  });

  test("an HDF5 file chosen from the File menu loads its groups as data folders", async ({
    app,
    page,
  }) => {
    const content = await written(
      app,
      [
        "import h5py",
        'with h5py.File("made.h5", "w") as f:',
        '    d = f.create_dataset("scan 1/image", data=np.arange(6, dtype=np.int32).reshape(2, 3))',
        '    d.attrs["units"] = "counts"',
        '    f["labels"] = np.array([b"x", b"y"])',
      ].join("\n"),
      "made.h5",
    );
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      app.menu("Data", "Load Parquet or HDF5 Files…"),
    ]);
    await chooser.setFiles({
      name: "beam.h5",
      mimeType: "application/x-hdf5",
      buffer: Buffer.from(content),
    });
    await expect.poll(async () => (await app.doc()).order).toEqual(["labels", "scan_1:image"]);
    await app.idle();
    expect((await app.lastEntry()).code).toBe('op.load_hdf5("beam.h5")');
    expect((await app.doc()).folders).toEqual(["scan_1"]);
    expect(await app.wave("scan_1:image")).toMatchObject({
      shape: [2, 3],
      data: [0, 1, 2, 3, 4, 5],
      unit: "counts",
    });
    expect((await app.wave("labels"))!.text).toEqual(["x", "y"]);
    expect(Object.keys(await app.files())).toEqual(["beam.h5"]);
  });
});
