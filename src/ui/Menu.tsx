import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GITHUB_URL } from "../app/links";
import { ui, useUi, type MenuItem } from "../app/session";

/**
 * Menus leave the keyboard focus where it was, so keys go on acting on the
 * window the menu command was for (Delete or the arrow keys on a page, say).
 */
export const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

const itemClass =
  "flex w-full items-center gap-4 px-3 py-[3px] text-left outline-none enabled:hover:bg-accent enabled:hover:text-white disabled:text-muted/60 disabled:opacity-50";

/** How far a menu keeps from the edges of the window. */
const EDGE = 4;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a submenu goes, relative to the item that opens it: to its right with
 * its first item level with it, unless that would leave the window, in which
 * case to its left, and moved up as far as it must to stay above the bottom.
 */
export function placeSubmenu(
  item: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  let x = item.right;
  if (x + size.width > viewport.width - EDGE) {
    const before = item.left - size.width;
    x = before >= EDGE ? before : Math.max(EDGE, viewport.width - EDGE - size.width);
  }
  // The list's top padding: its first item then lines up with this one.
  const y = Math.max(EDGE, Math.min(item.top - 4, viewport.height - EDGE - size.height));
  return { left: x - item.left, top: y - item.top };
}

/** An item that opens a menu of its own beside it, on hover or click. */
function SubmenuItem({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const show = open && !item.disabled;
  // Measured before it is painted, so it never shows where it does not fit.
  useLayoutEffect(() => {
    if (!show || !anchor.current || !list.current) {
      setPlace(null);
      return;
    }
    const { width, height } = list.current.getBoundingClientRect();
    setPlace(
      placeSubmenu(
        anchor.current.getBoundingClientRect(),
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [show]);
  return (
    <div
      ref={anchor}
      className="relative"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={show}
        disabled={item.disabled}
        className={`${itemClass} ${show ? "bg-accent text-white" : ""}`}
        // Opens, never closes: the pointer has opened it already by the time it clicks.
        onClick={() => setOpen(true)}
      >
        <span className="w-3" />
        <span className="-ml-3 flex-1">{item.label}</span>
        <span aria-hidden className="opacity-60">
          ▸
        </span>
      </button>
      {show ? (
        <div
          ref={list}
          className="absolute z-10 w-max"
          style={place ?? { left: "100%", top: 0, visibility: "hidden" }}
        >
          <MenuList items={item.submenu ?? []} onDone={onDone} />
        </div>
      ) : null}
    </div>
  );
}

export function MenuList({ items, onDone }: { items: readonly MenuItem[]; onDone: () => void }) {
  return (
    <div
      role="menu"
      className="min-w-44 rounded-md border border-line bg-paper py-1 shadow-xl"
      onMouseDown={keepFocus}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={index} className="my-1 border-t border-line-soft" />
        ) : item.submenu ? (
          <SubmenuItem key={index} item={item} onDone={onDone} />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={itemClass}
            onMouseDown={keepFocus}
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

/**
 * The menu bar as one menu, an item per menu opening its items beside it: the
 * same items, so the two show the same states and cannot drift apart.
 */
export const menuBarItems = (menus: readonly MenuDefinition[]): MenuItem[] =>
  menus.map((menu) => ({
    label: menu.title,
    submenu: menu.items,
    disabled: menu.items.length === 0,
  }));

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
    <div className="flex h-7 shrink-0 items-center border-b border-line bg-chrome px-1">
      <div ref={ref} role="menubar" className="flex min-w-0 flex-1 items-center">
        <span className="px-2 font-semibold tracking-tight">OresmePro</span>
        {menus.map((menu, index) => (
          <div key={menu.title} className="relative">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === index}
              className={`rounded px-2 py-0.5 outline-none ${open === index ? "bg-accent text-white" : "hover:bg-chrome-2"}`}
              onMouseDown={keepFocus}
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
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="OresmePro on GitHub"
        title="OresmePro on GitHub"
        className="mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-ink/70 hover:bg-chrome-2 hover:text-ink"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
      </a>
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
