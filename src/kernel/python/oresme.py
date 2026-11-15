"""Scripting interface to OresmePro.

Everything in the application -- waves, graphs, tables -- can be driven from
here. By convention the module is imported as ``op``::

    import numpy as np
    import oresme as op

    x = np.linspace(0, 10, 1000)
    w = op.make("signal", np.sin(x) * np.exp(-x / 5), dx=x[1] - x[0], x_unit="s")
    g = op.display(w)
    g.axis("left").label = "Amplitude (V)"
    g.trace("signal").color = "blue"

The data of a wave lives in the application, not in Python. ``w.data`` gives
a read-only NumPy copy; assign to ``w.data`` or ``w[...]`` to change the wave.

Waves can be kept in data folders: ``"run1:signal"`` is the wave ``signal`` in
the folder ``run1``. A 2-D wave is indexed ``w[i, j]`` with ``i`` along X.
"""

import contextlib
import hashlib
import inspect
import json
import math
import numbers
import os
import re
import warnings

import numpy as np

import _oresme_js

__all__ = [
    "OresmeError",
    "atomic",
    "action",
    "actions",
    "invoke",
    "Wave",
    "Graph",
    "Trace",
    "Axis",
    "Annotation",
    "Image",
    "Contour",
    "Cursor",
    "Folder",
    "Table",
    "make",
    "wave",
    "waves",
    "exists",
    "kill",
    "set_formula",
    "recalculate",
    "display",
    "image",
    "contour",
    "new_folder",
    "folder",
    "folders",
    "edit",
    "load_text",
    "to_dataframe",
    "from_dataframe",
    "load_excel",
    "load_igor",
    "graph",
    "graphs",
    "table",
    "tables",
    "kill_window",
    "Procedure",
    "new_procedure",
    "procedure",
    "procedures",
    "time_zone",
    "set_time_zone",
    "WAVE_TYPES",
    "Layout",
    "LayoutItem",
    "new_layout",
    "layout",
    "layouts",
    "Style",
    "style",
    "styles",
    "set_style",
    "apply_style",
    "set_default_style",
    "default_style",
    "GraphTemplate",
    "graph_template",
    "graph_templates",
    "set_graph_template",
    "Panel",
    "Control",
    "panel",
    "panels",
    "new_panel",
    "set_panel",
    "control",
]


class OresmeError(Exception):
    """The application rejected a request (bad name, missing wave, ...)."""


def _call(method, params=None, data=None):
    """Send one request to the application and wait for the answer."""
    try:
        payload = json.dumps(params or {}, allow_nan=False)
    except ValueError:
        raise OresmeError("Values must be finite numbers (no NaN or infinity here).") from None
    js_data = None
    if data is not None:
        from pyodide.ffi import to_js

        js_data = to_js(np.ascontiguousarray(data, dtype=np.float64))
    reply = _oresme_js.rpc(method, payload, js_data)
    result = json.loads(reply[0])
    if not result["ok"]:
        raise OresmeError(result["error"])
    binary = reply[1]
    array = None
    if binary is not None:
        array = np.frombuffer(binary.to_bytes(), dtype=np.float64)
    return result["result"], array


def _dispatch(command, data=None):
    return _call("dispatch", command, data)[0]


class atomic(contextlib.ContextDecorator):
    """Make the changes of a block go into the experiment together, or not at all.

    ::

        with op.atomic():
            corrected = op.make("corrected", raw.data - background.data)
            op.display(corrected)

    Inside the block Python sees its own changes, but the experiment (and so
    the GUI) sees none of them until the block ends. If the block raises,
    nothing it did is kept; if it ends normally, all of it goes in as one undo
    step. The analyses that make waves and results (``op.fit``,
    ``op.fit_peaks``, ``op.background``, ...) each run in a block of their
    own, so one that fails half way leaves nothing behind.

    The experiment may change while the block runs, since the GUI does not
    wait for Python. Such changes do not stop the block when they do not meet
    its own (a window moved, another wave edited). But if a wave the block
    read has changed meanwhile, nothing is kept and ``OresmeError`` is raised:
    what was computed from it is out of date.

    Blocks may be nested; an inner block that raises takes back only its own
    changes. Graphs and page layouts cannot be drawn or saved inside a block.
    ``@op.atomic()`` on a function makes each call of it a block.
    """

    def __enter__(self):
        _call("beginAtomic")
        return self

    def __exit__(self, kind, value, traceback):
        if kind is None:
            _call("commitAtomic")
        else:
            # The block's own exception is the one to report.
            with contextlib.suppress(OresmeError):
                _call("abortAtomic")
        return False


def _camel(name):
    return re.sub(r"_([a-z])", lambda match: match.group(1).upper(), name)


def _snake(name):
    return re.sub(r"[A-Z]", lambda match: "_" + match.group(0).lower(), name)


def _keys(value, spell):
    """Data with every dict key respelled (and NumPy numbers made plain), at any depth."""
    if isinstance(value, dict):
        return {spell(str(key)): _keys(item, spell) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_keys(item, spell) for item in value]
    return _plain(value)


def _is_text(values):
    if isinstance(values, str):
        return True
    if isinstance(values, np.ndarray):
        return values.dtype.kind in "US"
    return (
        isinstance(values, (list, tuple))
        and len(values) > 0
        and all(isinstance(item, str) for item in values)
    )


#: The number types a wave can have, by their NumPy names.
WAVE_TYPES = (
    "float64",
    "float32",
    "int8",
    "uint8",
    "int16",
    "uint16",
    "int32",
    "uint32",
    "complex128",
    "complex64",
)


def _as_array(values):
    array = np.asarray(values)
    if array.dtype.kind not in "biufc":
        array = np.asarray(values, dtype=np.float64)
    if array.ndim == 0:
        array = array.reshape(1)
    if array.ndim > 4:
        raise OresmeError(f"Waves have at most 4 dimensions; got shape {array.shape}.")
    return array


def _wave_type(array, dtype=None):
    """The type of wave to hold an array: the one asked for, else the array's own.

    Whole numbers of NumPy's default integer type become float64: that is
    what ``[1, 2, 3]`` and ``np.arange(10)`` are, and a wave of them should
    not start rounding what is later assigned to it. Other types a wave
    cannot have become float64 or complex128.
    """
    if dtype is not None:
        name = np.dtype(dtype).name
        if name not in WAVE_TYPES:
            raise OresmeError(f"A wave cannot be {name}. Types: {', '.join(WAVE_TYPES)}.")
        return name
    name = array.dtype.name
    if array.dtype in (np.dtype(np.int_), np.dtype(np.int64)):
        return "float64"
    if name in WAVE_TYPES:
        return name
    if array.dtype.kind == "c":
        return "complex128"
    return "uint8" if array.dtype.kind == "b" else "float64"


def _content(command, values, dtype=None):
    """Add the values to a command: text goes in the command, numbers alongside it."""
    if _is_text(values):
        items = [values] if isinstance(values, str) else [str(item) for item in values]
        command["text"] = items
        return None
    if isinstance(values, np.ndarray) and values.dtype.kind == "M":
        # Dates are stored as seconds since 1970-01-01 UTC, with the unit "dat".
        missing = np.isnat(values)
        values = values.astype("datetime64[ms]").astype(np.float64) / 1000.0
        # "Not a time" has no number of its own among the dates: it is a missing value.
        values[missing] = np.nan
        command.setdefault("unit", "dat")
    array = _as_array(values)
    kind = _wave_type(array, dtype)
    command["type"] = kind
    command["shape"] = list(array.shape)
    flat = array.ravel()
    # Numbers travel as float64 (which holds every other type exactly); a
    # complex wave as its real parts followed by its imaginary parts.
    if kind.startswith("complex"):
        command["complex"] = True
        return np.concatenate([flat.real, flat.imag]).astype(np.float64)
    if flat.dtype.kind == "c":
        flat = flat.real
    return flat.astype(np.float64)


def _wave_name(obj):
    """Name of an existing wave, given a Wave, a name, or data to store."""
    if isinstance(obj, Wave):
        return obj.name
    if isinstance(obj, str):
        return obj[5:] if obj.startswith("root:") else obj
    if isinstance(obj, (np.ndarray, list, tuple)):
        name = _call("uniqueName", {"base": "wave"})[0]
        make(name, obj)
        return name
    raise TypeError(f"Expected a wave, a wave name or an array, not {type(obj).__name__}.")


_data_cache = {}


def _wave_data(name):
    cached = _data_cache.get(name)
    info, array = _call("waveData", {"name": name, "rev": cached[0] if cached else None})
    if "text" in info:
        array = np.array(info["text"], dtype=str)
    elif array is None:
        return cached[1]
    else:
        kind = info["type"]
        if kind.startswith("complex"):
            half = len(array) // 2
            array = array[:half] + 1j * array[half:]
        if kind != "float64":
            array = array.astype(kind)
        array = array.reshape(info["shape"])
    array.flags.writeable = False
    if len(_data_cache) > 64:
        _data_cache.clear()
    _data_cache[name] = (info["rev"], array)
    return array


class _Props:
    """Base for objects whose properties live in the application."""

    _props = ()

    def _get(self):
        raise NotImplementedError

    def _set(self, props):
        raise NotImplementedError

    def set(self, **props):
        """Change several properties at once. Returns self."""
        for key in props:
            if key not in self._props:
                raise AttributeError(
                    f"{type(self).__name__} has no property {key!r}. "
                    f"Properties: {', '.join(self._props)}."
                )
        if props:
            self._set({_camel(key): _plain(value) for key, value in props.items()})
        return self

    def __getattr__(self, key):
        if key.startswith("_") or key not in type(self)._props:
            raise AttributeError(f"{type(self).__name__} has no attribute {key!r}.")
        return self._get()[_camel(key)]

    def __setattr__(self, key, value):
        if key.startswith("_") or isinstance(getattr(type(self), key, None), property):
            object.__setattr__(self, key, value)
        elif key in self._props:
            self.set(**{key: value})
        else:
            raise AttributeError(
                f"{type(self).__name__} has no property {key!r}. "
                f"Properties: {', '.join(self._props)}."
            )

    def __dir__(self):
        return sorted(set(object.__dir__(self)) | set(self._props))


def _plain(value):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, tuple):
        return [_plain(item) for item in value]
    return value


class _Flat:
    """A wave's points as one row, for reading and writing by position in memory."""

    def __init__(self, wave):
        self._wave = wave

    def __len__(self):
        return self._wave.data.size

    def __getitem__(self, key):
        return self._wave.data.reshape(-1)[key]

    def __setitem__(self, key, value):
        values = self._wave.data.copy()
        values.reshape(-1)[key] = value
        self._wave.data = values


