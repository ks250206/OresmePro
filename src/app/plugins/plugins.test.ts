import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { Doc } from "../../core/doc/doc";
import { verifyPackage } from "../../core/plugins/package";
import type { RunRequest, Sandbox } from "../../sandbox/host";
import { contributionCommands } from "./contributions";
import { PluginHost } from "./host";
import { fetchFromGitHub, readLocalPackage, unzipPackage } from "./sources";
import { MemoryPluginStorage, pageLocks, PluginStore } from "./store";

const encode = (value: unknown) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

const manifest = (change: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  name: "electrochem",
  title: "Electrochemistry",
  version: "0.1.0",
  python: { entry: "electrochem", packages: ["scipy"] },
  files: ["electrochem.py", "styles/paper.json"],
  actions: [
    {
      name: "scale",
      title: "Scale",
      params: {
        y: { type: "wave" },
        factor: { type: "number", default: 2 },
        labels: { type: "wave", text: true, optional: true },
        parts: { type: "integer", optional: true },
      },
    },
  ],
  contributes: { styles: ["styles/paper.json"] },
  ...change,
});

const files = (code = "from oresme_plugin import action\n") =>
  new Map<string, Uint8Array>([
    ["electrochem.py", encode(code)],
    ["styles/paper.json", encode({ graph: { fontSize: 12 } })],
  ]);

const github = { kind: "github" as const, owner: "lab", repo: "ec", ref: "main", path: "" };

async function packageOf(change: Record<string, unknown> = {}, code?: string, source = github) {
  return verifyPackage(
    encode(manifest(change)),
    files(code),
    source,
    source.kind === "github" ? "c".repeat(40) : null,
  );
}

describe("the plugin store", () => {
  it("installs, lists after a restart, turns off and removes, leaving no files behind", async () => {
    const storage = new MemoryPluginStorage();
    const store = new PluginStore(storage);
    await store.install(await packageOf());
    expect(store.list().map((plugin) => plugin.manifest.name)).toEqual(["electrochem"]);

    const reopened = new PluginStore(storage);
    await reopened.load();
    expect(reopened.find("electrochem")).toMatchObject({
      enabled: true,
      lock: { commit: "c".repeat(40) },
    });
    await reopened.setEnabled("electrochem", false);
    expect(reopened.find("electrochem")!.enabled).toBe(false);

    await reopened.remove("electrochem");
    expect(reopened.list()).toEqual([]);
    expect([...storage.files.keys()]).toEqual(["index.json"]);
  });

  it("refuses a plugin of the same name from somewhere else", async () => {
    const store = new PluginStore(new MemoryPluginStorage());
    await store.install(await packageOf());
    const other = await packageOf({}, undefined, { ...github, owner: "someone" });
    await expect(store.install(other)).rejects.toThrow(/already installed from lab\/ec/);
    expect(store.find("electrochem")!.lock.source).toEqual(github);
  });

  it("replaces a plugin by its update from the same place and drops the old files", async () => {
    const storage = new MemoryPluginStorage();
    const store = new PluginStore(storage);
    const first = await packageOf();
    await store.install(first);
    const update = await packageOf(
      { version: "0.2.0" },
      "from oresme_plugin import action  # new\n",
    );
    await store.install(update);
    expect(store.list()).toHaveLength(1);
    expect(store.find("electrochem")!.manifest.version).toBe("0.2.0");
    const oldCode = first.lock.files.find((file) => file.path === "electrochem.py")!.sha256;
    expect(storage.files.has(oldCode)).toBe(false);
  });

  it("keeps what another tab changed meanwhile, working from the list as storage has it", async () => {
    // Two tabs: each read the list before the other changed it.
    const storage = new MemoryPluginStorage();
    const locks = pageLocks();
    const tabA = new PluginStore(storage, { locks });
    const tabB = new PluginStore(storage, { locks });
    await tabA.load();
    await tabB.load();
    const first = await packageOf();
    await tabA.install(first);
    const other = await packageOf({ name: "tafel", title: "Tafel" });
    await tabB.install(other);
    const reopened = new PluginStore(storage);
    await reopened.load();
    expect(
      reopened
        .list()
        .map((plugin) => plugin.manifest.name)
        .sort(),
    ).toEqual(["electrochem", "tafel"]);
    // A's files were not cleared away as if nothing needed them.
    for (const file of first.lock.files) expect(storage.files.has(file.sha256)).toBe(true);
    await expect(reopened.files(reopened.find("electrochem")!)).resolves.toBeDefined();

    // Turning off and removing from the outdated tab A leave B's plugin alone.
    await tabA.setEnabled("electrochem", false);
    await tabA.remove("electrochem");
    await reopened.load();
    expect(reopened.list().map((plugin) => [plugin.manifest.name, plugin.enabled])).toEqual([
      ["tafel", true],
    ]);
    for (const file of other.lock.files) expect(storage.files.has(file.sha256)).toBe(true);
  });

  it("makes changes one at a time, so two at once both stay", async () => {
    const storage = new MemoryPluginStorage();
    const locks = pageLocks();
    const tabA = new PluginStore(storage, { locks });
    const tabB = new PluginStore(storage, { locks });
    await Promise.all([
      tabA.install(await packageOf()),
      tabB.install(await packageOf({ name: "tafel", title: "Tafel" })),
    ]);
    const reopened = new PluginStore(storage);
    await reopened.load();
    expect(reopened.list()).toHaveLength(2);
  });

  it("refuses files changed in storage since they were installed", async () => {
    const storage = new MemoryPluginStorage();
    const store = new PluginStore(storage);
    const installed = await store.install(await packageOf());
    expect((await store.files(installed)).get("electrochem.py")).toBeDefined();
    const code = installed.lock.files.find((file) => file.path === "electrochem.py")!.sha256;
    storage.files.set(code, encode("import js; js.fetch('https://example.com')\n"));
    await expect(store.files(installed)).rejects.toThrow(
      /has changed since the plugin was installed/,
    );
  });
});

