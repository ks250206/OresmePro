"""What a plugin's Python sees inside the sandbox.

A plugin's actions are described in its oresme-plugin.json: their names,
titles and arguments. Its Python registers a function for each with
``@action``. Wave arguments arrive as ``Wave`` objects and the rest as plain
values; the function returns new waves and plain values. It cannot see or
change the experiment: the application reads the waves it is given, runs the
function here and puts what comes back into the experiment itself::

    from oresme_plugin import action, wave

    @action("double")
    def double(y, factor=2.0):
        return {"waves": {"doubled": wave(y.data * factor, like=y)},
                "values": {"total": float(y.data.sum() * factor)}}

To keep a result the way the application keeps fits (shown in Analysis >
Results, compared, run again), put ``"result": {"names": [...], "coef":
[...], "sigma": [...]}`` among the values; ``chisq``, ``points``,
``converged`` and ``reason`` may go with them.

A wave of text (a list of strings, or a NumPy array of them) is a text wave:
labels for text markers, say.

To show what it made, an action may also return ``"graph"``: a graph for the
application to make from the waves it returned, named by their roles::

    "graph": {
        "name": "Ternary",
        "traces": [
            {"y": "frame_y", "x": "frame_x", "color": "#808080"},
            {"y": "y", "x": "x", "mode": "markers", "marker": "square",
             "legend": "Samples"},
            {"y": "tick_y", "x": "tick_x", "mode": "markers",
             "text_marker": "tick_text", "text_anchor": "RC"},
        ],
        "axes": {"left": {"line": False, "ticks": "none", "labels": "off"}},
        "graph": {"width": {"mode": "aspect", "aspect": 0.866}},
        "annotations": [{"kind": "legend", "anchor": "RT"}],
    }

A trace takes the properties of the application's traces (``mode``,
``color``, ``line_size``, ``line_style``, ``marker``, ``text_marker``, ...),
with roles where they name waves, and ``axis`` and ``haxis`` (sides) to plot
against; ``legend`` puts it in a legend with that text. ``axes`` and
``graph`` take the properties of axes and of the graph. The application
checks all of it as it checks what Python asks for, and makes the graph only
from the waves the action returned.

The sandbox has no network and no storage: only the packages the plugin
declares (numpy, scipy, ...) and its own files.
"""

import importlib
import json
import sys

import numpy as np

__all__ = ["action", "view", "ui", "wave", "Wave", "PluginError"]

_ACTIONS = {}

#: The number types a wave can have, as NumPy names them.
_TYPES = {
    "float64", "float32", "int8", "int16", "int32", "uint8", "uint16", "uint32",
    "complex128", "complex64",
}


class PluginError(Exception):
    """Raised by a plugin to report a problem with its input as a plain message."""


class Wave:
    """A wave handed to an action: its values and scaling, read-only."""

    def __init__(self, name, data, x0=0.0, dx=1.0, x_unit="", y0=0.0, dy=1.0, y_unit="",
                 unit="", note=""):
        self.name = name
        self.data = data
        self.x0 = x0
        self.dx = dx
        self.x_unit = x_unit
        self.y0 = y0
        self.dy = dy
        self.y_unit = y_unit
        self.unit = unit
        self.note = note

    @property
    def x(self):
        """The X value of each point along the first dimension."""
        return self.x0 + self.dx * np.arange(self.data.shape[0] if self.data.ndim else 0)

    @property
    def is_text(self):
        """Whether it is a text wave: ``data`` is then a 1-D array of str."""
        return self.data.dtype.kind in "USO"

    def __len__(self):
        return int(self.data.shape[0]) if self.data.ndim else 0

    def __repr__(self):
        return f"Wave({self.name!r}, shape={self.data.shape}, dtype={self.data.dtype})"


def wave(data, *, like=None, x0=None, dx=None, x_unit=None, y0=None, dy=None, y_unit=None,
         unit=None, note=None):
    """A wave for an action to return. ``like=w`` takes the scaling and units of ``w``."""
    values = np.asarray(data)
    base = like if isinstance(like, Wave) else None

    def pick(value, attribute, default):
        if value is not None:
            return value
        return getattr(base, attribute) if base is not None else default

    return Wave(
        "",
        values,
        x0=float(pick(x0, "x0", 0.0)),
        dx=float(pick(dx, "dx", 1.0)),
        x_unit=str(pick(x_unit, "x_unit", "")),
        y0=float(pick(y0, "y0", 0.0)),
        dy=float(pick(dy, "dy", 1.0)),
        y_unit=str(pick(y_unit, "y_unit", "")),
        unit=str(pick(unit, "unit", "")),
        note=str(note) if note is not None else "",
    )