class Wave(np.lib.mixins.NDArrayOperatorsMixin):
    """A named array with scaling, stored in the application.

    Arithmetic and NumPy functions work on a wave directly and give ordinary
    arrays: ``np.sqrt(w)``, ``w * 2``, ``w.data.mean()``.

    A wave is numeric with 1 to 4 dimensions, or a 1-D list of text.
    """

    __slots__ = ("_name",)

    def __init__(self, name):
        self._name = name

    def _info(self):
        return _call("waveInfo", {"name": self._name})[0]

    @property
    def name(self):
        return self._name

    @property
    def data(self):
        """The values as a read-only array. Assign to replace them all."""
        return _wave_data(self._name)

    @data.setter
    def data(self, values):
        command = {"op": "setWaveData", "name": self._name}
        info = self._info()
        keep = None
        if info["kind"] == "numeric" and not _is_text(values):
            # The wave keeps its type, as in Igor: values are converted to it.
            # Complex values make a real wave complex rather than lose half of them.
            keep = info["type"]
            if np.asarray(values).dtype.kind == "c" and not keep.startswith("complex"):
                keep = "complex64" if keep == "float32" else "complex128"
        _dispatch(command, _content(command, values, keep))

    @property
    def dtype(self):
        """The wave's number type, as a NumPy dtype."""
        info = self._info()
        return np.dtype(str) if info["kind"] == "text" else np.dtype(info["type"])

    @property
    def is_complex(self):
        return self._info()["type"].startswith("complex")

    def redimension(self, dtype):
        """Change the number type, converting the values (Igor's Redimension).

        Into an integer type they are rounded and held at the ends of its
        range. A real wave made complex gets zero imaginary parts; a complex
        wave made real keeps its real parts.
        """
        _dispatch({"op": "redimension", "name": self._name, "type": np.dtype(dtype).name})
        return self

    @property
    def shape(self):
        return tuple(self._info()["shape"])

    @property
    def ndim(self):
        return len(self._info()["shape"])

    @property
    def is_text(self):
        return self._info()["kind"] == "text"

    @property
    def x(self):
        """The X value of every index along the first dimension, from the scaling."""
        info = self._info()
        return float(info["x0"]) + float(info["dx"]) * np.arange(info["shape"][0])

    @property
    def y(self):
        """The Y value of every index along the second dimension of a 2-D wave."""
        info = self._info()
        if len(info["shape"]) < 2:
            raise OresmeError(f"{self._name} has one dimension; it has no Y scaling.")
        return float(info["y0"]) + float(info["dy"]) * np.arange(info["shape"][1])

    @property
    def y0(self):
        return float(self._info()["y0"])

    @property
    def dy(self):
        return float(self._info()["dy"])

    @property
    def y_unit(self):
        return self._info()["yUnit"]

    @property
    def x0(self):
        return float(self._info()["x0"])

    @x0.setter
    def x0(self, value):
        self.set_scale(x0=value)

    @property
    def dx(self):
        return float(self._info()["dx"])

    @dx.setter
    def dx(self, value):
        self.set_scale(dx=value)

    @property
    def x_unit(self):
        return self._info()["xUnit"]

    @x_unit.setter
    def x_unit(self, value):
        self.set_scale(unit=value)

    @property
    def unit(self):
        """Unit of the stored values, shown on axes."""
        return self._info()["unit"]

    @unit.setter
    def unit(self, value):
        _dispatch({"op": "setWaveMeta", "name": self._name, "unit": str(value)})

    @property
    def note(self):
        return self._info()["note"]

    @note.setter
    def note(self, value):
        _dispatch({"op": "setWaveMeta", "name": self._name, "note": str(value)})

    def set_scale(self, x0=None, dx=None, unit=None, *, y0=None, dy=None, y_unit=None):
        """Set the scaling: start, step and unit along X (and Y for a 2-D wave)."""
        command = {"op": "setWaveScale", "name": self._name}
        if x0 is not None:
            command["x0"] = float(x0)
        if dx is not None:
            command["dx"] = float(dx)
        if unit is not None:
            command["xUnit"] = str(unit)
        if y0 is not None:
            command["y0"] = float(y0)
        if dy is not None:
            command["dy"] = float(dy)
        if y_unit is not None:
            command["yUnit"] = str(y_unit)
        _dispatch(command)
        return self

    @property
    def formula(self):
        """The formula the values are computed from, as text; None if there is none.

        Assigning one computes it now and keeps it up to date as its waves
        change: ``r.formula = "V / I"`` (see ``op.set_formula`` for the
        language, and for a formula computed only when asked). Assigning
        None removes the formula and keeps the values.
        """
        info = self._info()["formula"]
        return None if info is None else info["expr"]

    @formula.setter
    def formula(self, expr):
        if expr is None:
            _dispatch({"op": "setFormula", "name": self._name, "expr": None})
        else:
            set_formula(self, expr)

    @property
    def formula_info(self):
        """How the formula stands, as a dict; None if there is none.

        ``expr`` and ``auto`` are as set; ``inputs`` names the waves it
        reads; ``status`` is ``"ok"``, ``"stale"`` (a manual formula whose
        inputs changed since it was computed), ``"error"`` (the last
        computation failed and the values are from before it) or
        ``"missing"`` (one of its waves does not exist), with ``message``
        saying more; ``zero_divisions`` counts the points that were divided
        by zero and so are NaN.
        """
        info = self._info()["formula"]
        if info is None:
            return None
        return {_snake(key): value for key, value in info.items() if key != "name"}

    def rename(self, new_name):
        """Rename the wave. A name with a folder ("run1:signal") moves it there."""
        new_name = _dispatch({"op": "renameWave", "name": self._name, "newName": new_name})
        _data_cache.pop(self._name, None)
        self._name = new_name or self._name
        return self

    def duplicate(self, new_name):
        """Copy this wave, with its scaling, to a new wave."""
        _dispatch({"op": "duplicateWave", "name": self._name, "newName": new_name})
        return Wave(new_name)

    def insert_points(self, at, count=1):
        """Insert ``count`` NaN points before point ``at``."""
        _dispatch({"op": "insertPoints", "name": self._name, "at": int(at), "count": int(count)})

    def delete_points(self, at, count=1):
        _dispatch({"op": "deletePoints", "name": self._name, "at": int(at), "count": int(count)})

    def kill(self):
        kill(self)

    def __len__(self):
        return self._info()["shape"][0]

    def __iter__(self):
        return iter(self.data)

    def __getitem__(self, key):
        return self.data[key]

    def __setitem__(self, key, value):
        info = self._info()
        count = info["shape"][0]
        if info["kind"] == "text":
            values = [str(item) for item in self.data]
            if isinstance(key, (int, np.integer)):
                index = int(key) + count if key < 0 else int(key)
                if not 0 <= index <= count:
                    raise IndexError(f"Point {key} is out of range for a wave of {count} points.")
                _dispatch(
                    {"op": "setWaveText", "name": self._name, "start": index, "values": [str(value)]}
                )
                return
            values[key] = [value] if isinstance(value, str) else [str(item) for item in value]
            self.data = values
            return
        is_complex = info["type"].startswith("complex")
        # A complex value turns a real wave complex, which only a copy of the whole wave can do.
        if len(info["shape"]) > 1 or (np.iscomplexobj(value) and not is_complex):
            values = self.data.copy()
            if np.iscomplexobj(value) and not np.iscomplexobj(values):
                values = values.astype(np.complex128)
            values[key] = value
            self.data = values
            return
        # Writing just past the end grows a 1-D wave, as typing below its last point in a table does.
        kind = np.complex128 if is_complex else np.float64
        if isinstance(key, (int, np.integer)):
            index = int(key) + count if key < 0 else int(key)
            if not 0 <= index <= count:
                raise IndexError(f"Point {key} is out of range for a wave of {count} points.")
            self._write_points(index, np.array([value], dtype=kind))
            return
        if isinstance(key, slice) and key.step in (None, 1):
            start, stop, _ = key.indices(count)
            if key.stop is not None and key.stop > count and (key.start or 0) <= count:
                stop = int(key.stop)
            if stop > start:
                values = np.empty(stop - start, dtype=kind)
                values[:] = value
                self._write_points(start, values)
                return
        values = self.data.copy()
        values[key] = value
        self.data = values

    def _write_points(self, start, values):
        """Store a run of points from ``start``; complex ones go as real parts, then imaginary."""
        command = {"op": "setWavePoints", "name": self._name, "start": start}
        if np.iscomplexobj(values):
            command["complex"] = True
            values = np.concatenate([values.real, values.imag])
        _dispatch(command, values.astype(np.float64))

    @property
    def flat(self):
        """The points in storage order, whatever the shape: ``w.flat[6:9] = 0``."""
        return _Flat(self)

    def __array__(self, dtype=None, copy=None):
        array = self.data
        if dtype is not None and np.dtype(dtype) != array.dtype:
            return array.astype(dtype)
        return array.copy() if copy else array

    def __array_ufunc__(self, ufunc, method, *inputs, out=None, **kwargs):
        if out is not None:
            raise TypeError("A wave cannot be an output argument. Assign the result to w.data.")
        arrays = tuple(item.data if isinstance(item, Wave) else item for item in inputs)
        return getattr(ufunc, method)(*arrays, **kwargs)

    def __array_function__(self, func, types, args, kwargs):
        # np.mean(w), np.fft.fft(w), ...: hand NumPy the values.
        def unwrap(item):
            if isinstance(item, Wave):
                return item.data
            if isinstance(item, (list, tuple)):
                return type(item)(unwrap(part) for part in item)
            return item

        return func(*unwrap(args), **{key: unwrap(value) for key, value in kwargs.items()})

    def __repr__(self):
        try:
            info = self._info()
        except OresmeError:
            return f"Wave({self._name!r}) <missing>"
        if info["kind"] == "text":
            return f"Wave({self._name!r}, n={info['shape'][0]}, text)"
        scale = f", x0={info['x0']:g}, dx={info['dx']:g}"
        if info["xUnit"]:
            scale += f" {info['xUnit']}"
        unit = f", unit={info['unit']!r}" if info["unit"] else ""
        if info["formula"]:
            unit += f", formula={info['formula']['expr']!r}"
        if len(info["shape"]) > 1:
            return f"Wave({self._name!r}, shape={tuple(info['shape'])}{scale}{unit})"
        return f"Wave({self._name!r}, n={info['shape'][0]}{scale}{unit})"


class Trace(_Props):
    """One curve in a graph.

    ``fill="zero"`` fills the area down to zero and ``fill="next"`` the band
    between this trace and the next one; ``fill_color`` and ``fill_opacity``
    style it. ``x_offset`` and ``y_offset`` shift the trace where it is
    drawn without changing its waves. ``color_wave`` colors the trace point
    by point from another wave, through ``color_table`` (over ``color_min``
    to ``color_max``, or the wave's own range). For a complex wave, ``part``
    chooses what is plotted: ``"real"``, ``"imag"``, ``"magnitude"`` or
    ``"phase"`` (radians).
    """

    _props = (
        "mode",
        "color",
        "line_size",
        "line_style",
        "marker",
        "marker_size",
        "marker_fill",
        "hidden",
        "y_error",
        "x_error",
        "fill",
        "fill_color",
        "fill_opacity",
        "x_offset",
        "y_offset",
        "color_wave",
        "color_table",
        "color_min",
        "color_max",
        "part",
    )

    def __init__(self, graph, name):
        self._graph = graph
        self._name = name

    @property
    def name(self):
        return self._name

    def _get(self):
        for trace in self._graph._info()["traces"]:
            if trace["name"] == self._name:
                return trace
        raise OresmeError(f"{self._graph.name} has no trace named {self._name!r}.")

    def _set(self, props):
        for key in ("yError", "xError", "colorWave"):
            if isinstance(props.get(key), Wave):
                props[key] = props[key].name
        _dispatch(
            {"op": "modifyTrace", "graph": self._graph.name, "trace": self._name, "props": props}
        )

    @property
    def y(self):
        return Wave(self._get()["y"])

    @property
    def x(self):
        name = self._get()["x"]
        return None if name is None else Wave(name)

    def remove(self):
        self._graph.remove(self)

    def __repr__(self):
        return f"Trace({self._name!r} in {self._graph.name})"


class Axis(_Props):
    """One axis of a graph: "left", "bottom", "right", "top", or one you added.

    ``span=(low, high)`` draws the axis over part of the plot area, as
    fractions from 0 to 1; use it to stack plots in one graph.

    ``reverse=True`` runs the axis high to low. ``tick_step=0.25`` puts the
    major ticks that far apart. ``tick_format`` writes the tick labels like
    Python's ``format``: ``".2f"``, ``"e"``, ``",.0f"``, ``"%"``; ``None``
    goes back to automatic labels.

    ``label_size`` and ``tick_label_size`` are the font sizes of the axis
    label and of the tick labels (``None``: the graph's ``font_size``).
    ``label_style`` sets the whole label in ``"plain"``, ``"italic"``,
    ``"bold"`` or ``"bold italic"``. Codes in the label change part of it,
    as in Igor: ``r"Voltage (\\f02V\\f00)"`` has an italic V, ``\\Z14``
    makes what follows 14 high, ``\\u`` puts the units there. Write such
    labels as raw strings (``r"..."``), or Python reads ``\\f`` and ``\\u``
    as its own escapes.
    """

    _props = (
        "label",
        "label_size",
        "label_style",
        "tick_label_size",
        "min",
        "max",
        "log",
        "mirror",
        "ticks",
        "minor",
        "grid",
        "span",
        "reverse",
        "tick_step",
        "tick_format",
    )

    def __init__(self, graph, name):
        self._graph = graph
        self._name = name

    @property
    def name(self):
        return self._name

    def _get(self):
        return self._graph._info()["axes"][self._name]

    def _set(self, props):
        _dispatch(
            {"op": "modifyAxis", "graph": self._graph.name, "axis": self._name, "props": props}
        )

    def set(self, **props):
        """Change properties. ``range=(lo, hi)`` sets both limits; ``range=None`` autoscales."""
        if "range" in props:
            limits = props.pop("range")
            props["min"], props["max"] = (None, None) if limits is None else limits
        return super().set(**props)

    @property
    def range(self):
        """(min, max); None for a limit that follows the data."""
        spec = self._get()
        return (spec["min"], spec["max"])

    @range.setter
    def range(self, limits):
        self.set(range=limits)

    def autoscale(self):
        return self.set(range=None)

    @property
    def side(self):
        return self._get()["side"]

    def remove(self):
        self._graph.remove_axis(self._name)

    def __repr__(self):
        return f"Axis({self._name!r} of {self._graph.name})"


class Annotation(_Props):
    """A legend, text box, color scale or tag in a graph.

    ``x`` and ``y`` are how far it has been moved from its anchor (for a tag:
    from its point), as fractions of the plot area.
    """

    _props = ("text", "anchor", "frame", "x", "y", "point")

    def __init__(self, graph, name):
        self._graph = graph
        self._name = name

    @property
    def name(self):
        return self._name

    def _get(self):
        for annotation in self._graph._info()["annotations"]:
            if annotation["name"] == self._name:
                return annotation
        raise OresmeError(f"{self._graph.name} has no annotation named {self._name!r}.")

    def _set(self, props):
        _dispatch(
            {
                "op": "modifyAnnotation",
                "graph": self._graph.name,
                "annotation": self._name,
                "props": props,
            }
        )

    def remove(self):
        _dispatch(
            {"op": "removeAnnotation", "graph": self._graph.name, "annotation": self._name}
        )

    def __repr__(self):
        return f"Annotation({self._name!r} in {self._graph.name})"


