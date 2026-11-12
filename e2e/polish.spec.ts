import { expect, test, type App } from "./fixtures";

/** A graph of two curves at a known place and size. */
async function pairGraph(app: App): Promise<void> {
  await app.run(`t = np.linspace(0, 10, 200)
upper = op.make("upper", np.sin(t) + 2, dx=t[1] - t[0])
lower = op.make("lower", np.sin(t) + 1, dx=t[1] - t[0])
g = op.display(upper, lower)`);
  await app.place("Graph0", 20, 16, 480, 340);
}

/** Where a graph's canvas is on the page. */
async function graphBox(app: App, name: string) {
  return (await app.window(name).locator("canvas").boundingBox())!;
}

test.describe("annotations", () => {
  test("a legend is dragged to another place, and that is recorded once", async ({ app, page }) => {
    await pairGraph(app);
    await app.run("leg = g.legend()");
    const box = await graphBox(app, "Graph0");
    // The legend sits in the top right corner of the plot area.
    const from = { x: box.x + box.width - 50, y: box.y + 30 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 150, from.y + 120, { steps: 8 });
    await page.mouse.up();
    const legend = (await app.doc()).graphs.Graph0!.annotations[0]!;
    expect(legend.x).toBeLessThan(-0.3);
    expect(legend.y).toBeGreaterThan(0.3);
    // Not a marquee: no zoom menu came up.
    await expect(page.getByRole("menuitem", { name: "Expand", exact: true })).toHaveCount(0);
    await expect
      .poll(async () => (await app.lastEntry()).code)
      .toBe(`op.graph("Graph0").annotation("legend0").set(x=${legend.x}, y=${legend.y})`);
    expect(
      (await app.entries()).filter((entry) => entry.code.includes("annotation(")),
    ).toHaveLength(1);
    expect((await app.run("print(leg.x, leg.y)")).output).toBe(`${legend.x} ${legend.y}\n`);

    // One undo puts it back.
    await app
      .window("Graph0")
      .locator("canvas")
      .click({ position: { x: 240, y: 300 } });
    await page.keyboard.press("Control+z");
    expect((await app.doc()).graphs.Graph0!.annotations[0]).toMatchObject({ x: 0, y: 0 });
  });

  test("a tag is added to a point of a trace and edited", async ({ app, page }) => {
    await pairGraph(app);
    const box = await graphBox(app, "Graph0");
    const onTrace = (await app.findInGraph("Graph0", { color: "red", minRun: 0.4, maxRun: 4 }))!;
    await page.mouse.click(box.x + onTrace.x, box.y + onTrace.y, { button: "right" });
    await page.getByRole("menuitem", { name: /^Add Tag at upper\[\d+\]$/ }).click();
    const tag = (await app.doc()).graphs.Graph0!.annotations[0]!;
    expect(tag).toMatchObject({ kind: "tag", trace: "upper", name: "tag0" });
    expect((await app.lastEntry()).code).toBe(`op.graph("Graph0").tag("upper", ${tag.point})`);

    // Put the box straight above its point, then double-click it to change its text.
    await app.run(`tag = g.annotation("tag0"); tag.set(x=0, y=-0.2)`);
    // Its frame is the one outlined rectangle in the picture.
    const svg = (await app.run("print(g.svg())")).output;
    const rect =
      /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#ffffff" stroke="#000000"/.exec(
        svg,
      )!;
    const [left, top, width, height] = rect.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    await page.mouse.dblclick(box.x + left + width / 2, box.y + top + height / 2);
    const dialog = page.getByRole("dialog", { name: /Modify tag0/ });
    await dialog.getByLabel("Text").fill("peak {y}");
    await dialog.getByLabel("Frame").uncheck();
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.annotations[0]).toMatchObject({
      text: "peak {y}",
      frame: false,
    });
    expect((await app.run("print('peak ' in g.svg())")).output).toBe("True\n");

    // The tag goes when its trace does.
    await app.run('g.remove("upper")');
    expect((await app.doc()).graphs.Graph0!.annotations).toEqual([]);
  });
});

test.describe("text formatting", () => {
  test("a text box takes Igor's codes, typed or from the buttons", async ({ app, page }) => {
    await pairGraph(app);
    await app.menu("Graph", "Add Text…");
    const dialog = page.getByRole("dialog", { name: /Add Text/ });
    const text = dialog.getByLabel("Text");
    await expect(text).toBeFocused();
    await text.fill("\\Z20Big\\M and ");
    await text.press("End");
    await dialog.getByLabel("Insert size").selectOption("8");
    await text.pressSequentially("small");
    await expect(text).toHaveValue("\\Z20Big\\M and \\Z08small\\M");
    await app.doIt();
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").textbox("\\\\Z20Big\\\\M and \\\\Z08small\\\\M", anchor="RT", frame=True)',
    );
    const svg = (await app.run("print(g.svg())")).output;
    expect(svg).toMatch(/font-size="20"[^>]*>Big</);
    expect(svg).toMatch(/font-size="12"[^>]*> and </);
    expect(svg).toMatch(/font-size="8"[^>]*>small</);
    // Big text and small text share one baseline.
    const y = (word: string) => new RegExp(`y="([\\d.]+)"[^>]*>${word}<`).exec(svg)![1];
    expect(y("Big")).toBe(y("small"));
  });
});

