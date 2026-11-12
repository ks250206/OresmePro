import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../doc/doc";
import { emptyDoc, type DocState } from "../doc/types";
import { IgorError, readBinaryWave, readPackedExperiment, type IgorWave } from "./igor";
import { isIgorFile, planIgorImport } from "./igorImport";
import {
  expectedIgor,
  expectedNumber,
  igorFixture,
  type ExpectedExperiment,
  type ExpectedWave,
} from "./testdata/igor";

const ARRAYS: Record<string, unknown> = {
  float64: Float64Array,
  float32: Float32Array,
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  complex128: Float64Array,
  complex64: Float32Array,
};

/** Checks a wave as read against what the generator says it holds. */
function expectWave(wave: IgorWave, expected: ExpectedWave, label: string): void {
  const { values, imag, text, ...rest } = expected;
  expect(
    {
      name: wave.name,
      version: wave.version,
      littleEndian: wave.littleEndian,
      igorType: wave.igorType,
      type: wave.type,
      shape: wave.shape,
      dims: wave.dims,
      unit: wave.unit,
      note: wave.note,
      formula: wave.formula,
      missingValues: wave.missingValues,
    },
    label,
  ).toEqual(rest);
  expect(wave.text, label).toEqual(text);
  if (text) return;
  expect(wave.data, label).toBeInstanceOf(ARRAYS[wave.type]);
  expect(Array.from(wave.data), label).toEqual(values!.map(expectedNumber));
  if (imag) {
    expect(wave.imag, label).toBeInstanceOf(ARRAYS[wave.type]);
    expect(Array.from(wave.imag!), label).toEqual(imag.map(expectedNumber));
  } else {
    expect(wave.imag, label).toBeNull();
  }
}

/** A record of a packed experiment, for files made in a test. */
function record(type: number, data: Uint8Array, little = true): Uint8Array {
  const bytes = new Uint8Array(8 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, type, little);
  view.setInt32(4, data.length, little);
  bytes.set(data, 8);
  return bytes;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};

const folderName = (name: string) => {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(name));
  return bytes;
};