class Image(_Props):
    """A 2-D wave shown as an image in a graph."""

    _props = ("color_table", "z_min", "z_max", "reverse", "layer", "chunk", "part")

    def __init__(self, graph, name):
        self._graph = graph
        self._name = name

    @property
    def name(self):
        return self._name

    def _get(self):
        for image in self._graph._info()["images"]:
            if image["name"] == self._name:
                return image
        raise OresmeError(f"{self._graph.name} has no image named {self._name!r}.")

    def _set(self, props):
        _dispatch(
            {"op": "modifyImage", "graph": self._graph.name, "image": self._name, "props": props}
        )

    def remove(self):
        _dispatch({"op": "removeImage", "graph": self._graph.name, "image": self._name})

    def __repr__(self):
        return f"Image({self._name!r} in {self._graph.name})"


class Contour(_Props):
    """Contour lines of a 2-D wave in a graph."""

    _props = ("levels", "color", "line_size", "color_table", "labels", "layer", "chunk")

    def __init__(self, graph, name):
        self._graph = graph
        self._name = name

    @property
    def name(self):
        return self._name

    def _get(self):
        for contour in self._graph._info()["contours"]:
            if contour["name"] == self._name:
                return contour
        raise OresmeError(f"{self._graph.name} has no contour named {self._name!r}.")

    def _set(self, props):
        _dispatch(
            {
                "op": "modifyContour",
                "graph": self._graph.name,
                "contour": self._name,
                "props": props,
            }
        )

    def remove(self):
        _dispatch({"op": "removeContour", "graph": self._graph.name, "contour": self._name})

    def __repr__(self):
        return f"Contour({self._name!r} in {self._graph.name})"


class Cursor:
    """Cursor A or B of a graph: a marker on one point of a trace."""

    def __init__(self, graph, name):
        self._graph = graph
        self._name = name

    def _info(self):
        return _call("cursorInfo", {"graph": self._graph.name, "cursor": self._name})[0]

    @property
    def name(self):
        return self._name

    @property
    def is_set(self):
        return self._name in self._graph._info()["cursors"]

    @property
    def trace(self):
        return Trace(self._graph, self._info()["trace"])

    @property
    def point(self):
        """Index of the point the cursor is on. Assign to move the cursor."""
        return self._info()["point"]

    @point.setter
    def point(self, value):
        self._graph.cursor(self._name, self._info()["trace"], value)

    @property
    def x(self):
        return float(self._info()["x"])

    @property
    def y(self):
        return float(self._info()["y"])

    def remove(self):
        _dispatch({"op": "removeCursor", "graph": self._graph.name, "cursor": self._name})

    def __repr__(self):
        if not self.is_set:
            return f"Cursor({self._name!r} of {self._graph.name}, not set)"
        info = self._info()
        return (
            f"Cursor({self._name!r} on {info['trace']}[{info['point']}], "
            f"x={info['x']:g}, y={info['y']:g})"
        )


class Graph(_Props):
    """A graph window."""

    _props = ("font_size", "font_family", "show_info")

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    def _info(self):
        return _call("graphInfo", {"name": self._name})[0]

    def _get(self):
        return self._info()

    def _set(self, props):
        _dispatch({"op": "modifyGraph", "graph": self._name, "props": props})

    def append(self, *y, x=None, axis="left", haxis="bottom"):
        """Add traces against the named vertical (``axis``) and horizontal (``haxis``) axes."""
        command = {
            "op": "appendTraces",
            "graph": self._name,
            "y": [_wave_name(item) for item in y],
            "x": None if x is None else _wave_name(x),
            "vAxis": axis,
            "hAxis": haxis,
        }
        return Trace(self, _dispatch(command))

    def remove(self, *traces):
        names = [item.name if isinstance(item, Trace) else item for item in traces]
        _dispatch({"op": "removeTraces", "graph": self._name, "traces": names})

    @property
    def traces(self):
        return [Trace(self, trace["name"]) for trace in self._info()["traces"]]

    def trace(self, name=None):
        """A trace by name; with no name, the only trace of the graph."""
        if isinstance(name, Wave):
            name = name.name
        names = [trace["name"] for trace in self._info()["traces"]]
        if name is None:
            if len(names) != 1:
                raise OresmeError(f"{self._name} has {len(names)} traces; say which one.")
            name = names[0]
        if name not in names:
            raise OresmeError(
                f"{self._name} has no trace named {name!r}. Traces: {', '.join(names) or 'none'}."
            )
        return Trace(self, name)

    def axis(self, name):
        axes = self._info()["axes"]
        if name not in axes:
            raise OresmeError(f"{self._name} has no axis named {name!r}. Axes: {', '.join(axes)}.")
        return Axis(self, name)

    @property
    def axes(self):
        return [Axis(self, name) for name in self._info()["axes"]]

    def add_axis(self, name, side):
        """Add another axis on a side ("left", "bottom", "right" or "top")."""
        _dispatch({"op": "addAxis", "graph": self._name, "name": name, "side": side})
        return Axis(self, name)

    def remove_axis(self, name):
        _dispatch({"op": "removeAxis", "graph": self._name, "axis": name})

    def append_image(self, wave_, *, axis="left", haxis="bottom", **props):
        """Show a wave as an image. ``color_table``, ``z_min``, ``z_max``, ``reverse``.

        For a 3-D or 4-D wave, ``layer`` and ``chunk`` choose the plane.
        """
        command = {
            "op": "appendImage",
            "graph": self._name,
            "wave": _wave_name(wave_),
            "vAxis": axis,
            "hAxis": haxis,
            "props": {_camel(key): _plain(value) for key, value in props.items()},
        }
        return Image(self, _dispatch(command))

    def append_contour(self, wave_, *, axis="left", haxis="bottom", **props):
        """Draw contour lines. ``levels``, ``labels``, ``color``, ``line_size``, ``color_table``.

        For a 3-D or 4-D wave, ``layer`` and ``chunk`` choose the plane.
        """
        command = {
            "op": "appendContour",
            "graph": self._name,
            "wave": _wave_name(wave_),
            "vAxis": axis,
            "hAxis": haxis,
            "props": {_camel(key): _plain(value) for key, value in props.items()},
        }
        return Contour(self, _dispatch(command))

    @property
    def images(self):
        return [Image(self, item["name"]) for item in self._info()["images"]]

    def image(self, name=None):
        names = [item["name"] for item in self._info()["images"]]
        if name is None and len(names) == 1:
            name = names[0]
        if name not in names:
            raise OresmeError(f"{self._name} has no image named {name!r}.")
        return Image(self, name)

    @property
    def contours(self):
        return [Contour(self, item["name"]) for item in self._info()["contours"]]

    def contour(self, name=None):
        names = [item["name"] for item in self._info()["contours"]]
        if name is None and len(names) == 1:
            name = names[0]
        if name not in names:
            raise OresmeError(f"{self._name} has no contour named {name!r}.")
        return Contour(self, name)

    def cursor(self, name, trace=None, point=None):
        """Cursor "A" or "B". With a trace and point, puts the cursor there first."""
        if point is not None:
            if trace is None:
                trace = self.trace()
            if isinstance(trace, (Trace, Wave)):
                trace = trace.name.rsplit(":", 1)[-1] if isinstance(trace, Wave) else trace.name
            _dispatch(
                {
                    "op": "setCursor",
                    "graph": self._name,
                    "cursor": name,
                    "trace": trace,
                    "point": int(point),
                }
            )
        return Cursor(self, name)

    def colorscale(self, image="", *, anchor="RC", frame=True):
        """Add a color scale bar for an image (the first one by default)."""
        if isinstance(image, Image):
            image = image.name
        return self._annotate("colorscale", image, anchor, frame)

    def save(self, filename, cursors=False):
        """Download the graph as a file: .pdf, .svg or .png, chosen by the name.

        Cursors are left out unless ``cursors=True``.
        """
        _call(
            "exportGraph",
            {"name": self._name, "filename": str(filename), "cursors": bool(cursors)},
        )

    def script(self):
        """Python that draws this graph again, as text.

        Like Igor's window recreation macro: paste it into a procedure to
        keep a graph's look, or to apply it to other waves.
        """
        return _call("graphScript", {"name": self._name})[0]

    left = property(lambda self: Axis(self, "left"))
    bottom = property(lambda self: Axis(self, "bottom"))
    right = property(lambda self: Axis(self, "right"))
    top = property(lambda self: Axis(self, "top"))

    def autoscale(self):
        """Autoscale every axis."""
        for name in self._info()["axes"]:
            Axis(self, name).autoscale()
        return self

    def legend(self, text="", *, anchor="RT", frame=True, x=0, y=0):
        """Add a legend. With no text it lists every trace.

        In custom text, ``\\s(traceName)`` draws that trace's symbol.
        ``anchor`` is two letters: L/M/R then T/C/B. ``x`` and ``y`` move
        it from there, as fractions of the plot area (dragging it with the
        mouse sets them).
        """
        return self._annotate("legend", text, anchor, frame, x, y)

    def textbox(self, text, *, anchor="RT", frame=True, x=0, y=0):
        """Add a text box. ``^{...}`` and ``_{...}`` give super- and subscripts."""
        return self._annotate("text", text, anchor, frame, x, y)

    def tag(self, trace, point, text="", *, frame=True, x=None, y=None):
        """Attach a label to one point of a trace; it follows the point.

        In the text, ``{x}``, ``{y}`` and ``{point}`` stand for the point's
        values; with no text the tag shows ``x, y``. ``x`` and ``y`` say where
        the box sits relative to the point, as fractions of the plot area.
        """
        if isinstance(trace, (Trace, Wave)):
            trace = trace.name.rsplit(":", 1)[-1] if isinstance(trace, Wave) else trace.name
        command = {
            "op": "addAnnotation",
            "graph": self._name,
            "kind": "tag",
            "text": text,
            "frame": frame,
            "trace": trace,
            "point": int(point),
        }
        if x is not None:
            command["x"] = float(x)
        if y is not None:
            command["y"] = float(y)
        return Annotation(self, _dispatch(command))

    def _annotate(self, kind, text, anchor, frame, x=0, y=0):
        command = {
            "op": "addAnnotation",
            "graph": self._name,
            "kind": kind,
            "text": text,
            "anchor": anchor,
            "frame": frame,
        }
        if x or y:
            command.update(x=float(x), y=float(y))
        return Annotation(self, _dispatch(command))

    @property
    def annotations(self):
        return [Annotation(self, item["name"]) for item in self._info()["annotations"]]

    def annotation(self, name):
        return Annotation(self, name)

    def save_style(self, name, size=False):
        """Keep this graph's look as a style named ``name`` and return it.

        The style holds the fonts, the look of the axes (ticks, mirror, grid)
        and of the traces in order (color, line, markers), not the data; with
        ``size=True`` also the size the graph is drawn at. A style of that
        name is replaced.
        """
        _dispatch({"op": "saveStyle", "name": name, "graph": self._name, "size": bool(size)})
        return Style(name)

    def save_template(self, name, fixed=()):
        """Keep this graph as a graph template named ``name`` and return it.

        Each wave the graph plots becomes a slot of the template (see
        ``GraphTemplate``); the traces, axes, look, text and size are kept.
        An axis keeps its range only if it is named in ``fixed`` (a name or
        a list of names; ``True`` for every axis): the others follow the
        data of each graph made from the template. A template of that name
        is replaced.
        """
        if fixed is True:
            fixed = list(self._info()["axes"])
        elif isinstance(fixed, str):
            fixed = [fixed]
        _dispatch(
            {
                "op": "saveGraphTemplate",
                "name": name,
                "graph": self._name,
                "fixed": [str(axis) for axis in fixed or ()],
            }
        )
        return GraphTemplate(name)

    def apply_style(self, style):
        """Give this graph the look of a style (a name or a Style). Returns self."""
        apply_style(style, graphs=[self])
        return self

    @property
    def style(self):
        """The Style last given to the graph, or None. Traces added later follow it."""
        name = self._info()["style"]
        return None if name is None else Style(name)

    def svg(self, width=None, height=None, cursors=False):
        """The graph as an SVG document; by default at its window's size."""
        return _call(
            "graphSvg",
            {"name": self._name, "width": width, "height": height, "cursors": bool(cursors)},
        )[0]

    def kill(self):
        kill_window(self._name)

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {"text/plain": repr(self), "image/svg+xml": self.svg()}

    def __repr__(self):
        return f"Graph({self._name!r})"


class Procedure:
    """A Python file kept in the experiment, shown in a procedure window.

    It is ``<name>.py`` in the working directory: ``run()`` executes it in
    the interactive namespace, and other code can ``import`` it.
    """

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    def _info(self):
        return _call("procedureInfo", {"name": self._name})[0]

    @property
    def code(self):
        return self._info()["code"]

    @code.setter
    def code(self, value):
        _dispatch({"op": "setProcedure", "name": self._name, "code": str(value)})

    @property
    def auto_run(self):
        """Whether the file runs when the experiment is opened."""
        return self._info()["autoRun"]

    @auto_run.setter
    def auto_run(self, value):
        _dispatch({"op": "setProcedure", "name": self._name, "autoRun": bool(value)})

    def run(self):
        """Run the file in the interactive namespace, as if it were typed there.

        What it defines can then be used from the command line. An error
        stops it and is reported with the file's name and line.
        """
        import linecache

        from IPython import get_ipython

        __tracebackhide__ = True
        code = self.code
        path = f"{self._name}.py"
        # Tracebacks quote the file, so it has to hold what is being run.
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(code)
        linecache.checkcache(path)
        exec(compile(code, path, "exec"), get_ipython().user_ns)

    def kill(self):
        kill_window(self._name)

    def __repr__(self):
        return f"Procedure({self._name!r})"


