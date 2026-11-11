import { describe, expect, it } from "vite-plus/test";
import { loadFile, loadFiles } from "./actions";
import { doc } from "./session";

const csv = (name: string, value: number) => new File([`x,y\n1,${value}\n2,${value}\n`], name);

describe("loading delimited text files", () => {
  it("gives files loaded together distinct wave names instead of overwriting", async () => {
    await loadFiles([csv("a.csv", 10), csv("b.csv", 20)]);
    const state = doc.getState();
    expect(state.waveOrder).toEqual(["x", "y", "x_1", "y_1"]);
    expect(Array.from(state.waves.y!.data)).toEqual([10, 10]);
    expect(Array.from(state.waves.y_1!.data)).toEqual([20, 20]);
  });

  it("does the same when two loads are started at once", async () => {
    await Promise.all([loadFile(csv("c.csv", 30)), loadFile(csv("d.csv", 40))]);
    const { waves, waveOrder } = doc.getState();
    expect(waveOrder).toHaveLength(8);
    expect(new Set(waveOrder).size).toBe(8);
    const loaded = waveOrder
      .filter((name) => name.startsWith("y"))
      .map((name) => waves[name]!.data[0]);
    expect(loaded.toSorted((a, b) => a! - b!)).toEqual([10, 20, 30, 40]);
  });
});
