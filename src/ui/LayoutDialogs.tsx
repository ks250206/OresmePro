/** The dialogs of page layouts: text on a page, and arranging items. */
import { useRef, useState } from "react";
import { arrangeItems } from "../app/actions";
import { useDoc } from "../app/session";
import { GRID_GAP, GRID_MARGIN, GRID_PRESETS, readingOrder } from "../core/doc/arrange";
import { Button, Dialog, Field, MarkupButtons, MarkupHelp, TextInput } from "./controls";
import { close, parseNumber, submit } from "./dialogParts";

/** Adds a block of text to a page layout, or changes one that is there. */
export function PageTextDialog({ layout, item }: { layout: string; item?: string }) {
  const existing = useDoc((state) =>
    state.pages[layout]?.items.find((other) => other.name === item),
  );
  const [text, setText] = useState(existing?.text ?? "");
  const [size, setSize] = useState(String(existing?.size ?? 12));
  const field = useRef<HTMLTextAreaElement>(null);
  if (item && !existing) return null;
  const points = parseNumber(size);
  const invalid = points === null || points < 4 || points > 200;
  const props: Record<string, unknown> = {};
  if (existing) {
    if (text !== existing.text) props.text = text;
    if (!invalid && points !== existing.size) props.size = points;
  }
  return (
    <Dialog
      title={existing ? `Edit Text — ${layout}` : `Add Text — ${layout}`}
      onClose={close}
      submitDisabled={
        invalid || text.trim() === "" || (existing ? Object.keys(props).length === 0 : false)
      }
      onSubmit={() =>
        submit(
          existing
            ? { op: "modifyLayoutItem", layout, item: existing.name, props }
            : { op: "addLayoutItem", layout, kind: "text", text, size: points! },
        )
      }
    >
      <textarea
        ref={field}
        aria-label="Text"
        autoFocus
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="selectable resize-none rounded border border-line bg-paper p-1.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      />
      <MarkupButtons field={field} value={text} onChange={setText} />
      <MarkupHelp />
      <Field label="Size">
        <TextInput
          aria-label="Size"
          aria-invalid={invalid}
          className="w-16"
          value={size}
          onChange={(event) => setSize(event.target.value)}
        />
        <span className="text-muted">points</span>
      </Field>
    </Dialog>
  );
}

/**
 * Puts graphs of a page layout in a grid of rows and columns that fills the
 * paper inside its margins: the selected graphs, or all of them.
 */
export function ArrangeLayoutDialog({
  layout,
  items,
}: {
  layout: string;
  items: readonly string[];
}) {
  const page = useDoc((state) =>
    Object.hasOwn(state.pages, layout) ? state.pages[layout] : undefined,
  );
  const [rows, setRows] = useState("2");
  const [columns, setColumns] = useState("2");
  const [margin, setMargin] = useState(String(GRID_MARGIN));
  const [across, setAcross] = useState(String(GRID_GAP));
  const [down, setDown] = useState(String(GRID_GAP));
  if (!page) return null;
  const count = (text: string) => {
    const value = parseNumber(text);
    return value !== null && Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
  };
  const points = (text: string) => {
    const value = parseNumber(text);
    return value !== null && value >= 0 ? value : null;
  };
  const values = {
    rows: count(rows),
    columns: count(columns),
    margin: points(margin),
    across: points(across),
    down: points(down),
  };
  const valid = Object.values(values).every((value) => value !== null);
  // The order the cells are filled in, as Python would take them.
  const graphs = page.items.filter((item) => item.kind === "graph");
  const order =
    items.length > 0 ? [...items] : readingOrder(graphs).map((index) => graphs[index]!.name);
  const cells = (values.rows ?? 0) * (values.columns ?? 0);
  const leftOut = valid ? order.slice(cells) : [];
  const number = (
    label: string,
    value: string,
    set: (text: string) => void,
    invalid: boolean,
    unit?: string,
  ) => (
    <Field label={label}>
      <TextInput
        aria-label={label}
        aria-invalid={invalid}
        className="w-16"
        value={value}
        onChange={(event) => set(event.target.value)}
      />
      {unit ? <span className="text-muted">{unit}</span> : null}
    </Field>
  );
  return (
    <Dialog
      title={`Arrange in Grid — ${layout}`}
      onClose={close}
      submitDisabled={!valid}
      onSubmit={() => {
        const done = arrangeItems(layout, {
          action: "arrange",
          items: items.length > 0 ? items : null,
          rows: values.rows!,
          columns: values.columns!,
          margin: values.margin!,
          gap: [values.across!, values.down!],
        });
        if (done) close();
      }}
    >
      <Field label="Presets" group>
        {GRID_PRESETS.map(([presetRows, presetColumns]) => (
          <Button
            key={`${presetRows}x${presetColumns}`}
            className="!px-2"
            aria-pressed={values.rows === presetRows && values.columns === presetColumns}
            onClick={() => {
              setRows(String(presetRows));
              setColumns(String(presetColumns));
            }}
          >
            {presetRows} × {presetColumns}
          </Button>
        ))}
      </Field>
      {number("Rows", rows, setRows, values.rows === null)}
      {number("Columns", columns, setColumns, values.columns === null)}
      {number("Margin", margin, setMargin, values.margin === null, "points around the grid")}
      <Field label="Gaps" group>
        <TextInput
          aria-label="Gap between columns"
          aria-invalid={values.across === null}
          className="w-16"
          value={across}
          onChange={(event) => setAcross(event.target.value)}
        />
        <span className="text-muted">across,</span>
        <TextInput
          aria-label="Gap between rows"
          aria-invalid={values.down === null}
          className="w-16"
          value={down}
          onChange={(event) => setDown(event.target.value)}
        />
        <span className="text-muted">down, in points</span>
      </Field>
      <p className="m-0 pl-[104px] text-[11px] leading-relaxed text-muted">
        {items.length > 0
          ? `The ${order.length} selected graph${order.length === 1 ? "" : "s"}`
          : `All ${order.length} graph${order.length === 1 ? "" : "s"} of the page`}{" "}
        fill the cells row by row, in the order they read on the page now. Text stays where it is.
        {leftOut.length > 0
          ? ` ${leftOut.join(", ")} ${leftOut.length === 1 ? "does" : "do"} not fit and ${
              leftOut.length === 1 ? "stays" : "stay"
            } where ${leftOut.length === 1 ? "it is" : "they are"}.`
          : ""}
      </p>
    </Dialog>
  );
}