class LayoutItem(_Props):
    """A graph or a block of text on a page layout.

    ``x`` and ``y`` are its top left corner and ``w`` and ``h`` the size of
    a graph, all in points (1/72 inch) from the top left of the page.
    ``text`` and ``size`` are the words and font size of a text item.
    """

    _props = ("x", "y", "w", "h", "text", "size")

    def __init__(self, layout, name):
        self._layout = layout
        self._name = name

    @property
    def name(self):
        return self._name

    def _get(self):
        for item in self._layout._get()["items"]:
            if item["name"] == self._name:
                return item
        raise OresmeError(f"{self._layout.name} has no item named {self._name!r}.")

    def _set(self, props):
        _dispatch(
            {
                "op": "modifyLayoutItem",
                "layout": self._layout.name,
                "item": self._name,
                "props": props,
            }
        )

    @property
    def graph(self):
        name = self._get()["graph"]
        return None if name is None else Graph(name)

    def remove(self):
        _dispatch({"op": "removeLayoutItem", "layout": self._layout.name, "item": self._name})

    def __repr__(self):
        return f"LayoutItem({self._name!r} on {self._layout.name})"


def _item_names(items):
    """Names of page items, given as names or as items; one alone is taken as a list."""
    if isinstance(items, (str, LayoutItem)):
        items = [items]
    return [item.name if isinstance(item, LayoutItem) else str(item) for item in items]


class Layout(_Props):
    """A page layout: graphs and text arranged on a sheet of paper.

    ``width`` and ``height`` are the size of the paper in points. The page
    shows the graphs as they are: change a graph and the page follows.
    """

    _props = ("width", "height")

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    def _get(self):
        return _call("pageInfo", {"name": self._name})[0]

    def _set(self, props):
        _dispatch({"op": "modifyLayout", "layout": self._name, "props": props})

    def add_graph(self, graph, x=None, y=None, w=None, h=None):
        """Put a graph on the page. Without a place, it goes below what is there."""
        command = {
            "op": "addLayoutItem",
            "layout": self._name,
            "kind": "graph",
            "graph": graph.name if isinstance(graph, Graph) else graph,
        }
        for key, value in (("x", x), ("y", y), ("w", w), ("h", h)):
            if value is not None:
                command[key] = float(value)
        return LayoutItem(self, _dispatch(command))

    def add_text(self, text, x=None, y=None, size=None):
        """Put text on the page. ``^{...}`` and ``_{...}`` give super- and subscripts."""
        command = {"op": "addLayoutItem", "layout": self._name, "kind": "text", "text": str(text)}
        for key, value in (("x", x), ("y", y), ("size", size)):
            if value is not None:
                command[key] = float(value)
        return LayoutItem(self, _dispatch(command))

    @property
    def items(self):
        return [LayoutItem(self, item["name"]) for item in self._get()["items"]]

    def item(self, name):
        return LayoutItem(self, name)

    def _arrange(self, request):
        return _call("arrangeLayout", {"layout": self._name, **request})[0]

    def align(self, items, edge):
        """Line items up: ``"left"``, ``"right"``, ``"top"`` or ``"bottom"`` edges,
        or their middles, ``"center"`` (one above the other) or ``"middle"``
        (side by side). They line up with the outermost of them; a single item
        lines up with the page. ``items`` are names or items of this page.
        """
        self._arrange({"action": "align", "items": _item_names(items), "edge": edge})

    def distribute(self, items, direction="horizontal"):
        """Space three or more items so the gaps between them are equal,
        ``"horizontal"``-ly or ``"vertical"``-ly. The outermost stay where they are.
        """
        self._arrange({"action": "distribute", "items": _item_names(items), "direction": direction})

    def match_size(self, items, dimension="both"):
        """Give graphs the ``"width"``, ``"height"`` or ``"both"`` of the first one named.

        Text keeps the size its words need and is left as it is.
        """
        self._arrange({"action": "matchSize", "items": _item_names(items), "dimension": dimension})

    def arrange(self, rows, columns, items=None, margin=36, gap=12):
        """Put graphs in a grid of ``rows`` by ``columns`` that fills the page inside
        ``margin`` points, with ``gap`` points between cells (or a pair: between
        columns, between rows). The graphs fill the cells row by row, in the order
        given; without ``items``, every graph of the page in the order they read on it
        now. Text is not moved; graphs beyond the cells stay where they are.
        """
        request = {
            "action": "arrange",
            "rows": _plain(rows),
            "columns": _plain(columns),
            "margin": _plain(margin),
            "gap": _plain(tuple(gap) if isinstance(gap, (list, tuple)) else gap),
        }
        if items is not None:
            request["items"] = _item_names(items)
        left_out = self._arrange(request)["leftOut"]
        if left_out:
            warnings.warn(
                f"{', '.join(left_out)} did not fit in the {rows} × {columns} grid "
                "and stayed where they were.",
                stacklevel=2,
            )

    def svg(self):
        """The page as an SVG document."""
        return _call("pageSvg", {"name": self._name})[0]

    def save(self, filename):
        """Download the page as a file: .pdf (at the paper's size), .svg or .png."""
        _call("exportPage", {"name": self._name, "filename": str(filename)})

    def kill(self):
        kill_window(self._name)

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {"text/plain": repr(self), "image/svg+xml": self.svg()}

    def __repr__(self):
        return f"Layout({self._name!r})"


#: Paper sizes in points, upright.
PAGE_SIZES = {"A4": (595, 842), "A5": (420, 595), "A3": (842, 1191), "Letter": (612, 792)}


def new_layout(name=None, size="A4", landscape=False):
    """Make a page layout. ``size`` is a paper name or (width, height) in points."""
    if isinstance(size, str):
        if size not in PAGE_SIZES:
            raise OresmeError(f"Paper sizes: {', '.join(PAGE_SIZES)}; or give (width, height).")
        size = PAGE_SIZES[size]
    width, height = (float(size[0]), float(size[1]))
    if landscape:
        width, height = height, width
    command = {"op": "newLayout", "width": width, "height": height}
    if name is not None:
        command["name"] = name
    return Layout(_dispatch(command))


def layouts():
    return [Layout(name) for name in _call("listWindows", {"kind": "page"})[0]]


def layout(name=None):
    """A page layout by name; with no name, the frontmost one."""
    names = _call("listWindows", {"kind": "page"})[0]
    if name is None:
        if not names:
            raise OresmeError("There are no page layouts.")
        return Layout(names[-1])
    if name not in names:
        raise OresmeError(f"No page layout named {name!r}.")
    return Layout(name)


class Table(_Props):
    """A table window showing waves as columns."""

    _props = ("digits",)

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    def _get(self):
        return _call("tableInfo", {"name": self._name})[0]

    def _set(self, props):
        _dispatch({"op": "modifyTable", "table": self._name, "props": props})

    @property
    def columns(self):
        return [Wave(name) for name in _call("tableInfo", {"name": self._name})[0]["columns"]]

    def to_dataframe(self):
        """The table's columns as a pandas DataFrame (see ``op.to_dataframe``)."""
        return to_dataframe(self)

    def append(self, *waves_):
        _dispatch(
            {
                "op": "appendToTable",
                "table": self._name,
                "waves": [_wave_name(item) for item in waves_],
            }
        )
        return self

    def remove(self, *waves_):
        _dispatch(
            {
                "op": "removeFromTable",
                "table": self._name,
                "waves": [_wave_name(item) for item in waves_],
            }
        )
        return self

    def kill(self):
        kill_window(self._name)

    def __repr__(self):
        return f"Table({self._name!r})"


def make(name, data=None, *, n=128, dtype=None, x0=None, dx=None, x_unit=None, y0=None,
         dy=None, y_unit=None, unit=None, note=None, overwrite=True):
    """Create a wave (or replace an existing one) and return it.

    ``data`` may be numbers with up to 4 dimensions, or a list of strings for
    a text wave. Without ``data`` the wave has ``n`` zeros; ``n=(rows,
    columns)``, with up to 4 sizes, makes a matrix of zeros. An existing wave
    keeps its scaling and units unless new ones are given; with
    ``overwrite=False`` making one is refused instead.

    The wave takes the type of the data when it is one a wave can have:
    float64 or float32, int8 to int32 and uint8 to uint32, complex128 or
    complex64. Plain whole numbers (a list of them, ``np.arange(10)``) are
    float64, like any other numbers. ``dtype`` asks for a type by name:
    ``dtype="int32"``.
    """
    command = {"op": "makeWave", "name": name, "overwrite": bool(overwrite)}
    for key, value in (("x0", x0), ("dx", dx), ("y0", y0), ("dy", dy)):
        if value is not None:
            command[key] = float(value)
    for key, value in (("xUnit", x_unit), ("yUnit", y_unit), ("unit", unit), ("note", note)):
        if value is not None:
            command[key] = str(value)
    if data is None:
        shape = tuple(int(size) for size in n) if isinstance(n, (tuple, list)) else int(n)
        values = np.zeros(shape)
    else:
        values = data
    return Wave(_dispatch(command, _content(command, values, dtype)))


def wave(name):
    """The existing wave with this name."""
    return Wave(_call("waveInfo", {"name": name})[0]["name"])


def waves(folder=None):
    """Every wave, in creation order; or only those directly in a folder."""
    names = _call("listWaves")[0]
    if folder is None:
        return [Wave(name) for name in names]
    path = folder.path if isinstance(folder, Folder) else _wave_name(folder)
    return [Wave(name) for name in names if name.rpartition(":")[0] == path]


def exists(name):
    return _wave_name(name) in _call("listWaves")[0]


class Folder:
    """A data folder. ``Folder("")`` is root."""

    def __init__(self, path):
        self._path = path

    @property
    def path(self):
        return self._path

    def _join(self, name):
        return f"{self._path}:{name}" if self._path else name

    def make(self, name, data=None, **options):
        """Create a wave in this folder. Same options as ``op.make``."""
        return make(self._join(name), data, **options)

    def wave(self, name):
        return wave(self._join(name))

    def waves(self):
        return waves(self)

    def folders(self):
        prefix = f"{self._path}:" if self._path else ""
        return [
            Folder(path)
            for path in _call("listFolders")[0]
            if path.startswith(prefix) and ":" not in path[len(prefix) :]
        ]

    def new_folder(self, name):
        return new_folder(self._join(name))

    def rename(self, new_path):
        """Rename or move the folder, with everything in it."""
        self._path = _dispatch({"op": "renameFolder", "path": self._path, "newPath": new_path})
        _data_cache.clear()
        return self

    def kill(self):
        """Delete the folder and the waves in it."""
        _dispatch({"op": "killFolder", "path": self._path})
        _data_cache.clear()

    def __repr__(self):
        return f"Folder({self._path or 'root'!r})"


def new_folder(path):
    """Create a data folder, e.g. ``op.new_folder("run1")`` or ``"run1:raw"``."""
    return Folder(_dispatch({"op": "newFolder", "path": path}))


def folder(path=""):
    """An existing data folder; root with no argument."""
    path = _wave_name(path) if path else ""
    if path and path not in _call("listFolders")[0]:
        raise OresmeError(f"No data folder named {path!r}.")
    return Folder(path)


def folders():
    """Every data folder below root."""
    return [Folder(path) for path in _call("listFolders")[0]]


def kill(*waves_):
    """Delete waves. A wave shown in a graph or table cannot be killed."""
    names = [item.name if isinstance(item, Wave) else item for item in waves_]
    _dispatch({"op": "killWaves", "names": names})
    for name in names:
        _data_cache.pop(name, None)


