import { describe, expect, it } from "vite-plus/test";
import { parseDelimited } from "./delimited";
import { decodeNpy, encodeNpy } from "./npy";

describe("npy", () => {
  it("round-trips float64 data with an aligned header", () => {
    const data = new Float64Array([1.5, -2, Number.NaN, 1e300]);
    const bytes = encodeNpy(data);
    expect((bytes.length - data.byteLength) % 64).toBe(0);
    expect(new TextDecoder().decode(bytes.subarray(1, 6))).toBe("NUMPY");
    expect([...decodeNpy(bytes)]).toEqual([...data]);
  });

  it("round-trips an empty array and rejects other files", () => {
    expect(decodeNpy(encodeNpy(new Float64Array(0)))).toHaveLength(0);
    expect(() => decodeNpy(new Uint8Array([1, 2, 3]))).toThrow(/Not a .npy/);
  });
});

describe("parseDelimited", () => {
  const free = () => false;

  it("reads CSV with a header", () => {
    const result = parseDelimited("time (s),signal\n0,1.5\n1,2.5\n", free);
    expect(result.names).toEqual(["time_s", "signal"]);
    expect([...result.columns[1]!]).toEqual([1.5, 2.5]);
    expect(result.rows).toBe(2);
  });

  it("reads whitespace-separated numbers without a header", () => {
    const result = parseDelimited("# comment\n1  2\n3  4\n", free);
    expect(result.names).toEqual(["column0", "column1"]);
    expect([...result.columns[0]!]).toEqual([1, 3]);
  });

  it("reads tab-separated data, leaving text columns out", () => {
    const result = parseDelimited("x\tlabel\ty\n1\ta\t\n2\tb\t5\n", free);
    expect(result.names).toEqual(["x", "y"]);
    expect(result.skipped).toEqual(["label"]);
    expect([...result.columns[1]!]).toEqual([Number.NaN, 5]);
  });

  it("avoids names that are taken", () => {
    const result = parseDelimited("x,x\n1,2\n", (name) => name === "x");
    expect(result.names).toEqual(["x_1", "x_2"]);
  });
});
