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

The sandbox has no network and no storage: only the packages the plugin
declares (numpy, scipy, ...) and its own files.
"""

import importlib
import json
import sys

import numpy as np

__all__ = ["action", "wave", "Wave", "PluginError"]

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
        raise PluginError("An action returns a dict with 'waves' and 'values'.")
    unknown = set(outcome) - {"waves", "values"}
    if unknown:
        raise PluginError(f"An action returns only 'waves' and 'values', not {sorted(unknown)}.")
    waves = {str(role): _output(str(role), value) for role, value in (outcome.get("waves") or {}).items()}
    # As JSON text: converted to JavaScript, None would become undefined, not null.
    values = json.dumps(_plain(outcome.get("values") or {}), allow_nan=False)
    return {"waves": waves, "values": values}
