import { useRef, useState, type KeyboardEvent } from "react";
import {
  CALCULATED,
  appendPlan,
  graphNameProblem,
  graphTraces,
  inListOrder,
  isCurve,
  isXWave,
  newGraphPlan,
  nextGraphName,
  pairSelection,
  targetWaves,
  traceColors,
  traceInfo,
  waveDetails,
  type PlannedTrace,
} from "../app/newGraph";
import { requestCommandLine, runGui, ui, useDoc, useUi } from "../app/session";
import { isVerticalSide, type Wave } from "../core/doc/types";
import { isTimeZone, timeZone } from "../core/plot/ticks";
import { Button, Checkbox, Dialog, ListBox, Select, TextInput, type ListItem } from "./controls";

const close = () => ui.set({ dialog: null });

/** A list shows a box to narrow it by name once it is longer than this. */
const FILTER_FROM = 8;
const LIST_HEIGHT = 188;
/** The columns of the list of traces: color, trace, points, type, X range, unit, axes. */
const TRACE_COLUMNS =
  "grid grid-cols-[10px_minmax(0,1.5fr)_64px_80px_minmax(0,1.7fr)_56px_96px] items-center gap-x-2";

const narrow = (names: readonly string[], filter: string): string[] => {
  const text = filter.trim().toLowerCase();
  return text ? names.filter((name) => name.toLowerCase().includes(text)) : [...names];
};

const pointsOf = (wave: Wave): number => wave.shape[0] ?? 0;

/** A row of a wave list: its name, and on the right what tells waves apart at a glance. */
function WaveRow({ name, note }: { name: string; note: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 font-mono text-[10.5px] opacity-75">{note}</span>
    </span>
  );
}

/** A captioned list of waves with its filter box, one of the two at the top of the dialog. */
function WaveColumn({
  caption,
  label,
  filter,
  onFilter,
  showFilter,
  ...list
}: {
  caption: string;
  label: string;
  filter: string;
  onFilter: (text: string) => void;
  showFilter: boolean;
} & Parameters<typeof ListBox>[0]) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex h-6 items-center gap-2">
        <span className="font-semibold">{caption}</span>
        {showFilter ? (
          <TextInput
            aria-label={`Filter ${label}`}
            placeholder="Filter"
            className="ml-auto w-36"
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
          />
        ) : null}
      </div>
      <ListBox label={label} {...list} style={{ height: LIST_HEIGHT }} />
    </div>
  );
}

/**
 * Igor's New Graph dialog, which is also its Append Traces dialog: Y waves on
 * the left, X waves on the right, and below them the traces to make. Add puts
 * the pairs of the selection into that list, on the axes chosen beside it, so
 * one graph can get traces on several X waves and axes; with the list empty,
 * Do It makes what is selected.
 */
