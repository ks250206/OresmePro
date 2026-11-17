import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

/** The example plugin that draws ternary diagrams. */
const TERNARY = fileURLToPath(new URL("../examples/plugins/ternary", import.meta.url));

test.describe("the example plugin ternary", () => {
  test.describe.configure({ timeout: 240_000 });

  test("draws a ternary diagram from the sandbox: text waves, text markers and a graph it asked for", async ({
    app,
    page,
  }) => {
    await app.run(
      [
        'op.make("SiO2", [50.0, 70, 20])',
        'op.make("Al2O3", [25.0, 10, 30])',
        'op.make("CaO", [25.0, 20, 50])',
      ].join("\n"),
    );
    await app.menu("Python", "Plugins…");
    await page.getByLabel("Plugin folder").setInputFiles(TERNARY);
    const approval = page.getByRole("dialog", { name: "Install Plugin" });
    await expect(approval).toContainText("Ternary Diagram 0.3.0");
    await approval.getByRole("button", { name: "Install" }).click();
    const dialog = page.getByRole("dialog", { name: "Plugins" });
    await expect(
      dialog.getByRole("option", { name: "Ternary Diagram", exact: true }).first(),
    ).toBeVisible();

    const run = await app.run(
      [
        'r = op.invoke("plugin.ternary.ternary", {"a": "SiO2", "b": "Al2O3", "c": "CaO", "names": "SiO2, Al2O3, CaO", "legend": "Samples"})',
        "print(r)",
      ].join("\n"),
    );
    expect(run.status, run.output).toBe("ok");
    const made = await page.evaluate(() => {
      const state = globalThis.oresme.doc.getState();
      const graph = state.graphs.Ternary0;
      return {
        traces: graph?.traces.map((trace) => trace.textMarker).filter(Boolean),
        corners: state.waves.SiO2_corner_text?.text,
        legend: graph?.annotations.map((item) => item.text),
        window: state.windows.at(-1)?.name,
      };
    });
    expect(made).toEqual({
      traces: ["SiO2_a_label", "SiO2_b_label", "SiO2_c_label", "SiO2_corner_text"],
      corners: ["SiO2", "Al2O3", "CaO"],
      legend: ["\\s(SiO2_y) Samples"],
      window: "Ternary0",
    });
    const svg = (await app.run('print(op.graph("Ternary0").svg())')).output;
    for (const word of [">SiO2<", ">Al2O3<", ">CaO<", ">100<", ">Samples<"]) {
      expect(svg).toContain(word);
    }

    // Its panel draws one too, from the waves and settings chosen in it.
    await dialog.getByRole("option", { name: "Ternary Diagram", exact: true }).first().click();
    await dialog.getByRole("button", { name: "Add Panels to Experiment" }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().panels)))
      .toEqual(["TernaryDiagram"]);
    await dialog.getByRole("button", { name: "Close" }).first().click();
    const panel = app.window("TernaryDiagram");
    await panel.getByLabel("A (top)").selectOption("SiO2");
    await panel.getByLabel("B (bottom right)").selectOption("Al2O3");
    await panel.getByLabel("C (bottom left)").selectOption("CaO");
    await panel.getByLabel("Tick labels").selectOption("counterclockwise");
    await panel.getByRole("button", { name: "Draw", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().graphs)))
      .toEqual(["Ternary0", "Ternary1"]);
    await expect(panel.getByRole("alert")).toHaveCount(0);

    // A text wave goes into the sandbox as the group, and each group is drawn on its own.
    // The graphs drawn so far are closed, so that they do not cover the panel.
    await app.run(
      [
        'op.make("phase", ["glass", "crystal", "glass"])',
        'op.close_window("Ternary0")',
        'op.close_window("Ternary1")',
      ].join("\n"),
    );
    await panel.getByRole("combobox", { name: "Group", exact: true }).selectOption("phase");
    await panel.getByLabel("Group markers").fill("circle, square");
    await panel.getByLabel("Group markers").press("Enter");
    await panel.getByLabel("Group colors").fill("red, blue");
    await panel.getByLabel("Group colors").press("Enter");
    await panel.getByRole("button", { name: "Draw", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => Object.keys(globalThis.oresme.doc.getState().graphs)))
      .toEqual(["Ternary0", "Ternary1", "Ternary2"]);
    await expect(panel.getByRole("alert")).toHaveCount(0);
    const grouped = await page.evaluate(() => {
      const graph = globalThis.oresme.doc.getState().graphs.Ternary2!;
      return {
        points: graph.traces
          .filter((trace) => /_g\d+_y$/.test(trace.y))
          .map((trace) => [trace.y, trace.marker, trace.color]),
        legend: graph.annotations.map((item) => item.text),
      };
    });
    expect(grouped.points).toHaveLength(2);
    expect(grouped.points.map(([, marker, color]) => [marker, color])).toEqual([
      ["circle", "#ff0000"],
      ["square", "#0000ff"],
    ]);
    expect(grouped.legend[0]).toMatch(/\\s\(\S+_g0_y\) glass\n\\s\(\S+_g1_y\) crystal/);
  });
});
