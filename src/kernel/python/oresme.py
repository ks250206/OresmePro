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
    "display",
    "image",
    "contour",
    "new_folder",
    "folder",
    "folders",
    "edit",
    "graph",
    "graphs",
    "table",
    "tables",
    "kill_window",
    "Procedure",
    "new_procedure",
    "procedure",
    "procedures",
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


def _as_array(values):
    array = np.asarray(values, dtype=np.float64)
    if array.ndim == 0:
        array = array.reshape(1)
    if array.ndim > 4:
        raise OresmeError(f"Waves have at most 4 dimensions; got shape {array.shape}.")
    return array


def _content(command, values):
    """Add the values to a command: text goes in the command, numbers alongside it."""
    if _is_text(values):
        items = [values] if isinstance(values, str) else [str(item) for item in values]
        command["text"] = items
        return None
    if isinstance(values, np.ndarray) and values.dtype.kind == "M":
        # Dates are stored as seconds since 1970-01-01 UTC, with the unit "dat".
        values = values.astype("datetime64[ms]").astype(np.float64) / 1000.0
        command.setdefault("unit", "dat")
    array = _as_array(values)
    command["shape"] = list(array.shape)
    return array.ravel()


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
        _dispatch(command, _content(command, values))

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
        if len(info["shape"]) > 1:
            values = self.data.copy()
            values[key] = value
            self.data = values
            return
        # Writing just past the end grows a 1-D wave, as typing below its last point in a table does.
        if isinstance(key, (int, np.integer)):
            index = int(key) + count if key < 0 else int(key)
            if not 0 <= index <= count:
                raise IndexError(f"Point {key} is out of range for a wave of {count} points.")
            _dispatch(
                {"op": "setWavePoints", "name": self._name, "start": index},
                np.array([value], dtype=np.float64),
            )
            return
        if isinstance(key, slice) and key.step in (None, 1):
            start, stop, _ = key.indices(count)
            if key.stop is not None and key.stop > count and (key.start or 0) <= count:
                stop = int(key.stop)
            if stop > start:
                values = np.empty(stop - start, dtype=np.float64)
                values[:] = value
                _dispatch({"op": "setWavePoints", "name": self._name, "start": start}, values)
                return
        values = self.data.copy()
        values[key] = value
        self.data = values

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
    to ``color_max``, or the wave's own range).
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
    """

    _props = (
        "label",
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


class Image(_Props):
    """A 2-D wave shown as an image in a graph."""

    _props = ("color_table", "z_min", "z_max", "reverse", "layer", "chunk")

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


def make(name, data=None, *, n=128, x0=None, dx=None, x_unit=None, y0=None, dy=None,
         y_unit=None, unit=None, note=None, overwrite=True):
    """Create a wave (or replace an existing one) and return it.

    ``data`` may be numbers with up to 4 dimensions, or a list of strings for
    a text wave. Without ``data`` the wave has ``n`` zeros. An existing wave
    keeps its scaling and units unless new ones are given.
    """
    command = {"op": "makeWave", "name": name, "overwrite": bool(overwrite)}
    for key, value in (("x0", x0), ("dx", dx), ("y0", y0), ("dy", dy)):
        if value is not None:
            command[key] = float(value)
    for key, value in (("xUnit", x_unit), ("yUnit", y_unit), ("unit", unit), ("note", note)):
        if value is not None:
            command[key] = str(value)
    values = np.zeros(int(n)) if data is None else data
    return Wave(_dispatch(command, _content(command, values)))


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


def display(*y, x=None, name=None):
    """Make a new graph of the given waves (or arrays) and return it.

    ``x`` plots them against an X wave instead of their own X scaling. A text
    wave as ``x`` makes a category plot (try ``mode="bars"`` on the traces).
    """
    command = {
        "op": "display",
        "y": [_wave_name(item) for item in y],
        "x": None if x is None else _wave_name(x),
    }
    if name is not None:
        command["name"] = name
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


def kill_window(name):
    """Close a graph, table or procedure window."""
    _dispatch({"op": "killWindow", "name": name})


def _input(prompt=""):
    """Ask for a line of text in the command window."""
    text, _ = _call("input", {"prompt": str(prompt)})
    if text is None:
        raise KeyboardInterrupt
    return text


from _oresme_analysis import *  # noqa: E402,F401,F403
from _oresme_analysis import __all__ as _analysis_all  # noqa: E402

__all__ += _analysis_all
