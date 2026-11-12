import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  width?: number;
}) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
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
        className="max-h-[76vh] overflow-hidden rounded-lg border border-line bg-chrome shadow-2xl flex flex-col"
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

/** A multi-select list of names, as in Igor's New Graph dialog. */
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
    <div
      role="listbox"
      aria-label={label}
      aria-multiselectable={multiple}
      className="overflow-auto rounded border border-line bg-paper"
      style={{ height }}
    >
      {names.length === 0 ? <div className="p-2 text-muted">Nothing here yet.</div> : null}
      {names.map((name) => {
        const active = selected.includes(name);
        return (
          <div
            key={name}
            role="option"
            aria-selected={active}
            className={`cursor-default px-2 py-0.5 ${active ? "bg-accent text-white" : "hover:bg-chrome"}`}
            onPointerDown={(event) => {
              if (multiple && (event.metaKey || event.ctrlKey)) {
                onChange(active ? selected.filter((item) => item !== name) : [...selected, name]);
              } else if (multiple && event.shiftKey && selected.length > 0) {
                const from = names.indexOf(selected.at(-1)!);
                const to = names.indexOf(name);
                const range = names.slice(Math.min(from, to), Math.max(from, to) + 1);
                onChange([...new Set([...selected, ...range])]);
              } else {
                onChange([name]);
              }
            }}
          >
            {name}
          </div>
        );
      })}
    </div>
  );
}
