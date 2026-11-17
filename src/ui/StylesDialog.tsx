/** The Styles dialog: the graph styles of the experiment and of the browser's library. */
import { useState, type ReactNode } from "react";
import {
  applyLibraryStyle,
  exportStyles,
  importStyles,
  libraryStyleCommands,
} from "../app/actions";
import { doc, graphSize, runGui, showError, useDoc, useLibraryStyles } from "../app/session";
import { browserLibrary, sameStyle } from "../app/styleLibrary";
import { checkName, uniqueName, type Command } from "../core/doc/commands";
import type { StyleSpec } from "../core/doc/types";
import { Button, Checkbox, Dialog, Field, NameList, Select, TextInput } from "./controls";
import { FONTS } from "./GraphDialogs";
import { close } from "./dialogParts";

/** What a style holds, in a few words. */
export function describeStyle(style: StyleSpec): string {
  const parts: string[] = [];
  const { graph, size, axes, traces } = style;
  if (graph) {
    const family =
      graph.fontFamily === undefined
        ? ""
        : (FONTS.find(([, value]) => value === graph.fontFamily)?.[0] ?? graph.fontFamily);
    const fontSize = graph.fontSize === undefined ? "" : `${graph.fontSize} px`;
    parts.push(`font ${[fontSize, family].filter(Boolean).join(" ")}`);
  }
  if (axes) parts.push(`axes ${Object.keys(axes).join(", ")}`);
  if (traces) parts.push(`${traces.length} trace look${traces.length === 1 ? "" : "s"}`);
  if (size) parts.push(`size ${size.width} × ${size.height}`);
  return parts.join(" · ") || "nothing yet";
}

export const isStyleName = (name: string): boolean => {
  try {
    checkName(name, "style");
    return true;
  } catch {
    return false;
  }
};

/** Runs something on the browser's library, telling the user if the browser would not. */
export function inLibrary(action: () => void): void {
  try {
    action();
  } catch (error) {
    showError("The style library did not change", error);
  }
}

export type StylePlace = "experiment" | "library";

/**
 * The styles of the experiment and of the browser's library: save a graph's
 * look as one, give it to graphs, choose the one new graphs get, and move
 * styles between the experiment, the library and files.
 */
