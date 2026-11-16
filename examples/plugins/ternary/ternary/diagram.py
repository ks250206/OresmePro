"""A ternary diagram, drawn with ordinary traces.

The triangle has A at the top, B at the bottom right and C at the bottom
left, with sides of length 1. A composition (a, b, c), scaled to
a + b + c = 1, is at

    x = b + a / 2,    y = a * sqrt(3) / 2.

Every part of the figure is a wave: the points, the frame, the grid lines
and tick marks (lines broken by NaN), and the tick labels and corner names
(text markers placed in data coordinates). The graph's own axes only carry
the coordinates, and are not drawn. So the look of everything can be
changed afterwards like that of any trace.
"""

import numpy as np
from oresme_plugin import PluginError, action, wave

HEIGHT = np.sqrt(3) / 2
#: How long the tick marks are, and how far beyond them the labels sit.
TICK = 0.02
GAP = 0.012

# Directions, as unit vectors: the side from C to A, and the side from A to B.
UP_RIGHT = np.array([0.5, HEIGHT])
DOWN_RIGHT = np.array([0.5, -HEIGHT])
LEFT = np.array([-1.0, 0.0])
RIGHT = np.array([1.0, 0.0])

FRAME = "#808080"
GRID = "#c8c8c8"
LABELS = "#606060"
POINTS = "#4a90d9"


def position(a, b, c):
    """Where compositions are in the triangle: (x, y), NaN where a + b + c is not positive."""
    a, b, c = (np.asarray(value, dtype=float) for value in (a, b, c))
    total = a + b + c
    with np.errstate(divide="ignore", invalid="ignore"):
        good = np.isfinite(total) & (total > 0)
        a = np.where(good, a / total, np.nan)
        b = np.where(good, b / total, np.nan)
    return b + a / 2, a * HEIGHT


def corner(a, b, c):
    """One composition's place, as a point."""
    x, y = position(a, b, c)
    return np.array([float(x), float(y)])


def broken(segments):
    """Segments (pairs of points) as one line of x and y, broken by NaN between them."""
    xs, ys = [], []
    for start, end in segments:
        xs += [start[0], end[0], np.nan]
        ys += [start[1], end[1], np.nan]
    return np.array(xs[:-1] or [np.nan]), np.array(ys[:-1] or [np.nan])


def levels(step):
    """The values (fractions) at which there are tick labels: 0, step, ..., 1."""
    count = int(round(100 / step))
    values = np.arange(count + 1) * step / 100
    return values[values <= 1 + 1e-9]


def grid_lines(step):
    """The lines a = v, b = v and c = v across the triangle, for every inner level v."""
    lines = []
    for v in levels(step)[1:]:
        if v >= 1 - 1e-9:
            continue
        lines.append((corner(v, 0, 1 - v), corner(v, 1 - v, 0)))  # a = v
        lines.append((corner(0, v, 1 - v), corner(1 - v, v, 0)))  # b = v
        lines.append((corner(1 - v, 0, v), corner(0, 1 - v, v)))  # c = v
    return lines


def sides(direction):
    """For each component, where its values are written and which way is out of the triangle.

    Each value is written where its line (a = v, say) meets a side, beyond
    the end of the line. Returns (name, place of value v, outward direction,
    anchor of the label) for a, b and c.
    """
    if direction == "clockwise":
        return [
            ("a", lambda v: corner(v, 0, 1 - v), LEFT, "RC"),
            ("b", lambda v: corner(1 - v, v, 0), UP_RIGHT, "LC"),
            ("c", lambda v: corner(0, 1 - v, v), DOWN_RIGHT, "MT"),
        ]
    return [
        ("a", lambda v: corner(v, 1 - v, 0), RIGHT, "LC"),
        ("b", lambda v: corner(0, v, 1 - v), -UP_RIGHT, "MT"),
        ("c", lambda v: corner(1 - v, 0, v), -DOWN_RIGHT, "RC"),
    ]


