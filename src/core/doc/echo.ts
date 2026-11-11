import type { Command } from "./commands";

/** Python source to be written as it is, where a literal would otherwise go. */
class PyExpression {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }
}

const same = (a: unknown, b: unknown): boolean =>
  a instanceof PyExpression && b instanceof PyExpression ? a.source === b.source : Object.is(a, b);

/** A number as an argument of float() or complex(): plain, or a quoted nan or inf. */
const pyNumber = (value: number): string =>
  Number.isFinite(value)
    ? String(value)
    : Number.isNaN(value)
      ? '"nan"'
      : value > 0
        ? '"inf"'
        : '"-inf"';

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
  throw new Error(`Cannot write ${typeof value} as a Python literal.`);
}

export const snakeCase = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

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
 * The Python statement that has the same effect as a command, for writing GUI
 * actions into the command history. Returns null for commands that cannot be
 * replayed from text (bulk data) or that are only view state.
 */
export function echoPython(
  command: Command,
  shapeOf?: (wave: string) => readonly number[] | undefined,
): string | null {
  switch (command.op) {
    case "makeWave":
    case "setWaveData":
    case "moveWindow":
    case "activateWindow":
    case "resizeColumn":
    case "setProcedure":
      return null;
    case "setTimeZone":
      return `op.set_time_zone(${pyLiteral(command.zone)})`;
    case "newProcedure":
      return `op.new_procedure(${keywords({ name: command.name, code: command.code || undefined })})`;
    case "modifyTable":
      return `op.table(${pyLiteral(command.table)}).set(${keywords(command.props)})`;
    case "redimension":
      return `op.wave(${pyLiteral(command.name)}).redimension(${pyLiteral(command.type)})`;
    case "setWavePoints": {
      const wave = `op.wave(${pyLiteral(command.name)})`;
      const { start } = command;
      // Complex points are written as complex(re, im), which also takes nan and inf.
      const { imag } = command;
      const values: ArrayLike<number | PyExpression> = imag
        ? Array.from(
            command.values,
            (re, index) => new PyExpression(`complex(${pyNumber(re)}, ${pyNumber(imag[index]!)})`),
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
      return `op.graph(${pyLiteral(command.graph)}).set(${keywords(command.props)})`;
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
    case "killWindow":
      return `op.kill_window(${pyLiteral(command.name)})`;
  }
}