export function NewGraphDialog({ append }: { append?: string }) {
  const state = useDoc((doc) => doc);
  const { waves, waveOrder } = state;
  const graph = append ? state.graphs[append] : undefined;
  const zone = timeZone(isTimeZone(state.timeZone) ? state.timeZone : "UTC");
  const preselected = useUi((store) => store.selectedWaves);

  const [fromTarget, setFromTarget] = useState(false);
  const target = append ? null : targetWaves(state);
  const limit = fromTarget && target ? target.waves : null;
  const allowed = (name: string) => !limit || limit.includes(name);
  const yNames = waveOrder.filter((name) => isCurve(waves[name]!) && allowed(name));
  // Numeric X waves first, then the text waves that make category plots.
  const xNames = [
    ...waveOrder.filter((name) => isCurve(waves[name]!) && allowed(name)),
    ...waveOrder.filter((name) => waves[name]!.text && isXWave(waves[name]!) && allowed(name)),
  ];

  // Both lists or neither, so that they stay side by side at the same height.
  const showFilters = Math.max(yNames.length, xNames.length) > FILTER_FROM;
  const [yFilter, setYFilter] = useState("");
  const [xFilter, setXFilter] = useState("");
  const yShown = narrow(yNames, yFilter);
  const xShown = [CALCULATED, ...narrow(xNames, xFilter)];
  const [ySelected, setYSelected] = useState<string[]>(() =>
    preselected.filter((name) => yNames.includes(name)),
  );
  const [xSelected, setXSelected] = useState<string[]>([CALCULATED]);
  const y = inListOrder(ySelected, yShown);
  const x = inListOrder(xSelected, xShown);
  const [focused, setFocused] = useState<"y" | "x">("y");

  const [axes, setAxes] = useState({ vAxis: "left", hAxis: "bottom" });
  const axisNames = (vertical: boolean) =>
    graph
      ? Object.entries(graph.axes)
          .filter(([, axis]) => isVerticalSide(axis.side) === vertical)
          .map(([name]) => name)
      : vertical
        ? ["left", "right"]
        : ["bottom", "top"];

  const nextId = useRef(0);
  const [pending, setPending] = useState<(PlannedTrace & { id: string })[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [name, setName] = useState("");

  const pairing = pairSelection(waves, y, x, axes);
  const toMake: readonly PlannedTrace[] = pending.length > 0 ? pending : pairing.traces;
  const nameProblem = append ? null : graphNameProblem(state, name.trim());
  // A graph closed while the dialog is open can no longer be appended to.
  const canDo = toMake.length > 0 && nameProblem === null && (!append || graph !== undefined);

  const plan = () =>
    append
      ? appendPlan(append, toMake)
      : newGraphPlan(toMake, name.trim() || null, nextGraphName(state));
  const doIt = () => {
    const { commands, echo } = plan();
    if (runGui(commands, { echo }) !== undefined) close();
  };

  const add = (traces: readonly PlannedTrace[]) => {
    if (traces.length === 0) return;
    setPending((list) => [
      ...list,
      ...traces.map((trace) => ({ ...trace, id: `t${(nextId.current += 1)}` })),
    ]);
    setYSelected([]);
  };
  const remove = () => {
    setPending((list) => list.filter((trace) => !chosen.includes(trace.id)));
    setChosen([]);
  };
  /** Moves the chosen traces one place up (-1) or down (1), keeping them together. */
  const move = (step: -1 | 1) =>
    setPending((list) => {
      const next = [...list];
      const indices = next.map((_, index) => index).filter((i) => chosen.includes(next[i]!.id));
      const order = step < 0 ? indices : [...indices].reverse();
      for (const index of order) {
        const to = index + step;
        if (to < 0 || to >= next.length || chosen.includes(next[to]!.id)) continue;
        [next[index], next[to]] = [next[to]!, next[index]!];
      }
      return next;
    });
  const canMove = (step: -1 | 1) =>
    pending.some((trace, index) => {
      const to = index + step;
      return (
        chosen.includes(trace.id) &&
        to >= 0 &&
        to < pending.length &&
        !chosen.includes(pending[to]!.id)
      );
    });

  // What tells the waves apart at a glance: a Y wave whose length the chosen X
  // wave does not have, or an X wave that has the length of none of the Y waves.
  const yLengths = new Set(y.map((name) => pointsOf(waves[name]!)));
  const onlyX = x.length === 1 && x[0] !== CALCULATED ? waves[x[0]!] : undefined;
  const yItems: ListItem[] = yShown.map((name) => {
    const count = pointsOf(waves[name]!);
    return {
      key: name,
      text: name,
      label: <WaveRow name={name} note={count.toLocaleString("en-US")} />,
      muted: onlyX !== undefined && pointsOf(onlyX) !== count,
      title: `${name}: ${count.toLocaleString("en-US")} points`,
    };
  });
  const xItems: ListItem[] = xShown.map((name) => {
    if (name === CALCULATED) {
      return {
        key: name,
        text: name,
        label: <WaveRow name={name} note="X scaling" />,
        title: "Each Y wave against its own X scaling",
      };
    }
    const wave = waves[name]!;
    const count = pointsOf(wave);
    return {
      key: name,
      text: name,
      label: (
        <WaveRow name={name} note={`${wave.text ? "text " : ""}${count.toLocaleString("en-US")}`} />
      ),
      muted: yLengths.size > 0 && !yLengths.has(count),
      title: `${name}: ${count.toLocaleString("en-US")} points${wave.text ? ", text (categories)" : ""}`,
    };
  });

  const details = (() => {
    const selection = focused === "y" ? y : x;
    if (selection.length !== 1) return null;
    if (selection[0] === CALCULATED) {
      return "_calculated_: each Y wave against its own X scaling (start + point × step).";
    }
    const wave = waves[selection[0]!];
    return wave ? waveDetails(wave, zone) : null;
  })();

  // The bottom list: what the graph has (when appending), then what is to be added.
  const styleName = graph ? graph.style : state.defaultStyle;
  const style = styleName === null ? undefined : state.styles[styleName];
  const existing = graph ? graphTraces(graph) : [];
  const shownTraces: {
    key: string;
    trace: PlannedTrace;
    kind: "existing" | "pending" | "preview";
  }[] = [
    ...existing.map((trace, index) => ({
      key: `existing:${index}`,
      trace,
      kind: "existing" as const,
    })),
    ...(pending.length > 0
      ? pending.map((trace) => ({ key: trace.id, trace, kind: "pending" as const }))
      : pairing.traces.map((trace, index) => ({
          key: `preview:${index}`,
          trace,
          kind: "preview" as const,
        }))),
  ];
  const colors = traceColors(style, 0, shownTraces.length);
  const traceItems: ListItem[] = shownTraces.map(({ key, trace, kind }, index) => {
    const info = traceInfo(waves, trace, zone);
    return {
      key,
      text: info.label,
      disabled: kind !== "pending",
      // A line under what the graph has already sets it off from what is added.
      className:
        kind === "existing" && index === existing.length - 1 ? "border-b border-line" : undefined,
      title:
        kind === "existing"
          ? `Already in ${append}`
          : kind === "preview"
            ? "What Do It makes from the selection"
            : undefined,
      label: (
        <span className={`${TRACE_COLUMNS} ${kind === "preview" ? "italic" : ""}`}>
          <span
            aria-hidden
            className="h-2.5 w-2.5 rounded-sm border border-black/20"
            style={{ background: colors[index], opacity: kind === "existing" ? 0.5 : 1 }}
          />
          <span className="truncate">{info.label}</span>
          <span className="text-right font-mono text-[11px]">{info.points}</span>
          <span className="truncate font-mono text-[11px]">{info.type}</span>
          <span className="truncate font-mono text-[11px]" title={info.xRange}>
            {info.xRange}
          </span>
          <span className="truncate">{info.unit}</span>
          <span className="truncate">{info.axes}</span>
        </span>
      ),
    };
  });

  const traceKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === "Delete" || event.key === "Backspace") && chosen.length > 0) {
      event.preventDefault();
      remove();
    } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      move(event.key === "ArrowUp" ? -1 : 1);
    }
  };

  const status = pairing.problem ?? (pending.length > 0 && y.length === 0 ? "" : pairing.summary);
  const caption =
    pending.length > 0
      ? "Traces to add"
      : pairing.traces.length > 0
        ? "Traces to add: none yet, so Do It makes the selection shown"
        : "Traces to add";

  return (
    <Dialog
      title={append ? `Append Traces to ${append}` : "New Graph"}
      width={820}
      onClose={close}
      submitDisabled={!canDo}
      onSubmit={doIt}
      buttons={
        <Button
          disabled={!canDo}
          onClick={() => {
            requestCommandLine(plan().echo);
            close();
          }}
        >
          To Cmd Line
        </Button>
      }
    >
      {append ? null : (
        <Checkbox
          label={target ? `From target: only the waves in ${target.window}` : "From target"}
          disabled={!target}
          checked={fromTarget && Boolean(target)}
          onChange={(event) => setFromTarget(event.target.checked)}
        />
      )}
      <div className="flex gap-3">
        <WaveColumn
          caption="Y Waves"
          label="Y waves"
          autoFocus
          filter={yFilter}
          showFilter={showFilters}
          onFilter={(text) => {
            setYFilter(text);
            const visible = narrow(yNames, text);
            setYSelected((list) => list.filter((item) => visible.includes(item)));
          }}
          items={yItems}
          selected={ySelected}
          onChange={setYSelected}
          onFocus={() => setFocused("y")}
          onActivate={(key) => add(pairSelection(waves, [key], x, axes).traces)}
          empty={limit ? `No numeric 1-D waves in ${target?.window}.` : "No numeric 1-D waves."}
        />
        <WaveColumn
          caption="X Waves"
          label="X waves"
          filter={xFilter}
          showFilter={showFilters}
          onFilter={(text) => {
            setXFilter(text);
            const visible = [CALCULATED, ...narrow(xNames, text)];
            setXSelected((list) => list.filter((item) => visible.includes(item)));
          }}
          items={xItems}
          selected={xSelected}
          onChange={setXSelected}
          onFocus={() => setFocused("x")}
        />
      </div>
      <div className="flex min-h-[2.6em] flex-col justify-center gap-0.5 text-[11.5px] leading-snug">
        <div
          role="status"
          aria-label="Pairing"
          className={pairing.problem ? "font-medium text-danger" : "text-muted"}
        >
          {status}
        </div>
        <div
          aria-label="Wave details"
          className="selectable truncate font-mono text-[11px] text-muted"
        >
          {details ?? " "}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pairing.traces.length === 0} onClick={() => add(pairing.traces)}>
          Add
        </Button>
        <Button disabled={chosen.length === 0} onClick={remove}>
          Remove
        </Button>
        <span className="ml-2 text-muted">Axes for the traces added</span>
        <Select
          aria-label="Vertical axis"
          value={axes.vAxis}
          onChange={(event) => setAxes({ ...axes, vAxis: event.target.value })}
        >
          {axisNames(true).map((axis) => (
            <option key={axis}>{axis}</option>
          ))}
        </Select>
        <Select
          aria-label="Horizontal axis"
          value={axes.hAxis}
          onChange={(event) => setAxes({ ...axes, hAxis: event.target.value })}
        >
          {axisNames(false).map((axis) => (
            <option key={axis}>{axis}</option>
          ))}
        </Select>
        <span className="ml-auto flex gap-1">
          <Button
            aria-label="Move up"
            title="Move up (Alt+↑)"
            disabled={!canMove(-1)}
            onClick={() => move(-1)}
            className="px-2"
          >
            ▲
          </Button>
          <Button
            aria-label="Move down"
            title="Move down (Alt+↓)"
            disabled={!canMove(1)}
            onClick={() => move(1)}
            className="px-2"
          >
            ▼
          </Button>
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="flex gap-2">
          <span className="font-semibold">{caption}</span>
          {existing.length > 0 ? (
            <span className="ml-auto text-muted">Greyed: already in {append}</span>
          ) : null}
        </span>
        <div aria-hidden className={`${TRACE_COLUMNS} px-2 text-[11px] text-muted`}>
          <span />
          <span>Trace</span>
          <span className="text-right">Points</span>
          <span>Type</span>
          <span>X range</span>
          <span>Unit</span>
          <span>Axes</span>
        </div>
        <ListBox
          label="Traces to add"
          items={traceItems}
          selected={chosen}
          onChange={setChosen}
          onKeyDown={traceKeys}
          style={{ height: 128 }}
          empty="Select Y waves and an X wave above, then Add, or Do It to make them at once."
        />
      </div>
      {append ? null : (
        <label className="flex items-center gap-2">
          <span className="text-muted">Graph name</span>
          <TextInput
            aria-label="Graph name"
            aria-invalid={nameProblem !== null}
            placeholder={nextGraphName(state)}
            className="w-40"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <span className={nameProblem ? "text-danger" : "text-muted"}>
            {nameProblem ?? "Left empty, the next free name."}
          </span>
        </label>
      )}
    </Dialog>
  );
}
