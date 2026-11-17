import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { setValue, viewStore } from "../app/pluginViews";
import { useStore } from "../app/store";
import {
  getPath,
  readGraph,
  type ViewGraph,
  type ViewGraphNode,
  type ViewNode,
  type ViewNodeKind,
  type ViewPortSide,
} from "../core/plugins/view";
import { Button } from "./controls";

/**
 * The nodes part of a plugin's view (docs/design/plugin-views.md §8): boxes
 * with ports, joined by edges, edited here and kept at the part's bind as
 * {nodes, edges}. Nodes are added from the palette, moved by dragging, and
 * joined by dragging from one port to another; Delete takes out what is
 * selected. What the graph means (a circuit, say) is the view's Python's to
 * read. Every edit is one step of the window's undo.
 */

type NodesNode = Extract<ViewNode, { type: "nodes" }>;

const BOX_HEIGHT = 26;
const PORT_RADIUS = 4;
const GRID = 10;

const boxWidth = (node: ViewGraphNode): number => Math.max(44, node.label.length * 7 + 18);

/** A kind for a node the palette does not list: no ports, drawn plain. */
const unknownKind = (kind: string): ViewNodeKind => ({
  kind,
  title: kind,
  ports: [],
  color: null,
  add: false,
});

/** Where a node's port is, from the node's place and the port's side. */
function portAt(node: ViewGraphNode, kind: ViewNodeKind, port: string): [number, number] | null {
  const index = kind.ports.findIndex((item) => item.name === port);
  if (index < 0) return null;
  const side = kind.ports[index]!.side;
  const along = kind.ports.filter((item) => item.side === side);
  const at = along.findIndex((item) => item.name === port);
  const width = boxWidth(node);
  const share = (at + 1) / (along.length + 1);
  const places: Record<ViewPortSide, [number, number]> = {
    left: [node.x, node.y + BOX_HEIGHT * share],
    right: [node.x + width, node.y + BOX_HEIGHT * share],
    top: [node.x + width * share, node.y],
    bottom: [node.x + width * share, node.y + BOX_HEIGHT],
  };
  return places[side];
}

/** A curve from a port, leaving it outward on its side, to a point. */
function wire(
  from: [number, number],
  fromSide: ViewPortSide,
  to: [number, number],
  toSide: ViewPortSide | null,
): string {
  const out = (side: ViewPortSide | null, [x, y]: [number, number], reach: number) => {
    if (side === "left") return [x - reach, y];
    if (side === "right") return [x + reach, y];
    if (side === "top") return [x, y - reach];
    if (side === "bottom") return [x, y + reach];
    return [x, y];
  };
  const reach = Math.max(20, Math.hypot(to[0] - from[0], to[1] - from[1]) / 3);
  const [c1x, c1y] = out(fromSide, from, reach);
  const [c2x, c2y] = out(toSide, to, reach);
  return `M${from[0]},${from[1]} C${c1x},${c1y} ${c2x},${c2y} ${to[0]},${to[1]}`;
}

/** The first id of a kind's own: the kind and the least number not taken (R0, R1, ...). */
export function freeId(graph: ViewGraph, kind: string): string {
  const taken = new Set(graph.nodes.map((node) => node.id));
  for (let index = 0; ; index += 1) if (!taken.has(`${kind}${index}`)) return `${kind}${index}`;
}

/** A place for a new node where none is yet, row by row from the top left. */
export function freePlace(graph: ViewGraph, width: number, height: number): [number, number] {
  const free = (x: number, y: number) =>
    graph.nodes.every(
      (node) =>
        x + 70 <= node.x ||
        x >= node.x + boxWidth(node) + 10 ||
        y + BOX_HEIGHT + 14 <= node.y ||
        y >= node.y + BOX_HEIGHT + 14,
    );
  for (let y = 16; y + BOX_HEIGHT < height; y += BOX_HEIGHT + 20)
    for (let x = 16; x + 60 < width; x += 80) if (free(x, y)) return [x, y];
  return [16, 16];
}

type Selection = { node: string } | { edge: number } | null;

type Gesture =
  | { type: "move"; id: string; dx: number; dy: number; x: number; y: number; moved: boolean }
  | { type: "wire"; from: [string, string]; x: number; y: number };

