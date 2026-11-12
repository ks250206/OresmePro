import { describe, expect, it } from "vite-plus/test";
import { menuBarItems, placeSubmenu } from "./Menu";

const viewport = { width: 1000, height: 700 };
const size = { width: 200, height: 300 };
/** An item 180 wide and 20 high whose top left corner is at (x, y). */
const item = (x: number, y: number) => ({ left: x, top: y, right: x + 180, bottom: y + 20 });

describe("submenus", () => {
  it("open to the right, level with their item, when they fit", () => {
    expect(placeSubmenu(item(100, 100), size, viewport)).toEqual({ left: 180, top: -4 });
  });

  it("open to the left near the right edge", () => {
    // 700 + 180 + 200 would pass 1000.
    expect(placeSubmenu(item(700, 100), size, viewport)).toEqual({ left: -200, top: -4 });
  });

  it("stay inside the window when neither side has room", () => {
    const narrow = { width: 400, height: 700 };
    const place = placeSubmenu(item(100, 100), size, narrow);
    // From the window's left: 100 + place.left, and it ends 4 short of the right edge.
    expect(100 + place.left + size.width).toBe(396);
  });

  it("move up near the bottom edge, but not above the top", () => {
    expect(placeSubmenu(item(100, 600), size, viewport)).toEqual({ left: 180, top: -204 });
    const short = { width: 1000, height: 200 };
    expect(placeSubmenu(item(100, 150), size, short).top).toBe(4 - 150);
  });
});

describe("the menu bar as a context menu", () => {
  it("has an item per menu with that menu's own items", () => {
    const undo = { label: "Undo", shortcut: "Ctrl+Z", disabled: true };
    const browser = { label: "Data Browser", checked: true };
    const items = menuBarItems([
      { title: "Edit", items: [undo] },
      { title: "Windows", items: [browser] },
      { title: "Empty", items: [] },
    ]);
    expect(items.map((entry) => entry.label)).toEqual(["Edit", "Windows", "Empty"]);
    expect(items[0]!.submenu![0]).toBe(undo);
    expect(items[1]!.submenu![0]).toBe(browser);
    expect(items.map((entry) => entry.disabled)).toEqual([false, false, true]);
  });
});
