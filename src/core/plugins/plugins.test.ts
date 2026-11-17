import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../doc/doc";
import type { CheckedResult } from "../sandbox/validate";
import {
  checkPath,
  describeSource,
  parseGitHubSource,
  parseManifest,
  PluginError,
  splitPluginActionId,
  type PluginManifest,
} from "./manifest";
import { planOutcome } from "./outcome";
import { checkAgainstLock, sha256, verifyPackage } from "./package";

const encode = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

export const sampleManifest = (change: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  name: "electrochem",
  title: "Electrochemistry",
  version: "0.1.0",
  description: "Cyclic voltammetry, Tafel and impedance.",
  license: "MIT",
  python: { entry: "electrochem", packages: ["scipy"] },
  files: ["electrochem/__init__.py", "electrochem/eis.py", "graphs/nyquist.json"],
  actions: [
    {
      name: "eis_fit",
      title: "EIS fit",
      params: {
        re: { type: "wave", title: "Z′" },
        im: { type: "wave", title: "Z″" },
        model: { type: "choice", choices: ["randles", "rc"], default: "randles" },
      },
    },
  ],
  contributes: { graphTemplates: ["graphs/nyquist.json"] },
  ...change,
});

const parse = (change: Record<string, unknown> = {}) =>
  parseManifest(encode(sampleManifest(change)));

describe("plugin manifests", () => {
  it("are read into a fixed shape", () => {
    const manifest = parse();
    expect(manifest.name).toBe("electrochem");
    expect(manifest.python).toEqual({ entry: "electrochem", packages: ["scipy"] });
    expect(manifest.files.map((file) => file.path)).toEqual([
      "electrochem/__init__.py",
      "electrochem/eis.py",
      "graphs/nyquist.json",
    ]);
    expect(manifest.actions[0]!.params.model).toEqual({
      type: "choice",
      choices: ["randles", "rc"],
      default: "randles",
      optional: true,
    });
    expect(manifest.contributes.graphTemplates).toEqual(["graphs/nyquist.json"]);
    expect(manifest.contributes.panels).toEqual([]);
  });

  it("say which wave arguments take text waves too", () => {
    const manifest = parse({
      actions: [
        {
          name: "a",
          title: "A",
          params: {
            y: { type: "wave" },
            group: { type: "wave", text: true, optional: true },
            labels: { type: "waves", text: false },
          },
        },
      ],
    });
    const params = manifest.actions[0]!.params;
    expect(params.y!.text).toBeUndefined();
    expect(params.group).toEqual({ type: "wave", text: true, optional: true });
    expect(params.labels!.text).toBeUndefined();
  });

  it.each([
    ["a name with capitals", { name: "Electro" }, /not a usable plugin name/],
    ["an unknown version", { manifestVersion: 2 }, /version/],
    ["a path out of the package", { files: ["../evil.py"] }, /plain relative path/],
    ["an absolute path", { files: ["/etc/passwd"] }, /plain relative path/],
    ["a hidden file", { files: ["electrochem/.hidden"] }, /plain relative path/],
    ["backslashes", { files: ["electrochem\\x.py"] }, /plain relative path/],
    ["a file twice in different case", { files: ["a.py", "A.py"] }, /twice/],
    ["the manifest among the files", { files: ["oresme-plugin.json"] }, /does not list itself/],
    ["an entry module that is not there", { files: ["other.py"] }, /entry module/],
    ["actions without Python", { python: null }, /entry module/],
    [
      "a contribution that is not a file of it",
      { contributes: { panels: ["x.json"] } },
      /not among the files/,
    ],
    ["an unknown kind of contribution", { contributes: { scripts: [] } }, /unknown kind/],
    [
      "an unknown argument type",
      { actions: [{ name: "a", title: "A", params: { x: { type: "file" } } }] },
      /unknown type/,
    ],
    [
      "two actions of one name",
      {
        actions: [
          { name: "a", title: "A" },
          { name: "a", title: "B" },
        ],
      },
      /same name/,
    ],
    [
      "text waves for an argument that is not a wave",
      { actions: [{ name: "a", title: "A", params: { n: { type: "number", text: true } } }] },
      /not a wave/,
    ],
    [
      "a text flag that is not true or false",
      { actions: [{ name: "a", title: "A", params: { y: { type: "wave", text: "yes" } } }] },
      /true or false/,
    ],
    ["a bad hash", { files: [{ path: "electrochem/__init__.py", sha256: "abc" }] }, /64 hex/],
    [
      "too many files",
      { files: Array.from({ length: 300 }, (_, index) => `f${index}.py`) },
      /at most/,
    ],
  ])("refuse %s", (_, change, message) => {
    expect(() => parse(change)).toThrow(message);
  });

  it("refuse text that is not JSON", () => {
    expect(() => parseManifest(encode("{name:"))).toThrow(/not valid JSON/);
  });

  it("check paths inside a package", () => {
    expect(checkPath("panels/eis.json")).toBe("panels/eis.json");
    for (const bad of ["", "a//b", "a/../b", "./a", `${"a/".repeat(9)}b`]) {
      expect(() => checkPath(bad)).toThrow(PluginError);
    }
  });
});

