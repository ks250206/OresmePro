import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ui, useUi, type MenuItem } from "../app/session";

export function MenuList({ items, onDone }: { items: readonly MenuItem[]; onDone: () => void }) {
  return (
    <div
      role="menu"
      className="min-w-44 rounded-md border border-line bg-paper py-1 shadow-xl"
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={index} className="my-1 border-t border-line-soft" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className="flex w-full items-center gap-4 px-3 py-[3px] text-left outline-none enabled:hover:bg-accent enabled:hover:text-white disabled:text-muted/60"
            onClick={() => {
              onDone();
              item.onSelect?.();
            }}
          >
            <span className="w-3 text-center">{item.checked ? "✓" : ""}</span>
            <span className="-ml-3 flex-1">{item.label}</span>
            {item.shortcut ? <span className="opacity-60">{item.shortcut}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}

export interface MenuDefinition {
  title: string;
  items: MenuItem[];
}

export function MenuBar({ menus }: { menus: readonly MenuDefinition[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return undefined;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      role="menubar"
      className="flex h-7 shrink-0 items-center border-b border-line bg-chrome px-1"
    >
      <span className="px-2 font-semibold tracking-tight">OresmePro</span>
      {menus.map((menu, index) => (
        <div key={menu.title} className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            className={`rounded px-2 py-0.5 outline-none ${open === index ? "bg-accent text-white" : "hover:bg-chrome-2"}`}
            onPointerDown={() => setOpen(open === index ? null : index)}
            onPointerEnter={() => {
              if (open !== null) setOpen(index);
            }}
          >
            {menu.title}
          </button>
          {open === index ? (
            <div className="absolute left-0 top-full z-40 mt-0.5">
              <MenuList items={menu.items} onDone={() => setOpen(null)} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Renders the context menu requested through the UI store. */
export function ContextMenuHost() {
  const menu = useUi((state) => state.contextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPosition({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && ref.current?.contains(event.target as Node)) return;
      ui.set({ contextMenu: null });
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} className="fixed z-50" style={{ left: position.x, top: position.y }}>
      <MenuList items={menu.items} onDone={() => ui.set({ contextMenu: null })} />
    </div>
  );
}

export function openContextMenu(event: { clientX: number; clientY: number }, items: MenuItem[]) {
  ui.set({ contextMenu: { x: event.clientX, y: event.clientY, items } });
}