def action(name):
    """Register a function as the action ``name`` described in the plugin's manifest."""
    def register(function):
        if not isinstance(name, str) or not name.replace("_", "").isalnum():
            raise ValueError(f"An action name is letters, digits and underscores: {name!r}")
        if name in _ACTIONS:
            raise ValueError(f"The action {name!r} is registered twice.")
        _ACTIONS[name] = function
        return function

    return register


def view(name):
    """Register a function as the view ``name`` (an editor of kind "view" in the manifest).

    The function is called with ``(state, event, waves)`` for each event of
    the view's window and returns a dict of ``state`` (plain values, kept by
    the application and given back each time), ``ui`` (what the window shows,
    built with ``ui``), ``waves`` (arrays the plots draw, by role; they do not
    go into the experiment) and ``message`` (shown at the bottom of the window).
    Leaving out ``state``, ``ui`` or ``message`` keeps the one before (a
    ``message`` of None takes it away); ``waves`` are those of this answer only. ``waves`` given to it are copies of
    those chosen in the window's ``ui.wave`` parts, by the path they are bound
    to. ``event`` is ``{"type": "open", "last": ...}``, ``{"type": "change",
    "paths": [...]}``, ``{"type": "command", "id": ...}`` (with ``"x"`` and
    ``"y"`` for a plot's ``on_click``) or ``{"type":
    "done", "id": ..., "args": ..., "ok": ..., "values": ..., "result": ...,
    "error": ...}`` (``args``: what the action ran with, to check that a result is
    for what the view shows now).
    See docs/design/plugin-views.md.
    """
    def register(function):
        if not isinstance(name, str) or not name.replace("_", "").isalnum():
            raise ValueError(f"A view name is letters, digits and underscores: {name!r}")
        key = f"view:{name}"
        if key in _ACTIONS:
            raise ValueError(f"The view {name!r} is registered twice.")

        def run(state, event, paths, **waves):
            bound = json.loads(paths)
            given = {bound[key_]: value for key_, value in waves.items() if key_ in bound}
            outcome = function(json.loads(state), json.loads(event), given)
            if outcome is None:
                outcome = {}
            if not isinstance(outcome, dict):
                raise PluginError("A view returns a dict with 'state', 'ui', 'waves' and 'message'.")
            unknown = set(outcome) - {"state", "ui", "waves", "message"}
            if unknown:
                raise PluginError(f"A view returns only 'state', 'ui', 'waves' and 'message', not {sorted(unknown)}.")

            def text(key_):
                if key_ not in outcome:
                    return None
                return json.dumps(_plain(outcome[key_]), allow_nan=False)

            # A message left out keeps the one shown; None (or "") takes it away.
            message = None
            if "message" in outcome:
                message = "" if outcome["message"] is None else str(outcome["message"])
            return {
                "waves": outcome.get("waves") or {},
                "values": {"state": text("state"), "ui": text("ui"), "message": message},
            }

        _ACTIONS[key] = run
        return function

    return register


def _part(type_, **props):
    """A part of a view, leaving out what is None (the application's default)."""
    return {"type": type_, **{key: value for key, value in props.items() if value is not None}}