test.describe("axis and trace options", () => {
  test("an axis is reversed and given a tick step and label format", async ({ app, page }) => {
    await pairGraph(app);
    await app.menu("Graph", "Modify Axis…");
    const dialog = page.getByRole("dialog", { name: /Modify Axis/ });
    await dialog.getByLabel("Axis", { exact: true }).selectOption("bottom");
    await dialog.getByLabel("Reversed").check();
    await dialog.getByLabel("Tick step").fill("2.5");
    await dialog.getByLabel("Tick labels").selectOption(".1f");
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.axes.bottom).toMatchObject({
      reverse: true,
      tickStep: 2.5,
      tickFormat: ".1f",
    });
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").axis("bottom").set(reverse=True, tick_format=".1f", tick_step=2.5)',
    );
    const svg = (await app.run("print(g.svg())")).output;
    for (const label of ["0.0", "2.5", "5.0", "7.5", "10.0"]) expect(svg).toContain(`>${label}<`);
    // Reversed: 10 is drawn to the left of 0.
    const at = (label: string) =>
      Number(new RegExp(`<text x="([\\d.]+)"[^>]*>${label}<`).exec(svg)![1]);
    expect(at("10.0")).toBeLessThan(at("0.0"));
  });

  test("a trace is filled to the next one and shifted", async ({ app, page }) => {
    await pairGraph(app);
    await app.menu("Graph", "Modify Trace Appearance…");
    const dialog = page.getByRole("dialog", { name: /Modify Trace Appearance/ });
    await dialog.getByLabel("Fill", { exact: true }).selectOption("next");
    await dialog.getByLabel("Fill opacity").fill("40");
    await dialog.getByLabel("Y offset").fill("0.5");
    await app.doIt();
    expect((await app.doc()).graphs.Graph0!.traces[0]).toMatchObject({
      fill: "next",
      fillOpacity: 0.4,
      yOffset: 0.5,
    });
    expect((await app.lastEntry()).code).toBe(
      'op.graph("Graph0").trace("upper").set(fill="next", y_offset=0.5, fill_opacity=0.4)',
    );
    const svg = (await app.run("print(g.svg())")).output;
    expect(svg).toContain('<polygon points="');
    expect(svg).toContain('fill-opacity="0.4"');
    // The band shows on screen: light red between the two curves.
    const tinted = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-window="Graph0"] canvas')!;
      const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      let count = 0;
      for (let at = 0; at < data.length; at += 4) {
        if (data[at]! > 250 && data[at + 1]! > 130 && data[at + 1]! < 175 && data[at + 2]! > 130) {
          count += 1;
        }
      }
      return count;
    });
    expect(tinted).toBeGreaterThan(2000);
  });
});

test.describe("time zone", () => {
  test("dates are shown and typed on the clock of the chosen zone", async ({ app, page }) => {
    await app.drop([
      { name: "log.csv", content: "time,value\n2026-01-15T00:00:00Z,1\n2026-01-15T12:00:00Z,2\n" },
    ]);
    await expect.poll(async () => (await app.doc()).order).toEqual(["time", "value"]);
    const grid = page.getByRole("grid", { name: "Table0" });
    const cells = grid.getByRole("gridcell");
    await expect(cells.nth(2)).toHaveText("2026-01-15 12:00:00");

    await app.menu("Data", "Time Zone for Dates…");
    const dialog = page.getByRole("dialog", { name: "Time Zone for Dates" });
    await dialog.getByLabel("Time zone").selectOption("other");
    await dialog.getByLabel("Zone name").fill("Asia/Tokyo");
    await app.doIt();
    expect((await app.lastEntry()).code).toBe('op.set_time_zone("Asia/Tokyo")');
    await expect(cells.nth(2)).toHaveText("2026-01-15 21:00:00");
    // The wave itself is the same moment as before.
    expect((await app.wave("time"))!.data[1]).toBe(Date.UTC(2026, 0, 15, 12) / 1000);

    // A time typed into the table is on Tokyo's clock too.
    await cells.nth(2).click();
    await page.keyboard.type("2026-01-15 22:30");
    await page.keyboard.press("Enter");
    expect((await app.wave("time"))!.data[1]).toBe(Date.UTC(2026, 0, 15, 13, 30) / 1000);

    await app.run('g = op.display("value", x="time")');
    expect((await app.run("print('Asia/Tokyo' in g.svg(), op.time_zone())")).output).toBe(
      "True Asia/Tokyo\n",
    );
  });
});