/** A fetch that serves a repository at one commit, and records what was asked. */
function fakeGitHub(served: Map<string, Uint8Array>, commit = "d".repeat(40)) {
  const asked: string[] = [];
  const fetchImpl = (url: string) => {
    asked.push(url);
    if (url.startsWith("https://api.github.com/repos/lab/ec/commits/")) {
      return Promise.resolve(new Response(`${commit}\n`));
    }
    const prefix = `https://raw.githubusercontent.com/lab/ec/${commit}/`;
    const bytes = url.startsWith(prefix)
      ? served.get(decodeURIComponent(url.slice(prefix.length)))
      : undefined;
    return Promise.resolve(
      bytes ? new Response(bytes as Uint8Array<ArrayBuffer>) : new Response("", { status: 404 }),
    );
  };
  return { fetchImpl, asked };
}

describe("fetching a plugin from GitHub", () => {
  it("fixes the branch to a commit and fetches every file from that commit", async () => {
    const served = new Map([["oresme-plugin.json", encode(manifest())], ...files()]);
    const { fetchImpl, asked } = fakeGitHub(served);
    const pkg = await fetchFromGitHub(github, fetchImpl);
    expect(pkg.lock.commit).toBe("d".repeat(40));
    expect(asked[0]).toBe("https://api.github.com/repos/lab/ec/commits/main");
    expect(asked.slice(1).every((url) => url.includes(`/${"d".repeat(40)}/`))).toBe(true);
    expect(pkg.manifest.name).toBe("electrochem");
  });

  it("refuses a package with a file missing", async () => {
    const served = new Map([
      ["oresme-plugin.json", encode(manifest())],
      ["electrochem.py", encode("")],
    ]);
    const { fetchImpl } = fakeGitHub(served);
    await expect(fetchFromGitHub(github, fetchImpl)).rejects.toThrow(/styles\/paper.json \(404\)/);
  });

  it("says when the repository or branch is not there", async () => {
    const fetchImpl = () => Promise.resolve(new Response("", { status: 404 }));
    await expect(fetchFromGitHub(github, fetchImpl)).rejects.toThrow(/GitHub has no lab\/ec/);
  });
});

