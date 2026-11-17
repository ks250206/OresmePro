import { describe, expect, it } from "vite-plus/test";
import { parseEditor } from "../core/plugins/editor";
import type { PluginAction } from "../core/plugins/manifest";
import { dragged, draggedFields, removeItem } from "./pluginEditors";

/** What dragging does to an item's fields is the plugin's rule, applied here. */
const params = {
  data: { type: "wave" as const, optional: false },
  items: { type: "json" as const, optional: false },
};
const actions: PluginAction[] = [
  { name: "preview", title: "Preview", description: "", params },
  { name: "fit", title: "Fit", description: "", params },
];
const spec = (drag: Record<string, unknown>) =>
  parseEditor(
    {
      kind: "spectrum-fit",
      name: "peaks",
      title: "Peaks",
      preview: "preview",
      fit: "fit",
      items: {
        param: "items",
        fields: [
          { key: "x" },
          { key: "height" },
          { key: "area" },
          { key: "sigma", min: 0.1 },
          { key: "other", default: 3 },
        ],
        drag,
      },
    },
    0,
    actions,
  );

describe("dragging an item of a model editor", () => {
  const start = { x: 10, height: 4, area: 20, sigma: 2, other: 3 };

  it("moves it and scales an area-like field with its height", () => {
    const editor = spec({ x: "x", height: { field: "area", rule: "proportional" } });
    expect(dragged(editor, start, [], { kind: "top", x: 12, height: 8, startHeight: 4 })).toEqual({
      x: 12,
      area: 40,
    });
    // A tied field follows the item it is tied to, not the mouse.
    expect(
      dragged(editor, start, ["x"], { kind: "top", x: 12, height: 2, startHeight: 4 }),
    ).toEqual({ area: 10 });
  });

  it("sets a height-like field to the height itself", () => {
    const editor = spec({ x: "x", height: { field: "height", rule: "value" } });
    expect(dragged(editor, start, [], { kind: "top", x: 10, height: 7, startHeight: 4 })).toEqual({
      x: 10,
      height: 7,
    });
  });

  it("widens it as its rule says, keeping the height where told", () => {
    const full = spec({ x: "x", width: { field: "sigma", rule: "full", scale: ["area"] } });
    expect(dragged(full, start, [], { kind: "width", x: 13, centre: 10, startWidth: 2 })).toEqual({
      sigma: 6,
      area: 60,
    });
    const half = spec({ x: "x", width: { field: "sigma", rule: "half" } });
    expect(dragged(half, start, [], { kind: "width", x: 13, centre: 10, startWidth: 2 })).toEqual({
      sigma: 3,
    });
    // Not below the field's least value.
    expect(dragged(half, start, [], { kind: "width", x: 10, centre: 10, startWidth: 2 })).toEqual({
      sigma: 0.1,
    });
  });

  it("always passes the fields dragging changes, and renames ties when an item goes", () => {
    const editor = spec({
      x: "x",
      height: { field: "area" },
      width: { field: "sigma", scale: ["height"] },
    });
    expect(draggedFields(editor)).toEqual(["x", "area", "sigma", "height"]);
    const items = [
      { values: { x: 1 }, constraints: { x: "" } },
      { values: { x: 2 }, constraints: { x: "A+1" } },
      { values: { x: 3 }, constraints: { x: "C*2, B" } },
    ];
    expect(removeItem(items, 0, [undefined, { values: { x: 2.5 }, tied: [], peak: null }])).toEqual(
      [
        { values: { x: 2.5 }, constraints: { x: "" } },
        { values: { x: 3 }, constraints: { x: "B*2, A" } },
      ],
    );
  });
});