def set_formula(wave, expr, *, auto=True):
    """Compute a wave's values from other waves with a formula, and return it.

    ::

        op.set_formula("R", "V / I")
        op.set_formula("ratio", "run1:A / run2:A", auto=False)

    The wave is made if it does not exist, with the length and X scaling of
    the waves in the formula. The values are computed now, as float64, and
    with ``auto=True`` again whenever one of those waves changes, in the
    same undo step as the change; with ``auto=False`` only by
    ``op.recalculate()``, the wave being marked out of date meanwhile.
    Values written into the wave itself are replaced by the formula's (or
    mark it out of date); ``w.formula = None`` removes the formula first.

    The formula is not Python. It works point by point on 1-D numeric waves
    with the same number of points and the same X scaling (nothing is
    interpolated), and knows only:

    - numbers, wave names (``run1:V`` in a data folder; ``'x'`` in quotes
      for a wave named like one of the words below), ``p`` (the point
      number), ``x`` (its X value), ``pi``, ``e``, ``nan``, ``inf``
    - ``+ - * / ^`` (``^`` is a power, ``-2^2`` is -4), comparisons
      ``< <= > >= == !=``, ``&& || !`` and ``test ? a : b``
    - ``abs sqrt exp ln log log10 sin cos tan asin acos atan atan2 sinh
      cosh tanh floor ceil round min max pow hypot sign isnan``; ``log`` is
      the common logarithm, as in Igor

    Division by zero gives NaN; a warning says how many points it took.
    NaN goes through everything but ``isnan``: ``isnan(V) ? 0 : V``. A
    formula that cannot be computed, or that would make a wave depend on
    itself, raises ``OresmeError`` saying where, and changes nothing. When
    an automatic recomputation fails later (an input deleted or of another
    length), the values stay as they were and ``w.formula_info`` says why.
    """
    command = {"op": "setFormula", "name": _wave_name(wave), "expr": str(expr)}
    if not auto:
        command["auto"] = False
    result = Wave(_dispatch(command))
    count = result.formula_info["zero_divisions"]
    if count:
        warnings.warn(
            f"{count} point{'s were' if count != 1 else ' was'} divided by zero and "
            f"{'are' if count != 1 else 'is'} NaN.",
            stacklevel=2,
        )
    return result


def recalculate(waves=None):
    """Compute formulas again: those of the given waves, or all.

    Only formulas that are out of date (manual ones whose waves changed) or
    whose last computation failed are computed, inputs before the waves
    computed from them. A warning names those that still fail.
    """
    command = {"op": "recalculate"}
    if waves is not None:
        if isinstance(waves, (Wave, str)):
            waves = [waves]
        command["names"] = [_wave_name(item) for item in waves]
    _dispatch(command)
    asked = None if waves is None else set(command["names"])
    for info in _call("formulas")[0]:
        if asked is not None and info["name"] not in asked:
            continue
        if info["status"] in ("error", "missing"):
            warnings.warn(f"{info['name']}: {info['message']}", stacklevel=2)


_DEFAULT = object()


def display(*y, x=None, name=None, style=_DEFAULT):
    """Make a new graph of the given waves (or arrays) and return it.

    ``x`` plots them against an X wave instead of their own X scaling. A text
    wave as ``x`` makes a category plot (try ``mode="bars"`` on the traces).
    The graph is given the default style, if there is one (see
    ``set_default_style``); ``style="paper"`` gives it another, and
    ``style=None`` none.
    """
    command = {
        "op": "display",
        "y": [_wave_name(item) for item in y],
        "x": None if x is None else _wave_name(x),
    }
    if name is not None:
        command["name"] = name
    if style is not _DEFAULT:
        command["style"] = style.name if isinstance(style, Style) else style
    return Graph(_dispatch(command))


def image(wave_, *, name=None, **props):
    """Make a new graph showing a 2-D wave as an image, and return the graph."""
    graph_ = display(name=name)
    try:
        graph_.append_image(wave_, **props)
    except Exception:
        graph_.kill()
        raise
    return graph_


def contour(wave_, *, name=None, **props):
    """Make a new graph of the contour lines of a 2-D wave, and return the graph."""
    graph_ = display(name=name)
    try:
        graph_.append_contour(wave_, **props)
    except Exception:
        graph_.kill()
        raise
    return graph_


def edit(*waves_, name=None):
    """Make a new table of the given waves and return it."""
    command = {"op": "edit", "waves": [_wave_name(item) for item in waves_]}
    if name is not None:
        command["name"] = name
    return Table(_dispatch(command))


def _read_source(source, name):
    """The bytes of a file to load, and the file name that goes into the notes of the waves."""
    if isinstance(source, (bytes, bytearray, memoryview)):
        if name is None:
            raise OresmeError("Give name=, a file name for the notes of the waves, with bytes.")
        return bytes(source), name
    path = os.fspath(source)
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError as error:
        raise OresmeError(
            f"Could not read {path}: {error.strerror or error}. Files added with "
            "File > Add Files for Python are in the working directory."
        ) from None
    return data, name or os.path.basename(path)


def _file_words(data):
    """A file's bytes as they travel to the application: float64 words, padded with zeros."""
    return np.frombuffer(data + b"\0" * (-len(data) % 8), dtype=np.float64)


def _import(kind, source, name, preset, options):
    """Read a file's bytes here and have the application turn them into waves."""
    data, filename = _read_source(source, name)
    settings = {key: value for key, value in options.items() if value is not None}
    if isinstance(settings.get("header"), bool):
        settings["header"] = "yes" if settings["header"] else "no"
    if isinstance(settings.get("sheets"), str):
        settings["sheets"] = [settings["sheets"]]
    for key in ("columns", "errors"):
        if key in settings:
            if not isinstance(settings[key], dict):
                raise OresmeError(f"{key} must be a dict keyed by column number, counted from 0.")
            settings[key] = {str(column): value for column, value in settings[key].items()}
    reply = _call(
        "importData",
        {
            "kind": kind,
            "filename": filename,
            "settings": settings,
            "preset": preset,
            "size": len(data),
            "digest": hashlib.sha256(data).hexdigest(),
        },
        _file_words(data),
    )[0]
    for table in reply["tables"]:
        unread = [
            f"{wave_} ({count})" for wave_, count in zip(table["waves"], table["unreadable"]) if count
        ]
        if unread:
            warnings.warn(
                f"{filename}: cells that could not be read are NaN in {', '.join(unread)}.",
                stacklevel=3,
            )
    return reply


def load_text(source, *, preset=None, encoding=None, delimiter=None, decimal=None, comment=None,
              skip=None, header=None, units=None, columns=None, x=None, errors=None,
              graph=False, table=True, name=None):
    """Load a file of delimited text (CSV, TSV, columns separated by spaces) as waves.

    ``source`` is a file in the working directory (the files of the
    experiment are there), any other path, or the file's bytes with
    ``name=``. Each column becomes a wave, returned in a list. What is not
    given is detected:

    - ``encoding``: "utf-8", "shift_jis", "euc-jp", "utf-16le", "utf-16be", "windows-1252".
    - ``delimiter``: "tab", "comma", "semicolon" or "space".
    - ``decimal``: "," for numbers written like 1,5 (a point then groups thousands).
    - ``comment``: lines starting with this are passed over; "#" unless given, "" for none.
    - ``skip``: lines above the table to pass over.
    - ``header``: True if the first row names the columns, False if it is data.
    - ``units``: "auto" takes units from headers like "Voltage (V)" or "I [mA]",
      "slash" from "Ewe/V", "row" from the row below the header, "none" leaves them.
    - ``columns``: choices by column number, counted from 0:
      ``{0: {"name": "t", "unit": "s"}, 3: {"type": "skip"}}``. A type is "number",
      "date", "text" or "skip". Cells that do not fit a type chosen become NaN, with
      a warning; a column left to be detected is text if any cell is not a number.
    - ``graph=True`` plots the numeric columns, against column ``x`` if given, with
      error bars from ``errors={value_column: uncertainty_column}``.
    - ``table=False`` makes no table.
    - ``preset``: the name of an import preset saved in the Load Data dialog; what is
      given here goes before it.
    """
    reply = _import("text", source, name, preset, dict(
        encoding=encoding, delimiter=delimiter, decimal=decimal, comment=comment, skip=skip,
        header=header, units=units, columns=columns, x=x, errors=errors,
        graph=bool(graph), table=bool(table),
    ))
    return [Wave(wave_) for wave_ in reply["tables"][0]["waves"]]


def load_excel(source, *, sheets=None, preset=None, decimal=None, skip=None, header=None,
               units=None, columns=None, x=None, errors=None, graph=False, table=True,
               name=None):
    """Load an Excel workbook (.xlsx, .xlsm) as waves: a dict of sheet name to its waves.

    ``sheets`` names the sheets to read (one name or a list); all that have
    cells otherwise. ``skip`` counts rows above the table. The other options
    are those of ``load_text`` and apply to every sheet read.
    """
    reply = _import("excel", source, name, preset, dict(
        sheets=sheets, decimal=decimal, skip=skip, header=header, units=units, columns=columns,
        x=x, errors=errors, graph=bool(graph), table=bool(table),
    ))
    return {table["sheet"]: [Wave(wave_) for wave_ in table["waves"]] for table in reply["tables"]}


def load_igor(source, *, name=None):
    """Load the waves of an Igor Pro file: a binary wave (.ibw) or a packed experiment (.pxp, .pxt).

    ``source`` is a file in the working directory, any other path, or the
    file's bytes with ``name=`` (whose extension says which kind it is).
    Returns the waves made, in a list in the order of the file: one for a
    binary wave, all of an experiment's waves otherwise, each in the data
    folder it was in (``w.name`` is then like ``"run1:signal"``). The values,
    dimensions, scaling, units and note are Igor's; names Igor allows but this
    app does not ("raw data") are made legal ("raw_data"), and a name that is
    taken gets a suffix. Each wave's note says which file it came from and
    what could not be kept as Igor had it. An experiment's graphs, tables,
    procedures, variables and history are not loaded, nor a wave whose values
    Igor did not save (it computes them from a formula); such waves are named
    in a warning.
    """
    data, filename = _read_source(source, name)
    reply = _call(
        "importIgor",
        {"filename": filename, "size": len(data), "digest": hashlib.sha256(data).hexdigest()},
        _file_words(data),
    )[0]
    if reply["skipped"]:
        warnings.warn(
            f"{filename}: not loaded, without saved values: {', '.join(reply['skipped'])}.",
            stacklevel=2,
        )
    return [Wave(wave_) for wave_ in reply["waves"]]


def _column_name(text, taken, prefix=""):
    """A legal wave name for a column title, not one of ``taken``."""
    leaf = re.sub(r"[^0-9A-Za-z_]+", "_", str(text)).strip("_") or "column"
    if not leaf[0].isalpha():
        leaf = f"wave_{leaf}"
    name = base = f"{prefix}{leaf}"
    suffix = 0
    while name in taken:
        suffix += 1
        name = f"{base}_{suffix}"
    taken.add(name)
    return name


def to_dataframe(*waves_):
    """The given waves as the columns of a pandas DataFrame.

    Each wave is a column named after it (without its data folder). Date
    waves become ``datetime64`` columns and text waves columns of strings. A
    table can be given in place of waves: its columns are used. Waves of
    different lengths are padded with NaN at the end.
    """
    import pandas as pd

    columns = {}
    for item in waves_:
        for wave_ in item.columns if isinstance(item, Table) else [item]:
            source = wave(_wave_name(wave_))
            values = source.data
            if getattr(values, "ndim", 1) != 1:
                raise OresmeError(f"{source.name} is not 1-D: a DataFrame column holds one dimension.")
            if source.unit == "dat":
                values = pd.to_datetime(np.asarray(values, dtype=float), unit="s")
            columns[source.name.rsplit(":", 1)[-1]] = pd.Series(values)
    return pd.DataFrame(columns)


def from_dataframe(frame, prefix="", *, index=None, table=True):
    """Make a wave of each column of a pandas DataFrame (or Series); returns the waves.

    Numbers become numeric waves, dates date waves (in UTC), and anything
    else text waves. Names are the column titles made into legal wave names,
    after ``prefix`` (which may name a data folder: ``"run1:"``); a name that
    is taken gets ``_1``, ``_2``, .... The index becomes a wave too unless it
    is the plain 0, 1, 2, ... (``index=False`` leaves it out, ``True`` forces
    it). With ``table`` the new waves are shown in a table.
    """
    import pandas as pd

    if isinstance(frame, pd.Series):
        frame = frame.to_frame(frame.name if frame.name is not None else "values")
    columns = []
    plain = isinstance(frame.index, pd.RangeIndex) and frame.index.start == 0 and frame.index.step == 1
    if index is True or (index is None and not plain):
        columns.append((frame.index.name if frame.index.name is not None else "index", frame.index.to_series()))
    columns += [(title, frame[title]) for title in frame.columns]
    taken = set(_call("listWaves")[0])
    made = []
    for title, column in columns:
        name = _column_name(title, taken, prefix)
        if pd.api.types.is_datetime64_any_dtype(column.dtype):
            if getattr(column.dt, "tz", None) is not None:
                column = column.dt.tz_convert("UTC").dt.tz_localize(None)
            values = column.to_numpy(dtype="datetime64[ns]")
        elif pd.api.types.is_bool_dtype(column.dtype):
            values = column.to_numpy(dtype=np.uint8)
        elif pd.api.types.is_numeric_dtype(column.dtype):
            # Missing values of pandas' nullable types become NaN.
            kind = column.dtype.kind if isinstance(column.dtype, np.dtype) else "f"
            values = column.to_numpy() if kind in "iufc" else column.to_numpy(dtype=float, na_value=np.nan)
        else:
            values = ["" if pd.isna(item) else str(item) for item in column.tolist()]
        made.append(make(name, values))
    if table and made:
        edit(*made)
    return made


def graphs():
    return [Graph(name) for name in _call("listWindows", {"kind": "graph"})[0]]


