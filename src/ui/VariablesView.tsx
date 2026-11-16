import { useState } from "react";
import { useStore } from "../app/store";
import {
  kernel,
  pythonVariables,
  requestCommandLine,
  useKernelState,
  type MenuItem,
} from "../app/session";
import { dropCode } from "../kernel/variables";
import { Button, TextInput } from "./controls";
import { openContextMenu } from "./Menu";

/**
 * The user's variables in Python, as a variable explorer shows them: name,
 * type and a short description, refreshed after each input. Variables can
 * be dropped (`del`), one, several or all: what Python starts with (np, op)
 * is never listed, so it cannot be dropped by mistake.
 */
export function VariablesView() {
  const status = useStore(pythonVariables, (state) => state.status);
  const kernelState = useKernelState();
  const ready = kernelState.status === "ready";
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [confirmAll, setConfirmAll] = useState(false);
  const all = status?.variables ?? [];
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((item) =>
    words.every((word) => `${item.name} ${item.type} ${item.summary}`.toLowerCase().includes(word)),
  );
  const chosen = picked.filter((name) => all.some((item) => item.name === name));

  const drop = (names: readonly string[]) => {
    if (names.length === 0) return;
    kernel.execute(dropCode(names));
    setPicked([]);
    setConfirmAll(false);
  };
  const toggle = (name: string, on: boolean) =>
    setPicked(on ? [...chosen, name] : chosen.filter((item) => item !== name));
  const menu = (event: React.MouseEvent, name: string) => {
    event.preventDefault();
    const items: MenuItem[] = [
      { label: "Show Value", disabled: !ready, onSelect: () => kernel.execute(name) },
      { label: "Put the Name in the Command Line", onSelect: () => requestCommandLine(name) },
      { separator: true },
      { label: `Drop ${name}`, disabled: !ready, onSelect: () => drop([name]) },
    ];
    openContextMenu(event, items);
  };

  return (
    <div className="absolute inset-0 flex flex-col text-[12px]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <TextInput
          aria-label="Find variables"
          placeholder="Find"
          className="min-w-0 flex-1"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <Button
          className="!h-5 !px-2"
          disabled={!ready || chosen.length === 0}
          title="Delete the variables ticked from Python's namespace (del)"
          onClick={() => drop(chosen)}
        >
          Drop{chosen.length > 1 ? ` ${chosen.length}` : ""}
        </Button>
        {confirmAll ? (
          <>
            <Button
              className="!h-5 !px-2"
              disabled={!ready}
              onClick={() => drop(all.map((item) => item.name))}
            >
              Drop All {all.length}
            </Button>
            <Button className="!h-5 !px-2" onClick={() => setConfirmAll(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button
            className="!h-5 !px-2"
            disabled={!ready || all.length === 0}
            title="Delete every variable of yours from Python's namespace"
            onClick={() => setConfirmAll(true)}
          >
            Drop All…
          </Button>
        )}
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto bg-paper">
        {status === null ? (
          <p className="m-0 px-3 py-2 text-muted">
            {kernelState.status === "ready" || kernelState.status === "busy"
              ? "Run something in the command line to see its variables."
              : "Python is starting."}
          </p>
        ) : all.length === 0 ? (
          <p className="m-0 px-3 py-2 text-muted">No variables yet: `x = 1` makes one.</p>
        ) : (
          <table aria-label="Variables" className="w-full border-collapse font-mono text-[11.5px]">
            <thead className="sticky top-0 bg-chrome text-left font-sans text-[11px] text-muted">
              <tr>
                <th className="w-6 px-1 font-normal" />
                <th className="px-1 font-normal">Name</th>
                <th className="px-1 font-normal">Type</th>
                <th className="px-1 font-normal">Value</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr
                  key={item.name}
                  className="border-t border-line-soft hover:bg-chrome"
                  onDoubleClick={() => ready && kernel.execute(item.name)}
                  onContextMenu={(event) => menu(event, item.name)}
                >
                  <td className="px-1">
                    <input
                      type="checkbox"
                      aria-label={`Pick ${item.name}`}
                      checked={chosen.includes(item.name)}
                      onChange={(event) => toggle(item.name, event.target.checked)}
                    />
                  </td>
                  <td className="max-w-[10rem] truncate px-1">{item.name}</td>
                  <td className="truncate px-1 text-muted">{item.type}</td>
                  <td className="max-w-0 truncate px-1" title={item.summary}>
                    {item.summary}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex h-5 shrink-0 items-center gap-2 border-t border-line px-2 text-[11px] text-muted">
        <span>
          {all.length} variable{all.length === 1 ? "" : "s"}
          {status && status.more > 0 ? `, and ${status.more} more not listed` : ""}
        </span>
        {kernelState.status === "busy" ? <span>· as of the last input</span> : null}
      </div>
    </div>
  );
}
