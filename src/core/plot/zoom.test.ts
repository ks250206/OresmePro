import { describe, expect, it } from "vite-plus/test";
import type { AxisGeometry } from "./layout";
import { makeScale } from "./scale";
import { marqueeZoom, panBy, tidy, zoomAbout } from "./zoom";

const hit = { x: 0, y: 0, w: 0, h: 0 };
// A 100x100 plot at the origin: X runs 0..10 left to right, Y 0..1 bottom to top.
const axes: Record<"bottom" | "left", AxisGeometry> = {
  bottom: { scale: makeScale(0, 10, false, 0, 100), hit, unit: "" },
  left: { scale: makeScale(0, 1, false, 100, 0), hit, unit: "" },
};
const range = (commands: ReturnType<typeof marqueeZoom>, axis: string) => {
  const command = commands.find((item) => item.op === "modifyAxis" && item.axis === axis);
  return command?.op === "modifyAxis" ? [command.props.min, command.props.max] : null;
};

describe("tidy", () => {
  it("keeps only the digits that matter at the given span", () => {
    expect(tidy(0.12340000000000001, 1)).toBe(0.1234);
    expect(tidy(1234.5678, 1000)).toBe(1234.6);
    expect(tidy(1000.0001234, 0.01)).toBe(1000.000123);
    expect(tidy(0, 1)).toBe(0);
  });
});

describe("marqueeZoom", () => {
  const marquee = { x: 20, y: 10, w: 30, h: 40 };

  it("expands to the marquee", () => {
    const commands = marqueeZoom("G", axes, marquee, "expand", {
      horizontal: true,
      vertical: true,
    });
    expect(range(commands, "bottom")).toEqual([2, 5]);
    expect(range(commands, "left")).toEqual([0.5, 0.9]);
  });

  it("can act on one direction only", () => {
    const commands = marqueeZoom("G", axes, marquee, "expand", {
      horizontal: true,
      vertical: false,
    });
    expect(commands).toHaveLength(1);
    expect(range(commands, "left")).toBeNull();
  });

  it("shrinks so the old view fits into the marquee", () => {
    const commands = marqueeZoom("G", axes, { x: 25, y: 0, w: 50, h: 100 }, "shrink", {
      horizontal: true,
      vertical: false,
    });
    expect(range(commands, "bottom")).toEqual([-5, 15]);
  });

  it("keeps a reversed axis reversed", () => {
    const reversed = { bottom: { scale: makeScale(10, 0, false, 0, 100), hit, unit: "" } };
    const commands = marqueeZoom("G", reversed, marquee, "expand", {
      horizontal: true,
      vertical: true,
    });
    expect(range(commands, "bottom")).toEqual([8, 5]);
  });

  it("works in decades on a log axis", () => {
    const log = { bottom: { scale: makeScale(1, 10000, true, 0, 100), hit, unit: "" } };
    const commands = marqueeZoom("G", log, { x: 25, y: 0, w: 50, h: 10 }, "expand", {
      horizontal: true,
      vertical: true,
    });
    expect(range(commands, "bottom")).toEqual([10, 1000]);
  });
});

describe("zoomAbout and panBy", () => {
  it("zooms about the pointer, leaving the value under it in place", () => {
    const commands = zoomAbout("G", axes, 50, 100, 0.5, null);
    expect(range(commands, "bottom")).toEqual([2.5, 7.5]);
    expect(range(commands, "left")).toEqual([0, 0.5]);
  });

  it("zooms a single axis when asked", () => {
    expect(zoomAbout("G", axes, 50, 50, 2, "left")).toHaveLength(1);
  });

  it("pans with the pointer", () => {
    const commands = panBy("G", axes, 10, 10);
    expect(range(commands, "bottom")).toEqual([-1, 9]);
    expect(range(commands, "left")).toEqual([0.1, 1.1]);
  });
});
