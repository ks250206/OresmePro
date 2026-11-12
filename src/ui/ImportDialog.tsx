import { useMemo, useState, useSyncExternalStore } from "react";
import { importFile, pickFile, type PendingFile } from "../app/actions";
import type { ImportPreset } from "../app/importPresets";
import { doc, importPresets, showError, ui } from "../app/session";
import {
  columnsFromRows,
  parseDelimited,
  type ColumnChoice,
  type ColumnType,
  type DelimitedResult,
} from "../core/io/delimited";
import {
  decodeText,
  ENCODINGS,
  importKind,
  type Encoding,
  type ImportSettings,
} from "../core/io/importData";
import { readXlsx, type Sheet } from "../core/io/xlsx";
import { timeZone } from "../core/plot/ticks";
import { Button, Checkbox, Dialog, Field, Select, TextInput } from "./controls";

/** Rows and columns of the file shown in the preview. */
const PREVIEW_ROWS = 100;
const PREVIEW_COLUMNS = 40;

const DELIMITER_LABELS = { tab: "Tab", comma: "Comma", semicolon: "Semicolon", space: "Spaces" };
const TYPE_LABELS: Record<Exclude<ColumnType, "auto" | "skip">, string> = {
  number: "Number",
  date: "Date",
  text: "Text",
};

/** What a column of the file is used for besides being a wave. */
function roleOf(settings: ImportSettings, column: number): string {
  if (settings.x === column) return "x";
  const value = Object.entries(settings.errors ?? {}).find(([, error]) => error === column);
  return value ? `error:${value[0]}` : "";
}

function withRole(settings: ImportSettings, column: number, role: string): ImportSettings {
  // A column has one role: taking a new one gives up the old.
  const errors = Object.fromEntries(
    Object.entries(settings.errors ?? {}).filter(
      ([value, error]) => error !== column && Number(value) !== column,
    ),
  );
  const next: ImportSettings = { ...settings, errors };
  if (settings.x === column) delete next.x;
  if (role === "x") next.x = column;
  else if (role.startsWith("error:")) errors[Number(role.slice(6))] = column;
  return next;
}

function withChoice(settings: ImportSettings, column: number, change: ColumnChoice) {
  const choice = { ...settings.columns?.[column], ...change };
  // An empty box means "as the file says", not an empty name or unit.
  if (!choice.name) delete choice.name;
  if (!choice.unit) delete choice.unit;
  if (choice.type === "auto") delete choice.type;
  return { ...settings, columns: { ...settings.columns, [column]: choice } };
}

interface Preview {
  result: DelimitedResult | null;
  /** The encoding the text was read in, or null for a workbook. */
  encoding: string | null;
  error: string | null;
}

