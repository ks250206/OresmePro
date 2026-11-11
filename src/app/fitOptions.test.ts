import { describe, expect, it } from "vite-plus/test";
import { parseConstraints, parseHold } from "./fitOptions";

describe("parseHold", () => {
  it("reads name=value pairs", () => {
    expect(parseHold("y0=0, width = 1.5e-3")).toBe('{"y0": 0, "width": 0.0015}');
    expect(parseHold("  ")).toBe("");
  });

  it("rejects anything else", () => {
    expect(parseHold("y0")).toBeNull();
    expect(parseHold("y0=abc")).toBeNull();
    expect(parseHold("2=y0")).toBeNull();
  });
});

describe("parseConstraints", () => {
  it("reads one-sided and two-sided limits", () => {
    expect(parseConstraints("A > 0")).toBe('{"A": (0, None)}');
    expect(parseConstraints("x0 <= 5, A >= -1")).toBe('{"x0": (None, 5), "A": (-1, None)}');
    expect(parseConstraints("2 < x0 < 5")).toBe('{"x0": (2, 5)}');
    expect(parseConstraints("0 < A, 5 > A")).toBe('{"A": (0, 5)}');
    expect(parseConstraints("")).toBe("");
  });

  it("rejects anything else", () => {
    expect(parseConstraints("A = 0")).toBeNull();
    expect(parseConstraints("A > B")).toBeNull();
  });
});
