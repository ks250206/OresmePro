import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../core/doc/doc";
import type { PlotDimension } from "../core/doc/types";
import { plotSideDraft, plotSideOf } from "./PlotSizeFields";

function graphWith(width: PlotDimension, height: PlotDimension) {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "y", data: Float64Array.from([1, 2, 3]) });
  doc.dispatch({ op: "display", y: ["y"], name: "G" });
  doc.dispatch({ op: "modifyGraph", graph: "G", props: { width, height } });
  return doc.getState().graphs.G!;
}

describe("the plot area fields of Modify Graph", () => {
  it.each<[string, PlotDimension, PlotDimension]>([
    [
      "a length at its limit, in inches",
      { mode: "absolute", value: 3000 / 72, unit: "inch" },
      { mode: "auto" },
    ],
    [
      "a length of many digits",
      { mode: "absolute", value: 8.123456, unit: "cm" },
      { mode: "aspect", factor: 0.61803398875 },
    ],
    [
      "a plan's factor",
      { mode: "plan", factor: 1.0000123, hAxis: "bottom", vAxis: "left" },
      { mode: "auto" },
    ],
    [
      "a length per unit",
      { mode: "perUnit", value: 0.123456789, unit: "cm", axis: "bottom" },
      { mode: "auto" },
    ],
  ])("give back %s exactly, so opening and pressing Do It changes nothing", (_, width, height) => {
    const graph = graphWith(width, height);
    expect(plotSideOf(plotSideDraft(graph, "width", 300))).toEqual(graph.width);
    expect(plotSideOf(plotSideDraft(graph, "height", 200))).toEqual(graph.height);
  });

  it("round the length offered for a side that is not Absolute yet", () => {
    const graph = graphWith({ mode: "auto" }, { mode: "auto" });
    expect(plotSideDraft(graph, "width", 302.3456).value).toBe("8");
  });
});
