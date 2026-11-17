import { isTimeZone } from "../plot/ticks";
import { checkAttributeName, checkAttributeValue, isFolderKey } from "./attributes";
import { dict, filterDict, withEntry, withoutEntries } from "./dict";
import { checkPackage, withPackages, withoutPackages } from "./pythonEnv";
import { checkResult, keptFolder, RESULT_BASE, RESULT_KINDS } from "./results";
import { captureTemplate, makeFromTemplate } from "./graphTemplates";
import { applyPanelCommand } from "./panels";
import {
  checkAnalysisTemplate,
  checkRun,
  renameResultInRun,
  RUN_BASE,
  withSampleOutcome,
  type TemplateRun,
} from "./analysisTemplates";
import { captureStyle } from "./styles";
import {
  DEFAULT_TABLE_DIGITS,
  DocError,
  PAGE_SIZES,
  type DocState,
  type GraphSpec,
  type TableSpec,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type PageItem,
  type PageSpec,
  type ProcedureSpec,
} from "./types";
import {
  type Command,
  type CommandOutcome,
  checkEditorMemory,
  editorMemoryKey,
} from "./commandTypes";
import {
  ITEM_VALIDATORS,
  type ItemProps,
  PAGE_VALIDATORS,
  checkGraphTemplate,
  checkStyle,
  putAnalysisTemplate,
  putPage,
  putTemplate,
  requireAnalysisTemplate,
  requirePage,
  requireRun,
  requireStyle,
  requireTemplate,
  validateProps,
  withStyle,
} from "./graphProps";
import { applyGraphCommand, isGraphCommand } from "./graphCommands";
import { applyWaveCommand, isWaveCommand, requireItem } from "./waveCommands";
import {
  bool,
  checkName,
  dropKept,
  followRange,
  importAsName,
  keepOutputs,
  oneOf,
  placeWindow,
  procedureName,
  putGraph,
  putTable,
  renamedEntry,
  requireGraph,
  requireTable,
  requireWave,
  requireWindow,
  uniqueName,
  unlink,
  windowTaken,
} from "./commandSupport";

// What other modules have always imported from here.
export {
  isTransient,
  editorMemoryKey,
  checkEditorMemory,
  type Command,
  type CommandOutcome,
} from "./commandTypes";
export {
  checkName,
  checkPath,
  sanitizeName,
  uniqueName,
  oneOf,
  windowTaken,
  importAsName,
  procedureName,
  placeWindow,
  emptyGraph,
  waveUsers,
} from "./commandSupport";
export { checkPlotDimension, savedPlotSize, checkStyle, checkGraphTemplate } from "./graphProps";
export { settleFormulas } from "./waveCommands";