describe("model editors in a manifest", () => {
  const params = {
    spectrum: { type: "wave" },
    energy: { type: "wave", optional: true },
    region: { type: "numbers", length: 2, optional: true },
    components: { type: "json" },
    shift: { type: "number", default: 0 },
  };
  const actions = [
    { name: "xps_preview", title: "Preview", params },
    { name: "xps_fit", title: "Fit", params },
  ];
  const editor = (change: Record<string, unknown> = {}) => ({
    name: "xps",
    title: "XPS Peak Fitting",
    preview: "xps_preview",
    fit: "xps_fit",
    data: "spectrum",
    x: "energy",
    range: "region",
    items: {
      param: "components",
      title: "Component",
      fields: [
        { key: "name", type: "text" },
        { key: "position", constraint: true },
        { key: "fwhm", default: 1.2, constraint: true, min: 0.05 },
        { key: "area", constraint: true },
      ],
      position: "position",
      width: "fwhm",
      amount: "area",
      coef: "{letter}_{key}",
    },
    partner: {
      title: "Doublet",
      ratios: [["p (1:2)", 0.5]],
      ties: { position: "{ref}+{offset}", area: "{ref}*{ratio}" },
    },
    settings: ["shift"],
    axis: { label: "Binding Energy (eV)", reverse: true },
    ...change,
  });
  const read = (change: Record<string, unknown> = {}) =>
    parse({ actions, editors: [editor(change)] });

  it("are read against the plugin's actions", () => {
    const [spec] = read().editors;
    expect(spec).toMatchObject({
      name: "xps",
      preview: "xps_preview",
      fit: "xps_fit",
      data: "spectrum",
      x: "energy",
      range: "region",
      settings: ["shift"],
      axis: { label: "Binding Energy (eV)", reverse: true },
    });
    expect(spec!.items.fields[2]).toEqual({
      key: "fwhm",
      title: "fwhm",
      kind: "number",
      default: 1.2,
      choices: [],
      constraint: true,
      hint: "",
      min: 0.05,
    });
    expect(spec!.partner!.offset).toBe("Offset");
    // A plugin without editors has none; json arguments are taken.
    expect(parse().editors).toEqual([]);
    expect(read().actions[1]!.params.components!.type).toBe("json");
  });

  it("are refused whole when anything does not fit", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ fit: "nothing" }, /does not have/],
      [{ data: "components" }, /no wave argument components/],
      [{ range: "shift" }, /no numbers argument shift/],
      [{ items: { ...editor().items, param: "spectrum" } }, /no json argument spectrum/],
      [{ items: { ...editor().items, position: "name" } }, /not one of its number fields/],
      [
        { items: { ...editor().items, fields: [{ key: "a" }, { key: "a" }], position: "a" } },
        /same key/,
      ],
      [
        { partner: { title: "Pair", ratios: [["1", 1]], ties: { name: "{ref}" } } },
        /not a field with a constraint/,
      ],
      [{ settings: ["components"] }, /twice/],
      [{ colour: "red" }, /unknown key "colour"/],
    ];
    for (const [change, message] of cases) expect(() => read(change)).toThrow(message);
    expect(() => parse({ actions, editors: [editor(), editor()] })).toThrow(/same name/);
  });
});

