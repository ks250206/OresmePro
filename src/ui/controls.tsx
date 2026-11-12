import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

const inputClass =
  "h-6 rounded border border-line bg-paper px-1.5 outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:bg-chrome disabled:text-muted";

export function Button({
  primary,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`h-6 rounded border px-3 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 ${
        primary
          ? "border-accent bg-accent font-medium text-white hover:brightness-110"
          : "border-line bg-paper hover:bg-chrome"
      } ${className}`}
    />
  );
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input type="text" spellCheck={false} {...props} className={`${inputClass} ${className}`} />
  );
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} pr-1 ${className}`} />;
}

export function Checkbox({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" {...props} className="accent-accent" />
      <span>{label}</span>
    </label>
  );
}

/**
 * A labelled row in a dialog form. With `group`, the row holds several
 * controls that each have a label of their own (two checkboxes, say): the
 * caption then names the group instead of becoming part of the first
 * control's name.
 */
export function Field({
  label,
  group,
  children,
}: {
  label: string;
  group?: boolean;
  children: ReactNode;
}) {
  const caption = <span className="w-24 shrink-0 text-right text-muted">{label}</span>;
  const content = <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>;
  return group ? (
    <div role="group" aria-label={label} className="flex items-center gap-2">
      {caption}
      {content}
    </div>
  ) : (
    <label className="flex items-center gap-2">
      {caption}
      {content}
    </label>
  );
}

/** A modal dialog with Igor's "Do It" / "Cancel" footer. */
export function Dialog({
  title,
  children,
  onClose,
  onSubmit,
  submitLabel = "Do It",
  submitDisabled,
  width = 420,
  buttons,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  width?: number;
  /** More buttons for the footer, on the left as in Igor ("To Cmd Line"). */
  buttons?: ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const first =
      ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      ref.current?.querySelector<HTMLElement>(
        "[autofocus], input:not([type=checkbox]), select, textarea",
      );
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[12vh]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        ref={ref}
        role="dialog"
        aria-label={title}
        style={{ width }}
        className="max-h-[76vh] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-chrome shadow-2xl flex flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitDisabled) onSubmit?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="border-b border-line-soft px-3 py-2 font-semibold">{title}</div>
        <div className="flex min-h-0 flex-col gap-2 overflow-auto p-3">{children}</div>
        <div className="flex justify-end gap-2 border-t border-line-soft px-3 py-2">
          {buttons ? <div className="mr-auto flex gap-2">{buttons}</div> : null}
          <Button onClick={onClose}>{onSubmit ? "Cancel" : "Close"}</Button>
          {onSubmit ? (
            <Button primary type="submit" disabled={submitDisabled}>
              {submitLabel}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

export interface ListItem {
  key: string;
  /** What the row shows; `text` when left out. */
  label?: ReactNode;
  /** The row's name: what it is called to assistive technology and found by typing. */
  text: string;
  /** Shown greyed, but still selectable. */
  muted?: boolean;
  /** Shown greyed and cannot be selected. */
  disabled?: boolean;
  title?: string;
  className?: string;
}

/**
 * A list to choose from, with the selection gestures of a desktop list:
 * click, Ctrl/Cmd-click to toggle, Shift-click for a range; the arrow keys,
 * Home and End (with Shift to extend), Ctrl/Cmd+A, and typing the start of a
 * name to jump to it. Keys it does not use go to `onKeyDown`.
 */
export function ListBox({
  items,
  selected,
  onChange,
  multiple = true,
  label,
  className = "",
  style,
  empty = "Nothing here yet.",
  onActivate,
  onKeyDown,
  onFocus,
  autoFocus,
  optionClassName,
}: {
  items: readonly ListItem[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  multiple?: boolean;
  label: string;
  className?: string;
  style?: CSSProperties;
  empty?: ReactNode;
  /** A double-click on a row. */
  onActivate?: (key: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  /** The control the dialog starts in. */
  autoFocus?: boolean;
  /** Classes for every row, for lists laid out in columns. */
  optionClassName?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const keys = items.filter((item) => !item.disabled).map((item) => item.key);
  const current = cursor !== null && keys.includes(cursor) ? cursor : null;
  const activeIndex = items.findIndex((item) => item.key === current);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, id]);

  const choose = (key: string, { toggle = false, extend = false } = {}) => {
    setCursor(key);
    const from = anchor.current !== null ? keys.indexOf(anchor.current) : -1;
    if (multiple && extend && from >= 0) {
      const to = keys.indexOf(key);
      const range = keys.slice(Math.min(from, to), Math.max(from, to) + 1);
      onChange(toggle ? [...new Set([...selected, ...range])] : range);
      return;
    }
    anchor.current = key;
    if (multiple && toggle) {
      onChange(
        selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key],
      );
    } else {
      onChange([key]);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const command = event.ctrlKey || event.metaKey;
    const at = current ?? selected.find((key) => keys.includes(key)) ?? null;
    const index = at === null ? -1 : keys.indexOf(at);
    const page = Math.max(1, Math.floor((ref.current?.clientHeight ?? 200) / 20) - 1);
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index < 0 ? 0 : index - 1,
      PageDown: index + page,
      PageUp: index - page,
      Home: 0,
      End: keys.length - 1,
    };
    if (event.key in moves && !event.altKey && keys.length > 0) {
      event.preventDefault();
      const key = keys[Math.max(0, Math.min(keys.length - 1, moves[event.key]!))]!;
      if (command && !event.shiftKey && multiple) setCursor(key);
      else choose(key, { extend: event.shiftKey, toggle: command });
      return;
    }
    if (event.key === " " && current !== null) {
      event.preventDefault();
      choose(current, { toggle: command });
      return;
    }
    if (command && event.key.toLowerCase() === "a" && multiple) {
      event.preventDefault();
      onChange(keys);
      return;
    }
    if (event.key.length === 1 && !command && !event.altKey && event.key !== " ") {
      const now = Date.now();
      const text =
        (now - typed.current.at < 800 ? typed.current.text : "") + event.key.toLowerCase();
      typed.current = { text, at: now };
      const found = items.find(
        (item) => !item.disabled && item.text.toLowerCase().startsWith(text),
      );
      if (found) choose(found.key);
      event.preventDefault();
      return;
    }
    onKeyDown?.(event);
    // Return does what it does in Igor's dialogs: Do It.
    if (event.key === "Enter" && !event.defaultPrevented) {
      event.preventDefault();
      ref.current?.closest("form")?.requestSubmit();
    }
  };
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      aria-multiselectable={multiple}
      aria-activedescendant={activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
      tabIndex={0}
      data-autofocus={autoFocus || undefined}
      className={`group overflow-auto rounded border border-line bg-paper outline-none focus:border-accent focus:ring-1 focus:ring-accent ${className}`}
      style={style}
      onKeyDown={keyDown}
      onFocus={onFocus}
    >
      {items.length === 0 ? <div className="p-2 text-muted">{empty}</div> : null}
      {items.map((item, index) => {
        const active = selected.includes(item.key);
        return (
          <div
            key={item.key}
            id={`${id}-${index}`}
            role="option"
            aria-selected={active}
            aria-disabled={item.disabled || undefined}
            aria-label={item.text}
            title={item.title}
            className={`cursor-default px-2 py-0.5 ${
              active
                ? "bg-accent text-white"
                : item.disabled || item.muted
                  ? "text-muted hover:bg-chrome"
                  : "hover:bg-chrome"
            } ${item.key === current ? "group-focus:outline group-focus:outline-1 group-focus:-outline-offset-1 group-focus:outline-dotted" : ""} ${optionClassName ?? ""} ${item.className ?? ""}`}
            onMouseDown={(event) => {
              // Keep the text from being selected by Shift-click; focus the list instead.
              event.preventDefault();
              ref.current?.focus();
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || item.disabled) return;
              choose(item.key, { toggle: event.metaKey || event.ctrlKey, extend: event.shiftKey });
            }}
            onDoubleClick={() => {
              if (!item.disabled) onActivate?.(item.key);
            }}
          >
            {item.label ?? item.text}
          </div>
        );
      })}
    </div>
  );
}

/** A list of names to choose one or several from. */
export function NameList({
  names,
  selected,
  onChange,
  multiple = true,
  height = 150,
  label,
}: {
  names: readonly string[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  multiple?: boolean;
  height?: number;
  label: string;
}) {
  return (
    <ListBox
      label={label}
      items={names.map((name) => ({ key: name, text: name }))}
      selected={selected}
      onChange={onChange}
      multiple={multiple}
      style={{ height }}
    />
  );
}