class ui:
    """The parts a view is built of; each makes a plain dict (see docs/design/plugin-views.md).

    ``bind`` is a path of the state, dotted (``"params.2.value"``): the part
    shows the value there and puts what is entered there.
    """

    @staticmethod
    def view(*parts, gap=None):
        body = parts[0] if len(parts) == 1 else _part("column", children=list(parts), gap=gap)
        return {"version": 1, "body": body}

    @staticmethod
    def column(*children, gap=None):
        return _part("column", children=list(children), gap=gap)

    @staticmethod
    def row(*children, gap=None):
        return _part("row", children=list(children), gap=gap)

    @staticmethod
    def split(first, second, direction="horizontal", ratio=None):
        return _part("split", children=[first, second], direction=direction, ratio=ratio)

    @staticmethod
    def tabs(*tabs):
        """Tabs from (title, part) pairs, in order."""
        return _part("tabs", tabs=[{"title": title, "body": body} for title, body in tabs])

    @staticmethod
    def group(title, body):
        return _part("group", title=title, body=body)

    @staticmethod
    def text(text, tone=None, mono=None):
        return _part("text", text=str(text), tone=tone, mono=mono)

    @staticmethod
    def number(label, bind, min=None, max=None, step=None, unit=None):
        return _part("number", label=label, bind=bind, min=min, max=max, step=step, unit=unit)

    @staticmethod
    def string(label, bind, placeholder=None, suggestions=None):
        return _part("string", label=label, bind=bind, placeholder=placeholder,
                     suggestions=None if suggestions is None else list(suggestions))

    @staticmethod
    def choice(label, bind, choices):
        """``choices``: values, or (title, value) pairs."""
        return _part("choice", label=label, bind=bind,
                     choices=[list(item) if isinstance(item, tuple) else item for item in choices])

    @staticmethod
    def checkbox(label, bind):
        return _part("checkbox", label=label, bind=bind)

    @staticmethod
    def wave(label, bind, optional=None):
        """A choice of a 1-D numeric wave; the view is given a copy of the one chosen."""
        return _part("wave", label=label, bind=bind, optional=optional)

    @staticmethod
    def table(bind, columns, add=None, remove=None):
        """A table of the list of dicts at ``bind``, one row each, with ``columns`` made by ``ui.col``."""
        return _part("table", bind=bind, columns=list(columns), add=add, remove=remove)

    @staticmethod
    def col(key, title=None, type=None, choices=None, editable=None, width=None):
        """A column of a table: ``type`` is "text", "number", "checkbox" or "choice"."""
        return {key_: value for key_, value in {
            "key": key, "title": title, "type": type,
            "choices": None if choices is None else [list(c) if isinstance(c, tuple) else c for c in choices],
            "editable": editable, "width": width,
        }.items() if value is not None}

    @staticmethod
    def plot(series, x_label=None, y_label=None, x_log=None, y_log=None, equal=None,
             x_reverse=None, height=None, handles=None, on_click=None):
        """Series made by ``ui.series``; ``handles`` made by ``ui.handle``; ``on_click``: a
        command sent with the place clicked (``event["x"]``, ``event["y"]``)."""
        return _part("plot", series=list(series), x_label=x_label, y_label=y_label, x_log=x_log,
                     y_log=y_log, equal=equal, x_reverse=x_reverse, height=height,
                     handles=None if handles is None else list(handles), on_click=on_click)

    @staticmethod
    def handle(x=None, y=None, bind_x=None, bind_y=None, label=None, color=None):
        """A handle on a plot, at ``x``, ``y`` in its units: a point, or a line across it
        when one of them is None. Dragged, it moves the values at ``bind_x`` and ``bind_y``
        by as much as it moves (by the same ratio on a log axis); each step is a change of
        those paths. Without a bind it only marks a place."""
        return {key: value for key, value in {
            "x": None if x is None else float(x), "y": None if y is None else float(y),
            "bind_x": bind_x, "bind_y": bind_y, "label": label, "color": color,
        }.items() if value is not None}

    @staticmethod
    def series(y, x=None, mode=None, color=None, label=None):
        """Arrays the view returned, by role: ``y`` against ``x`` (or the point numbers)."""
        return {key: value for key, value in {
            "x": x, "y": y, "mode": mode, "color": color, "label": label}.items() if value is not None}

    @staticmethod
    def button(label, on=None, action=None, args=None, replace=None, primary=None, disabled=None):
        """Calls the view with a command (``on``), or runs one of the plugin's actions (``action``)."""
        return _part("button", label=label, on=on, action=action, args=args, replace=replace,
                     primary=primary, disabled=disabled)

    @staticmethod
    def nodes(label, bind, palette, height=None):
        """Boxes joined at their ports, edited in the window: the graph at ``bind`` is
        ``{"nodes": [{"id", "kind", "label", "x", "y", "fixed"}], "edges": [{"from": [id,
        port], "to": [id, port]}]}``. ``palette``: the kinds, made by ``ui.kind``. A node
        added gets the id of its kind and the least number not taken (``R0``, ``R1``)."""
        return _part("nodes", label=label, bind=bind, palette=list(palette), height=height)

    @staticmethod
    def kind(kind, title=None, ports=("a", "b"), color=None, add=None):
        """A kind of node: its ports are names (on the left and right in turn) or
        ``(name, side)`` pairs, the side "left", "right", "top" or "bottom". ``add=False``
        for kinds only the view makes, such as fixed ends."""
        return {key: value for key, value in {
            "kind": kind, "title": title,
            "ports": [list(port) if isinstance(port, tuple) else port for port in ports],
            "color": color, "add": add,
        }.items() if value is not None}

    @staticmethod
    def bind(path):
        """An argument of a button's action taken from the state at ``path`` when it is pressed."""
        return {"$bind": path}


# --- Used by the sandbox, not by plugins ------------------------------------------


def _load(root, entry, expected_json):
    """Imports the plugin's entry module and checks that it registered the actions its manifest lists."""
    _ACTIONS.clear()
    if root not in sys.path:
        sys.path.insert(0, root)
    importlib.import_module(entry)
    expected = set(json.loads(expected_json))
    missing = sorted(expected - set(_ACTIONS))
    extra = sorted(set(_ACTIONS) - expected)
    if missing:
        raise PluginError(f"The manifest lists actions the Python does not register: {', '.join(missing)}.")
    if extra:
        raise PluginError(f"The Python registers actions the manifest does not list: {', '.join(extra)}.")
    return json.dumps(sorted(_ACTIONS))


def _is_list(value):
    """Whether a value from JavaScript is an array (a list of waves) rather than one wave."""
    try:
        return value.constructor.name == "Array"
    except AttributeError:
        return False