describe("reading Igor binary waves", () => {
  const files = Object.entries(expectedIgor).filter(([name]) => name.endsWith(".ibw"));

  it("reads every generated file to what its generator wrote", () => {
    expect(files.length).toBeGreaterThan(15);
    for (const [name, expected] of files) {
      expectWave(readBinaryWave(igorFixture(name)), expected as ExpectedWave, name);
    }
  });

  it("covers versions 1, 2, 3 and 5 in both byte orders", () => {
    const seen = new Set(
      files.map(([, item]) => {
        const wave = item as ExpectedWave;
        return `${wave.version}${wave.littleEndian ? "le" : "be"}`;
      }),
    );
    expect([...seen].toSorted()).toEqual(["1be", "2be", "2le", "3be", "3le", "5be", "5le"]);
  });

  it("puts Igor's columns-first values in this app's order", () => {
    // Igor's 3×2 matrix: value i + 3j at row i, column j; here row i is outermost.
    const wave = readBinaryWave(igorFixture("v5-le-complex.ibw"));
    expect(wave.shape).toEqual([3, 2]);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        expect([wave.data[i * 2 + j], wave.imag![i * 2 + j]]).toEqual([i + 3 * j, i + 3 * j - 10]);
      }
    }
    const cube = readBinaryWave(igorFixture("v5-be-3d.ibw"));
    // Value i + 10j + 100k at (i, j, k) of a 4×3×2 wave.
    expect(cube.data[((2 * 3 + 1) * 2 + 1) as number]).toBe(2 + 10 + 100);
  });

  it("uses the file's own buffer for values it need not reorder or swap", () => {
    const bytes = igorFixture("v5-le-float64.ibw");
    const wave = readBinaryWave(bytes);
    expect(wave.data.buffer).toBe(bytes.buffer);
    expect(wave.data.byteOffset).toBe(384);
    // Big-endian values are swapped into a copy; the file is left as it was.
    const big = igorFixture("v2-be-int16.ibw");
    const before = big.slice();
    expect(Array.from(readBinaryWave(big).data)).toEqual([-32768, -1, 0, 1, 32767]);
    expect(big).toEqual(before);
  });

  it("notes what it cannot keep as Igor had it", () => {
    const cube = readBinaryWave(igorFixture("v5-be-3d.ibw"));
    expect(cube.dims.map((dim) => dim.unit)).toEqual(["nanometre", "µm", "K"]);
    expect(cube.unit).toBe("counts per second");
    expect(cube.remarks).toEqual([
      "Igor's dimension labels are not loaded.",
      'Igor\'s scaling of the layers: start 5, step 0.5, unit "K" (a wave here has scaling for its rows and columns only).',
    ]);
    expect(readBinaryWave(igorFixture("v5-le-int64.ibw")).remarks).toEqual([
      "2 of the 64-bit integer values are beyond 2^53 and were rounded to the nearest float64.",
    ]);
    expect(readBinaryWave(igorFixture("v3-le-formula.ibw")).remarks).toEqual([
      'Igor computed this wave from the formula "ramp*2"; the values are those saved, and the formula is not kept.',
    ]);
    const legacy = readBinaryWave(igorFixture("v5-be-text-legacy.ibw"));
    expect(legacy.remarks).toEqual([
      "Igor's text wave is 2×2; a text wave here has one dimension, so its strings are in Igor's point order (the first index fastest).",
      "Text that is not UTF-8 was read as MacRoman and Shift_JIS (the encoding of an older Igor on a Mac).",
    ]);
    expect(readBinaryWave(igorFixture("v5-le-text-1252.ibw")).remarks).toEqual([
      "Text that is not UTF-8 was read as Windows-1252 (the encoding of an older Igor on Windows).",
    ]);
  });

  it("says when the values of a dependent wave are not in the file", () => {
    for (const name of ["v3-be-dependent.ibw", "v5-le-dependent.ibw"]) {
      const wave = readBinaryWave(igorFixture(name));
      expect(wave.missingValues).toBe(true);
      expect(wave.data).toHaveLength(0);
    }
  });

  it("refuses files that are not binary waves, or are damaged, saying why", () => {
    const refused = (bytes: Uint8Array, message: RegExp) => {
      expect(() => readBinaryWave(bytes)).toThrow(IgorError);
      expect(() => readBinaryWave(bytes)).toThrow(message);
    };
    refused(new TextEncoder().encode("x,y\n1,2\n"), /not an Igor binary wave/);
    refused(new Uint8Array(0), /not an Igor binary wave/);
    refused(
      igorFixture("experiment-le.pxp"),
      /packed experiment, not a binary wave: give the file the extension \.pxp/,
    );
    const original = igorFixture("v5-le-float64.ibw");
    refused(original.subarray(0, 100), /cut short: it ends inside the header/);
    refused(original.subarray(0, original.length - 1), /cut short: it ends inside the values/);
    const cube = igorFixture("v5-be-3d.ibw");
    refused(cube.subarray(0, cube.length - 10), /cut short: it ends inside the dimension labels/);
    // One changed byte in the header: the checksum catches it.
    const changed = original.slice();
    changed[64 + 84] ^= 0x01;
    refused(
      changed,
      /damaged, or not an Igor binary wave: the checksum of its header does not match/,
    );
    const v2 = igorFixture("v2-le.ibw");
    v2[20] ^= 0x10;
    refused(v2, /checksum/);
    // A version Igor does not write.
    const four = original.slice();
    four[0] = 4;
    refused(four, /version 4, which this reader does not know/);
  });
});