/** Reads enough of the file to show how the settings read it. */
function usePreview(
  file: PendingFile,
  settings: ImportSettings,
  sheets: readonly Sheet[] | null,
  sheet: string | null,
): Preview {
  const kind = importKind(file.name);
  const decoded = useMemo(
    () => (kind === "text" ? decodeText(file.bytes, settings.encoding) : null),
    [kind, file, settings.encoding],
  );
  return useMemo(() => {
    const state = doc.getState();
    const taken = (name: string) => name in state.waves;
    const zone = timeZone(state.timeZone);
    try {
      if (decoded) {
        return {
          result: parseDelimited(decoded.text, taken, zone, { ...settings, limit: PREVIEW_ROWS }),
          encoding: decoded.encoding,
          error: null,
        };
      }
      const rows = sheets?.find((item) => item.name === sheet)?.rows ?? [];
      const shown = rows.slice(0, (settings.skip ?? 0) + PREVIEW_ROWS + 2);
      return { result: columnsFromRows(shown, taken, zone, settings), encoding: null, error: null };
    } catch (error) {
      return {
        result: null,
        encoding: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [decoded, settings, sheets, sheet]);
}

function PreviewTable({
  result,
  settings,
  onChange,
}: {
  result: DelimitedResult;
  settings: ImportSettings;
  onChange: (settings: ImportSettings) => void;
}) {
  const columns = Array.from({ length: Math.min(result.width, PREVIEW_COLUMNS) }, (_, i) => i);
  /** For each column of the file, where it is among the columns that are read (or -1). */
  const read = columns.map((column) => result.indices.indexOf(column));
  const unreadable = read.map((index) => new Set(index >= 0 ? result.unreadable[index] : []));
  const titleOf = (column: number) =>
    read[column]! >= 0 ? result.names[read[column]!]! : `column ${column + 1}`;
  const detected = (column: number): string => {
    const index = read[column]!;
    if (index < 0) return "";
    if (result.dates[index]) return "date";
    return result.columns[index] instanceof Float64Array ? "number" : "text";
  };
  const cellClass = "border-b border-r border-line-soft px-1.5 py-0.5 whitespace-nowrap";
  return (
    <div
      className="max-h-[38vh] overflow-auto rounded border border-line bg-paper"
      role="region"
      aria-label="Preview"
    >
      <table className="border-separate border-spacing-0 text-left">
        <thead className="sticky top-0 z-10 bg-chrome">
          <tr>
            <th className="border-b border-r border-line px-1.5 py-1 align-top font-normal text-muted">
              {/* One label per control of the columns beside it, at the same height. */}
              <div className="flex flex-col gap-1 text-right leading-6">
                <span>Wave</span>
                <span>Type</span>
                <span>Unit</span>
                <span>Use</span>
              </div>
            </th>
            {columns.map((column) => {
              const choice = settings.columns?.[column] ?? {};
              const skipped = choice.type === "skip";
              const index = read[column]!;
              return (
                <th
                  key={column}
                  className="border-b border-r border-line px-1 py-1 align-top font-normal"
                >
                  <div className="flex w-32 flex-col gap-1">
                    <TextInput
                      aria-label={`Name of column ${column + 1}`}
                      disabled={skipped}
                      placeholder={index >= 0 ? result.names[index] : ""}
                      value={choice.name ?? ""}
                      onChange={(event) =>
                        onChange(withChoice(settings, column, { name: event.target.value }))
                      }
                    />
                    <Select
                      aria-label={`Type of column ${column + 1}`}
                      value={choice.type ?? "auto"}
                      onChange={(event) =>
                        onChange(
                          withChoice(settings, column, { type: event.target.value as ColumnType }),
                        )
                      }
                    >
                      <option value="auto">
                        Auto{detected(column) && !choice.type ? ` (${detected(column)})` : ""}
                      </option>
                      {Object.entries(TYPE_LABELS).map(([type, label]) => (
                        <option key={type} value={type}>
                          {label}
                        </option>
                      ))}
                      <option value="skip">Do not load</option>
                    </Select>
                    <TextInput
                      aria-label={`Unit of column ${column + 1}`}
                      disabled={skipped}
                      placeholder={(index >= 0 && result.units[index]) || "unit"}
                      value={choice.unit ?? ""}
                      onChange={(event) =>
                        onChange(withChoice(settings, column, { unit: event.target.value }))
                      }
                    />
                    <Select
                      aria-label={`Role of column ${column + 1}`}
                      disabled={skipped}
                      value={roleOf(settings, column)}
                      onChange={(event) => onChange(withRole(settings, column, event.target.value))}
                    >
                      <option value="">Data</option>
                      <option value="x">X for the graph</option>
                      {columns
                        .filter((other) => other !== column && read[other]! >= 0)
                        .map((other) => (
                          <option key={other} value={`error:${other}`}>
                            ± of {titleOf(other)}
                          </option>
                        ))}
                    </Select>
                  </div>
                </th>
              );
            })}
          </tr>
          {result.hasHeader ? (
            <tr>
              <th className={`${cellClass} bg-chrome text-right font-normal text-muted`}>Header</th>
              {columns.map((column) => (
                <th key={column} className={`${cellClass} bg-chrome font-semibold`}>
                  {result.header[column] ?? ""}
                </th>
              ))}
            </tr>
          ) : null}
        </thead>
        <tbody className="selectable font-mono text-[11px]">
          {result.cells.slice(0, PREVIEW_ROWS).map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className={`${cellClass} bg-chrome text-right font-sans text-muted`}>
                {rowIndex + 1}
              </td>
              {columns.map((column) => {
                const bad = unreadable[column]!.has(rowIndex);
                const skipped = settings.columns?.[column]?.type === "skip";
                return (
                  <td
                    key={column}
                    data-unreadable={bad || undefined}
                    title={bad ? "Could not be read as the type chosen: will be NaN" : undefined}
                    className={`${cellClass} ${
                      bad ? "bg-red-100 text-red-800" : skipped ? "text-muted/50" : ""
                    }`}
                  >
                    {row[column] ?? ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Says in a line how the file was found to be laid out. */
function describe(preview: Preview, settings: ImportSettings, kind: "text" | "excel"): string {
  const { result } = preview;
  if (!result || result.width === 0) return "Nothing to load with these settings.";
  const parts = [
    `${result.rows >= PREVIEW_ROWS ? `first ${Math.min(result.rows, PREVIEW_ROWS)}` : result.rows} rows`,
    `${result.width} columns${result.width > PREVIEW_COLUMNS ? ` (first ${PREVIEW_COLUMNS} shown)` : ""}`,
  ];
  if (kind === "text") {
    if (result.delimiter)
      parts.push(`separated by ${DELIMITER_LABELS[result.delimiter].toLowerCase()}`);
    if (preview.encoding) parts.push(preview.encoding);
  }
  if (result.skip > 0) {
    parts.push(
      `${result.skip} ${kind === "text" ? "lines" : "rows"} above the table${settings.skip === undefined ? " (found)" : ""}`,
    );
  }
  parts.push(result.hasHeader ? "with a header" : "no header");
  return parts.join(" · ");
}

function PresetBar({
  file,
  preset,
  settings,
  onApply,
}: {
  file: PendingFile;
  preset: string;
  settings: ImportSettings;
  onApply: (preset: ImportPreset | null) => void;
}) {
  const presets = useSyncExternalStore(importPresets.subscribe, importPresets.list);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const extension = /\.[^.]+$/.exec(file.name)?.[0] ?? "";
  const [pattern, setPattern] = useState(extension ? `*${extension}` : "");
  return (
    <>
      <Field label="Preset" group>
        <Select
          aria-label="Preset"
          className="min-w-40"
          value={preset}
          onChange={(event) => onApply(importPresets.get(event.target.value) ?? null)}
        >
          <option value="">None: as detected</option>
          {presets.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
              {item.pattern ? ` (${item.pattern})` : ""}
            </option>
          ))}
        </Select>
        <Button
          onClick={() => {
            setName(preset);
            if (preset) setPattern(importPresets.get(preset)?.pattern ?? "");
            setSaving(!saving);
          }}
        >
          Save As…
        </Button>
        <Button
          disabled={!preset}
          onClick={() => {
            importPresets.remove(preset);
            onApply(null);
          }}
        >
          Delete
        </Button>
        <span className="flex-1" />
        <Button
          onClick={() =>
            pickFile(".json,application/json", false, (picked) => {
              void picked[0]?.text().then((text) => {
                try {
                  importPresets.import(text);
                } catch (error) {
                  showError("Could not import the presets", error);
                }
              });
            })
          }
        >
          Import…
        </Button>
        <Button
          disabled={presets.length === 0}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([importPresets.export()], { type: "application/json" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "import-presets.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Export…
        </Button>
      </Field>
      {saving ? (
        <Field label="Save as" group>
          <TextInput
            aria-label="Preset name"
            placeholder="Name, such as the instrument"
            className="min-w-0 flex-1"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextInput
            aria-label="File names it is for"
            title="Files whose names fit are read with this preset without asking. * and ? stand for any text; several patterns are separated by commas."
            placeholder="*.csv (optional)"
            className="w-36"
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
          />
          <Button
            disabled={name.trim() === ""}
            onClick={() => {
              const saved = { name: name.trim(), pattern: pattern.trim(), settings };
              importPresets.save(saved);
              setSaving(false);
              onApply(importPresets.get(saved.name) ?? null);
            }}
          >
            Save Preset
          </Button>
        </Field>
      ) : null}
    </>
  );
}

/**
 * Shows how a file of data will be read before it is, and lets every guess
 * be corrected: the encoding, what separates the columns, where the table
 * starts, and each column's name, unit and type.
 */
export function ImportDialog({ file, rest }: { file: PendingFile; rest: readonly PendingFile[] }) {
  const kind = importKind(file.name);
  const matched = useMemo(() => importPresets.match(file.name), [file.name]);
  const [preset, setPreset] = useState(matched?.name ?? "");
  const [settings, setSettings] = useState<ImportSettings>(matched?.settings ?? {});
  const [keep, setKeep] = useState(true);
  const [sameForRest, setSameForRest] = useState(false);
  const [busy, setBusy] = useState(false);
  const workbook = useMemo((): { sheets: Sheet[] | null; error: string | null } => {
    if (kind !== "excel") return { sheets: null, error: null };
    try {
      return { sheets: readXlsx(file.bytes), error: null };
    } catch (error) {
      return { sheets: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [kind, file]);
  const [sheet, setSheet] = useState<string | null>(null);
  const shownSheet = sheet ?? workbook.sheets?.[0]?.name ?? null;
  const preview = usePreview(file, settings, workbook.sheets, shownSheet);
  const error = workbook.error ?? preview.error;
  const set = (change: Partial<ImportSettings>) => setSettings({ ...settings, ...change });
  const close = () => ui.set({ dialog: null });
  const loaded = (name: string) => settings.sheets?.includes(name) ?? true;

  const load = async () => {
    setBusy(true);
    try {
      if (!(await importFile(file, settings, keep))) return;
      let next = [...rest];
      if (sameForRest) {
        for (const other of rest) await importFile(other, settings, keep);
        next = [];
      }
      ui.set({
        dialog: next[0] ? { kind: "importData", file: next[0], rest: next.slice(1) } : null,
      });
    } finally {
      setBusy(false);
    }
  };

  const nothing = !preview.result || preview.result.names.length === 0;
  const unread =
    preview.result?.unreadable
      .map((rows, index) =>
        rows.length > 0
          ? `${preview.result!.names[index]} (${rows.length}${rows.length >= 1000 ? "+" : ""})`
          : "",
      )
      .filter(Boolean) ?? [];
  return (
    <Dialog
      title={`Load Data: ${file.name}`}
      width={920}
      onClose={close}
      onSubmit={() => void load()}
      submitLabel={rest.length > 0 && !sameForRest ? "Load and Go On" : "Load"}
      submitDisabled={busy || nothing || error !== null}
    >
      <PresetBar
        file={file}
        preset={preset}
        settings={settings}
        onApply={(chosen) => {
          setPreset(chosen?.name ?? "");
          setSettings(chosen?.settings ?? {});
        }}
      />
      {kind === "text" ? (
        <Field label="File" group>
          <Select
            aria-label="Encoding"
            value={settings.encoding ?? "auto"}
            onChange={(event) => set({ encoding: event.target.value as Encoding })}
          >
            {ENCODINGS.map((encoding) => (
              <option key={encoding} value={encoding}>
                {encoding === "auto" ? "Encoding: detect" : encoding}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Delimiter"
            value={settings.delimiter ?? "auto"}
            onChange={(event) =>
              set({ delimiter: event.target.value as ImportSettings["delimiter"] })
            }
          >
            <option value="auto">Columns: detect</option>
            {Object.entries(DELIMITER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1">
            <span className="text-muted">Comments</span>
            <TextInput
              aria-label="Comment marker"
              className="w-10"
              value={settings.comment ?? "#"}
              onChange={(event) => set({ comment: event.target.value })}
            />
          </label>
        </Field>
      ) : (
        <Field label="Sheets" group>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {(workbook.sheets ?? []).map((item) => (
              <span key={item.name} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  className="accent-accent"
                  aria-label={`Load sheet ${item.name}`}
                  checked={loaded(item.name)}
                  onChange={(event) => {
                    const names = (workbook.sheets ?? [])
                      .map((other) => other.name)
                      .filter((name) => (name === item.name ? event.target.checked : loaded(name)));
                    set({ sheets: names });
                  }}
                />
                <button
                  type="button"
                  aria-pressed={item.name === shownSheet}
                  className={`rounded px-1 ${item.name === shownSheet ? "bg-accent text-white" : "hover:bg-paper"}`}
                  onClick={() => setSheet(item.name)}
                >
                  {item.name}
                </button>
              </span>
            ))}
          </span>
        </Field>
      )}
      <Field label="Table" group>
        <label className="flex items-center gap-1">
          <span className="text-muted">{kind === "text" ? "Skip lines" : "Skip rows"}</span>
          <TextInput
            aria-label={kind === "text" ? "Lines to skip" : "Rows to skip"}
            className="w-14"
            inputMode="numeric"
            placeholder={kind === "text" ? "detect" : "0"}
            value={settings.skip ?? ""}
            onChange={(event) => {
              const text = event.target.value.trim();
              const next = { ...settings };
              if (/^\d+$/.test(text)) next.skip = Number(text);
              else delete next.skip;
              setSettings(next);
            }}
          />
        </label>
        <Select
          aria-label="Header"
          value={settings.header ?? "auto"}
          onChange={(event) => set({ header: event.target.value as ImportSettings["header"] })}
        >
          <option value="auto">Header: detect</option>
          <option value="yes">First row is a header</option>
          <option value="no">No header</option>
        </Select>
        <Select
          aria-label="Units"
          value={settings.units ?? "auto"}
          onChange={(event) => set({ units: event.target.value as ImportSettings["units"] })}
        >
          <option value="auto">Units: from "Name (unit)"</option>
          <option value="slash">Units: from "Name/unit"</option>
          <option value="row">Units: in the row below the header</option>
          <option value="none">No units</option>
        </Select>
        <Select
          aria-label="Decimal mark"
          value={settings.decimal ?? "."}
          onChange={(event) => set({ decimal: event.target.value as "." | "," })}
        >
          <option value=".">Decimal point: 1.5</option>
          <option value=",">Decimal comma: 1,5</option>
        </Select>
      </Field>
      {error ? (
        <p className="m-0 rounded border border-red-300 bg-red-50 px-2 py-1 text-red-800">
          {error}
        </p>
      ) : (
        <>
          <p className="m-0 text-muted" aria-label="How the file reads">
            {describe(preview, settings, kind)}
          </p>
          {preview.result && preview.result.width > 0 ? (
            <PreviewTable result={preview.result} settings={settings} onChange={setSettings} />
          ) : null}
          {unread.length > 0 ? (
            <p className="m-0 text-red-800" role="status">
              Cells that cannot be read as the type chosen become NaN: {unread.join(", ")}.
            </p>
          ) : null}
        </>
      )}
      <Field label="Then" group>
        <Checkbox
          label="Make a table"
          checked={settings.table ?? true}
          onChange={(event) => set({ table: event.target.checked })}
        />
        <Checkbox
          label="Make a graph"
          checked={settings.graph ?? false}
          onChange={(event) => set({ graph: event.target.checked })}
        />
        <Checkbox
          label="Keep the file with the experiment"
          title="The file is saved with the experiment and the history gets the line of Python that loads it again."
          checked={keep}
          onChange={(event) => setKeep(event.target.checked)}
        />
      </Field>
      {rest.length > 0 ? (
        <Field label="Other files" group>
          <Checkbox
            label={`Load the other ${rest.length} the same way, without asking`}
            checked={sameForRest}
            onChange={(event) => setSameForRest(event.target.checked)}
          />
        </Field>
      ) : null}
    </Dialog>
  );
}