describe("reading a plugin from files", () => {
  const picked = (entries: Record<string, Uint8Array>) =>
    Object.entries(entries).map(([path, bytes]) => ({ path, bytes: () => Promise.resolve(bytes) }));

  it("takes the folder that holds the manifest, and only the files it lists", async () => {
    const pkg = await readLocalPackage(
      picked({
        "electrochem-plugin/oresme-plugin.json": encode(manifest()),
        "electrochem-plugin/electrochem.py": encode("x = 1\n"),
        "electrochem-plugin/styles/paper.json": encode({}),
        "electrochem-plugin/README.md": encode("# notes"),
      }),
    );
    expect(pkg.lock.files.map((file) => file.path)).toEqual([
      "electrochem.py",
      "styles/paper.json",
    ]);
    expect(pkg.lock.source).toEqual({ kind: "local", label: "electrochem" });
  });

  it("reads a zip, and never takes a file from outside the package", async () => {
    const zip = zipSync({
      "oresme-plugin.json": encode(manifest()),
      "electrochem.py": encode("x = 1\n"),
      "styles/paper.json": encode({}),
      "../escape.py": strToU8("import js\n"),
    });
    const pkg = await readLocalPackage(picked({ "plugin.zip": zip }));
    expect(pkg.lock.files.map((file) => file.path)).toEqual([
      "electrochem.py",
      "styles/paper.json",
    ]);
  });

  it("refuses a zip that unpacks to more than a package may hold", () => {
    // Compresses to almost nothing, unpacks to 9 MiB.
    const zip = zipSync({
      "oresme-plugin.json": encode(manifest()),
      "big.bin": new Uint8Array(9 * 1024 * 1024),
    });
    expect(zip.byteLength).toBeLessThan(100_000);
    expect(() => unzipPackage(zip)).toThrow(/more than a plugin package may/);
  });
});

/** A sandbox that runs the action in JavaScript, as the plugin's Python would. */
function fakeSandbox(onRun?: (request: RunRequest) => void) {
  const runs: RunRequest[] = [];
  let destroyed = false;
  const sandbox = {
    load: () => Promise.resolve(["scale"]),
    run: (request: RunRequest) => {
      runs.push(request);
      onRun?.(request);
      const input = request.inputs.y as { data: ArrayBuffer; x0: number; dx: number };
      const factor = (request.params.factor as number | undefined) ?? 2;
      const data = new Float64Array(input.data).map((value) => value * factor);
      const made = (values: Float64Array) => ({
        type: "float64",
        shape: [values.length],
        data: values,
        imag: null,
        x0: input.x0,
        dx: input.dx,
        xUnit: "",
        y0: 0,
        dy: 1,
        yUnit: "",
        unit: "",
        note: "",
      });
      // With parts, also a wave for each part and a graph of them all.
      const parts = (request.params.parts as number | undefined) ?? 0;
      const roles = Array.from({ length: parts }, (_, index) => `part${index}`);
      const trace = (y: string) => ({
        y,
        x: null,
        vAxis: "left",
        hAxis: "bottom",
        legend: y,
        props: {},
      });
      return Promise.resolve({
        waves: [
          ["scaled", made(data)],
          ...roles.map((role, index) => [role, made(data.map((value) => value + index))]),
        ],
        values: { result: { names: ["factor"], coef: [factor], sigma: [0] } },
        graph:
          parts > 0
            ? {
                name: "Parts",
                traces: [trace("scaled"), ...roles.map(trace)],
                axes: {},
                graph: {},
                annotations: [{ kind: "legend", text: null, props: {} }],
              }
            : null,
        log: "scaled\n",
      });
    },
    destroy: () => {
      destroyed = true;
    },
    get isDestroyed() {
      return destroyed;
    },
  };
  return { sandbox: sandbox as unknown as Sandbox, runs };
}

async function setUp(onRun?: (request: RunRequest) => void) {
  const doc = new Doc();
  doc.dispatch({ op: "makeWave", name: "signal", data: new Float64Array([1, 2, 3]) });
  const store = new PluginStore(new MemoryPluginStorage());
  await store.install(await packageOf());
  const fake = fakeSandbox(onRun);
  let started = 0;
  const host = new PluginHost({
    store,
    doc,
    pyodideURL: "/pyodide/",
    createSandbox: () => {
      started += 1;
      return Promise.resolve(fake.sandbox);
    },
  });
  return { doc, store, host, fake, started: () => started };
}