export function ViewNodes({ viewKey, node }: { viewKey: string; node: NodesNode }) {
  const raw = useStore(viewStore(viewKey), (state) => getPath(state.state, node.bind));
  const graph = useMemo(() => readGraph(raw), [raw]);
  const kinds = useMemo(() => new Map(node.palette.map((kind) => [kind.kind, kind])), [node]);
  const kindOf = (id: string) => {
    const found = graph.nodes.find((item) => item.id === id);
    return found ? (kinds.get(found.kind) ?? unknownKind(found.kind)) : null;
  };
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(480);
  const [selected, setSelected] = useState<Selection>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const commit = (next: ViewGraph) =>
    setValue(viewKey, node.bind, {
      ...(raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}),
      nodes: next.nodes.map(({ id, kind, label, x, y, fixed }) =>
        fixed ? { id, kind, label, x, y, fixed } : { id, kind, label, x, y },
      ),
      edges: next.edges,
    });
  const local = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = svg.current!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const add = (kind: ViewNodeKind) => {
    const id = freeId(graph, kind.kind);
    const [x, y] = freePlace(graph, width, node.height);
    commit({
      ...graph,
      nodes: [...graph.nodes, { id, kind: kind.kind, label: id, x, y, fixed: false }],
    });
    setSelected({ node: id });
  };
  const remove = () => {
    if (!selected) return;
    // The button goes grey with nothing selected: the diagram keeps the focus, and so the
    // window's undo, rather than the page and the experiment's.
    svg.current?.focus({ preventScroll: true });
    if ("edge" in selected) {
      commit({ ...graph, edges: graph.edges.filter((_, index) => index !== selected.edge) });
    } else {
      const target = graph.nodes.find((item) => item.id === selected.node);
      if (!target || target.fixed) return;
      commit({
        nodes: graph.nodes.filter((item) => item.id !== target.id),
        edges: graph.edges.filter((edge) => edge.from[0] !== target.id && edge.to[0] !== target.id),
      });
    }
    setSelected(null);
  };
  const connect = (from: [string, string], to: [string, string]) => {
    if (from[0] === to[0]) return;
    const same = (a: [string, string], b: [string, string]) => a[0] === b[0] && a[1] === b[1];
    if (
      graph.edges.some(
        (edge) =>
          (same(edge.from, from) && same(edge.to, to)) ||
          (same(edge.from, to) && same(edge.to, from)),
      )
    )
      return;
    commit({ ...graph, edges: [...graph.edges, { from, to }] });
  };
  const removable =
    selected !== null &&
    ("edge" in selected || graph.nodes.some((item) => item.id === selected.node && !item.fixed));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    event.stopPropagation();
    remove();
  };

  /** Where each node is drawn: where it is, or where it is being dragged to. */
  const placed = graph.nodes.map((item) =>
    gesture?.type === "move" && gesture.id === item.id
      ? { ...item, x: gesture.x, y: gesture.y }
      : item,
  );
  const placeOf = new Map(placed.map((item) => [item.id, item]));
  const port = ([id, name]: [string, string]) => {
    const at = placeOf.get(id);
    const kind = kindOf(id);
    if (!at || !kind) return null;
    const point = portAt(at, kind, name);
    const side = kind.ports.find((item) => item.name === name)?.side ?? null;
    return point && side ? { point, side } : null;
  };
  const selectedLabel =
    selected === null
      ? ""
      : "edge" in selected
        ? "the connection"
        : (graph.nodes.find((item) => item.id === selected.node)?.label ?? "");

  let edges: ReactNode[] = [];
  edges = graph.edges.map((edge, index) => {
    const a = port(edge.from);
    const b = port(edge.to);
    if (!a || !b) return null;
    const path = wire(a.point, a.side, b.point, b.side);
    const chosen = selected !== null && "edge" in selected && selected.edge === index;
    const name = `Connection from ${edge.from.join(".")} to ${edge.to.join(".")}`;
    return (
      <g
        key={`edge-${index}`}
        role="button"
        aria-label={name}
        aria-pressed={chosen}
        onPointerDown={(event) => {
          event.stopPropagation();
          setSelected({ edge: index });
          svg.current?.focus({ preventScroll: true });
        }}
      >
        <path d={path} fill="none" stroke="transparent" strokeWidth={10} />
        <path
          d={path}
          fill="none"
          stroke={chosen ? "#1f6fd1" : "#3b424d"}
          strokeWidth={chosen ? 2.25 : 1.5}
        />
      </g>
    );
  });

  return (
    <div ref={box} className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {node.label ? <span className="mr-1 text-[11px] text-muted">{node.label}</span> : null}
        {node.palette
          .filter((kind) => kind.add)
          .map((kind) => (
            <Button key={kind.kind} title={`Add ${kind.title}`} onClick={() => add(kind)}>
              + {kind.kind}
            </Button>
          ))}
        <Button disabled={!removable} onClick={remove}>
          {removable ? `Remove ${selectedLabel}` : "Remove"}
        </Button>
      </div>
      <div
        className="overflow-auto rounded border border-line-soft bg-paper"
        style={{ height: node.height }}
      >
        <svg
          ref={svg}
          role="group"
          aria-label={node.label || "Nodes"}
          tabIndex={0}
          // As large as the diagram, scrolled when it is larger than the part.
          width={Math.max(width - 2, ...placed.map((item) => item.x + boxWidth(item) + 24))}
          height={Math.max(node.height - 2, ...placed.map((item) => item.y + BOX_HEIGHT + 24))}
          className="block touch-none outline-none"
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (event.button === 0) setSelected(null);
          }}
          onPointerMove={(event) => {
            if (!gesture) return;
            const [px, py] = local(event);
            if (gesture.type === "wire") setGesture({ ...gesture, x: px, y: py });
            else {
              const x = Math.max(0, Math.round((px - gesture.dx) / GRID) * GRID);
              const y = Math.max(0, Math.round((py - gesture.dy) / GRID) * GRID);
              setGesture({
                ...gesture,
                x,
                y,
                moved: gesture.moved || x !== gesture.x || y !== gesture.y,
              });
            }
          }}
          onPointerUp={(event) => {
            if (!gesture) return;
            setGesture(null);
            if (gesture.type === "move") {
              if (!gesture.moved) return;
              commit({
                ...graph,
                nodes: graph.nodes.map((item) =>
                  item.id === gesture.id ? { ...item, x: gesture.x, y: gesture.y } : item,
                ),
              });
              return;
            }
            // Let go on a port: the edge is made between the two.
            const target = (
              document.elementFromPoint(event.clientX, event.clientY) as Element | null
            )
              ?.closest("[data-port]")
              ?.getAttribute("data-port");
            if (target) connect(gesture.from, target.split(".") as [string, string]);
          }}
          onPointerCancel={() => setGesture(null)}
        >
          {edges}
          {gesture?.type === "wire"
            ? (() => {
                const start = port(gesture.from);
                return start ? (
                  <path
                    d={wire(start.point, start.side, [gesture.x, gesture.y], null)}
                    fill="none"
                    stroke="#1f6fd1"
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                  />
                ) : null;
              })()
            : null}
          {placed.map((item) => {
            const kind = kinds.get(item.kind) ?? unknownKind(item.kind);
            const w = boxWidth(item);
            const chosen = selected !== null && "node" in selected && selected.node === item.id;
            const color = kind.color ?? "#3b424d";
            return (
              <g key={item.id}>
                <g
                  role="button"
                  aria-label={`Node ${item.label}`}
                  aria-pressed={chosen}
                  style={{ cursor: "move" }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    svg.current?.focus({ preventScroll: true });
                    svg.current?.setPointerCapture(event.pointerId);
                    setSelected({ node: item.id });
                    const [px, py] = local(event);
                    setGesture({
                      type: "move",
                      id: item.id,
                      dx: px - item.x,
                      dy: py - item.y,
                      x: item.x,
                      y: item.y,
                      moved: false,
                    });
                  }}
                >
                  <rect
                    x={item.x}
                    y={item.y}
                    width={w}
                    height={BOX_HEIGHT}
                    rx={item.fixed ? BOX_HEIGHT / 2 : 4}
                    fill={item.fixed ? "#eef1f5" : "#ffffff"}
                    stroke={chosen ? "#1f6fd1" : color}
                    strokeWidth={chosen ? 2 : 1.25}
                  />
                  <text
                    x={item.x + w / 2}
                    y={item.y + BOX_HEIGHT / 2 + 4}
                    textAnchor="middle"
                    fontSize={12}
                    fill={color}
                    style={{ userSelect: "none" }}
                  >
                    {item.label}
                  </text>
                </g>
                {kind.ports.map((each) => {
                  const point = portAt(item, kind, each.name)!;
                  return (
                    <circle
                      key={each.name}
                      data-port={`${item.id}.${each.name}`}
                      role="button"
                      aria-label={`Port ${each.name} of ${item.label}`}
                      cx={point[0]}
                      cy={point[1]}
                      r={PORT_RADIUS}
                      fill="#ffffff"
                      stroke="#1f6fd1"
                      strokeWidth={1.25}
                      style={{ cursor: "crosshair" }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        svg.current?.setPointerCapture(event.pointerId);
                        const [px, py] = local(event);
                        setGesture({ type: "wire", from: [item.id, each.name], x: px, y: py });
                      }}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
