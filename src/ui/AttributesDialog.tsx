import { useState } from "react";
import { runGui, ui, useDoc } from "../app/session";
import {
  checkAttributeName,
  folderKey,
  isFolderKey,
  type AttributeValue,
} from "../core/doc/attributes";
import type { DocState } from "../core/doc/types";
import { Button, Dialog, TextInput } from "./controls";

const close = () => ui.set({ dialog: null });

/** What a cell typed says: a number where it reads as one, text otherwise, and nothing when empty. */
export function attributeFromText(text: string): AttributeValue | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const number = Number(trimmed);
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed) && Number.isFinite(number)
    ? number
    : trimmed;
}

/**
 * The samples the table has a row for: the targets asked for, or every data
 * folder with waves in it (but the results' own copies), or, where there
 * are no folders, the waves of root.
 */
export function sampleRows(state: DocState, targets?: readonly string[]): string[] {
  if (targets && targets.length > 0) return [...targets];
  const folders = state.folders.filter(
    (folder) =>
      folder !== "results" &&
      !folder.startsWith("results:") &&
      state.waveOrder.some((wave) => wave.startsWith(`${folder}:`)),
  );
  if (folders.length > 0) return folders.map(folderKey);
  return state.waveOrder.filter((wave) => !wave.includes(":"));
}

/** One cell: typed text, committed when it is left or Enter is pressed. */
function Cell({
  row,
  name,
  value,
}: {
  row: string;
  name: string;
  value: AttributeValue | undefined;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === undefined ? "" : String(value));
  const commit = () => {
    if (text === null) return;
    const next = attributeFromText(text);
    setText(null);
    if (next === (value ?? null)) return;
    runGui({ op: "setAttributes", target: row, values: { [name]: next } });
  };
  return (
    <TextInput
      aria-label={`${name} of ${row}`}
      className="w-28"
      value={shown}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.stopPropagation();
          setText(null);
        }
      }}
    />
  );
}

/**
 * The attributes of samples as a table: a row for each data folder (or the
 * waves asked for), a column for each attribute. A folder's attributes are
 * those of every wave in it; results have the attributes of the wave they
 * read, so Analysis › Results can set them beside and plot against them.
 */
export function AttributesDialog({ targets }: { targets?: readonly string[] }) {
  const state = useDoc((current) => current);
  const rows = sampleRows(state, targets);
  const [added, setAdded] = useState<string[]>([]);
  const [column, setColumn] = useState("");
  const columns: string[] = [];
  for (const row of rows) {
    for (const name of Object.keys(state.attributes[row] ?? {})) {
      if (!columns.includes(name)) columns.push(name);
    }
  }
  for (const name of added) if (!columns.includes(name)) columns.push(name);
  const columnProblem = (() => {
    if (column === "") return null;
    try {
      checkAttributeName(column);
      return columns.includes(column) ? `${column} is there already.` : null;
    } catch (error) {
      return (error as Error).message;
    }
  })();
  const label = (row: string) => (isFolderKey(row) ? `${row.slice(0, -1)} (folder)` : row);
  const cell = "border-b border-r border-line-soft px-1 py-0.5 whitespace-nowrap";

  return (
    <Dialog title="Sample Attributes" width={760} onClose={close}>
      <p className="m-0 text-muted">
        A row for each sample: a data folder, whose attributes all its waves have, or a wave. Type
        numbers or text; an empty cell has no attribute. Results have the attributes of the wave
        they read (Analysis › Results).
      </p>
      {rows.length === 0 ? (
        <p className="m-0 text-muted">There are no samples yet: make or load some waves.</p>
      ) : (
        <div
          className="max-h-[50vh] overflow-auto rounded border border-line bg-paper"
          role="region"
          aria-label="Attributes"
        >
          <table className="border-separate border-spacing-0 text-left">
            <thead className="sticky top-0 z-10 bg-chrome">
              <tr>
                {["Sample", ...columns].map((title) => (
                  <th key={title} className={`${cell} border-line font-semibold`}>
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row}>
                  <td className={`${cell} font-medium`}>{label(row)}</td>
                  {columns.map((name) => (
                    <td key={name} className={cell}>
                      <Cell row={row} name={name} value={state.attributes[row]?.[name]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <TextInput
          aria-label="New attribute"
          aria-invalid={columnProblem !== null}
          placeholder="New attribute: thickness, Mg, cycle"
          className="w-64"
          value={column}
          onChange={(event) => setColumn(event.target.value.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && column && !columnProblem) {
              event.preventDefault();
              setAdded([...added, column]);
              setColumn("");
            }
          }}
        />
        <Button
          disabled={column === "" || columnProblem !== null}
          onClick={() => {
            setAdded([...added, column]);
            setColumn("");
          }}
        >
          Add Column
        </Button>
        {columnProblem ? <span className="text-[11px] text-danger">{columnProblem}</span> : null}
      </div>
    </Dialog>
  );
}