describe("running a plugin's action", () => {
  it("lists the actions of the plugins that are on", async () => {
    const { host, store } = await setUp();
    expect(host.catalog().map((spec) => spec.id)).toEqual(["plugin.electrochem.scale"]);
    await store.setEnabled("electrochem", false);
    expect(host.catalog()).toEqual([]);
  });

  it("hands over copies of the waves and keeps what comes back as one change", async () => {
    const { doc, host, fake } = await setUp();
    const outcome = await host.run("plugin.electrochem.scale", { y: "signal", factor: 3 });
    expect(outcome).toMatchObject({ waves: { scaled: "signal_scaled" }, log: "scaled\n" });
    const state = doc.getState();
    expect([...state.waves.signal_scaled!.data]).toEqual([3, 6, 9]);
    expect(state.results[outcome.result!]).toMatchObject({
      kind: "plugin",
      source: {
        action: "plugin.electrochem.scale",
        plugin: "electrochem",
        origin: "github:lab/ec",
        commit: "c".repeat(40),
      },
    });
    // The document's own array was not handed over.
    const handed = fake.runs[0]!.inputs.y as { data: ArrayBuffer };
    expect(handed.data).not.toBe(state.waves.signal!.data.buffer);
    expect([...new Float64Array(handed.data)]).toEqual([1, 2, 3]);
    doc.undo();
    expect(doc.getState().waves.signal_scaled).toBeUndefined();
    expect(Object.keys(doc.getState().results)).toEqual([]);
  });

  it("starts one sandbox and stops it when the plugin is turned off", async () => {
    const { host, store, fake, started } = await setUp();
    await host.run("plugin.electrochem.scale", { y: "signal" });
    await host.run("plugin.electrochem.scale", { y: "signal" });
    expect(started()).toBe(1);
    await store.setEnabled("electrochem", false);
    await Promise.resolve();
    expect(fake.sandbox.isDestroyed).toBe(true);
    await expect(host.run("plugin.electrochem.scale", { y: "signal" })).rejects.toThrow(
      /turned off/,
    );
  });

  it("hands over a text wave only to an argument that takes them", async () => {
    const { doc, host, fake } = await setUp();
    doc.dispatch({ op: "makeWave", name: "names", text: ["a", "b", "c"] });
    const refused = host.run("plugin.electrochem.scale", { y: "names" });
    await expect(refused).rejects.toThrow("names is a text wave; y takes numeric waves.");
    await expect(refused).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { field: "y" },
    });
    expect(fake.runs).toEqual([]);

    await host.run("plugin.electrochem.scale", { y: "signal", labels: "names" });
    expect(fake.runs[0]!.inputs.labels).toMatchObject({
      name: "names",
      dtype: "text",
      shape: [3],
      text: ["a", "b", "c"],
    });
    // A copy, not the document's own list.
    expect((fake.runs[0]!.inputs.labels as { text: string[] }).text).not.toBe(
      doc.getState().waves.names!.text,
    );
  });

  it("refuses arguments the action does not take before anything runs", async () => {
    const { host, fake } = await setUp();
    await expect(host.run("plugin.electrochem.scale", { y: "nothing" })).rejects.toThrow(
      /no wave named/,
    );
    await expect(host.run("plugin.electrochem.scale", { y: "signal", extra: 1 })).rejects.toThrow(
      /no argument/,
    );
    await expect(host.run("plugin.electrochem.unknown", {})).rejects.toThrow(/No installed plugin/);
    expect(fake.runs).toEqual([]);
  });

  it("keeps nothing when a wave it was given changed while it ran", async () => {
    let doc: Doc | null = null;
    const set = await setUp(() =>
      doc!.dispatch({ op: "setWavePoints", name: "signal", start: 0, values: [100] }),
    );
    doc = set.doc;
    await expect(set.host.run("plugin.electrochem.scale", { y: "signal" })).rejects.toThrow(
      /signal changed while the plugin was running/,
    );
    expect(set.doc.getState().waves.signal_scaled).toBeUndefined();
  });

  it("keeps nothing of a run stopped while it ran, and says it was stopped", async () => {
    const controller = new AbortController();
    const set = await setUp((request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
    });
    const run = set.host.run("plugin.electrochem.scale", { y: "signal" }, null, {
      signal: controller.signal,
    });
    await expect(run).rejects.toMatchObject({ details: { phase: "stopped" } });
    expect(set.doc.getState().waves.signal_scaled).toBeUndefined();
    // Stopped before it began, it does not start.
    await expect(
      set.host.run("plugin.electrochem.scale", { y: "signal" }, null, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ details: { phase: "stopped" } });
    expect(set.fake.runs).toHaveLength(1);
  });

  it("takes a wave named from root, and keeps its result under the wave's own name", async () => {
    const { doc, host } = await setUp();
    doc.dispatch({ op: "makeWave", name: "signal_scaled", data: new Float64Array([0]) });
    const outcome = await host.run("plugin.electrochem.scale", { y: "root:signal", factor: 2 });
    // Next to "signal", and not over the "signal_scaled" that is there.
    expect(outcome.waves).toEqual({ scaled: "signal_scaled_1" });
    const result = doc.getState().results[outcome.result!]!;
    expect(result.inputs.map((input) => input.wave)).toEqual(["signal"]);
    expect(result.settings).toMatchObject({ inputs: { y: "signal" }, params: { factor: 2 } });
  });

  it("puts its waves into a block of Python's that is open", async () => {
    const { doc, host } = await setUp();
    const stage = doc.stage();
    stage.dispatch({ op: "makeWave", name: "staged", data: new Float64Array([5]) });
    await host.run("plugin.electrochem.scale", { y: "staged" }, stage);
    expect(doc.getState().waves.staged_scaled).toBeUndefined();
    stage.commit();
    expect([...doc.getState().waves.staged_scaled!.data]).toEqual([10]);
  });
});