def names_of(text):
    names = [name.strip() for name in str(text).split(",")]
    if len(names) != 3 or not all(names):
        raise PluginError('Names are three names separated by commas: "A, B, C".')
    return names


@action("ternary")
def ternary(a, b, c, names="A, B, C", step=10.0, grid=True, ticks="clockwise", legend=""):
    if not (len(a) == len(b) == len(c)):
        raise PluginError(f"A, B and C have {len(a)}, {len(b)} and {len(c)} points; they need as many.")
    if not 1 <= step <= 50:
        raise PluginError("The grid step is between 1 and 50 %.")
    top, right, left = names_of(names)
    x, y = position(a.data, b.data, c.data)

    frame = np.array([corner(0, 0, 1), corner(1, 0, 0), corner(0, 1, 0), corner(0, 0, 1)])
    waves = {
        "x": wave(x),
        "y": wave(y),
        "frame_x": wave(frame[:, 0]),
        "frame_y": wave(frame[:, 1]),
        "corner_x": wave([0.5, 1 + 0.1, -0.1]),
        "corner_y": wave([HEIGHT + 0.09, -0.06, -0.06]),
        "corner_text": wave([top, right, left]),
    }
    traces = [{"y": "frame_y", "x": "frame_x", "color": FRAME, "line_size": 1}]
    if grid:
        gx, gy = broken(grid_lines(step))
        waves["grid_x"], waves["grid_y"] = wave(gx), wave(gy)
        # Under the frame, so it is drawn first.
        traces.insert(
            0, {"y": "grid_y", "x": "grid_x", "color": GRID, "line_style": "dash", "line_size": 0.75}
        )
    if ticks != "none":
        marks = []
        for key, place, out, anchor in sides(ticks):
            values = levels(step)
            points = np.array([place(v) for v in values])
            marks += [(point, point + TICK * out) for point in points]
            labels = points + (TICK + GAP) * out
            waves[f"{key}_x"] = wave(labels[:, 0])
            waves[f"{key}_y"] = wave(labels[:, 1])
            waves[f"{key}_label"] = wave(np.round(values * 100, 6))
            traces.append(
                {
                    "y": f"{key}_y",
                    "x": f"{key}_x",
                    "mode": "markers",
                    "text_marker": f"{key}_label",
                    "text_anchor": anchor,
                    "color": LABELS,
                }
            )
        tx, ty = broken(marks)
        waves["tick_x"], waves["tick_y"] = wave(tx), wave(ty)
        traces.append({"y": "tick_y", "x": "tick_x", "color": FRAME, "line_size": 1})
    traces.append(
        {
            "y": "corner_y",
            "x": "corner_x",
            "mode": "markers",
            "text_marker": "corner_text",
            "text_size": 14,
            "color": "#000000",
        }
    )
    point_trace = {
        "y": "y",
        "x": "x",
        "mode": "markers",
        "marker": "square",
        "marker_size": 4,
        "color": POINTS,
    }
    if legend:
        point_trace["legend"] = str(legend)
    traces.append(point_trace)

    hidden = {"line": False, "ticks": "none", "labels": "off", "mirror": "off", "grid": "off"}
    graph = {
        "name": "Ternary",
        "traces": traces,
        "axes": {
            "bottom": {**hidden, "min": -0.2, "max": 1.2},
            "left": {**hidden, "min": -0.11, "max": HEIGHT + 0.13},
        },
        "graph": {
            # One unit as long across as up, so the triangle has equal sides.
            "width": {"mode": "plan", "factor": 1, "h_axis": "bottom", "v_axis": "left"},
            "height": {"mode": "absolute", "value": 9, "unit": "cm"},
            "margin_left": 4,
            "margin_right": 4,
            "margin_top": 4,
            "margin_bottom": 4,
        },
        "annotations": [{"kind": "legend", "anchor": "RT"}] if legend else [],
    }
    inside = int(np.count_nonzero(np.isfinite(x)))
    return {"waves": waves, "values": {"points": inside}, "graph": graph}