def graph(name=None):
    """A graph by name; with no name, the frontmost graph."""
    names = _call("listWindows", {"kind": "graph"})[0]
    if name is None:
        if not names:
            raise OresmeError("There are no graphs.")
        return Graph(names[-1])
    if name not in names:
        raise OresmeError(f"No graph named {name!r}.")
    return Graph(name)


def tables():
    return [Table(name) for name in _call("listWindows", {"kind": "table"})[0]]


def table(name=None):
    """A table by name; with no name, the frontmost table."""
    names = _call("listWindows", {"kind": "table"})[0]
    if name is None:
        if not names:
            raise OresmeError("There are no tables.")
        return Table(names[-1])
    if name not in names:
        raise OresmeError(f"No table named {name!r}.")
    return Table(name)


def new_procedure(name=None, code=""):
    """Make a procedure window: a Python file that is saved with the experiment."""
    command = {"op": "newProcedure", "code": str(code)}
    if name is not None:
        command["name"] = name
    return Procedure(_dispatch(command))


def procedures():
    return [Procedure(name) for name in _call("listWindows", {"kind": "procedure"})[0]]


def procedure(name=None):
    """A procedure by name; with no name, the frontmost one."""
    names = _call("listWindows", {"kind": "procedure"})[0]
    if name is None:
        if not names:
            raise OresmeError("There are no procedures.")
        return Procedure(names[-1])
    if name not in names:
        raise OresmeError(f"No procedure named {name!r}.")
    return Procedure(name)


def time_zone():
    """The time zone dates are shown and typed in: "UTC", "local" or a name such as "Asia/Tokyo"."""
    return _call("timeZone")[0]


def set_time_zone(zone):
    """Show dates on axes and in tables in a time zone.

    ``"UTC"`` (the default), ``"local"`` for this computer's zone, or an IANA
    name such as ``"Asia/Tokyo"``. Date waves hold seconds since 1970 UTC and
    are not changed; dates typed or loaded without an offset are read in
    this zone.
    """
    _dispatch({"op": "setTimeZone", "zone": str(zone)})


def kill_window(name):
    """Close a graph, table or procedure window."""
    _dispatch({"op": "killWindow", "name": name})


class Style:
    """A graph style: the look of a graph kept in the experiment under a name.

    ``data`` is what it holds, as a plain dict with any of ``"graph"``
    (``font_size``, ``font_family``), ``"size"`` (``width`` and ``height`` of
    the drawn graph, in pixels), ``"axes"`` (by ``"left"``, ``"bottom"``,
    ``"right"``, ``"top"`` and ``"other"`` for added axes: ``mirror``,
    ``ticks``, ``minor``, ``grid``) and ``"traces"``: a list of trace looks
    (``mode``, ``color``, ``line_size``, ``line_style``, ``marker``,
    ``marker_size``, ``marker_fill``) that the traces of a graph take in
    turn, starting again from the first when there are more traces. A style
    changes only what it holds.
    """

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    @property
    def data(self):
        """What the style holds, as a dict (a copy: change it with ``op.set_style``)."""
        return _keys(_call("styleInfo", {"name": self._name})[0], _snake)

    def apply(self, graphs=None):
        """Give graphs this look; every graph when ``graphs`` is None."""
        apply_style(self, graphs)
        return self

    def rename(self, new_name):
        _dispatch({"op": "renameStyle", "name": self._name, "newName": new_name})
        self._name = new_name
        return self

    def remove(self):
        """Delete the style. Graphs keep the look it gave them."""
        _dispatch({"op": "removeStyle", "name": self._name})

    def __repr__(self):
        return f"Style({self._name!r})"


def _style_name(style):
    return style.name if isinstance(style, Style) else style


def styles():
    """Every style of the experiment."""
    return [Style(name) for name in _call("listStyles")[0]["names"]]


def style(name):
    """The style with this name."""
    if name not in _call("listStyles")[0]["names"]:
        raise OresmeError(f"No style named {name!r}.")
    return Style(name)


def set_style(name, data):
    """Define a style from a dict (see ``Style``) or copy another Style; returns it.

    A style of that name is replaced. Unknown keys and bad values are refused.
    """
    if isinstance(data, Style):
        data = data.data
    _dispatch({"op": "setStyle", "name": name, "style": _keys(data, _camel)})
    return Style(name)


def apply_style(style, graphs=None):
    """Give graphs the look of a style; every graph when ``graphs`` is None.

    It is one step to undo, however many graphs it changes.
    """
    if graphs is None:
        names = _call("listWindows", {"kind": "graph"})[0]
    else:
        if isinstance(graphs, (Graph, str)):
            graphs = [graphs]
        names = [item.name if isinstance(item, Graph) else item for item in graphs]
    _dispatch({"op": "applyStyle", "style": _style_name(style), "graphs": names})


def set_default_style(style):
    """Give new graphs this style (a name or a Style); None to give them none."""
    _dispatch({"op": "setDefaultStyle", "name": _style_name(style)})


def default_style():
    """The Style new graphs are given, or None."""
    name = _call("listStyles")[0]["default"]
    return None if name is None else Style(name)


# --- Actions ---------------------------------------------------------------
#
# An action is a function registered under a name, with a description of its
# arguments. Panels, templates and plugins call analyses this way: they send
# the name and plain values (JSON), which are checked here against the
# description before the function is called. No Python is written from what
# they send and run.