describe("reading Igor packed experiments", () => {
  it("reads the waves and data folders of both byte orders to what the generator wrote", () => {
    for (const name of ["experiment-le.pxp", "experiment-be.pxp"]) {
      const expected = expectedIgor[name] as ExpectedExperiment;
      const experiment = readPackedExperiment(igorFixture(name));
      expect(experiment.littleEndian, name).toBe(expected.littleEndian);
      expect(experiment.folders, name).toEqual(expected.folders);
      expect(experiment.rest, name).toEqual(expected.rest);
      expect(experiment.waves.map((item) => item.folder)).toEqual(
        expected.waves.map((item) => item.folder),
      );
      experiment.waves.forEach((item, index) => {
        const { folder, ...wave } = expected.waves[index]!;
        expectWave(item.wave, wave, `${name}: ${[...folder, wave.name].join(":")}`);
      });
      // The superseded record of a wave named "old" is passed over.
      expect(experiment.waves.some((item) => item.wave.name === "old")).toBe(false);
    }
  });

  it("refuses files that are not packed experiments, or are cut short", () => {
    const refused = (bytes: Uint8Array, message: RegExp) => {
      expect(() => readPackedExperiment(bytes)).toThrow(IgorError);
      expect(() => readPackedExperiment(bytes)).toThrow(message);
    };
    const file = igorFixture("experiment-be.pxp");
    refused(file.subarray(0, file.length - 3), /cut short or damaged: after \d+ records it ends/);
    refused(file.subarray(0, 5000), /cut short or damaged/);
    refused(new TextEncoder().encode("Igor? No, a text file.\n"), /not an Igor packed experiment/);
    refused(new Uint8Array(0), /not an Igor packed experiment/);
    refused(
      igorFixture("v5-le-zero.ibw"),
      /binary wave, not a packed experiment: give the file the extension \.ibw/,
    );
    // A data folder that is opened and never closed.
    refused(record(9, folderName("open")), /ends inside data folder open/);
    refused(
      concat(
        record(9, folderName("a")),
        record(10, new Uint8Array(0)),
        record(10, new Uint8Array(0)),
      ),
      /closes a data folder that was never opened/,
    );
  });

  it("names the record of a damaged wave", () => {
    const file = igorFixture("experiment-le.pxp");
    // The first record is the variables of root; the wave wave0 follows it.
    const view = new DataView(file.buffer);
    const second = 8 + view.getInt32(4, true);
    file[second + 8 + 64 + 30] ^= 0x01;
    expect(() => readPackedExperiment(file)).toThrow(
      new RegExp(
        `In record 2 \\(a wave record at byte ${second}\\): The file is damaged, or not an Igor binary wave: the checksum`,
      ),
    );
  });

  it("passes over records of kinds it does not know", () => {
    const wave = igorFixture("v5-le-zero.ibw");
    const experiment = readPackedExperiment(
      concat(
        record(77, new Uint8Array(5)),
        record(3, wave),
        record(9, folderName("f")),
        record(3, wave),
        record(10, new Uint8Array(0)),
      ),
    );
    expect(experiment.waves.map((item) => item.folder)).toEqual([[], ["f"]]);
    expect(experiment.rest.other).toBe(1);
  });
});

/** Runs a plan's commands as one step, as the app does. */
function load(state: DocState, bytes: Uint8Array, filename: string) {
  const doc = new Doc();
  doc.load(state);
  const plan = planIgorImport(bytes, filename, doc.getState(), "ab12");
  for (const command of plan.commands) doc.dispatch(command, { group: "load" });
  return { doc, plan, state: doc.getState() };
}

