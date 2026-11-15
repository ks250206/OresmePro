import { expect, test } from "./fixtures";

test.describe("actions", () => {
  test("the main thread calls an analysis by name, after the code before it, and sees it in the history", async ({
    app,
    page,
  }) => {
    await app.idle();
    const ids = await page.evaluate(() =>
      globalThis.oresme.kernel.getActions().map((spec) => spec.id),
    );
    expect(ids).toContain("core.fit");
    expect(ids).toContain("core.histogram");

    // The wave is made by code still running when the call is sent: the call waits for it.
    const result = await page.evaluate(() => {
      const { kernel } = globalThis.oresme;
      kernel.execute(
        'import time\ntime.sleep(0.3)\nx = np.linspace(-5, 5, 201)\nop.make("sig", 1 + 3 * np.exp(-((x - 1) / 0.8) ** 2), x0=-5, dx=0.05)',
      );
      return kernel.invoke("core.fit", { function: "gauss", y: "sig" });
    });
    expect(result).toMatchObject({ result: "Fit0", wave: { wave: "fit_sig" }, converged: true });
    expect((result as { coef: { x0: number } }).coef.x0).toBeCloseTo(1, 6);
    const entry = await app.lastEntry();
    expect(entry.code).toBe('op.fit("gauss", op.wave("sig"))');
    expect(entry.source).toBe("gui");
    expect(entry.status).toBe("ok");
    expect(entry.output).toMatch(/Fit: gauss\(sig\)/);
  });

  test("a refused call rejects with the reason and changes nothing", async ({ app, page }) => {
    await app.run('op.make("w", [1.0, 2.0, 3.0])');
    const before = await page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().waves));
    const error = await page.evaluate(() =>
      globalThis.oresme.kernel.invoke("core.smooth", { wave: "w", n: "five" }).then(
        () => null,
        (reason: Error) => reason.message,
      ),
    );
    expect(error).toBe("OresmeError: core.smooth: n must be a number, not 'five'.");
    const entry = await app.lastEntry();
    expect(entry.code).toBe('op.invoke("core.smooth", {"wave": "w", "n": "five"})');
    expect(entry.status).toBe("error");
    expect(await page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().waves))).toEqual(
      before,
    );
  });

  test("an action a procedure registers reaches the main thread", async ({ app, page }) => {
    await page.evaluate(() => {
      const { kernel } = globalThis.oresme;
      (globalThis as { actionsChanged?: number }).actionsChanged = 0;
      kernel.subscribeActions(() => {
        (globalThis as { actionsChanged?: number }).actionsChanged! += 1;
      });
    });
    await app.run(
      [
        '@op.action("lab.double", title="Double", params={"wave": {"type": "wave"}})',
        "def double(wave):",
        '    return op.make(wave.name + "_2", wave.data * 2)',
        'op.make("v", [1.0, 2.0])',
      ].join("\n"),
    );
    expect(
      await page.evaluate(() => (globalThis as { actionsChanged?: number }).actionsChanged),
    ).toBe(1);
    const spec = await page.evaluate(() =>
      globalThis.oresme.kernel.getActions().find((item) => item.id === "lab.double"),
    );
    expect(spec).toMatchObject({ title: "Double", params: { wave: { type: "wave" } } });
    const result = await page.evaluate(() =>
      globalThis.oresme.kernel.invoke("lab.double", { wave: "v" }),
    );
    expect(result).toEqual({ wave: "v_2" });
    expect((await app.wave("v_2"))!.data).toEqual([2, 4]);
  });
});
