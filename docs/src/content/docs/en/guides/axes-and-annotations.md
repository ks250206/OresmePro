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

## Draw shapes

As with Igor Pro's drawing tools (Show Tools), lines, arrows, rectangles, rounded rectangles, ovals, polygons and text can be drawn on a graph: arrows to point things out, boxes to mark ranges.

**Graph → Show Tools** (**⌥T** / **Alt+T**, or the graph's right-click menu) shows or hides the tool palette at the left of the graph. Igor's ⌘T is the browser's (a new tab) and never reaches the page, so it is ⌥T here.

| Tool                     | How it draws                                                                      |
| ------------------------ | --------------------------------------------------------------------------------- |
| Select (arrow)           | Click a drawing to select it and drag it to move it; drag a □ handle to resize it |
| Line, arrow              | Drag from one end to the other                                                    |
| Rectangle, rounded, oval | Drag from one corner to the opposite one                                          |
| Polygon                  | Click each corner; double-click the last (or press Enter)                         |
| Text                     | Click where it starts and type it                                                 |

- After drawing, the tool goes back to Select. **Delete** removes the drawing selected; **Escape** clears the selection or what is being drawn
- **Shift**-click adds a drawing to the selection or takes it out. With the tools out, **⌘A** / **Ctrl+A** selects every drawing instead of autoscaling the axes. Drawings selected are moved and removed together (and removing them is undone in one step)
- Double-click a drawing for **Modify Drawing**: color, line size and style, fill (color and opacity), arrowheads (end, start, both), text and its size, and layer
- Its right-click menu brings it to the front or sends it to the back, moves it behind or in front of the traces, pins it to the axes or the plot area, and removes it
- **Coordinates**: by default a drawing is placed as fractions of the plot area, so it stays where it is when the graph is zoomed. With the axes button of the palette on, new drawings are placed in axis values and move with the data (an arrow pointing at a peak). The right-click menu changes it afterwards
- Drawings are part of the graph and saved with the experiment. They are in exported SVG, PNG and PDF files, page layouts, graph templates and recreation scripts, and can be undone; drawing is written in the history as Python

```python
g.draw("arrow", [2.6, 0.85, 3.75, 0.95], coords="axes", color="red", line_size=2)
g.draw("rect", [0.1, 0.1, 0.4, 0.3], fill="#ffee88", fill_opacity=0.5, layer="back")
g.draw("text", [0.05, 0.05], text="Peak A", text_size=14)
g.drawing("draw0").set(arrow="both")
```

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
