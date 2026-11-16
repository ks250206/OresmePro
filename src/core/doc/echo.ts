import type { Arrangement } from "./arrange";
import type { Command } from "./commands";
import type { PlotDimension } from "./types";

/** Python source to be written as it is, where a literal would otherwise go. */
class PyExpression {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }
}

const same = (a: unknown, b: unknown): boolean =>
  a instanceof PyExpression && b instanceof PyExpression ? a.source === b.source : Object.is(a, b);

/** Formats a JavaScript value as a Python literal. */
export function pyLiteral(value: unknown): string {
  if (value instanceof PyExpression) return value.source;
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return 'float("nan")';
    if (value === Infinity) return 'float("inf")';
    if (value === -Infinity) return 'float("-inf")';
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(", ")}]`;
  if (typeof value === "object" && !ArrayBuffer.isView(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => `${pyLiteral(key)}: ${pyLiteral(item)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  throw new Error(`Cannot write ${typeof value} as a Python literal.`);
}

export const snakeCase = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** Data with the keys of its dicts in Python's spelling, as Python reads a style. */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [snakeCase(key), snakeKeys(item)]),
  );
}

export const camelCase = (name: string): string =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const names = (values: readonly string[]): string => values.map(pyLiteral).join(", ");

function keywords(props: Readonly<Record<string, unknown>>): string {
  return Object.entries(props)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${snakeCase(key)}=${pyLiteral(value)}`)
    .join(", ");
}

/** The indices along each dimension of a position in C-order data. */
function unravel(position: number, shape: readonly number[]): number[] {
  const indices: number[] = [];
  let rest = position;
  for (let dim = shape.length - 1; dim >= 0; dim -= 1) {
    indices.unshift(rest % shape[dim]!);
    rest = Math.floor(rest / shape[dim]!);
  }
  return indices;
}

const joinArgs = (...parts: string[]): string => parts.filter(Boolean).join(", ");

/** The `axis=` / `haxis=` arguments, left out when they are the defaults. */
const axisKeywords = (command: { vAxis?: string; hAxis?: string }) => ({
  axis: command.vAxis && command.vAxis !== "left" ? command.vAxis : undefined,
  haxis: command.hAxis && command.hAxis !== "bottom" ? command.hAxis : undefined,
});

/**
 * The arguments of `make` for graphs made from a template: a wave for each
 * slot, or a list of them, one for each graph. A slot that has the same wave
 * in every graph is written once; Python repeats it for each graph, which it
 * counts from the lists, so at least one argument stays a list.
 */
function makeArguments(command: Extract<Command, { op: "makeGraphs" }>): string {
  const { samples, names } = command;
  const many = samples.length > 1;
  const slots = [...new Set(samples.flatMap((sample) => Object.keys(sample)))];
  const columns = slots
    .map((slot) => [slot, samples.map((sample) => sample[slot] ?? null)] as const)
    // A slot left empty everywhere is left out, as Python leaves it.
    .filter(([, values]) => values.some((value) => value !== null));
  const same = (values: readonly unknown[]) => values.every((value) => value === values[0]);
  const listed = !many || names !== undefined || columns.some(([, values]) => !same(values));
  const args = columns.map(([slot, values]) => {
    const value = !many || (listed && same(values)) ? values[0] : values;
    return `${slot}=${pyLiteral(value)}`;
  });
  if (names !== undefined) args.push(`name=${pyLiteral(many ? [...names] : names[0])}`);
  return args.join(", ");
}

/** A panel's data with references to its controls written as `op.control(name)`. */
function withControlCalls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withControlCalls);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  if (entries.length === 1 && entries[0]![0] === "$control" && typeof entries[0]![1] === "string") {
    return new PyExpression(`op.control(${pyLiteral(entries[0]![1])})`);
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, withControlCalls(item)]));
}

/** The call of a panel's method that adds a control of a kind, as `op.panel` takes it. */
function addControlCall(command: Extract<Command, { op: "addControl" }>): string {
  const { label, options, ...rest } = command.props ?? {};
  const props = withControlCalls(rest) as Record<string, unknown>;
  const name = pyLiteral(command.name);
  const panel = `op.panel(${pyLiteral(command.panel)})`;
  // The words a heading, a paragraph and a button show come second; a choice's options do.
  const words = command.kind === "heading" || command.kind === "text" || command.kind === "button";
  const positional = words
    ? label === undefined
      ? ""
      : pyLiteral(label)
    : command.kind === "choice"
      ? pyLiteral(options ?? [])
      : "";
  const named = words ? props : { label, ...props };
  return `${panel}.${command.kind}(${joinArgs(name, positional, keywords(named))})`;
}

const LENGTH_CALLS: Record<string, string> = { pt: "op.pt", cm: "op.cm", inch: "op.inch" };

/**
 * How a side of the plot area is sized, as `Graph.set` takes it: "auto",
 * a length (`op.cm(8)`), or a tuple ("aspect", f), ("plan", f, haxis,
 * vaxis), ("per_unit", n, unit, axis). Anything else is written as it is.
 */
function plotDimensionPython(value: unknown): unknown {
  const dimension = value as Partial<PlotDimension> | null;
  const tuple = (...items: unknown[]) => new PyExpression(`(${items.map(pyLiteral).join(", ")})`);
  switch (dimension?.mode) {
    case "auto":
      return "auto";
    case "absolute":
      return new PyExpression(
        `${LENGTH_CALLS[dimension.unit ?? "pt"] ?? "op.pt"}(${pyLiteral(dimension.value)})`,
      );
    case "aspect":
      return tuple("aspect", dimension.factor);
    case "plan":
      return tuple("plan", dimension.factor, dimension.hAxis, dimension.vAxis);
    case "perUnit":
      return tuple("per_unit", dimension.value, dimension.unit, dimension.axis);
    default:
      return value;
  }
}

/** A graph's properties as `Graph.set` takes them. */
function graphKeywords(props: Readonly<Record<string, unknown>>): string {
  return keywords(
    Object.fromEntries(
      Object.entries(props).map(([key, value]) => [
        key,
        key === "width" || key === "height" ? plotDimensionPython(value) : value,
      ]),
    ),
  );
}

/**
 * The Python statement that has the same effect as a command, for writing GUI
 * actions into the command history. Returns null for commands that cannot be
 * replayed from text (bulk data) or that are only view state.
 */
export function echoPython(
  command: Command,
  shapeOf?: (wave: string) => readonly number[] | undefined,
): string | null {
  switch (command.op) {
    case "addResult":
    // A run is recorded by the Python that does it (t.run, run.retry), never by the GUI.
    case "addRun":
    case "updateRunSample":
    case "makeWave":
    case "setWaveData":
    case "moveWindow":
    case "activateWindow":
    case "resizeColumn":
    case "setProcedure":
      return null;
    case "removeResults":
      return command.names.map((name) => `op.result(${pyLiteral(name)}).remove()`).join("\n");
    case "renameResult":
      return `op.result(${pyLiteral(command.name)}).rename(${pyLiteral(command.newName)})`;
    case "setTemplate":
      // The keys of a template are Python's already, and its arguments are named as the actions name them.
      return `op.set_template(${pyLiteral(command.name)}, ${pyLiteral(command.template)})`;
    case "removeTemplate":
      return `op.template(${pyLiteral(command.name)}).remove()`;
    case "renameTemplate":
      return `op.template(${pyLiteral(command.name)}).rename(${pyLiteral(command.newName)})`;
    case "removeRuns":
      return command.names.map((name) => `op.run(${pyLiteral(name)}).remove()`).join("\n");
    case "newLayout":
      return `op.new_layout(${keywords({ name: command.name, width: command.width, height: command.height })})`;
    case "modifyLayout":
      return `op.layout(${pyLiteral(command.layout)}).set(${keywords(command.props)})`;
    case "addLayoutItem": {
      const layout = `op.layout(${pyLiteral(command.layout)})`;
      const place = keywords({ x: command.x, y: command.y, w: command.w, h: command.h });
      return command.kind === "graph"
        ? `${layout}.add_graph(${joinArgs(pyLiteral(command.graph), place)})`
        : `${layout}.add_text(${joinArgs(pyLiteral(command.text), keywords({ x: command.x, y: command.y, size: command.size }))})`;
    }
    case "modifyLayoutItem":
      return `op.layout(${pyLiteral(command.layout)}).item(${pyLiteral(command.item)}).set(${keywords(command.props)})`;
    case "removeLayoutItem":
      return `op.layout(${pyLiteral(command.layout)}).item(${pyLiteral(command.item)}).remove()`;
    case "setTimeZone":
      return `op.set_time_zone(${pyLiteral(command.zone)})`;
    case "newPanel":
      return `op.new_panel(${keywords({ name: command.name, title: command.title })})`;
    case "setPanel":
      return `op.set_panel(${pyLiteral(command.name)}, ${pyLiteral(withControlCalls(command.panel))})`;
    case "modifyPanel":
      return `op.panel(${pyLiteral(command.panel)}).set(${keywords(command.props)})`;
    case "addControl":
      return addControlCall(command);
    case "modifyControl":
      return `op.panel(${pyLiteral(command.panel)}).control(${pyLiteral(command.control)}).set(${keywords(
        withControlCalls(command.props) as Record<string, unknown>,
      )})`;
    case "removeControl":
      return `op.panel(${pyLiteral(command.panel)}).control(${pyLiteral(command.control)}).remove()`;
    case "moveControl":
      return `op.panel(${pyLiteral(command.panel)}).control(${pyLiteral(command.control)}).move(${command.to})`;
    case "setControlValue":
      return `op.panel(${pyLiteral(command.panel)})[${pyLiteral(command.control)}] = ${pyLiteral(command.value)}`;
    case "newProcedure":
      return `op.new_procedure(${keywords({
        name: command.name,
        code: command.code || undefined,
        autoRun: command.autoRun === false ? false : undefined,
      })})`;
    case "modifyTable":
      return `op.table(${pyLiteral(command.table)}).set(${keywords(command.props)})`;
    case "redimension":
      return `op.wave(${pyLiteral(command.name)}).redimension(${pyLiteral(command.type)})`;
    case "setWavePoints": {
      const wave = `op.wave(${pyLiteral(command.name)})`;
      const { start } = command;
      // Complex points are written as complex(re, im). Its two arguments must be
      // numbers, so nan and inf are float("nan") and float("inf"), not text.
      const { imag } = command;
      const values: ArrayLike<number | PyExpression> = imag
        ? Array.from(
            command.values,
            (re, index) =>
              new PyExpression(`complex(${pyLiteral(re)}, ${pyLiteral(imag[index]!)})`),
          )
        : command.values;
      const shape = shapeOf?.(command.name) ?? [];
      if (values.length === 1) {
        // A cell of a matrix is written by its indices, not its place in memory.
        const index = shape.length > 1 ? unravel(start, shape).join(", ") : String(start);
        return `${wave}[${index}] = ${pyLiteral(values[0])}`;
      }
      const target = `${shape.length > 1 ? `${wave}.flat` : wave}[${start}:${start + values.length}]`;
      const list = Array.from(values);
      // A run of one value (clearing a range to NaN) is written once, not per point.
      if (list.every((value) => same(value, list[0]))) {
        return `${target} = ${pyLiteral(list[0])}`;
      }
      return `${target} = ${pyLiteral(list)}`;
    }
    case "setWaveText": {
      const wave = `op.wave(${pyLiteral(command.name)})`;
      if (command.values.length === 1) {
        return `${wave}[${command.start}] = ${pyLiteral(command.values[0])}`;
      }
      const end = command.start + command.values.length;
      return `${wave}[${command.start}:${end}] = ${pyLiteral([...command.values])}`;
    }
    case "insertPoints":
      return `op.wave(${pyLiteral(command.name)}).insert_points(${command.at}, ${command.count})`;
    case "deletePoints":
      return `op.wave(${pyLiteral(command.name)}).delete_points(${command.at}, ${command.count})`;
    case "setWaveScale":
      return `op.wave(${pyLiteral(command.name)}).set_scale(${keywords({
        x0: command.x0,
        dx: command.dx,
        unit: command.xUnit,
        y0: command.y0,
        dy: command.dy,
        yUnit: command.yUnit,
      })})`;
    case "setWaveMeta": {
      const wave = `op.wave(${pyLiteral(command.name)})`;
      const parts: string[] = [];
      if (command.unit !== undefined) parts.push(`${wave}.unit = ${pyLiteral(command.unit)}`);
      if (command.note !== undefined) parts.push(`${wave}.note = ${pyLiteral(command.note)}`);
      return parts.join("; ") || null;
    }
    case "renameWave":
      return `op.wave(${pyLiteral(command.name)}).rename(${pyLiteral(command.newName)})`;
    case "duplicateWave":
      return `op.wave(${pyLiteral(command.name)}).duplicate(${pyLiteral(command.newName)})`;
    case "killWaves":
      return `op.kill(${names(command.names)})`;
    case "setFormula":
      return command.expr === null
        ? `op.wave(${pyLiteral(command.name)}).formula = None`
        : `op.set_formula(${joinArgs(
            pyLiteral(command.name),
            pyLiteral(command.expr),
            command.auto === false ? "auto=False" : "",
          )})`;
    case "recalculate":
      return command.names === undefined
        ? "op.recalculate()"
        : `op.recalculate(${pyLiteral([...command.names])})`;
    case "newFolder":
      return `op.new_folder(${pyLiteral(command.path)})`;
    case "renameFolder":
      return `op.folder(${pyLiteral(command.path)}).rename(${pyLiteral(command.newPath)})`;
    case "killFolder":
      return `op.folder(${pyLiteral(command.path)}).kill()`;
    case "display":
      return `op.display(${joinArgs(
        names(command.y),
        keywords({ x: command.x ?? undefined, name: command.name }),
        // A style of null is written, as None: it means no style, not the default.
        command.style === undefined ? "" : `style=${pyLiteral(command.style)}`,
      )})`;
    case "appendTraces":
      return `op.graph(${pyLiteral(command.graph)}).append(${joinArgs(
        names(command.y),
        keywords({ x: command.x ?? undefined, ...axisKeywords(command) }),
      )})`;
    case "removeTraces":
      return `op.graph(${pyLiteral(command.graph)}).remove(${names(command.traces)})`;
    case "modifyTrace":
      return `op.graph(${pyLiteral(command.graph)}).trace(${pyLiteral(command.trace)}).set(${keywords(command.props)})`;
    case "modifyAxis": {
      const axis = `op.graph(${pyLiteral(command.graph)}).axis(${pyLiteral(command.axis)})`;
      const { min, max, ...rest } = command.props;
      const hasRange = min !== undefined && max !== undefined;
      if (hasRange && min === null && max === null && Object.keys(rest).length === 0) {
        return `${axis}.autoscale()`;
      }
      const range = hasRange
        ? min === null && max === null
          ? "range=None"
          : `range=(${pyLiteral(min)}, ${pyLiteral(max)})`
        : keywords({ min, max });
      return `${axis}.set(${joinArgs(range, keywords(rest))})`;
    }
    case "addAxis":
      return `op.graph(${pyLiteral(command.graph)}).add_axis(${pyLiteral(command.name)}, ${pyLiteral(command.side)})`;
    case "removeAxis":
      return `op.graph(${pyLiteral(command.graph)}).remove_axis(${pyLiteral(command.axis)})`;
    case "appendImage":
      return `op.graph(${pyLiteral(command.graph)}).append_image(${joinArgs(
        pyLiteral(command.wave),
        keywords({ ...axisKeywords(command), ...command.props }),
      )})`;
    case "modifyImage":
      return `op.graph(${pyLiteral(command.graph)}).image(${pyLiteral(command.image)}).set(${keywords(command.props)})`;
    case "removeImage":
      return `op.graph(${pyLiteral(command.graph)}).image(${pyLiteral(command.image)}).remove()`;
    case "appendContour":
      return `op.graph(${pyLiteral(command.graph)}).append_contour(${joinArgs(
        pyLiteral(command.wave),
        keywords({ ...axisKeywords(command), ...command.props }),
      )})`;
    case "modifyContour":
      return `op.graph(${pyLiteral(command.graph)}).contour(${pyLiteral(command.contour)}).set(${keywords(command.props)})`;
    case "removeContour":
      return `op.graph(${pyLiteral(command.graph)}).contour(${pyLiteral(command.contour)}).remove()`;
    case "setCursor":
      return `op.graph(${pyLiteral(command.graph)}).cursor(${pyLiteral(command.cursor)}, ${pyLiteral(command.trace)}, ${command.point})`;
    case "removeCursor":
      return `op.graph(${pyLiteral(command.graph)}).cursor(${pyLiteral(command.cursor)}).remove()`;
    case "modifyGraph":
      return `op.graph(${pyLiteral(command.graph)}).set(${graphKeywords(command.props)})`;
    case "addAnnotation": {
      const graph = `op.graph(${pyLiteral(command.graph)})`;
      const place = keywords({ x: command.x, y: command.y });
      if (command.kind === "tag") {
        return `${graph}.tag(${joinArgs(
          pyLiteral(command.trace),
          String(command.point),
          command.text ? pyLiteral(command.text) : "",
          keywords({ frame: command.frame }),
          place,
        )})`;
      }
      const options = joinArgs(keywords({ anchor: command.anchor, frame: command.frame }), place);
      const text = command.text ? pyLiteral(command.text) : "";
      if (command.kind === "legend") return `${graph}.legend(${joinArgs(text, options)})`;
      if (command.kind === "colorscale") return `${graph}.colorscale(${joinArgs(text, options)})`;
      return `${graph}.textbox(${joinArgs(pyLiteral(command.text ?? ""), options)})`;
    }
    case "modifyAnnotation":
      return `op.graph(${pyLiteral(command.graph)}).annotation(${pyLiteral(command.annotation)}).set(${keywords(command.props)})`;
    case "removeAnnotation":
      return `op.graph(${pyLiteral(command.graph)}).annotation(${pyLiteral(command.annotation)}).remove()`;
    case "edit":
      return `op.edit(${joinArgs(names(command.waves), keywords({ name: command.name }))})`;
    case "appendToTable":
      return `op.table(${pyLiteral(command.table)}).append(${names(command.waves)})`;
    case "removeFromTable":
      return `op.table(${pyLiteral(command.table)}).remove(${names(command.waves)})`;
    case "saveStyle":
      return `op.graph(${pyLiteral(command.graph)}).save_style(${joinArgs(
        pyLiteral(command.name),
        command.size ? "size=True" : "",
      )})`;
    case "setStyle":
      return `op.set_style(${pyLiteral(command.name)}, ${pyLiteral(snakeKeys(command.style))})`;
    case "removeStyle":
      return `op.style(${pyLiteral(command.name)}).remove()`;
    case "renameStyle":
      return `op.style(${pyLiteral(command.name)}).rename(${pyLiteral(command.newName)})`;
    case "applyStyle":
      return command.graphs.length === 1
        ? `op.graph(${pyLiteral(command.graphs[0])}).apply_style(${pyLiteral(command.style)})`
        : `op.apply_style(${pyLiteral(command.style)}, graphs=${pyLiteral([...command.graphs])})`;
    case "setDefaultStyle":
      return `op.set_default_style(${pyLiteral(command.name)})`;
    case "saveGraphTemplate":
      return `op.graph(${pyLiteral(command.graph)}).save_template(${joinArgs(
        pyLiteral(command.name),
        command.fixed && command.fixed.length > 0 ? `fixed=${pyLiteral([...command.fixed])}` : "",
      )})`;
    case "setGraphTemplate":
      return `op.set_graph_template(${pyLiteral(command.name)}, ${pyLiteral(snakeKeys(command.template))})`;
    case "removeGraphTemplate":
      return `op.graph_template(${pyLiteral(command.name)}).remove()`;
    case "renameGraphTemplate":
      return `op.graph_template(${pyLiteral(command.name)}).rename(${pyLiteral(command.newName)})`;
    case "makeGraphs":
      return `op.graph_template(${pyLiteral(command.template)}).make(${makeArguments(command)})`;
    case "killWindow":
      return `op.kill_window(${pyLiteral(command.name)})`;
    case "linkGraphs":
      return `op.link_graphs(${joinArgs(
        command.graphs.map(pyLiteral).join(", "),
        keywords({
          axes: command.axes === "xy" ? "xy" : undefined,
          cursors: command.cursors === false ? false : undefined,
        }),
      )})`;
    case "unlinkGraphs":
      return `op.unlink_graphs(${command.graphs.map(pyLiteral).join(", ")})`;
    case "closeWindow":
      return `op.close_window(${pyLiteral(command.name)})`;
    case "reopenWindow":
      return `op.reopen_window(${pyLiteral(command.name)})`;
    case "renameWindow":
      return `op.rename_window(${pyLiteral(command.name)}, ${pyLiteral(command.newName)})`;
  }
}

/**
 * The `op.make` call that makes the same empty wave as a command does (the
 * command's data is all zeros; makeWave carries data, so loads are not echoed
 * through here). A keyword is left out where `op.make` gives the same without
 * it: the default for a new wave, the old value for a wave that `previous`
 * says is being overwritten, which keeps its scaling and units unless told.
 */
export function echoMake(
  command: Extract<Command, { op: "makeWave" }>,
  previous?: { x0: number; dx: number; xUnit: string; unit: string },
): string {
  const shape = command.shape ?? [command.data?.length ?? 0];
  const unless = <T>(value: T | undefined, otherwise: T): T | undefined =>
    value === undefined || Object.is(value, otherwise) ? undefined : value;
  return `op.make(${joinArgs(
    pyLiteral(command.name),
    keywords({
      // op.make makes 128 points when not told otherwise, as Igor's Make does.
      n: shape.length > 1 ? new PyExpression(`(${shape.join(", ")})`) : unless(shape[0], 128),
      dtype: unless(command.type, "float64"),
      x0: unless(command.x0, previous?.x0 ?? 0),
      dx: unless(command.dx, previous?.dx ?? 1),
      xUnit: unless(command.xUnit, previous?.xUnit ?? ""),
      unit: unless(command.unit, previous?.unit ?? ""),
    }),
  )})`;
}

/**
 * The Python call that rearranges items on a page as the layout window did:
 * one call for the whole arrangement, so the history reads as what was done
 * and not as the item changes it took.
 */
export function echoArrangement(layout: string, arrangement: Arrangement): string {
  const page = `op.layout(${pyLiteral(layout)})`;
  switch (arrangement.action) {
    case "align":
      return `${page}.align(${pyLiteral([...arrangement.items])}, ${pyLiteral(arrangement.edge)})`;
    case "distribute":
      return `${page}.distribute(${pyLiteral([...arrangement.items])}, ${pyLiteral(arrangement.direction)})`;
    case "matchSize":
      return `${page}.match_size(${pyLiteral([...arrangement.items])}, ${pyLiteral(arrangement.dimension)})`;
    case "arrange": {
      const [across, down] = arrangement.gap;
      return `${page}.arrange(${joinArgs(
        String(arrangement.rows),
        String(arrangement.columns),
        arrangement.items ? `items=${pyLiteral([...arrangement.items])}` : "",
        `margin=${pyLiteral(arrangement.margin)}`,
        `gap=${across === down ? pyLiteral(across) : `(${pyLiteral(across)}, ${pyLiteral(down)})`}`,
      )})`;
    }
  }
}
