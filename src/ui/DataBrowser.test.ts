import { describe, expect, it } from "vite-plus/test";
import { docsUrl } from "../app/links";
import { Doc } from "../core/doc/doc";
import { waveMatches } from "./DataBrowser";

describe("finding waves in the Data Browser", () => {
  const doc = new Doc();
  doc.dispatch({ op: "newFolder", path: "run1" });
  doc.dispatch({
    op: "makeWave",
    name: "run1:voltage",
    data: new Float64Array([1, 2]),
    unit: "V",
    xUnit: "s",
  });
  doc.dispatch({ op: "makeWave", name: "labels", data: new Float64Array(0), text: ["a", "b"] });
  const wave = (name: string) => doc.getState().waves[name]!;

  it("matches every word, in any case, in the path, units, type or note", () => {
    expect(waveMatches(wave("run1:voltage"), "RUN1")).toBe(true);
    expect(waveMatches(wave("run1:voltage"), "volt v")).toBe(true);
    expect(waveMatches(wave("run1:voltage"), "float64")).toBe(true);
    expect(waveMatches(wave("run1:voltage"), "volt current")).toBe(false);
    expect(waveMatches(wave("labels"), "text")).toBe(true);
    expect(waveMatches(wave("run1:voltage"), "text")).toBe(false);
    expect(waveMatches(wave("labels"), "   ")).toBe(true);
  });
});

describe("links to the documentation", () => {
  it("open in Japanese or in English", () => {
    expect(docsUrl("", true)).toBe("https://ks250206.github.io/OresmePro/docs/");
    expect(docsUrl("guides/curve-fitting/", false)).toBe(
      "https://ks250206.github.io/OresmePro/docs/en/guides/curve-fitting/",
    );
  });
});