#: The kinds of value a parameter of an action takes.
_PARAM_TYPES = ("wave", "waves", "number", "integer", "string", "boolean", "choice", "numbers")
_PARAM_KEYS = frozenset(
    ("type", "title", "description", "optional", "default", "choices", "min", "max", "length", "arg")
)
_ACTION_ID = re.compile(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+")
#: Namespaces of action ids that only the application registers in.
_RESERVED_NAMESPACES = ("core", "plugin")

# id -> {version: _Action}
_actions = {}
# Goes up on every registration, so that the kernel can tell the GUI the list changed.
_actions_revision = 0
# The reserved namespace the application is registering in at the moment.
_registering_in = None


@contextlib.contextmanager
def _registering(namespace):
    """Let the code in the block register actions in a reserved namespace (``core``, ``plugin``).

    The reservation keeps procedures from taking the application's names by
    accident. It is no security boundary: procedures are trusted code.
    """
    global _registering_in
    before = _registering_in
    _registering_in = namespace
    try:
        yield
    finally:
        _registering_in = before


class _Action:
    def __init__(self, id, version, title, description, params, function):
        self.id = id
        self.version = version
        self.title = title
        self.description = description
        # name -> description, as checked (with "arg" where it is passed under another name).
        self.params = params
        self.function = function

    def spec(self):
        return {
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "description": self.description,
            "params": {
                name: {key: value for key, value in spec.items() if key != "arg"}
                for name, spec in self.params.items()
            },
        }


def _is_number(value):
    return isinstance(value, numbers.Real) and not isinstance(value, (bool, np.bool_))


def _is_integer(value):
    return _is_number(value) and (isinstance(value, numbers.Integral) or float(value).is_integer())


def _check_value(spec, value, where, resolve_names=True):
    """The value of one argument as plain JSON, or OresmeError saying what is wrong with it."""
    kind = spec["type"]
    if value is None:
        raise OresmeError(f"{where} cannot be None (null): leave it out instead.")

    def number(item, what):
        if not _is_number(item):
            raise OresmeError(f"{what} must be a number, not {item!r}.")
        if not math.isfinite(float(item)):
            raise OresmeError(f"{what} must be a finite number, not {item!r}.")
        if kind == "integer" and not _is_integer(item):
            raise OresmeError(f"{what} must be a whole number, not {item!r}.")
        plain = int(item) if kind == "integer" else float(item)
        if "min" in spec and plain < spec["min"]:
            raise OresmeError(f"{what} must be at least {spec['min']:g}, not {plain:g}.")
        if "max" in spec and plain > spec["max"]:
            raise OresmeError(f"{what} must be at most {spec['max']:g}, not {plain:g}.")
        return plain

    def wave_name(item, what):
        if isinstance(item, Wave):
            return item.name
        if not isinstance(item, str) or not item:
            raise OresmeError(f"{what} must be the name of a wave, not {item!r}.")
        return _wave_name(item) if resolve_names else item

    def items():
        if not isinstance(value, (list, tuple)):
            raise OresmeError(f"{where} must be a list, not {value!r}.")
        if "length" in spec and len(value) != spec["length"]:
            raise OresmeError(f"{where} must have {spec['length']} items, not {len(value)}.")
        return list(value)

    if kind == "wave":
        return wave_name(value, where)
    if kind == "waves":
        return [wave_name(item, f"{where}[{index}]") for index, item in enumerate(items())]
    if kind in ("number", "integer"):
        return number(value, where)
    if kind == "numbers":
        return [number(item, f"{where}[{index}]") for index, item in enumerate(items())]
    if kind == "string":
        if not isinstance(value, str):
            raise OresmeError(f"{where} must be a string, not {value!r}.")
        return value
    if kind == "boolean":
        if not isinstance(value, (bool, np.bool_)):
            raise OresmeError(f"{where} must be True or False, not {value!r}.")
        return bool(value)
    # A choice: a string matches a string, a number a number.
    if isinstance(value, str) or _is_number(value):
        for choice in spec["choices"]:
            if isinstance(choice, str) == isinstance(value, str) and choice == value:
                return choice
    listed = ", ".join(_py_literal(choice) for choice in spec["choices"])
    raise OresmeError(f"{where} must be one of {listed}, not {value!r}.")


def _check_spec(action_id, name, spec):
    """A parameter's description, checked, with ``optional`` filled in."""
    where = f"{action_id}: parameter {name!r}"
    if not isinstance(name, str) or not name.isidentifier() or name.startswith("_"):
        raise OresmeError(f"{action_id}: {name!r} is not a parameter name (letters, digits and _).")
    if not isinstance(spec, dict):
        raise OresmeError(f"{where} must be described by a dict, such as {{'type': 'wave'}}.")
    unknown = sorted(set(spec) - _PARAM_KEYS)
    if unknown:
        raise OresmeError(f"{where}: unknown key {unknown[0]!r}. Keys: {', '.join(sorted(_PARAM_KEYS))}.")
    kind = spec.get("type")
    if kind not in _PARAM_TYPES:
        raise OresmeError(f"{where}: type must be one of {', '.join(_PARAM_TYPES)}, not {kind!r}.")
    checked = {"type": kind}
    for key in ("title", "description", "arg"):
        if key in spec:
            if not isinstance(spec[key], str) or not spec[key]:
                raise OresmeError(f"{where}: {key} must be a string.")
            checked[key] = spec[key]
    if "arg" in checked and not checked["arg"].isidentifier():
        raise OresmeError(f"{where}: arg must be the name of a parameter of the function.")
    if "choices" in spec or kind == "choice":
        choices = spec.get("choices")
        if kind != "choice":
            raise OresmeError(f"{where}: only a choice has choices.")
        if (
            not isinstance(choices, (list, tuple))
            or not choices
            or not all(isinstance(item, str) or _is_number(item) for item in choices)
            or len(set(choices)) != len(choices)
        ):
            raise OresmeError(f"{where}: choices must be a list of different strings or numbers.")
        checked["choices"] = [_plain(item) for item in choices]
    for key in ("min", "max"):
        if key in spec:
            if kind not in ("number", "integer", "numbers"):
                raise OresmeError(f"{where}: only numbers have {key}.")
            if not _is_number(spec[key]) or not math.isfinite(spec[key]):
                raise OresmeError(f"{where}: {key} must be a finite number.")
            checked[key] = _plain(spec[key])
    if "min" in checked and "max" in checked and checked["min"] > checked["max"]:
        raise OresmeError(f"{where}: min is above max.")
    if "length" in spec:
        if kind not in ("waves", "numbers"):
            raise OresmeError(f"{where}: only lists (waves, numbers) have a length.")
        if not _is_integer(spec["length"]) or spec["length"] < 0:
            raise OresmeError(f"{where}: length must be a whole number.")
        checked["length"] = int(spec["length"])
    optional = spec.get("optional", False)
    if not isinstance(optional, bool):
        raise OresmeError(f"{where}: optional must be True or False.")
    if "default" in spec:
        checked["default"] = _check_value(checked, spec["default"], f"{where}: default", False)
        optional = True
    checked["optional"] = optional
    return checked


def _check_signature(action_id, function, params):
    """Every argument must reach the function, and every parameter it needs must be described."""
    signature = inspect.signature(function)
    takes_any = any(item.kind is item.VAR_KEYWORD for item in signature.parameters.values())
    targets = {}
    for name, spec in params.items():
        targets.setdefault(spec.get("arg", name), []).append(name)
    for arg, names in targets.items():
        item = signature.parameters.get(arg)
        if (item is None and not takes_any) or (
            item is not None and item.kind not in (item.POSITIONAL_OR_KEYWORD, item.KEYWORD_ONLY)
        ):
            raise OresmeError(f"{action_id}: the function has no keyword parameter {arg!r}.")
        if len(names) > 1 and any(not params[name]["optional"] for name in names):
            raise OresmeError(
                f"{action_id}: {', '.join(names)} are all passed as {arg!r}, so each must be optional."
            )
        if item is None or item.default is item.empty:
            continue
        for name in names:
            if "default" in params[name] and params[name]["default"] != _plain(item.default):
                raise OresmeError(
                    f"{action_id}: the default of {name!r} is {params[name]['default']!r}, "
                    f"but the function's is {item.default!r}."
                )
    for arg, item in signature.parameters.items():
        if item.kind in (item.VAR_POSITIONAL, item.VAR_KEYWORD) or item.default is not item.empty:
            continue
        names = targets.get(arg, [])
        if not names or params[names[0]]["optional"]:
            raise OresmeError(f"{action_id}: the function needs {arg!r}; describe it as a required parameter.")


def action(id, *, version=1, title, params, description=None):
    """Register a function as an action: called by name, with arguments of known types.

    ::

        @op.action("lab.normalize", title="Normalize", params={
            "wave": {"type": "wave", "title": "Wave"},
            "to": {"type": "number", "default": 1.0, "min": 0},
        })
        def normalize(wave, to=1.0):
            return op.make(f"{wave.name}_norm", wave.data / np.nanmax(wave.data) * to)

    Panels, templates and plugins call actions with plain values (JSON)
    instead of Python code; from Python, ``op.invoke("lab.normalize",
    {"wave": "signal"})`` does the same. The arguments are checked against
    ``params`` before the function is called, and the call runs in an
    ``op.atomic()`` block, so a call that fails changes nothing.

    ``id`` is a lowercase dotted name such as ``"lab.normalize"``. Ids that
    start with ``core.`` are the application's own analyses, and ``plugin.``
    is kept for plugins: a procedure cannot register those. Registering the
    same id and version again replaces it, as running a procedure again
    does. A new ``version`` of an action can be registered beside the old
    one: a caller that names a version gets it, others get the highest.

    ``params`` maps each argument's name to a dict that describes it: its
    ``type``, and optionally a ``title``, a ``description``,
    ``optional=True``, and a ``default``, which makes it optional and must be
    the function's own default. The types are:

    - ``"wave"``: the name of an existing wave, passed as an ``op.Wave``;
    - ``"waves"``: a list of names of waves, passed as a list of ``op.Wave``;
    - ``"number"``, ``"integer"``: with ``min`` and ``max`` if wanted (inclusive);
    - ``"numbers"``: a list of numbers, with ``min``, ``max`` and ``length`` if wanted;
    - ``"string"``, ``"boolean"``;
    - ``"choice"``: one of ``choices``, a list of strings or numbers.

    An argument that is left out is not passed, so the function's default
    applies. None (null) is never a value: leave the argument out instead.
    ``arg`` passes an argument as the parameter of that name. Two optional
    arguments may be passed as the same parameter (a number of peaks or
    their positions, say); at most one of them can then be given.

    Returns the function unchanged.
    """

    def register(function):
        _register_action(id, version, title, params, description, function)
        return function

    return register


def _register_action(id, version, title, params, description, function):
    global _actions_revision
    if not isinstance(id, str) or not _ACTION_ID.fullmatch(id):
        raise OresmeError(
            f"{id!r} is not an action id: use lowercase dotted names such as 'lab.normalize'."
        )
    namespace = id.split(".", 1)[0]
    if namespace in _RESERVED_NAMESPACES and _registering_in != namespace:
        owner = "plugins" if namespace == "plugin" else "the application"
        raise OresmeError(f"Action ids starting with {namespace}. are kept for {owner}.")
    if not _is_integer(version) or version < 1:
        raise OresmeError(f"{id}: version must be a whole number from 1, not {version!r}.")
    if not isinstance(title, str) or not title:
        raise OresmeError(f"{id}: title must be a string.")
    if description is not None and not isinstance(description, str):
        raise OresmeError(f"{id}: description must be a string or None.")
    if not isinstance(params, dict):
        raise OresmeError(f"{id}: params must be a dict of name: description.")
    if not callable(function):
        raise OresmeError(f"{id}: only a function can be registered as an action.")
    checked = {name: _check_spec(id, name, spec) for name, spec in params.items()}
    _check_signature(id, function, checked)
    _actions.setdefault(id, {})[int(version)] = _Action(
        id, int(version), title, description, checked, function
    )
    _actions_revision += 1


def actions():
    """The registered actions, as plain dicts: id, version, title, description and params.

    Every version of each action is listed, ordered by id and then version.
    ``params`` maps each argument's name to its description (see ``op.action``),
    with ``optional`` always given.
    """
    return [_actions[id][version].spec() for id in sorted(_actions) for version in sorted(_actions[id])]


def _find_action(id, version):
    if not isinstance(id, str) or id not in _actions:
        raise OresmeError(f"No action named {id!r}.")
    versions = _actions[id]
    if version is None:
        return versions[max(versions)]
    if not _is_integer(version) or int(version) not in versions:
        known = ", ".join(str(number) for number in sorted(versions))
        raise OresmeError(f"{id} has no version {version!r} (it has {known}).")
    return versions[int(version)]


def _prepare_action(id, args, version=None):
    """Check a call of an action without making it.

    Returns the action, the arguments as plain JSON and the keyword arguments
    to call its function with. Nothing in the experiment changes: waves are
    only looked up.
    """
    found = _find_action(id, version)
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise OresmeError(f"The arguments of {found.id} are a dict of name: value, not {args!r}.")
    for name in args:
        if name not in found.params:
            taken = ", ".join(found.params) or "nothing"
            raise OresmeError(f"{found.id} takes no argument {name!r}. It takes: {taken}.")
    missing = [name for name, spec in found.params.items() if not spec["optional"] and name not in args]
    if missing:
        raise OresmeError(f"{found.id} needs {', '.join(repr(name) for name in missing)}.")
    given = {
        name: _check_value(found.params[name], value, f"{found.id}: {name}")
        for name, value in args.items()
    }
    passed = {}
    for name, value in given.items():
        arg = found.params[name].get("arg", name)
        if arg in passed:
            other = next(item for item in given if found.params[item].get("arg", item) == arg)
            raise OresmeError(f"{found.id}: give {other!r} or {name!r}, not both.")
        passed[arg] = value
    # Only now, with every argument right, are the waves looked up.
    for name, value in given.items():
        kind = found.params[name]["type"]
        if kind not in ("wave", "waves"):
            continue
        try:
            resolved = wave(value) if kind == "wave" else [wave(item) for item in value]
        except OresmeError as error:
            raise OresmeError(f"{found.id}: {name}: {error}") from None
        passed[found.params[name].get("arg", name)] = resolved
    return found, given, passed


def invoke(id, args=None, *, version=None):
    """Call an action by its id with a dict of plain values, as the application does.

    ::

        r = op.invoke("core.fit", {"function": "gauss", "y": "signal"})

    The arguments are checked against the action's parameters first (see
    ``op.action``); a call that is refused raises ``OresmeError`` and does
    nothing. Waves may be given by name or as ``op.Wave``. ``version`` picks
    a version of the action, the highest by default. The call runs in an
    ``op.atomic()`` block and returns what the function returns.
    """
    found, _, passed = _prepare_action(id, args, version)
    with atomic():
        return found.function(**passed)


def _py_literal(value):
    """Python source for a plain (JSON) value."""
    if value is None or isinstance(value, bool):
        return repr(value)
    if isinstance(value, str):
        # A JSON string is a Python string literal too.
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_py_literal(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{_py_literal(key)}: {_py_literal(item)}" for key, item in value.items()) + "}"
    raise TypeError(f"Not a plain value: {value!r}")


def _action_code(found, given):
    """The Python that does what a call of an action with these checked arguments does.

    An action of this module is written as a call of its function, with the
    arguments in order as far as they go and the rest by keyword, as a person
    would write it: ``op.fit("gauss", op.wave("signal"), quiet=True)``. Any
    other action is written as a call of ``op.invoke``.
    """
    function = found.function
    name = getattr(function, "__name__", "")
    if name not in __all__ or globals().get(name) is not function:
        return f"op.invoke({_py_literal(found.id)}, {_py_literal(given)}, version={found.version})"

    def source(key, value):
        kind = found.params[key]["type"]
        if kind == "wave":
            return f"op.wave({_py_literal(value)})"
        if kind == "waves":
            return "[" + ", ".join(f"op.wave({_py_literal(item)})" for item in value) + "]"
        return _py_literal(value)

    by_arg = {found.params[key].get("arg", key): source(key, value) for key, value in given.items()}
    parts = []
    in_order = True
    for arg, item in inspect.signature(function).parameters.items():
        if arg not in by_arg:
            in_order = False
            continue
        if in_order and item.kind is item.POSITIONAL_OR_KEYWORD:
            parts.append(by_arg.pop(arg))
        else:
            in_order = False
            parts.append(f"{arg}={by_arg.pop(arg)}")
    # What the function takes through **kwargs, in the order given.
    parts.extend(f"{arg}={value}" for arg, value in by_arg.items())
    return f"op.{name}({', '.join(parts)})"


def _result_json(value):
    """What an action returned, as plain JSON for the application.

    Numbers, strings, lists and dicts stay as they are (NaN and infinities
    become None) and NumPy arrays become lists. A wave becomes ``{"wave":
    name}``, a graph ``{"graph": name}``, a table ``{"table": name}`` and a
    page layout ``{"layout": name}``. The results of analyses say what they
    hold through a ``_json()`` method of their own. Anything else becomes
    ``{"repr": text}``.
    """
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, numbers.Integral):
        return int(value)
    if isinstance(value, numbers.Real):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, Wave):
        return {"wave": value.name}
    for kind, key in ((Graph, "graph"), (Table, "table"), (Layout, "layout")):
        if isinstance(value, kind):
            return {key: value.name}
    if callable(getattr(value, "_json", None)):
        return _result_json(value._json())
    if isinstance(value, np.ndarray):
        return _result_json(value.tolist())
    if isinstance(value, dict):
        return {str(key): _result_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_result_json(item) for item in value]
    return {"repr": repr(value)}


class GraphTemplate:
    """A graph template: a graph kept with its waves taken out, to make the
    same graph of other data.

    Where the graph had a wave, the template has a slot, named after what
    the wave was for: ``"y"`` and ``"x"``, ``"yerr"`` and ``"xerr"`` for
    error bars, ``"color"`` for a color wave and ``"z"`` for an image or
    contours, numbered by trace (``"y1"``, ``"y2"``) when there are several.
    ``slots`` lists them. Make a graph by giving a wave for each slot::

        t = op.graph_template(op.graph("Graph0"), "IV")
        t.make(y="s2_I", x="s2_V")

    Text in annotations and axis labels can name what fills a slot:
    ``{y.name}`` and ``{y.unit}`` are the name and the unit of the wave in
    slot ``y``. Where the graph's text named one of its waves, or a unit
    in parentheses (``"Current (A)"``), the template has such a reference
    instead, so a graph of another sample shows that sample's name and unit.

    ``data`` is what the template holds, as a dict: ``"style"`` (the look
    and size, as a ``Style`` holds them), ``"slots"`` (``name``, ``role``
    and the units of the wave it was made from), ``"traces"``, ``"images"``,
    ``"contours"``, ``"axes"`` and ``"annotations"`` as in a graph, with
    slot names where the graph has wave names. ``op.set_graph_template``
    defines one from such a dict.
    """

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    def _info(self):
        return _call("graphTemplateInfo", {"name": self._name})[0]

    @property
    def data(self):
        """What the template holds, as a dict (a copy: change it with ``op.set_graph_template``)."""
        return _keys(self._info(), _snake)

    @property
    def slots(self):
        """The names of the slots, in the order of the graph."""
        return [slot["name"] for slot in self._info()["slots"]]

    def make(self, /, name=None, **slots):
        """Make a graph of the waves given for the slots, and return it.

        Give a wave (a Wave or a name) for each slot:
        ``t.make(y=current, x=voltage)``. A slot of X, error bars or a color
        wave may be left out; the graph then goes without it. Lists make
        several graphs, one for each item, and return a list of them:
        ``t.make(y=[a, b, c], x=voltage)`` makes three graphs, all against
        ``voltage``. ``name`` names the graph (a list, the
        graphs); left out, names are chosen.

        Where a wave's unit differs from that of the wave the template was
        made from, a warning says so, and the graph is made all the same.
        All the graphs are made or, if one cannot be, none; and they are one
        step to undo.
        """
        listed = [value for value in [*slots.values(), name] if isinstance(value, (list, tuple))]
        many = bool(listed)
        if many:
            counts = {len(value) for value in listed}
            if len(counts) != 1:
                raise OresmeError(
                    "Lists given for the slots must all have one item for each graph."
                )
            count = counts.pop()
            columns = {
                slot: list(value) if isinstance(value, (list, tuple)) else [value] * count
                for slot, value in slots.items()
            }
            samples = [
                {
                    slot: _slot_wave(column[index])
                    for slot, column in columns.items()
                    if column[index] is not None
                }
                for index in range(count)
            ]
            names = None if name is None else [str(item) for item in name]
        else:
            samples = [
                {slot: _slot_wave(value) for slot, value in slots.items() if value is not None}
            ]
            names = None if name is None else [str(name)]
        found = _call("graphTemplateWarnings", {"name": self._name, "samples": samples})[0]
        before = set(_call("listWindows", {"kind": "graph"})[0])
        command = {"op": "makeGraphs", "template": self._name, "samples": samples}
        if names is not None:
            command["names"] = names
        _dispatch(command)
        for message in found:
            warnings.warn(message, stacklevel=2)
        made = [
            Graph(item) for item in _call("listWindows", {"kind": "graph"})[0] if item not in before
        ]
        return made if many else made[0]

    def rename(self, new_name):
        """Give the template another name. Returns self."""
        _dispatch({"op": "renameGraphTemplate", "name": self._name, "newName": new_name})
        self._name = new_name
        return self

    def remove(self):
        """Delete the template. Graphs made from it stay as they are."""
        _dispatch({"op": "removeGraphTemplate", "name": self._name})

    def __repr__(self):
        return f"GraphTemplate({self._name!r})"