/** Applies one command. Pure: returns a new state, or throws {@link DocError}. */
export function applyCommand(state: DocState, command: Command): CommandOutcome {
  if (isWaveCommand(command)) return applyWaveCommand(state, command);
  if (isGraphCommand(command)) return applyGraphCommand(state, command);
  switch (command.op) {
    case "edit": {
      const name =
        command.name === undefined
          ? uniqueName("Table", windowTaken(state))
          : checkName(command.name, "table");
      if (windowTaken(state)(name)) {
        throw new DocError(
          `A window named ${JSON.stringify(name)} already exists.`,
          "ALREADY_EXISTS",
          { name: name },
        );
      }
      const columns = [...new Set(command.waves.map((wave) => requireWave(state, wave).name))];
      return {
        state: {
          ...putTable(state, { name, columns, digits: DEFAULT_TABLE_DIGITS, widths: dict() }),
          windows: [...state.windows, placeWindow(state, name, "table")],
        },
        result: name,
      };
    }
    case "appendToTable": {
      const table = requireTable(state, command.table);
      const added = command.waves.map((wave) => requireWave(state, wave).name);
      const columns = [...new Set([...table.columns, ...added])];
      return { state: putTable(state, { ...table, columns }), result: null };
    }
    case "removeFromTable": {
      const table = requireTable(state, command.table);
      const columns = table.columns.filter((column) => !command.waves.includes(column));
      const widths = filterDict(table.widths, (_, wave) => columns.includes(wave));
      return { state: putTable(state, { ...table, columns, widths }), result: null };
    }
    case "modifyTable": {
      const table = requireTable(state, command.table);
      const props = validateProps<Pick<TableSpec, "digits">>(
        command.props,
        {
          digits: (value) => {
            if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 17) {
              throw new DocError(
                "digits must be a whole number from 1 to 17.",
                "INVALID_ARGUMENT",
                { field: "digits" },
              );
            }
            return value;
          },
        },
        "table",
      );
      return { state: putTable(state, { ...table, ...props }), result: null };
    }
    case "resizeColumn": {
      const table = requireTable(state, command.table);
      if (!table.columns.includes(command.wave)) return { state, result: null };
      const width = Math.round(Math.max(32, Math.min(800, command.width)));
      return {
        state: putTable(state, { ...table, widths: withEntry(table.widths, command.wave, width) }),
        result: null,
      };
    }
    case "setTimeZone": {
      if (!isTimeZone(command.zone)) {
        throw new DocError(
          `${JSON.stringify(command.zone)} is not a time zone. Use "UTC", "local" or a name such as "Asia/Tokyo".`,
          "INVALID_ARGUMENT",
          { field: "zone" },
        );
      }
      return { state: { ...state, timeZone: command.zone }, result: null };
    }
    case "newLayout": {
      const name =
        command.name === undefined
          ? uniqueName("Layout", windowTaken(state))
          : checkName(command.name, "layout");
      if (windowTaken(state)(name)) {
        throw new DocError(
          `A window named ${JSON.stringify(name)} already exists.`,
          "ALREADY_EXISTS",
          { name: name },
        );
      }
      const page: PageSpec = {
        name,
        width: PAGE_VALIDATORS.width(command.width ?? PAGE_SIZES.A4[0]),
        height: PAGE_VALIDATORS.height(command.height ?? PAGE_SIZES.A4[1]),
        items: [],
      };
      return {
        state: {
          ...state,
          pages: withEntry(state.pages, name, page),
          windows: [...state.windows, placeWindow(state, name, "page")],
        },
        result: name,
      };
    }
    case "modifyLayout": {
      const page = requirePage(state, command.layout);
      const props = validateProps<Pick<PageSpec, "width" | "height">>(
        command.props,
        PAGE_VALIDATORS,
        "layout",
      );
      return { state: putPage(state, { ...page, ...props }), result: null };
    }
    case "addLayoutItem": {
      const page = requirePage(state, command.layout);
      const kind = oneOf(command.kind, ["graph", "text"] as const, "kind");
      const margin = 36;
      // Below what is there already, or back at the top if that is off the page.
      let below = margin;
      for (const item of page.items) below = Math.max(below, item.y + item.h + 12);
      const base = { x: margin, y: below < page.height - 2 * margin ? below : margin };
      let item: PageItem;
      if (kind === "graph") {
        const graph = requireGraph(state, command.graph ?? "");
        const w = Math.min(page.width - 2 * margin, 440);
        item = {
          name: uniqueName("graph", (name) => page.items.some((other) => other.name === name)),
          kind,
          graph: graph.name,
          text: "",
          ...base,
          w,
          h: Math.round(w * 0.68),
          size: 12,
        };
      } else {
        if (typeof command.text !== "string" || command.text === "") {
          throw new DocError("Give the text to put on the page.");
        }
        item = {
          name: uniqueName("text", (name) => page.items.some((other) => other.name === name)),
          kind,
          graph: null,
          text: command.text,
          ...base,
          w: 0,
          h: 0,
          size: 12,
        };
      }
      const given: Record<string, unknown> = {};
      for (const key of ["x", "y", "w", "h", "size"] as const) {
        if (command[key] !== undefined) given[key] = command[key];
      }
      item = { ...item, ...validateProps<ItemProps>(given, ITEM_VALIDATORS, "item") };
      return {
        state: putPage(state, { ...page, items: [...page.items, item] }),
        result: item.name,
      };
    }
    case "modifyLayoutItem": {
      const page = requirePage(state, command.layout);
      const target = requireItem(page.items, command.item, page.name, "item");
      const props = validateProps<ItemProps>(command.props, ITEM_VALIDATORS, "item");
      const items = page.items.map((item) => (item === target ? { ...item, ...props } : item));
      return { state: putPage(state, { ...page, items }), result: null };
    }
    case "removeLayoutItem": {
      const page = requirePage(state, command.layout);
      const target = requireItem(page.items, command.item, page.name, "item");
      return {
        state: putPage(state, { ...page, items: page.items.filter((item) => item !== target) }),
        result: null,
      };
    }
    case "newPanel":
    case "setPanel":
    case "modifyPanel":
    case "addControl":
    case "modifyControl":
    case "removeControl":
    case "moveControl":
    case "setControlValue":
      return applyPanelCommand(state, command);
    case "newProcedure": {
      let name = "Procedure";
      if (command.name !== undefined) {
        name = procedureName(command.name);
      } else {
        // Procedure, Procedure1, Procedure2: the first is plain, like Igor's.
        for (let count = 1; windowTaken(state)(name); count += 1) name = `Procedure${count}`;
      }
      if (windowTaken(state)(name)) {
        throw new DocError(
          `A window named ${JSON.stringify(name)} already exists.`,
          "ALREADY_EXISTS",
          { name: name },
        );
      }
      if (command.code !== undefined && typeof command.code !== "string") {
        throw new DocError("code must be text.", "INVALID_ARGUMENT", { field: "code" });
      }
      const procedure: ProcedureSpec = {
        name,
        code: command.code ?? "",
        autoRun: command.autoRun === undefined ? true : bool(command.autoRun, "autoRun"),
        importAs: command.importAs === undefined ? null : importAsName(command.importAs),
      };
      return {
        state: {
          ...state,
          procedures: withEntry(state.procedures, name, procedure),
          windows: [...state.windows, placeWindow(state, name, "procedure")],
        },
        result: name,
      };
    }
    case "setProcedure": {
      const procedure = state.procedures[command.name];
      if (!procedure)
        throw new DocError(`No procedure named ${JSON.stringify(command.name)}.`, "NOT_FOUND", {
          kind: "procedure",
          name: command.name,
        });
      if (command.code !== undefined && typeof command.code !== "string") {
        throw new DocError("code must be text.", "INVALID_ARGUMENT", { field: "code" });
      }
      const next: ProcedureSpec = {
        ...procedure,
        code: command.code ?? procedure.code,
        autoRun:
          command.autoRun === undefined ? procedure.autoRun : bool(command.autoRun, "autoRun"),
        importAs:
          command.importAs === undefined ? procedure.importAs : importAsName(command.importAs),
      };
      if (
        next.code === procedure.code &&
        next.autoRun === procedure.autoRun &&
        next.importAs === procedure.importAs
      ) {
        return { state, result: null };
      }
      return {
        state: { ...state, procedures: withEntry(state.procedures, command.name, next) },
        result: null,
      };
    }
    case "newNote": {
      let name = "Note0";
      if (command.name !== undefined) {
        name = checkName(command.name, "note");
      } else {
        // Note0, Note1, ...: numbered from zero as graphs and tables are.
        for (let count = 1; windowTaken(state)(name); count += 1) name = `Note${count}`;
      }
      if (windowTaken(state)(name)) {
        throw new DocError(
          `A window named ${JSON.stringify(name)} already exists.`,
          "ALREADY_EXISTS",
          { name: name },
        );
      }
      if (command.text !== undefined && typeof command.text !== "string") {
        throw new DocError("text must be text.", "INVALID_ARGUMENT", { field: "text" });
      }
      return {
        state: {
          ...state,
          notes: withEntry(state.notes, name, { name, text: command.text ?? "" }),
          windows: [...state.windows, placeWindow(state, name, "note")],
        },
        result: name,
      };
    }
    case "setNote": {
      const note = state.notes[command.name];
      if (!note)
        throw new DocError(`No note named ${JSON.stringify(command.name)}.`, "NOT_FOUND", {
          kind: "note",
          name: command.name,
        });
      if (typeof command.text !== "string")
        throw new DocError("text must be text.", "INVALID_ARGUMENT", { field: "text" });
      if (command.text === note.text) return { state, result: null };
      return {
        state: {
          ...state,
          notes: withEntry(state.notes, command.name, { ...note, text: command.text }),
        },
        result: null,
      };
    }
    case "saveStyle": {
      const name = checkName(command.name, "style");
      requireGraph(state, command.graph);
      const style = captureStyle(state, command.graph, command.size === true);
      return { state: { ...state, styles: withEntry(state.styles, name, style) }, result: name };
    }
    case "setStyle": {
      const name = checkName(command.name, "style");
      const style = checkStyle(command.style);
      return { state: { ...state, styles: withEntry(state.styles, name, style) }, result: name };
    }
    case "addResult": {
      const kind = RESULT_KINDS.find(
        (item) => item === (command.result as { kind?: unknown } | null)?.kind,
      );
      const taken = (name: string) => name in state.results;
      // A name that is given replaces the result of that name: the same analysis, run again.
      const name =
        command.name === undefined
          ? uniqueName(RESULT_BASE[kind ?? "fit"], taken)
          : checkName(command.name, "result");
      const result = checkResult(command.result, name, state);
      // The result run again under its name keeps what it makes now, not what it made before.
      const before = state.results[name];
      const { state: next, kept } = keepOutputs(
        before ? dropKept(state, before) : state,
        name,
        result.outputs,
      );
      return {
        state: { ...next, results: withEntry(next.results, name, { ...result, kept }) },
        result: name,
      };
    }
    case "removeResults": {
      let next = state;
      for (const name of command.names) {
        const result = state.results[name];
        if (!result)
          throw new DocError(`No result named ${JSON.stringify(name)}.`, "NOT_FOUND", {
            kind: "result",
            name: name,
          });
        next = dropKept(next, result);
      }
      return {
        state: { ...next, results: withoutEntries(next.results, command.names) },
        result: null,
      };
    }
    case "renameResult": {
      const result = state.results[command.name];
      if (!result)
        throw new DocError(`No result named ${JSON.stringify(command.name)}.`, "NOT_FOUND", {
          kind: "result",
          name: command.name,
        });
      const newName = checkName(command.newName, "result");
      if (newName === command.name) return { state, result: newName };
      if (newName in state.results) {
        throw new DocError(
          `A result named ${JSON.stringify(newName)} already exists.`,
          "ALREADY_EXISTS",
          { name: newName },
        );
      }
      // Its copies move with it, and whatever names them follows (graphs, the result itself).
      let moved = state;
      if (state.folders.includes(keptFolder(command.name))) {
        moved = applyCommand(state, {
          op: "renameFolder",
          path: keptFolder(command.name),
          newPath: keptFolder(newName),
        }).state;
      }
      const runs = dict<TemplateRun>();
      for (const run of Object.values(moved.runs)) {
        runs[run.name] = renameResultInRun(run, command.name, newName);
      }
      return {
        state: {
          ...moved,
          results: withEntry(withoutEntries(moved.results, [command.name]), newName, {
            ...moved.results[command.name]!,
            name: newName,
          }),
          runs,
        },
        result: newName,
      };
    }
    case "setTemplate": {
      const name = checkName(command.name, "template");
      const template = checkAnalysisTemplate(command.template);
      return { state: putAnalysisTemplate(state, name, template), result: name };
    }
    case "removeTemplate": {
      requireAnalysisTemplate(state, command.name);
      return {
        state: { ...state, templates: withoutEntries(state.templates, [command.name]) },
        result: null,
      };
    }
    case "renameTemplate": {
      const template = requireAnalysisTemplate(state, command.name);
      const newName = checkName(command.newName, "template");
      if (newName === command.name) return { state, result: newName };
      if (newName in state.templates) {
        throw new DocError(
          `Template ${JSON.stringify(newName)} already exists.`,
          "ALREADY_EXISTS",
          { name: newName },
        );
      }
      const templates = withEntry(
        withoutEntries(state.templates, [command.name]),
        newName,
        template,
      );
      return { state: { ...state, templates }, result: newName };
    }
    case "addRun": {
      const taken = (name: string) => name in state.runs;
      const name =
        command.name === undefined ? uniqueName(RUN_BASE, taken) : checkName(command.name, "run");
      if (taken(name))
        throw new DocError(
          `A run named ${JSON.stringify(name)} already exists.`,
          "ALREADY_EXISTS",
          { name: name },
        );
      const run = checkRun(command.run, name);
      return { state: { ...state, runs: withEntry(state.runs, name, run) }, result: name };
    }
    case "updateRunSample": {
      const run = requireRun(state, command.run);
      const { op: _op, run: _run, index, ...outcome } = command;
      const next = withSampleOutcome(state, run, index, outcome);
      return { state: { ...state, runs: withEntry(state.runs, run.name, next) }, result: null };
    }
    case "removeRuns": {
      for (const name of command.names) requireRun(state, name);
      return { state: { ...state, runs: withoutEntries(state.runs, command.names) }, result: null };
    }
    case "removeStyle": {
      requireStyle(state, command.name);
      const graphs = dict<GraphSpec>();
      for (const graph of Object.values(state.graphs)) {
        graphs[graph.name] = graph.style === command.name ? { ...graph, style: null } : graph;
      }
      return {
        state: {
          ...state,
          graphs,
          styles: withoutEntries(state.styles, [command.name]),
          defaultStyle: state.defaultStyle === command.name ? null : state.defaultStyle,
        },
        result: null,
      };
    }
    case "renameStyle": {
      const style = requireStyle(state, command.name);
      const newName = checkName(command.newName, "style");
      if (newName === command.name) return { state, result: null };
      if (newName in state.styles) {
        throw new DocError(`Style ${JSON.stringify(newName)} already exists.`, "ALREADY_EXISTS", {
          name: newName,
        });
      }
      const follow = (name: string | null) => (name === command.name ? newName : name);
      const graphs = dict<GraphSpec>();
      for (const graph of Object.values(state.graphs)) {
        graphs[graph.name] = graph.style === command.name ? { ...graph, style: newName } : graph;
      }
      return {
        state: {
          ...state,
          graphs,
          styles: withEntry(withoutEntries(state.styles, [command.name]), newName, style),
          defaultStyle: follow(state.defaultStyle),
        },
        result: newName,
      };
    }
    case "applyStyle": {
      requireStyle(state, command.style);
      if (!Array.isArray(command.graphs))
        throw new DocError("graphs must be a list of graph names.", "INVALID_ARGUMENT", {
          field: "graphs",
        });
      let next = state;
      for (const name of new Set<string>(command.graphs)) {
        next = withStyle(next, requireGraph(next, name), command.style);
      }
      return { state: next, result: null };
    }
    case "setDefaultStyle": {
      if (command.name !== null) requireStyle(state, command.name);
      if (command.name === state.defaultStyle) return { state, result: null };
      return { state: { ...state, defaultStyle: command.name }, result: null };
    }
    case "saveGraphTemplate": {
      const name = checkName(command.name, "graph template");
      requireGraph(state, command.graph);
      const fixed = command.fixed ?? [];
      if (!Array.isArray(fixed) || fixed.some((axis) => typeof axis !== "string")) {
        throw new DocError("fixed must be a list of axis names.", "INVALID_ARGUMENT", {
          field: "fixed",
        });
      }
      // Checked like a template given as data, which also puts it in the usual order.
      const template = checkGraphTemplate(captureTemplate(state, command.graph, fixed));
      return { state: putTemplate(state, name, template), result: name };
    }
    case "setGraphTemplate": {
      const name = checkName(command.name, "graph template");
      return {
        state: putTemplate(state, name, checkGraphTemplate(command.template)),
        result: name,
      };
    }
    case "removeGraphTemplate": {
      requireTemplate(state, command.name);
      return {
        state: { ...state, graphTemplates: withoutEntries(state.graphTemplates, [command.name]) },
        result: null,
      };
    }
    case "renameGraphTemplate": {
      const template = requireTemplate(state, command.name);
      const newName = checkName(command.newName, "graph template");
      if (newName === command.name) return { state, result: null };
      if (newName in state.graphTemplates) {
        throw new DocError(
          `Graph template ${JSON.stringify(newName)} already exists.`,
          "ALREADY_EXISTS",
          { name: newName },
        );
      }
      const graphTemplates = withEntry(
        withoutEntries(state.graphTemplates, [command.name]),
        newName,
        template,
      );
      return { state: { ...state, graphTemplates }, result: newName };
    }
    case "makeGraphs": {
      const template = requireTemplate(state, command.template);
      const { samples, names } = command;
      if (!Array.isArray(samples) || samples.length === 0) {
        throw new DocError("Give at least one sample: a dict of wave names by slot.");
      }
      if (names !== undefined && (!Array.isArray(names) || names.length !== samples.length)) {
        throw new DocError(
          `names must be a list of ${samples.length} graph names, one for each sample.`,
        );
      }
      // Each graph is made on the document the one before left, so the
      // reducer returns all of them or, if one cannot be made, none.
      let next = state;
      let made: string | null = null;
      samples.forEach((sample: unknown, at) => {
        const name = names?.[at] ?? uniqueName("Graph", windowTaken(next));
        try {
          next = makeFromTemplate(next, template, sample, name, applyCommand);
        } catch (error) {
          if (samples.length > 1 && error instanceof DocError) {
            throw new DocError(`Sample ${at + 1}: ${error.message}`);
          }
          throw error;
        }
        made = name;
      });
      return { state: next, result: made };
    }
    case "linkGraphs": {
      const names = [...new Set(command.graphs)];
      if (names.length < 2) throw new DocError("Link two graphs or more.");
      const graphs = names.map((name) => requireGraph(state, name));
      const axes = oneOf(command.axes ?? "x", ["x", "xy"] as const, "axes");
      const cursors = command.cursors === undefined ? true : bool(command.cursors, "cursors");
      const taken = new Set(Object.values(state.graphs).map((graph) => graph.link?.group));
      const group = uniqueName("Link", (name) => taken.has(name));
      let next = unlink(state, names);
      for (const graph of graphs) {
        next = putGraph(next, { ...next.graphs[graph.name]!, link: { group, axes, cursors } });
      }
      // They start where the first one is.
      const first = next.graphs[names[0]!]!;
      for (const axisName of axes === "xy" ? ["bottom", "left"] : ["bottom"]) {
        const from = first.axes[axisName]!;
        next = followRange(next, first, axisName, { min: from.min, max: from.max });
      }
      return { state: next, result: group };
    }
    case "unlinkGraphs": {
      for (const name of command.graphs) requireGraph(state, name);
      return { state: unlink(state, command.graphs), result: null };
    }
    case "setAttributes": {
      const target = command.target;
      if (typeof target !== "string")
        throw new DocError("target must be a wave or a data folder.", "INVALID_ARGUMENT", {
          field: "target",
        });
      if (isFolderKey(target)) {
        if (!state.folders.includes(target.slice(0, -1))) {
          throw new DocError(
            `No data folder named ${JSON.stringify(target.slice(0, -1))}.`,
            "NOT_FOUND",
            { kind: "data folder", name: target.slice(0, -1) },
          );
        }
      } else {
        requireWave(state, target);
      }
      if (typeof command.values !== "object" || command.values === null) {
        throw new DocError(
          "values must be a dict of attribute names and values.",
          "INVALID_ARGUMENT",
          { field: "values" },
        );
      }
      const key = isFolderKey(target) ? target : requireWave(state, target).name;
      const next: Record<string, number | string> = { ...state.attributes[key] };
      for (const [name, value] of Object.entries(command.values)) {
        checkAttributeName(name);
        if (value === null) delete next[name];
        else next[name] = checkAttributeValue(value, name);
      }
      const attributes =
        Object.keys(next).length > 0
          ? withEntry(state.attributes, key, next)
          : withoutEntries(state.attributes, [key]);
      return { state: { ...state, attributes }, result: null };
    }
    case "recordPackages": {
      if (!Array.isArray(command.packages))
        throw new DocError("packages must be a list.", "INVALID_ARGUMENT", { field: "packages" });
      const packages = command.packages.map(checkPackage);
      if (typeof command.pyodide !== "string")
        throw new DocError("pyodide must be a version.", "INVALID_ARGUMENT", { field: "pyodide" });
      return {
        state: { ...state, python: withPackages(state.python, packages, command.pyodide) },
        result: null,
      };
    }
    case "forgetPackages": {
      return {
        state: { ...state, python: withoutPackages(state.python, command.names) },
        result: null,
      };
    }
    case "keepEditorState": {
      const key = editorMemoryKey(command.plugin, command.editor);
      if (command.state === null || command.state === undefined) {
        if (!(key in state.editors)) return { state, result: null };
        return { state: { ...state, editors: withoutEntries(state.editors, [key]) }, result: null };
      }
      const memory = checkEditorMemory({ ...command });
      return { state: { ...state, editors: withEntry(state.editors, key, memory) }, result: null };
    }
    case "killWindow": {
      if (!windowTaken(state)(command.name)) {
        throw new DocError(`No window named ${JSON.stringify(command.name)}.`, "NOT_FOUND", {
          kind: "window",
          name: command.name,
        });
      }
      const gone = [command.name];
      let pages = withoutEntries(state.pages, gone);
      // A graph that is closed leaves the pages it was on.
      if (command.name in state.graphs) {
        for (const [name, page] of Object.entries(pages)) {
          if (page.items.some((item) => item.graph === command.name)) {
            pages = withEntry(pages, name, {
              ...page,
              items: page.items.filter((item) => item.graph !== command.name),
            });
          }
        }
      }
      return {
        state: {
          ...state,
          graphs: withoutEntries(state.graphs, gone),
          tables: withoutEntries(state.tables, gone),
          procedures: withoutEntries(state.procedures, gone),
          pages,
          panels: withoutEntries(state.panels, gone),
          notes: withoutEntries(state.notes, gone),
          windows: state.windows.filter((window) => window.name !== command.name),
        },
        result: null,
      };
    }
    case "closeWindow": {
      const target = requireWindow(state, command.name);
      if (target.hidden) return { state, result: null };
      // To the back, so the window in front of the others is always an open one.
      return {
        state: {
          ...state,
          windows: [
            { ...target, hidden: true },
            ...state.windows.filter((window) => window !== target),
          ],
        },
        result: null,
      };
    }
    case "reopenWindow": {
      const target = requireWindow(state, command.name);
      const { hidden: _, ...open } = target;
      if (!target.hidden && state.windows.at(-1) === target) return { state, result: null };
      return {
        state: {
          ...state,
          windows: [...state.windows.filter((window) => window !== target), open],
        },
        result: null,
      };
    }
    case "renameWindow": {
      const target = requireWindow(state, command.name);
      const newName =
        target.kind === "procedure"
          ? procedureName(command.newName)
          : checkName(command.newName, target.kind === "page" ? "page layout" : target.kind);
      if (newName === target.name) return { state, result: newName };
      if (windowTaken(state)(newName)) {
        throw new DocError(
          `A window named ${JSON.stringify(newName)} already exists.`,
          "ALREADY_EXISTS",
          { name: newName },
        );
      }
      const { name } = target;
      let pages = renamedEntry(state.pages, name, newName);
      // Page layouts show graphs by name.
      if (target.kind === "graph") {
        pages = dict<PageSpec>(
          Object.entries(pages).map(([key, page]): [string, PageSpec] => [
            key,
            page.items.some((item) => item.graph === name)
              ? {
                  ...page,
                  items: page.items.map((item) =>
                    item.graph === name ? { ...item, graph: newName } : item,
                  ),
                }
              : page,
          ]),
        );
      }
      return {
        state: {
          ...state,
          graphs: renamedEntry(state.graphs, name, newName),
          tables: renamedEntry(state.tables, name, newName),
          procedures: renamedEntry(state.procedures, name, newName),
          pages,
          panels: renamedEntry(state.panels, name, newName),
          notes: renamedEntry(state.notes, name, newName),
          windows: state.windows.map((window) =>
            window === target ? { ...window, name: newName } : window,
          ),
        },
        result: newName,
      };
    }
    case "moveWindow": {
      const windows = state.windows.map((window) =>
        window.name === command.name
          ? {
              ...window,
              x: command.x ?? window.x,
              y: command.y ?? window.y,
              w: Math.max(MIN_WINDOW_WIDTH, command.w ?? window.w),
              h: Math.max(MIN_WINDOW_HEIGHT, command.h ?? window.h),
            }
          : window,
      );
      return { state: { ...state, windows }, result: null };
    }
    case "activateWindow": {
      const target = requireWindow(state, command.name);
      // A closed window comes back with reopenWindow, which can be undone.
      if (target.hidden) {
        throw new DocError(`${command.name} is closed. Reopen it to bring it to the front.`);
      }
      if (state.windows.at(-1) === target) return { state, result: null };
      return {
        state: {
          ...state,
          windows: [...state.windows.filter((window) => window !== target), target],
        },
        result: null,
      };
    }
  }
}