describe("previews and runs that replace what the last run made", () => {
  const id = "plugin.electrochem.scale";

  it("previews without putting anything in the experiment", async () => {
    const { doc, host } = await setUp();
    const before = doc.getState();
    const outcome = await host.preview(id, { y: "signal", factor: 4 });
    expect([...(outcome.waves[0]![1].data as Float64Array)]).toEqual([4, 8, 12]);
    expect(doc.getState()).toBe(before);
  });

  it("never replaces unless asked", async () => {
    const { host } = await setUp();
    await host.run(id, { y: "signal" });
    const again = await host.run(id, { y: "signal" });
    expect(again.waves).toEqual({ scaled: "signal_scaled_1" });
  });

  it("makes again under their names the waves its last run made from the same inputs", async () => {
    const { doc, host } = await setUp();
    doc.dispatch({ op: "makeWave", name: "other", data: new Float64Array([1, 1, 1]) });
    await host.run(id, { y: "signal" });
    // Another input's run is no reason to replace this one's.
    await host.run(id, { y: "other" }, null, { replace: true });
    const again = await host.run(id, { y: "signal", factor: 3 }, null, { replace: true });
    expect(again.waves).toEqual({ scaled: "signal_scaled" });
    const state = doc.getState();
    expect([...state.waves.signal_scaled!.data]).toEqual([3, 6, 9]);
    expect(state.waves.other_scaled).toBeDefined();
    expect(Object.keys(state.results)).toHaveLength(3);
    // As one change: undone, the wave is what the first run made.
    doc.undo();
    expect([...doc.getState().waves.signal_scaled!.data]).toEqual([2, 4, 6]);
  });

  it("leaves a wave changed since alone, and one the plugin did not make", async () => {
    const { doc, host } = await setUp();
    await host.run(id, { y: "signal" });
    doc.dispatch({ op: "setWavePoints", name: "signal_scaled", start: 0, values: [100] });
    const again = await host.run(id, { y: "signal" }, null, { replace: true });
    expect(again.waves).toEqual({ scaled: "signal_scaled_1" });
    expect(doc.getState().waves.signal_scaled!.data[0]).toBe(100);
    // With no run of its own before, a wave of the same name is not its to replace.
    doc.dispatch({ op: "makeWave", name: "mine", data: new Float64Array([7, 7, 7]) });
    doc.dispatch({ op: "makeWave", name: "mine_scaled", data: new Float64Array([0]) });
    const first = await host.run(id, { y: "mine" }, null, { replace: true });
    expect(first.waves).toEqual({ scaled: "mine_scaled_1" });
  });

  it("leaves a wave renamed since alone, though its result follows it", async () => {
    const { doc, host } = await setUp();
    const first = await host.run(id, { y: "signal" });
    doc.dispatch({ op: "renameWave", name: "signal_scaled", newName: "saved_fit" });
    expect(doc.getState().results[first.result!]!.outputs).toEqual({ scaled: "saved_fit" });
    const again = await host.run(id, { y: "signal", factor: 5 }, null, { replace: true });
    expect(again.waves).toEqual({ scaled: "signal_scaled" });
    expect([...doc.getState().waves.saved_fit!.data]).toEqual([2, 4, 6]);
  });

  it("updates the graph its last run made, and drops what it no longer makes", async () => {
    const { doc, host } = await setUp();
    const first = await host.run(id, { y: "signal", parts: 2 });
    expect(first.graph).toBe("Parts0");
    doc.dispatch({
      op: "modifyTrace",
      graph: "Parts0",
      trace: "signal_scaled",
      props: { color: "#123456" },
    });
    const again = await host.run(id, { y: "signal", parts: 1 }, null, { replace: true });
    expect(again.graph).toBe("Parts0");
    const state = doc.getState();
    expect(Object.keys(state.graphs)).toEqual(["Parts0"]);
    const graph = state.graphs.Parts0!;
    expect(graph.traces.map((trace) => trace.y)).toEqual(["signal_scaled", "signal_part0"]);
    // What was changed in the graph stays; the legend lists the traces again.
    expect(graph.traces[0]!.color).toBe("#123456");
    expect(graph.annotations[0]!.text.split("\n")).toHaveLength(2);
    expect(state.waves.signal_part1).toBeUndefined();
    // Two parts again: the trace goes back in.
    await host.run(id, { y: "signal", parts: 2 }, null, { replace: true });
    expect(doc.getState().graphs.Parts0!.traces.map((trace) => trace.y)).toEqual([
      "signal_scaled",
      "signal_part0",
      "signal_part1",
    ]);
  });
});