describe("plugin sources", () => {
  it("read GitHub addresses, with a branch and folder in them or apart", () => {
    expect(parseGitHubSource("https://github.com/lab/ec-tools")).toEqual({
      kind: "github",
      owner: "lab",
      repo: "ec-tools",
      ref: "HEAD",
      path: "",
    });
    expect(
      parseGitHubSource("https://github.com/lab/ec-tools/tree/v1.2/plugins/eis"),
    ).toMatchObject({
      ref: "v1.2",
      path: "plugins/eis",
    });
    expect(parseGitHubSource("https://github.com/lab/ec-tools.git", "main", "/sub/")).toMatchObject(
      {
        ref: "main",
        path: "sub",
      },
    );
  });

  it.each([
    ["another host", "https://gitlab.com/lab/ec"],
    ["plain http", "http://github.com/lab/ec"],
    ["no repository", "https://github.com/lab"],
    ["a file view", "https://github.com/lab/ec/blob/main/x.py"],
    ["not an address", "lab/ec"],
  ])("refuse %s", (_, address) => {
    expect(() => parseGitHubSource(address)).toThrow(PluginError);
  });

  it("name actions and sources", () => {
    expect(splitPluginActionId("plugin.electrochem.eis_fit")).toEqual({
      plugin: "electrochem",
      action: "eis_fit",
    });
    expect(splitPluginActionId("core.fit")).toBeNull();
    expect(splitPluginActionId("plugin.a.b.c")).toBeNull();
    expect(describeSource(parseGitHubSource("https://github.com/lab/ec/tree/main/eis"))).toBe(
      "github:lab/ec/eis",
    );
  });
});

const packageFiles = () =>
  new Map<string, Uint8Array>([
    ["electrochem/__init__.py", encode("from .eis import *\n")],
    ["electrochem/eis.py", encode("def eis_fit(re, im, model='randles'):\n    return {}\n")],
    ["graphs/nyquist.json", encode({ name: "Nyquist" })],
  ]);
const local = { kind: "local" as const, label: "electrochem" };

