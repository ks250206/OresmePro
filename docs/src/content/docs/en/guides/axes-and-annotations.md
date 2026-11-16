---
title: Axes, legends, annotations, and cursors
sidebar:
  order: 3
---

## Axes and annotations

Use a name such as `g.axis("left")` to get an axis. Set `range` to fix its limits and call `autoscale()` to restore automatic scaling. For a series with a different unit, create another axis and specify its name when appending the trace.

**Show labels** in **Modify Axis** chooses which labels an axis draws, as Igor Pro's ModifyGraph `noLabel` does. The axis line and its ticks stay in every case.

| Setting   | Draws                                           |
| --------- | ----------------------------------------------- |
| on        | The tick labels and the axis label (default)    |
| axis only | The axis label only, without tick label numbers |
| off       | Neither                                         |

An automatic margin narrows by what is no longer drawn. Use it to take the numbers off inner axes of stacked plots, for example.

```python
g.axis("bottom").labels = "axis only"
g.axis("left").set(labels="off")
```

An axis label's direction is set by its side: a left axis's label reads upwards, a right axis's downwards (the tops of its letters face out), and top and bottom labels read across. **turned … °** in **Modify Axis** turns it clockwise from there, as Igor Pro's ModifyGraph `lblRot` does; 180 makes a right axis's label read upwards as a left one does. It takes −360 to 360 degrees, and an automatic margin widens to fit the turned label.

```python
g.axis("right").label_rotation = 180
```

Unticking **Draw the axis line** in **Modify Axis** leaves out the axis line itself, as Igor Pro's `axThick=0` does. With ticks none and Show labels off too, nothing of the axis is drawn: for a figure drawn with traces on axes that are not shown, such as a ternary diagram.

```python
g.axis("left").set(line=False, ticks="none", labels="off")
```

## Text markers

Choosing a wave under **Text markers** in **Modify Trace Appearance** draws its values at the points instead of markers, as Igor Pro's text markers do: labels placed in data coordinates. A text wave gives its text; a numeric wave, its numbers. The mode must be markers or lines+markers.

- **Text anchor** says which point of each label sits on its data point: `MC` centres it, `RC` puts it to the left of the point, `MT` below it
- From Python, `text_size` sets their size and `text_rotation` turns them clockwise, in degrees
- They take the trace's color, or a color per point from `color_wave`

```python
names = op.make("names", ["P1", "P2", "P3"])
g.trace("peaks").set(mode="markers", text_marker=names, text_anchor="LB", text_size=10)
```

- `g.legend()` adds a trace legend. Use `anchor="LT"` to position it in the upper left.
- `g.textbox("Run 1")` adds text anchored to the graph.
- `g.tag(trace, point, "Y = {y}")` adds a label attached to a point. Point indices start at zero.

## Inspect points with cursors

Place cursor A or B from a trace's context menu. Move it along the trace to inspect samples. In Python, use `Graph.cursor` to position or retrieve a cursor.

```python
y = op.make("cursor_data", [1, 4, 9, 16], dx=0.5)
g = op.display(y)
a = g.cursor("A", g.trace(), 2)
print(a.point, a.x, a.y)
```

Placing a cursor shows the cursor info bar under the graph, with the cursors' positions and the difference between A and B. You can also show or hide it with **Show Cursor Info** in the graph's context menu, `⌘I` / `Ctrl+I`, or `g.set(show_info=True)` in Python. Showing the bar keeps the graph (the figure) the same size and makes the window taller by the bar's height; hiding it shrinks the window back, as Igor's info panel does. An exported figure is therefore the same size with or without the bar, and undo restores the bar and the window's height together. Experiments saved by earlier versions with the bar showing open with the window and figure sizes they were saved with.

The info bar moves cursors too. Click (or right-click) the wave's name to list the graph's traces: the cursor goes to the one chosen, at the same point number (or its last point). Type a point number between the brackets and press Enter to move it there. A cursor not placed yet is placed from "place on a trace…".

Put both cursors on the same trace to use the points between them as a [fit range](../curve-fitting/). [Axis API](../../reference/api/axis/) · [Cursor API](../../reference/api/cursor/)
