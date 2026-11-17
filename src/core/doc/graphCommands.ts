/** The commands on graphs: traces, axes, images, contours, cursors and drawings. (Applied through ./commands.) */
import { filterDict, withEntry, withoutEntries } from "./dict";
import { axisLook, traceLook } from "./styles";
import {
  ANNOTATION_KINDS,
  defaultDrawing,
  DRAWING_KINDS,
  AXIS_SIDES,
  CURSOR_NAMES,
  DocError,
  TAG_OFFSET,
  defaultAxis,
  infoBarHeight,
  figureSize,
  windowSizeFor,
  sizeAxes,
  leafName,
  type AnnotationSpec,
  type AxisSpec,
  type ContourSpec,
  type CursorName,
  type DocState,
  type ImageSpec,
  type TraceSpec,
  type TraceStyle,
} from "./types";
import {
  ANNOTATION_VALIDATORS,
  AXIS_VALIDATORS,
  type AnnotationProps,
  CONTOUR_VALIDATORS,
  type ContourProps,
  DRAWING_VALIDATORS,
  type DrawingProps,
  GRAPH_PROP_VALIDATORS,
  type GraphProps,
  IMAGE_VALIDATORS,
  type ImageProps,
  TRACE_VALIDATORS,
  checkDrawing,
  checkPlotSize,
  requireStyle,
  validateProps,
  withStyle,
} from "./graphProps";
import type { Command, CommandOutcome } from "./commandTypes";
import {
  addTraces,
  checkName,
  checkPlane,
  cursorX,
  emptyGraph,
  followCursor,
  followRange,
  index,
  nextItemName,
  oneOf,
  placeWindow,
  putGraph,
  requireAxis,
  requireGraph,
  requireNumeric,
  requireWave,
  uniqueName,
  windowTaken,
} from "./commandSupport";
import { checkErrorWaves, requireItem } from "./waveCommands";

/** The commands applied here. */
export const GRAPH_OPS = [
  "display",
  "appendTraces",
  "removeTraces",
  "modifyTrace",
  "addAxis",
  "removeAxis",
  "modifyAxis",
  "modifyGraph",
  "appendImage",
  "modifyImage",
  "removeImage",
  "appendContour",
  "modifyContour",
  "removeContour",
  "setCursor",
  "removeCursor",
  "addAnnotation",
  "modifyAnnotation",
  "removeAnnotation",
  "addDrawing",
  "modifyDrawing",
  "removeDrawing",
  "orderDrawing",
] as const;
export type GraphCommand = Extract<Command, { op: (typeof GRAPH_OPS)[number] }>;
const GRAPH_OPS_SET: ReadonlySet<string> = new Set(GRAPH_OPS);
export const isGraphCommand = (command: Command): command is GraphCommand =>
  GRAPH_OPS_SET.has(command.op);