def _slot_wave(obj):
    """The name of the wave given for a slot: a Wave or a name."""
    if isinstance(obj, Wave):
        return obj.name
    if isinstance(obj, str):
        return obj[5:] if obj.startswith("root:") else obj
    raise TypeError(
        f"A slot takes a wave or a wave name, not {type(obj).__name__}. "
        "Make a wave of the data first."
    )


def graph_templates():
    """Every graph template of the experiment."""
    return [GraphTemplate(name) for name in _call("listGraphTemplates")[0]]


def graph_template(source, name=None, fixed=()):
    """A graph template: the one named ``source``, or one made from a graph.

    ``op.graph_template("IV")`` is the template named IV.
    ``op.graph_template(g, "IV")`` keeps the graph ``g`` (a Graph or a
    graph name) as a template named IV and returns it; see
    ``Graph.save_template`` for ``fixed``.
    """
    if name is None:
        if isinstance(source, GraphTemplate):
            return source
        if source not in _call("listGraphTemplates")[0]:
            raise OresmeError(f"No graph template named {source!r}.")
        return GraphTemplate(source)
    graph_ = source if isinstance(source, Graph) else graph(source)
    return graph_.save_template(name, fixed=fixed)


def set_graph_template(name, data):
    """Define a graph template from a dict (see ``GraphTemplate``) or copy another; returns it.

    A template of that name is replaced. What the dict leaves out is as in a
    new graph; unknown keys, bad values and references to slots or axes the
    template does not have are refused.
    """
    if isinstance(data, GraphTemplate):
        data = data.data
    _dispatch({"op": "setGraphTemplate", "name": name, "template": _keys(data, _camel)})
    return GraphTemplate(name)


# --- Panels ------------------------------------------------------------------
#
# A panel is a window of controls: headings, text, fields, pickers and
# buttons. A button calls an action with the values of the panel's controls;
# it holds the action's id and its arguments, never code.


def control(name):
    """A control of a panel, given as an argument of a button.

    ::

        p.button("run", "Fit", action="core.fit",
                 args={"function": op.control("model"), "y": op.control("target")})

    When the button is pressed, the argument is the value the control has
    then. It is the dict ``{"$control": name}``, which is how a panel keeps it.
    """
    return {"$control": str(name)}


def _panel_data(value):
    """Plain data for a panel: waves as their names, tuples as lists, at any depth."""
    if isinstance(value, Wave):
        return value.name
    if isinstance(value, dict):
        return {str(key): _panel_data(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_panel_data(item) for item in value]
    return _plain(value)


class Control:
    """A control of a panel: a heading, a paragraph of text, a field, a
    picker or a button.

    ``value`` is what a field or picker holds (the name of the wave, for a
    wave picker) and ``data`` all of its properties, as the panel keeps them.
    ``set(...)`` changes properties: ``label``, ``inline`` (on the line of
    the control before it), and those of its kind, as the panel's methods
    that add controls take them; ``name`` renames it, and the buttons that
    pass its value follow.
    """

    def __init__(self, panel, name):
        self._panel = panel
        self._name = name

    @property
    def name(self):
        return self._name

    @property
    def panel(self):
        return self._panel

    def _get(self):
        for item in self._panel._get()["controls"]:
            if item["name"] == self._name:
                return item
        raise OresmeError(f"{self._panel.name} has no control named {self._name!r}.")

    @property
    def kind(self):
        return self._get()["kind"]

    @property
    def data(self):
        return self._get()

    @property
    def label(self):
        return self._get()["label"]

    @label.setter
    def label(self, value):
        self.set(label=value)

    @property
    def value(self):
        info = self._get()
        if "value" not in info:
            raise OresmeError(f"{self._name} is a {info['kind']}, which has no value.")
        return info["value"]

    @value.setter
    def value(self, value):
        self._panel[self._name] = value

    def set(self, **props):
        """Change several properties at once. Returns self."""
        if props:
            _dispatch(
                {
                    "op": "modifyControl",
                    "panel": self._panel.name,
                    "control": self._name,
                    "props": _panel_data(props),
                }
            )
            if "name" in props:
                self._name = str(props["name"])
        return self

    def move(self, index):
        """Put the control at a place in the panel, counted from 0 (the top)."""
        _dispatch(
            {"op": "moveControl", "panel": self._panel.name, "control": self._name, "to": _plain(index)}
        )
        return self

    def press(self):
        """Press the button: see ``Panel.press``."""
        return self._panel.press(self._name)

    def remove(self):
        _dispatch({"op": "removeControl", "panel": self._panel.name, "control": self._name})

    def __repr__(self):
        return f"Control({self._name!r} of {self._panel.name})"


class Panel:
    """A panel: controls that run analyses, in a window of the experiment.

    ::

        p = op.panel("quick_fit", title="Quick Fit")
        p.wave("target", label="Spectrum", dims=1)
        p.choice("model", ["gauss", "lor"], label="Model")
        p.button("run", "Fit", action="core.fit",
                 args={"function": op.control("model"), "y": op.control("target")})
        p["model"] = "lor"

    The methods that add controls take the control's ``name`` first, unique
    in the panel. When the panel has a control of that name and kind
    already, they change it instead and keep its value, so a procedure that
    builds a panel can run again. ``value`` is the value a new control
    starts with. ``inline=True`` puts a control on the line of the one
    before it; so does ``with p.row():`` for the controls added in it.

    ``p["name"]`` reads and sets the value of a control; the values are part
    of the experiment, saved with it and undone like any other change.
    A button calls an action (see ``op.action``) with plain values and the
    values of controls (``op.control``). To have a button run your own
    Python, register the function as an action in a procedure and name it.
    """

    def __init__(self, name):
        self._name = name
        # How many controls a `with p.row():` block has added, or None outside one.
        self._row = None

    @property
    def name(self):
        return self._name

    def _get(self):
        return _call("panelInfo", {"name": self._name})[0]

    @property
    def title(self):
        return self._get()["title"]

    @title.setter
    def title(self, value):
        self.set(title=value)

    def set(self, *, title=None):
        """Change the panel's title (what its window shows; its name when empty). Returns self."""
        if title is not None:
            _dispatch({"op": "modifyPanel", "panel": self._name, "props": {"title": str(title)}})
        return self

    @property
    def data(self):
        """The panel as plain data: its title and controls, as ``op.set_panel`` takes them."""
        info = self._get()
        return {"title": info["title"], "controls": info["controls"]}

    @property
    def controls(self):
        return [Control(self, item["name"]) for item in self._get()["controls"]]

    def control(self, name):
        names = [item["name"] for item in self._get()["controls"]]
        if name not in names:
            raise OresmeError(f"{self._name} has no control named {name!r}.")
        return Control(self, name)

    def __getitem__(self, name):
        return self.control(name).value

    def __setitem__(self, name, value):
        _dispatch(
            {"op": "setControlValue", "panel": self._name, "control": name, "value": _panel_data(value)}
        )

    def __contains__(self, name):
        return any(item["name"] == name for item in self._get()["controls"])

    def _add(self, kind, name, props):
        props = {key: _panel_data(value) for key, value in props.items() if value is not None}
        if self._row is not None:
            props.setdefault("inline", self._row > 0)
            self._row += 1
        for item in self._get()["controls"]:
            if item["name"] != name:
                continue
            if item["kind"] != kind:
                raise OresmeError(f"{self._name} already has a {item['kind']} named {name!r}.")
            # Run again, the panel keeps the value the user has given the control.
            props.pop("value", None)
            if props:
                _dispatch({"op": "modifyControl", "panel": self._name, "control": name, "props": props})
            return Control(self, name)
        _dispatch({"op": "addControl", "panel": self._name, "kind": kind, "name": name, "props": props})
        return Control(self, name)

    def heading(self, name, label=None, *, inline=None):
        """A heading: ``label`` in bold."""
        return self._add("heading", name, {"label": label, "inline": inline})

    def text(self, name, label=None, *, inline=None):
        """A paragraph of text: ``label``, which may have several lines."""
        return self._add("text", name, {"label": label, "inline": inline})

    def number(self, name, label=None, *, value=None, min=None, max=None, step=None, inline=None):
        """A field for a number, from ``min`` to ``max`` (inclusive) if given;
        ``step`` is how much the arrows change it.
        """
        props = {"label": label, "value": value, "min": min, "max": max, "step": step, "inline": inline}
        return self._add("number", name, props)

    def string(self, name, label=None, *, value=None, inline=None):
        """A field for text."""
        return self._add("string", name, {"label": label, "value": value, "inline": inline})

    def checkbox(self, name, label=None, *, value=None, inline=None):
        """A checkbox: its value is True or False."""
        return self._add("checkbox", name, {"label": label, "value": value, "inline": inline})

    def choice(self, name, options, *, value=None, label=None, inline=None):
        """A menu of ``options`` (texts or numbers); it starts at the first unless ``value`` says."""
        props = {"label": label, "options": list(options), "value": value, "inline": inline}
        return self._add("choice", name, props)

    #: The same as ``choice``.
    select = choice

    def wave(self, name, label=None, *, value=None, dims=None, filter=None, inline=None):
        """A wave picker: its value is the name of the wave chosen.

        ``dims`` lists only waves of that many dimensions; ``filter`` only
        those whose names contain it, or match it as a pattern with ``*``
        (``"*_I"``). The picker follows the wave when it is renamed; when
        the wave is killed, the name stays and is shown as missing.
        """
        props = {"label": label, "value": value, "dims": dims, "filter": filter, "inline": inline}
        return self._add("wave", name, props)

    def button(self, name, label=None, *, action, args=None, version=None, inline=None):
        """A button that calls the action ``action`` with ``args`` when pressed.

        Each argument is a plain value (text, a number, True or False, a
        list) or ``op.control(name)``, the value of a control of the panel
        at the time of the press. ``version`` calls that version of the
        action rather than the highest.
        """
        props = {"label": label, "action": action, "args": args or {}, "version": version, "inline": inline}
        return self._add("button", name, props)

    @contextlib.contextmanager
    def row(self):
        """Put the controls added in the block on one line."""
        before = self._row
        self._row = 0
        try:
            yield self
        finally:
            self._row = before

    def press(self, name):
        """Press a button: call its action with the values the panel has now, as a click does.

        Returns what the action returns. Raises ``OresmeError`` when a value
        is missing (no wave chosen, say) or the action refuses the call.
        """
        call = _call("panelCall", {"panel": self._name, "button": name})[0]
        return invoke(call["action"], call["args"], version=call["version"])

    def kill(self):
        kill_window(self._name)

    def __repr__(self):
        return f"Panel({self._name!r})"


def panels():
    """Every panel of the experiment."""
    return [Panel(name) for name in _call("listWindows", {"kind": "panel"})[0]]


def panel(name=None, title=None):
    """The panel named ``name``, made (with a window) if there is none; with no name, the frontmost.

    ``title`` gives it a title, as its window shows it.
    """
    names = _call("listWindows", {"kind": "panel"})[0]
    if name is None:
        if not names:
            raise OresmeError("There are no panels.")
        return Panel(names[-1])
    if name not in names:
        return new_panel(name, title=title)
    found = Panel(name)
    if title is not None and found.title != title:
        found.title = title
    return found


def new_panel(name=None, title=None):
    """Make an empty panel with a window. Without a name, one is chosen (Panel0, ...)."""
    command = {"op": "newPanel"}
    if name is not None:
        command["name"] = name
    if title is not None:
        command["title"] = str(title)
    return Panel(_dispatch(command))


def set_panel(name, data):
    """Give the panel ``name`` a title and controls from a dict (``p.data``, or a file
    exported from a panel window), making it if there is none. Returns it.

    ``data`` is ``{"title": ..., "controls": [...]}``, where each control is
    a dict of its ``kind``, ``name`` and properties, as ``Control.data``
    gives them. Unknown keys and bad values are refused.
    """
    if isinstance(data, Panel):
        data = data.data
    _dispatch({"op": "setPanel", "name": name, "panel": _panel_data(data)})
    return Panel(name)


def _input(prompt=""):
    """Ask for a line of text in the command window."""
    text, _ = _call("input", {"prompt": str(prompt)})
    if text is None:
        raise KeyboardInterrupt
    return text


from _oresme_analysis import *  # noqa: E402,F401,F403
from _oresme_analysis import __all__ as _analysis_all  # noqa: E402

__all__ += _analysis_all