export function StylesDialog({ graph: initial }: { graph?: string }) {
  const styles = useDoc((state) => state.styles);
  const defaultStyle = useDoc((state) => state.defaultStyle);
  const windows = useDoc((state) => state.windows);
  const graph = useDoc((state) => (initial && state.graphs[initial] ? initial : null));
  const current = useDoc((state) => (graph ? state.graphs[graph]!.style : null));
  const width = useDoc((state) => (graph ? graphSize(state, graph).width : 0));
  const height = useDoc((state) => (graph ? graphSize(state, graph).height : 0));
  const library = useLibraryStyles();
  const graphNames = windows.filter((window) => window.kind === "graph").map((w) => w.name);

  const [name, setName] = useState(
    () => current ?? uniqueName("style", (taken) => taken in doc.getState().styles),
  );
  const [withSize, setWithSize] = useState(false);
  const [picked, setPicked] = useState<{ place: StylePlace; names: string[] }>(() => ({
    place: "experiment",
    names: current ? [current] : [],
  }));
  const [targets, setTargets] = useState<string[]>(graph ? [graph] : []);
  const [renaming, setRenaming] = useState<string | null>(null);

  const source = (place: StylePlace) => (place === "experiment" ? styles : library);
  const chosen = picked.names.filter((item) => item in source(picked.place));
  const one = chosen.length === 1 ? chosen[0]! : null;
  const style = one ? source(picked.place)[one] : undefined;
  const pick = (place: StylePlace) => (names: string[]) => {
    setPicked({ place, names });
    setRenaming(null);
  };

  const save = () => {
    if (!graph) return;
    if (name in styles && !window.confirm(`Replace the style ${name}?`)) return;
    const command: Command = { op: "saveStyle", name, graph, ...(withSize ? { size: true } : {}) };
    if (runGui(command) !== undefined) pick("experiment")([name]);
  };
  const apply = (list: readonly string[]) => {
    if (!one || list.length === 0) return;
    if (picked.place === "library") applyLibraryStyle(one, list);
    else runGui({ op: "applyStyle", style: one, graphs: list });
  };
  const rename = () => {
    if (!one || renaming === null) return;
    const newName = renaming.trim();
    if (picked.place === "experiment") {
      if (runGui({ op: "renameStyle", name: one, newName }) === undefined) return;
    } else {
      let done = false;
      inLibrary(() => {
        browserLibrary().rename(one, newName);
        done = true;
      });
      if (!done) return;
    }
    pick(picked.place)([newName]);
  };
  const remove = () => {
    if (picked.place === "experiment") {
      runGui(chosen.map((item): Command => ({ op: "removeStyle", name: item })));
    } else if (
      window.confirm(`Delete ${chosen.join(", ")} from the library? This cannot be undone.`)
    ) {
      inLibrary(() => {
        for (const item of chosen) browserLibrary().remove(item);
      });
    }
  };
  const toLibrary = () =>
    inLibrary(() => {
      for (const item of chosen) {
        const there = library[item];
        if (
          there &&
          !sameStyle(there, styles[item]!) &&
          !window.confirm(`The library has a style ${item} already. Replace it?`)
        ) {
          continue;
        }
        browserLibrary().put(item, styles[item]!);
      }
    });
  const toExperiment = () => {
    const commands: Command[] = [];
    for (const item of chosen) commands.push(...(libraryStyleCommands(item) ?? []));
    runGui(commands);
  };

  const list = (place: StylePlace, title: string, buttons: ReactNode) => {
    const names = Object.keys(source(place));
    const selected = picked.place === place ? chosen : [];
    const renamingHere = renaming !== null && picked.place === place && one !== null;
    return (
      <div role="group" aria-label={title} className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-muted">{title}</div>
        <NameList
          label={title}
          names={names}
          selected={selected}
          onChange={pick(place)}
          height={120}
        />
        {renamingHere ? (
          <div className="flex gap-1.5">
            <TextInput
              aria-label="New name"
              aria-invalid={!isStyleName(renaming.trim())}
              autoFocus
              className="min-w-0 flex-1"
              value={renaming}
              onChange={(event) => setRenaming(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  rename();
                }
              }}
            />
            <Button disabled={!isStyleName(renaming.trim())} onClick={rename}>
              Rename
            </Button>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Button
              disabled={selected.length !== 1}
              onClick={() => setRenaming(selected[0] ?? null)}
            >
              Rename…
            </Button>
            <Button disabled={selected.length === 0} onClick={remove}>
              Delete
            </Button>
            {buttons}
            <Button
              disabled={selected.length === 0}
              onClick={() =>
                exportStyles(selected.map((item) => [item, source(place)[item]!] as const))
              }
            >
              Export…
            </Button>
          </div>
        )}
      </div>
    );
  };

  const libraryMissing = !browserLibrary().available;
  return (
    <Dialog title="Graph Styles" onClose={close} help="guides/graphs/" width={660}>
      {graph ? (
        <div role="group" aria-label="Save style" className="flex flex-col gap-1.5">
          <Field label={`Save ${graph} as`} group>
            <TextInput
              aria-label="Style name"
              aria-invalid={!isStyleName(name)}
              className="w-36"
              value={name}
              onChange={(event) => setName(event.target.value.trim())}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isStyleName(name)) {
                  event.preventDefault();
                  save();
                }
              }}
            />
            <Checkbox
              label={`Include size (${width} × ${height})`}
              checked={withSize}
              onChange={(event) => setWithSize(event.target.checked)}
            />
            <Button disabled={!isStyleName(name)} onClick={save}>
              Save
            </Button>
          </Field>
          <div className="pl-[104px] text-[11px] leading-relaxed text-muted">
            A style keeps fonts, ticks, mirror axes, grids and each trace&apos;s color, line and
            markers; not ranges, labels or data.
          </div>
        </div>
      ) : null}
      <div className="flex gap-3 border-t border-line-soft pt-2">
        {list(
          "experiment",
          "In this experiment",
          <Button
            disabled={chosen.length === 0 || picked.place !== "experiment" || libraryMissing}
            onClick={toLibrary}
          >
            To Library
          </Button>,
        )}
        {list(
          "library",
          "Library (this browser)",
          <>
            <Button
              disabled={chosen.length === 0 || picked.place !== "library"}
              onClick={toExperiment}
            >
              To Experiment
            </Button>
            <Button disabled={libraryMissing} onClick={importStyles}>
              Import…
            </Button>
          </>,
        )}
      </div>
      {libraryMissing ? (
        <div className="text-[11px] text-muted">
          This browser keeps no library: its storage is turned off. Export styles to keep them.
        </div>
      ) : null}
      <div className="text-[11px] text-muted">
        {one && style
          ? `${one}: ${describeStyle(style)}`
          : "Select a style to see what it holds and to apply it."}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line-soft pt-2">
        <Field label="New graphs get">
          <Select
            aria-label="Default style"
            value={defaultStyle ?? ""}
            onChange={(event) =>
              runGui({ op: "setDefaultStyle", name: event.target.value || null })
            }
          >
            <option value="">No style</option>
            {Object.keys(styles).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </Select>
        </Field>
        <Field label="Apply to" group>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <NameList
              label="Graphs"
              names={graphNames}
              selected={targets.filter((item) => graphNames.includes(item))}
              onChange={setTargets}
              height={84}
            />
            <div className="flex flex-wrap gap-1.5">
              {graph ? (
                <Button disabled={!one} onClick={() => apply([graph])}>
                  Apply to {graph}
                </Button>
              ) : null}
              <Button
                disabled={!one || targets.length === 0}
                onClick={() => apply(targets.filter((item) => graphNames.includes(item)))}
              >
                Apply to Selected Graphs
              </Button>
              <Button disabled={!one || graphNames.length === 0} onClick={() => apply(graphNames)}>
                Apply to All Graphs
              </Button>
            </div>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
