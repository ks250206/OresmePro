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
"""

import json
import re

import numpy as np

import _oresme_js

__all__ = [
    "OresmeError",
    "Wave",
    "Graph",
    "Trace",
    "Axis",
    "Annotation",
    "Table",
    "make",
    "wave",
    "waves",
    "exists",
    "kill",
    "display",
    "edit",
    "graph",
    "graphs",
    "table",
    "tables",
    "kill_window",
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


def _camel(name):
    return re.sub(r"_([a-z])", lambda match: match.group(1).upper(), name)


def _as_array(values):
    array = np.asarray(values, dtype=np.float64)
    if array.ndim == 0:
        array = array.reshape(1)
    if array.ndim != 1:
        raise OresmeError(f"Waves are one-dimensional; got an array of shape {array.shape}.")
    return array


def _wave_name(obj):
    """Name of an existing wave, given a Wave, a name, or data to store."""
    if isinstance(obj, Wave):
        return obj.name
    if isinstance(obj, str):
        return obj
    if isinstance(obj, (np.ndarray, list, tuple)):
        name = _call("uniqueName", {"base": "wave"})[0]
        make(name, obj)
        return name
    raise TypeError(f"Expected a wave, a wave name or an array, not {type(obj).__name__}.")


_data_cache = {}


def _wave_data(name):
    cached = _data_cache.get(name)
    info, array = _call("waveData", {"name": name, "rev": cached[0] if cached else None})
    if array is None:
        return cached[1]
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


class Wave(np.lib.mixins.NDArrayOperatorsMixin):
    """A named array with X scaling, stored in the application.

    Arithmetic and NumPy functions work on a wave directly and give ordinary
    arrays: ``np.sqrt(w)``, ``w * 2``, ``w.data.mean()``.
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
        _dispatch({"op": "setWaveData", "name": self._name}, _as_array(values))

    @property
    def x(self):
        """The X value of every point, from the wave's scaling."""
        info = self._info()
        return info["x0"] + info["dx"] * np.arange(info["n"])

    @property
    def x0(self):
        return self._info()["x0"]

    @x0.setter
    def x0(self, value):
        self.set_scale(x0=value)

    @property
    def dx(self):
        return self._info()["dx"]

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

    def set_scale(self, x0=None, dx=None, unit=None):
        """Set the X scaling: X of point 0, X step per point, and X unit."""
        command = {"op": "setWaveScale", "name": self._name}
        if x0 is not None:
            command["x0"] = float(x0)
        if dx is not None:
            command["dx"] = float(dx)
        if unit is not None:
            command["xUnit"] = str(unit)
        _dispatch(command)
        return self

    def rename(self, new_name):
        _dispatch({"op": "renameWave", "name": self._name, "newName": new_name})
        _data_cache.pop(self._name, None)
        self._name = new_name
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
        return self._info()["n"]

    def __iter__(self):
        return iter(self.data)

    def __getitem__(self, key):
        return self.data[key]

    def __setitem__(self, key, value):
        count = len(self)
        if isinstance(key, (int, np.integer)):
            index = int(key) + count if key < 0 else int(key)
            if not 0 <= index < count:
                raise IndexError(f"Point {key} is out of range for a wave of {count} points.")
            _dispatch(
                {"op": "setWavePoints", "name": self._name, "start": index},
                np.array([value], dtype=np.float64),
            )
            return
        if isinstance(key, slice):
            start, stop, step = key.indices(count)
            if step == 1 and stop > start:
                values = np.empty(stop - start, dtype=np.float64)
                values[:] = value
                _dispatch({"op": "setWavePoints", "name": self._name, "start": start}, values)
                return
        values = self.data.copy()
        values[key] = value
        self.data = values

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

    def __repr__(self):
        try:
            info = self._info()
        except OresmeError:
            return f"Wave({self._name!r}) <missing>"
        scale = f", x0={info['x0']:g}, dx={info['dx']:g}"
        if info["xUnit"]:
            scale += f" {info['xUnit']}"
        unit = f", unit={info['unit']!r}" if info["unit"] else ""
        return f"Wave({self._name!r}, n={info['n']}{scale}{unit})"


