import type { Command } from "./commands";

/** Formats a JavaScript value as a Python literal. */
export function pyLiteral(value: unknown): string {
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
export function echoPython(command: Command): string | null {
  switch (command.op) {
    case "makeWave":
    case "setWaveData":
    case "moveWindow":
    case "activateWindow":
      return null;
    case "setWavePoints": {
      const wave = `op.wave(${pyLiteral(command.name)})`;
      if (command.values.length === 1) {
        return `${wave}[${command.start}] = ${pyLiteral(command.values[0])}`;
      }
      const end = command.start + command.values.length;
      return `${wave}[${command.start}:${end}] = ${pyLiteral(Array.from(command.values))}`;
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
      const options = keywords({ anchor: command.anchor, frame: command.frame });
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