def _given(value):
    """Whether a value from JavaScript is there: its null arrives as ``JsNull``, not None."""
    return value is not None and type(value).__name__ != "JsNull"


def _input(value):
    """A wave as the application sends it (a JS object) made a ``Wave``."""
    item = value.to_py(depth=1)
    if str(item["dtype"]) == "text":
        # A text wave: its values as an array of str, one dimension.
        data = np.array([str(text) for text in item["text"].to_py()], dtype=str)
    else:
        dtype = np.dtype(str(item["dtype"]))
        shape = tuple(int(size) for size in item["shape"].to_py())
        data = np.frombuffer(item["data"].to_bytes(), dtype=dtype).reshape(shape)
        imag = item.get("imag")
        if _given(imag):
            data = data + 1j * np.frombuffer(imag.to_bytes(), dtype=dtype).reshape(shape)
    data.flags.writeable = False
    return Wave(
        str(item["name"]), data, float(item["x0"]), float(item["dx"]), str(item["xUnit"]),
        float(item["y0"]), float(item["dy"]), str(item["yUnit"]), str(item["unit"]),
        str(item["note"]),
    )


def _output(role, value):
    if not isinstance(value, Wave):
        value = wave(value)
    data = np.asarray(value.data)
    if data.dtype.kind in "USO":
        items = data.tolist() if data.ndim == 1 else None
        if items is None or not all(isinstance(item, str) for item in items):
            raise PluginError(f"Wave {role!r} must be numbers, or one dimension of text.")
        return {
            "dtype": "text",
            "shape": [len(items)],
            "text": json.dumps(items),
            "x0": float(value.x0),
            "dx": float(value.dx),
            "xUnit": str(value.x_unit),
            "y0": float(value.y0),
            "dy": float(value.dy),
            "yUnit": str(value.y_unit),
            "unit": str(value.unit),
            "note": str(value.note),
        }
    if data.dtype.kind == "b":
        data = data.astype(np.uint8)
    elif data.dtype.kind in "iu" and data.dtype.name not in _TYPES:
        data = data.astype(np.float64)
    elif data.dtype.kind == "f" and data.dtype.name not in _TYPES:
        data = data.astype(np.float64)
    if data.dtype.name not in _TYPES:
        raise PluginError(f"Wave {role!r} has values of type {data.dtype}, which a wave cannot hold.")
    if data.ndim == 0 or data.ndim > 4:
        raise PluginError(f"Wave {role!r} must have 1 to 4 dimensions, not {data.ndim}.")
    complex_ = data.dtype.kind == "c"
    part = data.real if complex_ else data
    dtype = part.dtype.name
    out = {
        "dtype": dtype,
        "shape": list(data.shape),
        "data": memoryview(np.ascontiguousarray(part).tobytes()),
        "imag": memoryview(np.ascontiguousarray(data.imag).tobytes()) if complex_ else None,
        "x0": float(value.x0),
        "dx": float(value.dx),
        "xUnit": str(value.x_unit),
        "y0": float(value.y0),
        "dy": float(value.dy),
        "yUnit": str(value.y_unit),
        "unit": str(value.unit),
        "note": str(value.note),
    }
    return out


def _plain(value):
    """A value as JSON can hold it: no NumPy types, and None where a number is not finite."""
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if isinstance(value, np.ndarray):
        return _plain(value.tolist())
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return float(value) if np.isfinite(value) else None
    if value is None or isinstance(value, str):
        return value
    raise PluginError(f"An action cannot return {type(value).__name__} as a value.")


def _run(name, inputs, params_json):
    """Runs an action on waves and values sent by the application."""
    function = _ACTIONS.get(name)
    if function is None:
        raise PluginError(f"The plugin has no action {name!r}.")
    arguments = {}
    for key, value in inputs.to_py(depth=1).items():
        if _is_list(value):
            arguments[key] = [_input(item) for item in value]
        else:
            arguments[key] = _input(value)
    arguments.update(json.loads(params_json))
    outcome = function(**arguments)
    if outcome is None:
        outcome = {}
    if not isinstance(outcome, dict):
        raise PluginError("An action returns a dict with 'waves', 'values' and 'graph'.")
    unknown = set(outcome) - {"waves", "values", "graph"}
    if unknown:
        raise PluginError(
            f"An action returns only 'waves', 'values' and 'graph', not {sorted(unknown)}."
        )
    waves = {str(role): _output(str(role), value) for role, value in (outcome.get("waves") or {}).items()}
    # As JSON text: converted to JavaScript, None would become undefined, not null.
    values = json.dumps(_plain(outcome.get("values") or {}), allow_nan=False)
    graph = json.dumps(_plain(outcome.get("graph")), allow_nan=False)
    return {"waves": waves, "values": values, "graph": graph}