describe("plugin packages", () => {
  it("are locked by the hash of every file and one digest over all", async () => {
    const files = packageFiles();
    const pkg = await verifyPackage(encode(sampleManifest()), files, local, null);
    expect(pkg.lock.files).toEqual([
      {
        path: "electrochem/__init__.py",
        sha256: await sha256(files.get("electrochem/__init__.py")!),
        size: 19,
      },
      expect.objectContaining({ path: "electrochem/eis.py" }),
      expect.objectContaining({ path: "graphs/nyquist.json" }),
    ]);
    expect(pkg.lock.digest).toMatch(/^[0-9a-f]{64}$/);
    // The same files give the same digest; one byte more gives another.
    const again = await verifyPackage(encode(sampleManifest()), packageFiles(), local, null);
    expect(again.lock.digest).toBe(pkg.lock.digest);
    const changed = packageFiles();
    changed.set("electrochem/eis.py", encode("def eis_fit(re, im, model='rc'):\n    return {}\n"));
    expect(
      (await verifyPackage(encode(sampleManifest()), changed, local, null)).lock.digest,
    ).not.toBe(pkg.lock.digest);
  });

  it("refuse a missing file, a file not listed and contributions that are not JSON", async () => {
    const missing = packageFiles();
    missing.delete("electrochem/eis.py");
    await expect(verifyPackage(encode(sampleManifest()), missing, local, null)).rejects.toThrow(
      /missing/,
    );
    const extra = packageFiles();
    extra.set("steal.py", encode(""));
    await expect(verifyPackage(encode(sampleManifest()), extra, local, null)).rejects.toThrow(
      /not in its list/,
    );
    const broken = packageFiles();
    broken.set("graphs/nyquist.json", encode("{"));
    await expect(verifyPackage(encode(sampleManifest()), broken, local, null)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("refuse a file whose hash is not the one the manifest gives", async () => {
    const manifest = sampleManifest({
      files: [
        { path: "electrochem/__init__.py", sha256: "0".repeat(64) },
        "electrochem/eis.py",
        "graphs/nyquist.json",
      ],
    });
    await expect(verifyPackage(encode(manifest), packageFiles(), local, null)).rejects.toThrow(
      /SHA-256 differs/,
    );
  });

  it("refuse a file larger than a package may hold", async () => {
    const files = packageFiles();
    files.set("electrochem/eis.py", new Uint8Array(9 * 1024 * 1024));
    await expect(verifyPackage(encode(sampleManifest()), files, local, null)).rejects.toThrow(
      /larger than/,
    );
  });

  it("are checked again when read back, so a changed file is refused", async () => {
    const pkg = await verifyPackage(encode(sampleManifest()), packageFiles(), local, null);
    await expect(
      checkAgainstLock(pkg.lock, pkg.manifestBytes, packageFiles()),
    ).resolves.toBeUndefined();
    const tampered = packageFiles();
    tampered.set("electrochem/eis.py", encode("import js\n"));
    await expect(checkAgainstLock(pkg.lock, pkg.manifestBytes, tampered)).rejects.toThrow(
      /has changed/,
    );
    await expect(
      checkAgainstLock(pkg.lock, encode(sampleManifest({ version: "9" })), packageFiles()),
    ).rejects.toThrow(/manifest has changed/);
  });
});

describe("what a plugin's run does to the experiment", () => {
  const manifest = (): PluginManifest => parse();
  const outcome = (values: CheckedResult["values"] = {}): CheckedResult => ({
    waves: [
      [
        "fit",
        {
          type: "float64",
          shape: [3],
          data: new Float64Array([1, 2, 3]),
          imag: null,
          text: null,
          x0: 0,
          dx: 1,
          xUnit: "Ohm",
          y0: 0,
          dy: 1,
          yUnit: "",
          unit: "Ohm",
          note: "",
        },
      ],
    ],
    values,
    graph: null,
    log: "",
  });
  const source = {
    action: "plugin.electrochem.eis_fit",
    plugin: "electrochem",
    version: "0.1.0",
    origin: "github:lab/ec",
    commit: "a".repeat(40),
    digest: "b".repeat(64),
  };

  function experiment(): Doc {
    const doc = new Doc();
    doc.dispatch({ op: "makeWave", name: "cell1:zre", data: new Float64Array([1, 2, 3]) });
    doc.dispatch({ op: "makeWave", name: "cell1:zim", data: new Float64Array([0, 1, 0]) });
    doc.dispatch({ op: "makeWave", name: "cell1:zre_fit", data: new Float64Array([9]) });
    return doc;
  }

  it("makes waves next to the first input, never over a wave that is there", () => {
    const doc = experiment();
    const action = manifest().actions[0]!;
    const args = { re: "cell1:zre", im: "cell1:zim", model: "randles" };
    const plan = planOutcome(doc.getState(), action, args, outcome(), source, 1000);
    expect(plan.waves).toEqual({ fit: "cell1:zre_fit_1" });
    doc.transact((writer) => plan.commands.forEach((command) => writer.dispatch(command)));
    const made = doc.getState().waves["cell1:zre_fit_1"]!;
    expect([...made.data]).toEqual([1, 2, 3]);
    expect(made.note).toMatch(
      /Made by plugin\.electrochem\.eis_fit \(github:lab\/ec @ aaaaaaaaaaaa\)/,
    );
    expect([...doc.getState().waves["cell1:zre_fit"]!.data]).toEqual([9]);
    expect(plan.keepsResult).toBe(false);
  });

  it("keeps a result with where it came from when the values hold one", () => {
    const doc = experiment();
    const action = manifest().actions[0]!;
    const args = { re: "cell1:zre", im: "cell1:zim", model: "rc" };
    const plan = planOutcome(
      doc.getState(),
      action,
      args,
      outcome({
        result: { names: ["R0", "R1"], coef: [10, 20], sigma: [0.1, null], chisq: 0.5, points: 3 },
      }),
      source,
      1000,
    );
    let name: string | null = null;
    doc.transact((writer) => {
      for (const command of plan.commands) {
        const made = writer.dispatch(command);
        if (command.op === "addResult") name = made;
      }
    });
    const result = doc.getState().results[name!]!;
    expect(result).toMatchObject({
      kind: "plugin",
      names: ["R0", "R1"],
      coef: [10, 20],
      sigma: [0.1, null],
      chisq: 0.5,
      points: 3,
      freedom: 1,
      outputs: { fit: "cell1:zre_fit_1" },
      source,
      settings: {
        action: "plugin.electrochem.eis_fit",
        inputs: { re: "cell1:zre", im: "cell1:zim" },
        params: { model: "rc" },
      },
    });
    // Renaming an input follows into the result.
    doc.dispatch({ op: "renameWave", name: "cell1:zre", newName: "cell1:real" });
    expect(doc.getState().results[name!]!.settings).toMatchObject({ inputs: { re: "cell1:real" } });
  });
});
