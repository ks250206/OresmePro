import { describe, expect, it } from "vite-plus/test";
import { colorAt } from "./colorTables";
import { contourLevels, contourSegments } from "./contour";
import type { Prim } from "./displayList";
import { toPdf } from "./pdf";
import { crc32, encodePng } from "./png";

describe("color tables", () => {
  it("interpolates between stops", () => {
    expect(colorAt("grays", 0)).toBe("#000000");
    expect(colorAt("grays", 1)).toBe("#ffffff");
    expect(colorAt("grays", 0.5)).toBe("#808080");
    expect(colorAt("viridis", 2)).toBe("#fde725");
  });
});

describe("contours", () => {
  it("chooses round levels strictly inside the data range", () => {
    expect(contourLevels(4, 0, 10)).toEqual([2, 4, 6, 8]);
    expect(contourLevels([1, 2], 0, 10)).toEqual([1, 2]);
    expect(contourLevels(5, 3, 3)).toEqual([]);
  });

  it("finds the line where a plane crosses a level", () => {
    // z[i][j] = i on a 3x3 grid: the level 0.5 is the line i = 0.5.
    const data = Float64Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    const segments = contourSegments(data, 3, 3, 0.5);
    expect(segments.length).toBe(8);
    for (let index = 0; index < segments.length; index += 2)
      expect(segments[index]).toBeCloseTo(0.5);
  });

  it("skips cells that touch NaN", () => {
    const data = Float64Array.from([0, 0, 1, Number.NaN]);
    expect(contourSegments(data, 2, 2, 0.5)).toHaveLength(0);
  });
});

describe("png", () => {
  it("computes the standard CRC and writes a valid header", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const png = encodePng(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(new DataView(png.buffer).getUint32(16)).toBe(2);
    expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
  });
});

describe("pdf", () => {
  const prims: Prim[] = [
    { kind: "rect", x: 0, y: 0, w: 200, h: 100, fill: "#ffffff" },
    { kind: "polyline", points: [10, 10, 50, 60, 90, 20], stroke: "#ff0000", width: 1 },
    {
      kind: "text",
      x: 20,
      y: 90,
      text: "−5 µV α 時間",
      family: "Helvetica",
      size: 12,
      fill: "#000000",
    },
    {
      kind: "image",
      x: 100,
      y: 10,
      w: 40,
      h: 40,
      cols: 1,
      rows: 2,
      rgba: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]),
    },
  ];

  it("writes a document whose cross-reference table points at its objects", () => {
    const pdf = toPdf(prims, 200, 100);
    const text = Array.from(pdf, (byte) => String.fromCharCode(byte)).join("");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 150 75]");
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n /gm)].map((match) =>
      Number(match[1]),
    );
    expect(offsets.length).toBeGreaterThan(5);
    offsets.forEach((offset, index) => {
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  it("uses built-in fonts for Latin, Greek and Japanese text, and masks transparency", () => {
    const text = Array.from(toPdf(prims, 200, 100), (byte) => String.fromCharCode(byte)).join("");
    expect(text).toContain("/BaseFont /Helvetica");
    expect(text).toContain("/BaseFont /Symbol");
    expect(text).toContain("/BaseFont /HeiseiKakuGo-W5");
    expect(text).toContain("/SMask");
  });

  it("draws other scripts as a picture when it can", () => {
    const calls: string[] = [];
    const pdf = toPdf(prims, 200, 100, {
      rasterizeText: (value) => {
        calls.push(value);
        return {
          cols: 1,
          rows: 1,
          rgba: new Uint8ClampedArray(4),
          width: 30,
          ascent: 10,
          descent: 3,
        };
      },
    });
    const text = Array.from(pdf, (byte) => String.fromCharCode(byte)).join("");
    expect(calls).toEqual(["\u22125 \u00b5V \u03b1 \u6642\u9593"]);
    expect(text).not.toContain("HeiseiKakuGo");
    expect(text).toContain("/Im2");
  });
});
