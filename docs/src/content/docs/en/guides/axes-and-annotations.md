---
title: Axes, legends, annotations, and cursors
sidebar:
  order: 3
---

## Axes and annotations

Use a name such as `g.axis("left")` to get an axis. Set `range` to fix its limits and call `autoscale()` to restore automatic scaling. For a series with a different unit, create another axis and specify its name when appending the trace.

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

Put both cursors on the same trace to use the points between them as a [fit range](../curve-fitting/). [Axis API](../../reference/api/axis/) · [Cursor API](../../reference/api/cursor/)