export function applyGraphCommand(state: DocState, command: GraphCommand): CommandOutcome {
  switch (command.op) {
    case "display": {
      const name =
        command.name === undefined
          ? uniqueName("Graph", windowTaken(state))
          : checkName(command.name, "graph");
      if (windowTaken(state)(name)) {
        throw new DocError(
          `A window named ${JSON.stringify(name)} already exists.`,
          "ALREADY_EXISTS",
          { name: name },
        );
      }
      const style = command.style === undefined ? state.defaultStyle : command.style;
      if (style !== null) requireStyle(state, style);
      const empty = emptyGraph(name);
      const graph =
        command.y.length === 0
          ? empty
          : addTraces(state, empty, command.y, command.x ?? null, "left", "bottom");
      const made = {
        ...putGraph(state, graph),
        windows: [...state.windows, placeWindow(state, name, "graph")],
      };
      return { state: style === null ? made : withStyle(made, graph, style), result: name };
    }
    case "appendTraces": {
      const graph = requireGraph(state, command.graph);
      const next = addTraces(
        state,
        graph,
        command.y,
        command.x ?? null,
        command.vAxis ?? "left",
        command.hAxis ?? "bottom",
      );
      // New traces take their places in the cycle of the graph's style.
      const style = graph.style === null ? undefined : state.styles[graph.style];
      const traces = next.traces.map((trace, index) =>
        index < graph.traces.length ? trace : { ...trace, ...traceLook(style, index) },
      );
      return { state: putGraph(state, { ...next, traces }), result: next.traces.at(-1)!.name };
    }
    case "removeTraces": {
      const graph = requireGraph(state, command.graph);
      for (const name of command.traces) requireItem(graph.traces, name, graph.name, "trace");
      const traces = graph.traces.filter((trace) => !command.traces.includes(trace.name));
      const cursors = filterDict(graph.cursors, (cursor) => !command.traces.includes(cursor.trace));
      // A tag goes with the trace it points at.
      const annotations = graph.annotations.filter(
        (item) => item.trace === null || !command.traces.includes(item.trace),
      );
      return { state: putGraph(state, { ...graph, traces, cursors, annotations }), result: null };
    }
    case "modifyTrace": {
      const graph = requireGraph(state, command.graph);
      const trace = requireItem(graph.traces, command.trace, graph.name, "trace");
      const next = {
        ...trace,
        ...validateProps<TraceStyle>(command.props, TRACE_VALIDATORS, "trace"),
      };
      checkErrorWaves(state, next);
      const normalized: TraceSpec = {
        ...next,
        yError:
          typeof next.yError === "string" ? requireWave(state, next.yError).name : next.yError,
        xError:
          typeof next.xError === "string" ? requireWave(state, next.xError).name : next.xError,
        colorWave: next.colorWave === null ? null : requireWave(state, next.colorWave).name,
        textMarker: next.textMarker === null ? null : requireWave(state, next.textMarker).name,
      };
      const traces = graph.traces.map((item) => (item === trace ? normalized : item));
      return { state: putGraph(state, { ...graph, traces }), result: null };
    }
    case "addAxis": {
      const graph = requireGraph(state, command.graph);
      const name = checkName(command.name, "axis");
      if (name in graph.axes) {
        throw new DocError(
          `${graph.name} already has an axis named ${JSON.stringify(name)}.`,
          "ALREADY_EXISTS",
          { kind: "axis", name },
        );
      }
      const plain = defaultAxis(oneOf(command.side, AXIS_SIDES, "side"));
      const style = graph.style === null ? undefined : state.styles[graph.style];
      const axis = { ...plain, ...axisLook(style, name, plain) };
      return {
        state: putGraph(state, { ...graph, axes: withEntry(graph.axes, name, axis) }),
        result: name,
      };
    }
    case "removeAxis": {
      const graph = requireGraph(state, command.graph);
      if (!(command.axis in graph.axes)) {
        throw new DocError(
          `${graph.name} has no axis named ${JSON.stringify(command.axis)}.`,
          "NOT_FOUND",
          { kind: "axis", name: command.axis },
        );
      }
      if ((AXIS_SIDES as readonly string[]).includes(command.axis)) {
        throw new DocError("The left, bottom, right and top axes cannot be removed.");
      }
      const users = [
        ...graph.traces,
        ...graph.images,
        ...graph.contours,
        ...graph.drawings.filter((item) => item.coords === "axes"),
      ].filter((item) => item.vAxis === command.axis || item.hAxis === command.axis);
      if (users.length > 0) {
        throw new DocError(
          `Axis ${command.axis} is in use by ${users.map((item) => item.name).join(", ")}.`,
          "IN_USE",
          { kind: "axis", name: command.axis, users: users.map((item) => item.name) },
        );
      }
      const sizing = (["width", "height"] as const).filter((side) =>
        sizeAxes(graph[side]).includes(command.axis),
      );
      if (sizing.length > 0) {
        throw new DocError(
          `Axis ${command.axis} sizes the ${sizing.join(" and the ")} of the plot area. Size it another way first.`,
        );
      }
      const axes = withoutEntries(graph.axes, [command.axis]);
      return { state: putGraph(state, { ...graph, axes }), result: null };
    }
    case "modifyAxis": {
      const graph = requireGraph(state, command.graph);
      const current = graph.axes[command.axis];
      if (!current) {
        throw new DocError(
          `${graph.name} has no axis named ${JSON.stringify(command.axis)}. Axes: ${Object.keys(graph.axes).join(", ")}.`,
          "NOT_FOUND",
          { kind: "axis", name: command.axis },
        );
      }
      const axis = {
        ...current,
        ...validateProps<Omit<AxisSpec, "side">>(command.props, AXIS_VALIDATORS, "axis"),
      };
      if (axis.min !== null && axis.max !== null && axis.min === axis.max) {
        throw new DocError("The axis range must not be empty.");
      }
      if (axis.log && ((axis.min ?? 1) <= 0 || (axis.max ?? 1) <= 0)) {
        throw new DocError("A log axis needs a range greater than 0.");
      }
      const next = putGraph(state, { ...graph, axes: withEntry(graph.axes, command.axis, axis) });
      return { state: followRange(next, graph, command.axis, command.props), result: null };
    }
    case "modifyGraph": {
      const graph = requireGraph(state, command.graph);
      const props = validateProps<GraphProps>(command.props, GRAPH_PROP_VALIDATORS, "graph");
      const next = { ...graph, ...props };
      if (props.width !== undefined || props.height !== undefined) {
        checkPlotSize(next.width, next.height, (axis) => next.axes[axis]?.side, graph.name);
      }
      // Showing the cursor readout grows the window by its bar, and hiding it
      // shrinks the window back, so the figure keeps its size (as in Igor).
      // The window grows downwards, past the desktop if need be, as it does
      // when a style with a size is given; undo gives the old size back.
      // Magnifying the graph grows its window by as much, so the figure
      // keeps its size and is drawn bigger (as Igor's expand does).
      const windows =
        infoBarHeight(next) === infoBarHeight(graph) && next.magnification === graph.magnification
          ? state.windows
          : state.windows.map((window) =>
              window.name === graph.name
                ? { ...window, ...windowSizeFor(figureSize(window, graph), next) }
                : window,
            );
      return { state: { ...putGraph(state, next), windows }, result: null };
    }
    case "appendImage": {
      const graph = requireGraph(state, command.graph);
      const wave = requireNumeric(state, command.wave, 2, "shown as an image");
      const image: ImageSpec = {
        name: nextItemName(graph.images, leafName(wave.name)),
        wave: wave.name,
        vAxis: requireAxis(graph, command.vAxis ?? "left", true),
        hAxis: requireAxis(graph, command.hAxis ?? "bottom", false),
        colorTable: "grays",
        zMin: null,
        zMax: null,
        reverse: false,
        layer: 0,
        chunk: 0,
        part: "real",
        ...validateProps<ImageProps>(command.props ?? {}, IMAGE_VALIDATORS, "image"),
      };
      checkPlane(wave, image);
      return {
        state: putGraph(state, { ...graph, images: [...graph.images, image] }),
        result: image.name,
      };
    }
    case "modifyImage": {
      const graph = requireGraph(state, command.graph);
      const image = requireItem(graph.images, command.image, graph.name, "image");
      const next = {
        ...image,
        ...validateProps<ImageProps>(command.props, IMAGE_VALIDATORS, "image"),
      };
      checkPlane(requireWave(state, image.wave), next);
      const images = graph.images.map((item) => (item === image ? next : item));
      return { state: putGraph(state, { ...graph, images }), result: null };
    }
    case "removeImage": {
      const graph = requireGraph(state, command.graph);
      const image = requireItem(graph.images, command.image, graph.name, "image");
      const images = graph.images.filter((item) => item !== image);
      return { state: putGraph(state, { ...graph, images }), result: null };
    }
    case "appendContour": {
      const graph = requireGraph(state, command.graph);
      const wave = requireNumeric(state, command.wave, 2, "shown as contours");
      const contour: ContourSpec = {
        name: nextItemName(graph.contours, leafName(wave.name)),
        wave: wave.name,
        vAxis: requireAxis(graph, command.vAxis ?? "left", true),
        hAxis: requireAxis(graph, command.hAxis ?? "bottom", false),
        levels: 10,
        color: "#000000",
        lineSize: 1,
        colorTable: null,
        labels: true,
        layer: 0,
        chunk: 0,
        ...validateProps<ContourProps>(command.props ?? {}, CONTOUR_VALIDATORS, "contour"),
      };
      checkPlane(wave, contour);
      return {
        state: putGraph(state, { ...graph, contours: [...graph.contours, contour] }),
        result: contour.name,
      };
    }
    case "modifyContour": {
      const graph = requireGraph(state, command.graph);
      const contour = requireItem(graph.contours, command.contour, graph.name, "contour");
      const next = {
        ...contour,
        ...validateProps<ContourProps>(command.props, CONTOUR_VALIDATORS, "contour"),
      };
      checkPlane(requireWave(state, contour.wave), next);
      const contours = graph.contours.map((item) => (item === contour ? next : item));
      return { state: putGraph(state, { ...graph, contours }), result: null };
    }
    case "removeContour": {
      const graph = requireGraph(state, command.graph);
      const contour = requireItem(graph.contours, command.contour, graph.name, "contour");
      const contours = graph.contours.filter((item) => item !== contour);
      return { state: putGraph(state, { ...graph, contours }), result: null };
    }
    case "setCursor": {
      const graph = requireGraph(state, command.graph);
      const cursor: CursorName = oneOf(command.cursor, CURSOR_NAMES, "cursor");
      const trace = requireItem(graph.traces, command.trace, graph.name, "trace");
      const length = state.waves[trace.y]?.data.length ?? 0;
      if (!Number.isInteger(command.point) || command.point < 0 || command.point >= length) {
        throw new DocError(
          `Point ${command.point} is out of range for ${trace.name} (${length} points).`,
        );
      }
      const next = putGraph(state, {
        ...graph,
        cursors: withEntry(graph.cursors, cursor, { trace: trace.name, point: command.point }),
      });
      return {
        state: followCursor(next, graph, cursor, cursorX(state, trace, command.point)),
        result: null,
      };
    }
    case "removeCursor": {
      const graph = requireGraph(state, command.graph);
      const cursor: CursorName = oneOf(command.cursor, CURSOR_NAMES, "cursor");
      const cursors = withoutEntries(graph.cursors, [cursor]);
      return {
        state: followCursor(putGraph(state, { ...graph, cursors }), graph, cursor, null),
        result: null,
      };
    }
    case "addAnnotation": {
      const graph = requireGraph(state, command.graph);
      const kind = oneOf(command.kind, ANNOTATION_KINDS, "kind");
      const text = ANNOTATION_VALIDATORS.text(command.text ?? "");
      if (kind === "colorscale") {
        if (graph.images.length === 0) throw new DocError(`${graph.name} has no image.`);
        if (text !== "") requireItem(graph.images, text, graph.name, "image");
      }
      const tag = kind === "tag";
      if (tag) {
        const trace = requireItem(graph.traces, command.trace ?? "", graph.name, "trace");
        const length = state.waves[trace.y]?.data.length ?? 0;
        if (index(command.point, "point") >= length) {
          throw new DocError(`Point ${command.point} is past the end of ${trace.name}.`);
        }
      }
      const annotation: AnnotationSpec = {
        name: uniqueName(kind, (name) => graph.annotations.some((item) => item.name === name)),
        kind,
        text,
        anchor: ANNOTATION_VALIDATORS.anchor(
          command.anchor ?? (kind === "colorscale" ? "RC" : "RT"),
        ),
        frame: ANNOTATION_VALIDATORS.frame(command.frame ?? true),
        x: ANNOTATION_VALIDATORS.x(command.x ?? (tag ? TAG_OFFSET.x : 0)),
        y: ANNOTATION_VALIDATORS.y(command.y ?? (tag ? TAG_OFFSET.y : 0)),
        trace: tag ? command.trace! : null,
        point: tag ? command.point! : 0,
      };
      return {
        state: putGraph(state, { ...graph, annotations: [...graph.annotations, annotation] }),
        result: annotation.name,
      };
    }
    case "modifyAnnotation": {
      const graph = requireGraph(state, command.graph);
      const target = requireItem(graph.annotations, command.annotation, graph.name, "annotation");
      const props = validateProps<AnnotationProps>(
        command.props,
        ANNOTATION_VALIDATORS,
        "annotation",
      );
      const annotations = graph.annotations.map((item) =>
        item === target ? { ...item, ...props } : item,
      );
      return { state: putGraph(state, { ...graph, annotations }), result: null };
    }
    case "removeAnnotation": {
      const graph = requireGraph(state, command.graph);
      const target = requireItem(graph.annotations, command.annotation, graph.name, "annotation");
      const annotations = graph.annotations.filter((item) => item !== target);
      return { state: putGraph(state, { ...graph, annotations }), result: null };
    }
    case "addDrawing": {
      const graph = requireGraph(state, command.graph);
      const kind = oneOf(command.kind, DRAWING_KINDS, "kind");
      const props = validateProps<DrawingProps>(
        { ...command.props, points: command.points },
        DRAWING_VALIDATORS,
        "drawing",
      );
      const drawing = checkDrawing(graph, {
        name: uniqueName("draw", (name) => graph.drawings.some((item) => item.name === name)),
        kind,
        points: [],
        ...defaultDrawing(kind),
        ...props,
      });
      return {
        state: putGraph(state, { ...graph, drawings: [...graph.drawings, drawing] }),
        result: drawing.name,
      };
    }
    case "modifyDrawing": {
      const graph = requireGraph(state, command.graph);
      const target = requireItem(graph.drawings, command.drawing, graph.name, "drawing");
      const props = validateProps<DrawingProps>(command.props, DRAWING_VALIDATORS, "drawing");
      const next = checkDrawing(graph, { ...target, ...props });
      const drawings = graph.drawings.map((item) => (item === target ? next : item));
      return { state: putGraph(state, { ...graph, drawings }), result: null };
    }
    case "removeDrawing": {
      const graph = requireGraph(state, command.graph);
      const target = requireItem(graph.drawings, command.drawing, graph.name, "drawing");
      const drawings = graph.drawings.filter((item) => item !== target);
      return { state: putGraph(state, { ...graph, drawings }), result: null };
    }
    case "orderDrawing": {
      const graph = requireGraph(state, command.graph);
      const target = requireItem(graph.drawings, command.drawing, graph.name, "drawing");
      const place = oneOf(command.place, ["front", "back"] as const, "place");
      const others = graph.drawings.filter((item) => item !== target);
      const drawings = place === "front" ? [...others, target] : [target, ...others];
      return { state: putGraph(state, { ...graph, drawings }), result: null };
    }
  }
}