describe("loading Igor files into the experiment", () => {
  it("knows Igor files by their names", () => {
    expect(["a.ibw", "b.PXP", "c.pxt"].map(isIgorFile)).toEqual([true, true, true]);
    expect(["a.csv", "b.oresme", "ibw"].map(isIgorFile)).toEqual([false, false, false]);
  });

  it("makes a binary wave one wave with its scaling, units and note", () => {
    const { state, plan } = load(emptyDoc(), igorFixture("v2-le.ibw"), "run.ibw");
    expect(state.waveOrder).toEqual(["sig_1"]);
    const wave = state.waves.sig_1!;
    expect(wave).toMatchObject({ type: "float64", shape: [8], x0: -1, dx: 0.25, xUnit: "ms" });
    expect(wave).toMatchObject({ unit: "mV", y0: 0, dy: 1, yUnit: "" });
    expect(wave.note).toBe(
      "Loaded from run.ibw (SHA-256 ab12): Igor wave 'sig 1', binary wave version 2, 64-bit float.\nIgor's note:\nfirst line\nsecond line\nthird",
    );
    expect(plan.summary).toBe(
      "Loaded sig_1 (float64, 8 points) from run.ibw (Igor's name: sig 1).",
    );
  });

  it("gives a wave whose name is taken a suffix instead of overwriting", () => {
    const first = load(emptyDoc(), igorFixture("v5-le-4d-uint16.ibw"), "a.ibw").state;
    const { state, plan } = load(first, igorFixture("v5-le-4d-uint16.ibw"), "b.ibw");
    expect(state.waveOrder).toEqual(["frames", "frames_1"]);
    expect(state.waves.frames_1).toMatchObject({ type: "uint16", shape: [3, 2, 2, 2] });
    expect(state.waves.frames_1!.data).toBeInstanceOf(Uint16Array);
    expect(plan.summary).toBe(
      "Loaded frames_1 (uint16, 3×2×2×2) from b.ibw (Igor's name: frames).",
    );
  });

  it("keeps the scaling of the first two dimensions and notes the rest", () => {
    const { state, plan } = load(emptyDoc(), igorFixture("v5-be-3d.ibw"), "cube.ibw");
    expect(state.waves.cube).toMatchObject({
      shape: [4, 3, 2],
      x0: 0.5,
      dx: 0.1,
      xUnit: "nanometre",
      y0: -1,
      dy: 2,
      yUnit: "µm",
      unit: "counts per second",
    });
    expect(state.waves.cube!.note.split("\n")).toEqual([
      "Loaded from cube.ibw (SHA-256 ab12): Igor wave cube, binary wave version 5, 64-bit float.",
      "Igor's dimension labels are not loaded.",
      'Igor\'s scaling of the layers: start 5, step 0.5, unit "K" (a wave here has scaling for its rows and columns only).',
      "Igor's note:",
      "測定 1",
      "温度 300 K",
    ]);
    expect(plan.summary.split("\n")[0]).toBe("Loaded cube (float64, 4×3×2) from cube.ibw.");
  });

  it("makes complex and text waves", () => {
    const complex = load(emptyDoc(), igorFixture("v5-be-cint16.ibw"), "iq.ibw").state.waves.iq!;
    expect(complex.type).toBe("complex64");
    expect([Array.from(complex.data), Array.from(complex.imag!)]).toEqual([
      [1, -32768, 0],
      [-2, 32767, 0],
    ]);
    const text = load(emptyDoc(), igorFixture("v5-be-text-legacy.ibw"), "t.ibw").state.waves
      .legacy!;
    expect(text.text).toEqual(["µs", "°C", "温度", "plain"]);
    expect(text.unit).toBe("µA");
    expect(text.note.split("\n").at(-1)).toBe("°C");
  });

  it("refuses a wave whose values are not in the file", () => {
    expect(() => planIgorImport(igorFixture("v3-be-dependent.ibw"), "d.ibw", emptyDoc())).toThrow(
      'There are no values to load: Igor computes this wave from the formula " K0" and did not save its values.',
    );
  });

  it("loads a packed experiment's waves under their data folders, as one step", () => {
    const start = load(emptyDoc(), igorFixture("v5-le-zero.ibw"), "z.ibw").state;
    // A folder that exists already is used; its wave keeps its name.
    const before = load(start, igorFixture("v1-be.ibw"), "old.ibw");
    before.doc.dispatch({ op: "renameWave", name: "old", newName: "raw_data:sig" });
    const { doc, state, plan } = load(
      before.doc.getState(),
      igorFixture("experiment-be.pxp"),
      "exp.pxp",
    );
    const run = ["int8", "uint8", "int16", "uint16", "int32", "uint32", "float32", "float64"].map(
      (type, index) => `raw_data:run_1:t${index}_${type}`,
    );
    expect(state.waveOrder).toEqual([
      "empty",
      "raw_data:sig",
      "wave0",
      "my_wave",
      "a_b",
      "a_b_1",
      "wave_2nd",
      "dup",
      "raw_data:sig_1",
      ...run,
      "raw_data:run_1:c64",
      "raw_data:run_1:c128",
      "raw_data:run_1:cu32",
      "raw_data:run_1:matrix",
      "a_folder_whose_name_is_longer_than_31_bytes:labels",
      "dup_1:inner",
    ]);
    expect(state.folders).toEqual([
      "raw_data",
      "raw_data:run_1",
      "a_folder_whose_name_is_longer_than_31_bytes",
      "dup_1",
    ]);
    expect(state.waves["raw_data:run_1:t5_uint32"]).toMatchObject({ type: "uint32" });
    expect(Array.from(state.waves["raw_data:run_1:t5_uint32"]!.data)).toEqual([0, 0, 4294967295]);
    expect(state.waves["raw_data:run_1:cu32"]).toMatchObject({ type: "complex128" });
    expect(state.waves["raw_data:run_1:matrix"]).toMatchObject({
      shape: [2, 3],
      y0: 10,
      dy: 5,
      yUnit: "mm",
    });
    expect(state.waves["raw_data:sig_1"]).toMatchObject({ x0: 2, dx: 0.5, xUnit: "s", unit: "A" });
    expect(state.waves["raw_data:sig_1"]!.note).toBe(
      "Loaded from exp.pxp (SHA-256 ab12): Igor wave root:'raw data':sig, binary wave version 5, 32-bit float.\nIgor's note:\nraw\nsignal",
    );
    expect(plan.summary.split("\n")).toEqual([
      "Loaded 21 waves from exp.pxp: 6 in root, 1 in raw_data, 12 in raw_data:run_1, 1 in a_folder_whose_name_is_longer_than_31_bytes, 1 in dup_1.",
      "Renamed to names allowed here, or taken already: root:'my wave' → my_wave, root:'a b' → a_b, root:a_b → a_b_1, root:'2nd' → wave_2nd, root:'raw data' → raw_data, root:'raw data':sig → raw_data:sig_1, root:'raw data':'run 1' → raw_data:run_1, root:'raw data':'run 1':'t0 int8' → raw_data:run_1:t0_int8, root:'raw data':'run 1':'t1 uint8' → raw_data:run_1:t1_uint8, root:'raw data':'run 1':'t2 int16' → raw_data:run_1:t2_int16, root:'raw data':'run 1':'t3 uint16' → raw_data:run_1:t3_uint16, root:'raw data':'run 1':'t4 int32' → raw_data:run_1:t4_int32 and 5 more.",
      "Not loaded: root:dep (Igor computes it from a formula and did not save its values).",
      "Data folders without waves are not made: root:'only variables'.",
      "Not brought over: 2 graphs, 1 table (Igor's window recreation macros), the procedure window, 4 variables and 2 strings, the history, 1 record of a kind this reader does not know.",
    ]);
    expect(plan.skipped).toEqual([
      "root:dep (Igor computes it from a formula and did not save its values)",
    ]);
    // One step to undo, whatever the file held.
    doc.undo();
    expect(doc.getState().waveOrder).toEqual(["empty", "raw_data:sig"]);
    expect(doc.getState().folders).toEqual(["raw_data"]);
  });
});