describe("what a plugin brings as data", () => {
  const template = { slots: [{ name: "y", role: "y" }], traces: [{ y: "y" }] };

  it("reads a file of graph templates as the app exports it, by their names", () => {
    const exported = {
      format: "oresme-graph-templates",
      version: 1,
      templates: { Bode: template },
    };
    const commands = contributionCommands("graphTemplates", "t/bode.json", encode(exported));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ op: "setGraphTemplate", name: "Bode" });
    const doc = new Doc();
    doc.dispatch(commands[0]!);
    expect(doc.getState().graphTemplates.Bode!.slots[0]).toMatchObject({ name: "y", role: "y" });
  });

  it("reads one entry, named by its name (which is not part of it) or by its file", () => {
    const doc = new Doc();
    for (const command of [
      ...contributionCommands("graphTemplates", "t/a.json", encode({ name: "Named", ...template })),
      ...contributionCommands("graphTemplates", "t/plain.json", encode(template)),
      ...contributionCommands("styles", "s/paper.json", encode({ graph: { fontSize: 12 } })),
    ]) {
      doc.dispatch(command);
    }
    expect(Object.keys(doc.getState().graphTemplates)).toEqual(["Named", "plain"]);
    expect(doc.getState().styles.paper).toMatchObject({ graph: { fontSize: 12 } });
  });

  it("refuses a file of templates with one that is not valid", () => {
    const exported = { format: "oresme-graph-templates", templates: { Bad: { traces: [{}] } } };
    expect(() => contributionCommands("graphTemplates", "bad.json", encode(exported))).toThrow(
      /bad.json: Bad/,
    );
  });
});
