import type { ReactNode } from "react";
import {
  setTools,
  SHOW_TOOLS_KEYS,
  toggleTools,
  type DrawTool,
  type GraphTools,
} from "../app/drawTools";

/** The icon of each tool: what it draws, in a 16×16 box. */
const ICONS: Record<DrawTool, ReactNode> = {
  select: <path d="M4 2.5v10l2.8-2.6 1.9 4.1 1.6-.7-1.9-4h3.8z" fill="currentColor" />,
  line: <path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.5" fill="none" />,
  arrow: (
    <>
      <path d="M3 13L11.5 4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M13.5 2.5l-1.2 5-3.8-3.8z" fill="currentColor" />
    </>
  ),
  rect: (
    <rect x="2.5" y="4" width="11" height="8" stroke="currentColor" strokeWidth="1.4" fill="none" />
  ),
  roundrect: (
    <rect
      x="2.5"
      y="4"
      width="11"
      height="8"
      rx="3"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
    />
  ),
  oval: (
    <ellipse cx="8" cy="8" rx="5.5" ry="4" stroke="currentColor" strokeWidth="1.4" fill="none" />
  ),
  polygon: (
    <path
      d="M3 12.5L5 4l5 2.5 3-3 .5 9z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      fill="none"
    />
  ),
  text: (
    <path d="M3.5 3.5h9M8 3.5v9.5M6 13h4" stroke="currentColor" strokeWidth="1.5" fill="none" />
  ),
};

const TITLES: Record<DrawTool, string> = {
  select: "Select: move, resize, change (double-click) or remove (Delete) a drawing",
  line: "Line: drag from one end to the other",
  arrow: "Arrow: drag from its tail to its head",
  rect: "Rectangle: drag from one corner to the opposite one",
  roundrect: "Rounded rectangle",
  oval: "Oval: drag across its box",
  polygon: "Polygon: click each corner, double-click the last",
  text: "Text: click where it starts",
};

const TOOLS: readonly DrawTool[] = [
  "select",
  "line",
  "arrow",
  "rect",
  "roundrect",
  "oval",
  "polygon",
  "text",
];

function ToolButton({
  label,
  title,
  pressed,
  onClick,
  children,
}: {
  label: string;
  title: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      className={`grid h-6 w-6 place-items-center rounded ${
        pressed ? "bg-accent text-white" : "text-ink/75 hover:bg-chrome-2 hover:text-ink"
      }`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

/**
 * The drawing tools of a graph, in a column beside it, as Igor's tool
 * palette: the tool to draw with, whether new drawings are pinned to the
 * axes, and a button to hide the palette.
 */
export function DrawPalette({ graph, tools }: { graph: string; tools: GraphTools }) {
  return (
    <div
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="vertical"
      className="flex w-8 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-chrome py-1"
    >
      {TOOLS.map((tool) => (
        <ToolButton
          key={tool}
          label={
            tool === "select"
              ? "Select"
              : `Draw ${tool === "roundrect" ? "rounded rectangle" : tool}`
          }
          title={TITLES[tool]}
          pressed={tools.tool === tool}
          onClick={() => setTools(graph, { tool, ...(tool === "select" ? {} : { selected: [] }) })}
        >
          {ICONS[tool]}
        </ToolButton>
      ))}
      <div className="my-1 h-px w-5 bg-line" />
      <ToolButton
        label="Pin new drawings to the axes"
        title={
          tools.onAxes
            ? "New drawings are pinned to the axes: they move with the data. Click to pin them to the plot area"
            : "New drawings stay where they are in the plot area. Click to pin them to the axes, to move with the data"
        }
        pressed={tools.onAxes}
        onClick={() => setTools(graph, { onAxes: !tools.onAxes })}
      >
        <path
          d="M2.5 13.5h11M2.5 13.5v-11M5.5 10.5l2.5-4 2 2 2.5-4"
          stroke="currentColor"
          strokeWidth="1.3"
          fill="none"
        />
      </ToolButton>
      <span className="flex-1" />
      <ToolButton
        label="Hide the drawing tools"
        title={`Hide the drawing tools (${SHOW_TOOLS_KEYS})`}
        pressed={false}
        onClick={() => toggleTools(graph, false)}
      >
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.4" />
      </ToolButton>
    </div>
  );
}