class Trace(_Props):
    """One curve in a graph."""

    _props = (
        "mode",
        "color",
        "line_size",
        "line_style",
        "marker",
        "marker_size",
        "marker_fill",
        "hidden",
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
    """One axis of a graph: "left", "bottom", "right" or "top"."""

    _props = ("label", "min", "max", "log", "mirror", "ticks", "minor", "grid")

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

    def __repr__(self):
        return f"Axis({self._name!r} of {self._graph.name})"


class Annotation(_Props):
    """A legend or text box in a graph."""

    _props = ("text", "anchor", "frame")

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


class Graph(_Props):
    """A graph window."""

    _props = ("font_size", "font_family")

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
        """Add traces. ``axis`` is "left" or "right"; ``haxis`` is "bottom" or "top"."""
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
        if name not in ("left", "bottom", "right", "top"):
            raise OresmeError('An axis is "left", "bottom", "right" or "top".')
        return Axis(self, name)

    left = property(lambda self: Axis(self, "left"))
    bottom = property(lambda self: Axis(self, "bottom"))
    right = property(lambda self: Axis(self, "right"))
    top = property(lambda self: Axis(self, "top"))

    def autoscale(self):
        """Autoscale every axis."""
        for name in ("left", "bottom", "right", "top"):
            Axis(self, name).autoscale()
        return self

    def legend(self, text="", *, anchor="RT", frame=True):
        """Add a legend. With no text it lists every trace.

        In custom text, ``\\s(traceName)`` draws that trace's symbol.
        ``anchor`` is two letters: L/M/R then T/C/B.
        """
        return self._annotate("legend", text, anchor, frame)

    def textbox(self, text, *, anchor="RT", frame=True):
        """Add a text box. ``^{...}`` and ``_{...}`` give super- and subscripts."""
        return self._annotate("text", text, anchor, frame)

    def _annotate(self, kind, text, anchor, frame):
        name = _dispatch(
            {
                "op": "addAnnotation",
                "graph": self._name,
                "kind": kind,
                "text": text,
                "anchor": anchor,
                "frame": frame,
            }
        )
        return Annotation(self, name)

    @property
    def annotations(self):
        return [Annotation(self, item["name"]) for item in self._info()["annotations"]]

    def annotation(self, name):
        return Annotation(self, name)

    def svg(self, width=None, height=None):
        """The graph as an SVG document; by default at its window's size."""
        return _call("graphSvg", {"name": self._name, "width": width, "height": height})[0]

    def kill(self):
        kill_window(self._name)

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {"text/plain": repr(self), "image/svg+xml": self.svg()}

    def __repr__(self):
        return f"Graph({self._name!r})"


class Table:
    """A table window showing waves as columns."""

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    @property
    def columns(self):
        return [Wave(name) for name in _call("tableInfo", {"name": self._name})[0]["columns"]]

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


def make(name, data=None, *, n=128, x0=None, dx=None, x_unit=None, unit=None, note=None,
         overwrite=True):
    """Create a wave (or replace an existing one) and return it.

    Without ``data`` the wave has ``n`` zeros. An existing wave keeps its
    scaling and units unless new ones are given.
    """
    command = {"op": "makeWave", "name": name, "overwrite": bool(overwrite)}
    if x0 is not None:
        command["x0"] = float(x0)
    if dx is not None:
        command["dx"] = float(dx)
    if x_unit is not None:
        command["xUnit"] = str(x_unit)
    if unit is not None:
        command["unit"] = str(unit)
    if note is not None:
        command["note"] = str(note)
    values = np.zeros(int(n)) if data is None else _as_array(data)
    _dispatch(command, values)
    return Wave(name)


def wave(name):
    """The existing wave with this name."""
    _call("waveInfo", {"name": name})
    return Wave(name)


def waves():
    """Every wave, in creation order."""
    return [Wave(name) for name in _call("listWaves")[0]]


def exists(name):
    return name in _call("listWaves")[0]


def kill(*waves_):
    """Delete waves. A wave shown in a graph or table cannot be killed."""
    names = [item.name if isinstance(item, Wave) else item for item in waves_]
    _dispatch({"op": "killWaves", "names": names})
    for name in names:
        _data_cache.pop(name, None)


def display(*y, x=None, name=None):
    """Make a new graph of the given waves (or arrays) and return it.

    ``x`` plots them against an X wave instead of their own X scaling.
    """
    command = {
        "op": "display",
        "y": [_wave_name(item) for item in y],
        "x": None if x is None else _wave_name(x),
    }
    if name is not None:
        command["name"] = name
    return Graph(_dispatch(command))


def edit(*waves_, name=None):
    """Make a new table of the given waves and return it."""
    command = {"op": "edit", "waves": [_wave_name(item) for item in waves_]}
    if name is not None:
        command["name"] = name
    return Table(_dispatch(command))


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


def kill_window(name):
    """Close a graph or table."""
    _dispatch({"op": "killWindow", "name": name})
