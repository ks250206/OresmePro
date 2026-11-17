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
import importlib
import inspect
import io
import json
import math
import numbers
import os
import re
import sys
import warnings

import numpy as np

import _oresme_js

__all__ = [
    "OresmeError",
    "InvalidArgumentError",
    "NotFoundError",
    "AlreadyExistsError",
    "InUseError",
    "ConflictError",
    "UnsupportedError",
    "PluginFailedError",
    "InternalError",
    "atomic",
    "action",
    "actions",
    "invoke",
    "Wave",
    "Graph",
    "Trace",
    "Axis",
    "Annotation",
    "Drawing",
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
    "load_parquet",
    "load_hdf5",
    "graph",
    "graphs",
    "table",
    "tables",
    "kill_window",
    "link_graphs",
    "unlink_graphs",
    "set_attributes",
    "attributes",
    "Procedure",
    "new_procedure",
    "Note",
    "new_note",
    "note",
    "notes",
    "close_window",
    "reopen_window",
    "rename_window",
    "windows",
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
    "Length",
    "pt",
    "cm",
    "inch",
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
    "Template",
    "template",
    "templates",
    "set_template",
    "Run",
    "run",
    "runs",
    "Panel",
    "Control",
    "panel",
    "panels",
    "new_panel",
    "set_panel",
    "control",
]


class OresmeError(Exception):
    """The application rejected a request (bad name, missing wave, ...).

    ``code`` says what kind of refusal it is and ``details`` holds what it is
    about, for code to tell errors apart without reading the message::

        try:
            op.wave("signal")
        except op.NotFoundError as error:
            print(error.details)          # {'kind': 'wave', 'name': 'signal'}

    Each code has a class of its own, all of them OresmeError:

    - ``InvalidArgumentError`` ("INVALID_ARGUMENT", also a ValueError): a
      value, name or argument that is not allowed; ``details["field"]``
      names it when it is known.
    - ``NotFoundError`` ("NOT_FOUND", also a LookupError): something asked
      for by name is not there; ``details["kind"]`` and ``details["name"]``.
    - ``AlreadyExistsError`` ("ALREADY_EXISTS"): the name is taken.
    - ``InUseError`` ("IN_USE"): it cannot be removed while other things use
      it; ``details["users"]``.
    - ``ConflictError`` ("CONFLICT"): what the step was computed from changed
      meanwhile; doing it again may work.
    - ``UnsupportedError`` ("UNSUPPORTED"): a file, format or package the app
      cannot handle.
    - ``PluginFailedError`` ("PLUGIN_FAILED"): a plugin failed;
      ``details["phase"]`` is "start", "load", "run", "timeout", "stopped" or
      "invalid_output".
    - ``InternalError`` ("INTERNAL"): a fault of the app itself.

    An OresmeError raised without a code has the code "UNSPECIFIED". The
    codes are part of the API, and kept from one version to the next.
    Errors of NumPy, SciPy and Python itself are not turned into these.
    """

    code = "UNSPECIFIED"

    def __init__(self, message="", *, code=None, details=None):
        super().__init__(message)
        self.code = code or type(self).code
        self.details = dict(details or {})


class InvalidArgumentError(OresmeError, ValueError):
    """A value, name or argument that is not allowed (code "INVALID_ARGUMENT")."""

    code = "INVALID_ARGUMENT"


class NotFoundError(OresmeError, LookupError):
    """Something asked for by name is not there (code "NOT_FOUND")."""

    code = "NOT_FOUND"


class AlreadyExistsError(OresmeError):
    """The name is taken already (code "ALREADY_EXISTS")."""

    code = "ALREADY_EXISTS"


class InUseError(OresmeError):
    """It cannot be removed while other things use it (code "IN_USE")."""

    code = "IN_USE"


class ConflictError(OresmeError):
    """What the step was computed from changed meanwhile (code "CONFLICT"): doing it again may work."""

    code = "CONFLICT"


class UnsupportedError(OresmeError):
    """A file, format or package the app cannot handle (code "UNSUPPORTED")."""

    code = "UNSUPPORTED"


class PluginFailedError(OresmeError):
    """A plugin failed (code "PLUGIN_FAILED"); ``details["phase"]`` says where."""

    code = "PLUGIN_FAILED"


class InternalError(OresmeError):
    """A fault of the app itself (code "INTERNAL")."""

    code = "INTERNAL"


_ERROR_CLASSES = {
    cls.code: cls
    for cls in (
        InvalidArgumentError,
        NotFoundError,
        AlreadyExistsError,
        InUseError,
        ConflictError,
        UnsupportedError,
        PluginFailedError,
        InternalError,
    )
}


def _refusal(result):
    """The exception for a refusal the application answered with (its code, message and details)."""
    code = result.get("code")
    cls = _ERROR_CLASSES.get(code, OresmeError)
    return cls(result.get("error", ""), code=code, details=result.get("details"))


def _call(method, params=None, data=None):
    """Send one request to the application and wait for the answer."""
    try:
        payload = json.dumps(params or {}, allow_nan=False)
    except ValueError:
        raise InvalidArgumentError("Values must be finite numbers (no NaN or infinity here).") from None
    js_data = None
    if data is not None:
        from pyodide.ffi import to_js

        js_data = to_js(np.ascontiguousarray(data, dtype=np.float64))
    reply = _oresme_js.rpc(method, payload, js_data)
    result = json.loads(reply[0])
    if not result["ok"]:
        raise _refusal(result)
    binary = reply[1]
    array = None
    if binary is not None:
        array = np.frombuffer(binary.to_bytes(), dtype=np.float64)
    return result["result"], array


def _dispatch(command, data=None):
    if _fresh is not None and command.get("op") == "makeWave":
        command = _fresh_name(command)
    return _call("dispatch", command, data)[0]


# While a template does a sample (see Template.run): the waves there were
# before the sample began, and the new names given to waves made under one of
# those names. None at other times.
_fresh = None

#: Waves every fit writes anew by design, holding the latest fit: never renamed.
_SCRATCH_WAVES = frozenset(("W_coef", "W_sigma", "W_peaks"))


def _fresh_name(command):
    """A command making a wave, renamed if it would replace a wave from before the sample.

    A template's steps name the waves they make after their inputs
    (``fit_<wave>``), and a wave of that name may be there already, from an
    earlier run say. It is kept: the new wave is made as ``<name>_1``
    (``_2``, ...) instead, and a step that makes the same name again in the
    same sample writes to that new wave.
    """
    name = command["name"]
    key = name[5:] if isinstance(name, str) and name.startswith("root:") else name
    if key in _fresh["renamed"]:
        return {**command, "name": _fresh["renamed"][key]}
    if key not in _fresh["taken"] or key in _SCRATCH_WAVES:
        return command
    taken = set(_call("listWaves")[0])
    number = 1
    while f"{key}_{number}" in taken:
        number += 1
    _fresh["renamed"][key] = f"{key}_{number}"
    return {**command, "name": f"{key}_{number}"}


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

    @property
    def attributes(self):
        """The attributes of the sample this wave is: those of its data folders, then its own.

        A dict of name to number or text, such as ``{"thickness": 12.5,
        "instrument": "XPS-2"}``; see ``op.set_attributes``.
        """
        return attributes(self)

    def set_attributes(self, values=None, **named):
        """Set attributes of this wave itself (None removes one). Returns self."""
        set_attributes(self, values, **named)
        return self

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

    ``text_marker`` draws the values of another wave (text, or numbers) at
    the points instead of markers, as Igor's text markers do: labels placed
    in data coordinates. ``text_anchor`` says which point of each label sits
    on its data point ("MC" centres it, "RC" puts it to the left, "MT"
    below), ``text_size`` is their size (None: the graph's font size) and
    ``text_rotation`` turns them clockwise, in degrees. The mode must draw
    markers ("markers" or "lines+markers").
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
        "text_marker",
        "text_anchor",
        "text_size",
        "text_rotation",
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
        raise NotFoundError(f"{self._graph.name} has no trace named {self._name!r}.", details={"kind": "trace", "name": self._name})

    def _set(self, props):
        for key in ("yError", "xError", "colorWave", "textMarker"):
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

    ``label_rotation`` turns the axis label from where its side sets it, in
    degrees clockwise, as Igor's lblRot: a left axis's label reads upwards, a
    right axis's downwards, and 180 turns either round.

    ``labels`` says which labels are drawn, as Igor's noLabel: ``"on"``
    (tick labels and the axis label), ``"axis only"`` (the axis label, no
    tick labels) or ``"off"`` (neither). The axis line and ticks stay.

    ``line=False`` leaves out the axis line itself. With ``ticks="none"`` and
    ``labels="off"`` too, nothing of the axis is drawn: for a figure such as
    a ternary diagram, drawn with traces on axes that are not shown.
    """

    _props = (
        "label",
        "label_size",
        "label_style",
        "label_rotation",
        "tick_label_size",
        "labels",
        "min",
        "max",
        "log",
        "mirror",
        "line",
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
        raise NotFoundError(f"{self._graph.name} has no annotation named {self._name!r}.", details={"kind": "annotation", "name": self._name})

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


class Drawing(_Props):
    """A shape or text drawn on a graph (see ``Graph.draw``).

    ``points`` are x, y pairs, in fractions of the plot area from its top
    left corner (``coords="plot"``) or in values on the axes ``h_axis`` and
    ``v_axis`` (``coords="axes"``). ``color``, ``line_size`` (0: no
    outline) and ``line_style`` ("solid", "dash", "dot", "dashdot") draw its
    outline; ``fill`` (a color, or None) and ``fill_opacity`` fill a closed
    shape. ``arrow`` puts arrowheads on a line: "none", "end", "start" or
    "both". A polygon with ``closed=False`` is a line through its corners.
    ``text`` and ``text_size`` are those of text. ``layer`` is "front"
    (over the traces and axes) or "back" (behind the traces).
    """

    _props = (
        "points",
        "coords",
        "h_axis",
        "v_axis",
        "color",
        "line_size",
        "line_style",
        "fill",
        "fill_opacity",
        "arrow",
        "closed",
        "text",
        "text_size",
        "layer",
    )

    def __init__(self, graph, name):
        self._graph = graph
        self._name = name

    @property
    def name(self):
        return self._name

    @property
    def kind(self):
        return self._get()["kind"]

    def _get(self):
        for drawing in self._graph._info()["drawings"]:
            if drawing["name"] == self._name:
                return drawing
        raise NotFoundError(f"{self._graph.name} has no drawing named {self._name!r}.", details={"kind": "drawing", "name": self._name})

    def _set(self, props):
        if "points" in props:
            props["points"] = [float(value) for value in np.asarray(props["points"], dtype=float).ravel()]
        _dispatch(
            {"op": "modifyDrawing", "graph": self._graph.name, "drawing": self._name, "props": props}
        )

    def remove(self):
        _dispatch({"op": "removeDrawing", "graph": self._graph.name, "drawing": self._name})

    def to_front(self):
        """Draw it in front of the other drawings of its layer. Returns self."""
        _dispatch(
            {"op": "orderDrawing", "graph": self._graph.name, "drawing": self._name, "place": "front"}
        )
        return self

    def to_back(self):
        """Draw it behind the other drawings of its layer. Returns self."""
        _dispatch(
            {"op": "orderDrawing", "graph": self._graph.name, "drawing": self._name, "place": "back"}
        )
        return self

    def __repr__(self):
        return f"Drawing({self._name!r} in {self._graph.name})"


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
        raise NotFoundError(f"{self._graph.name} has no image named {self._name!r}.", details={"kind": "image", "name": self._name})

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
        raise NotFoundError(f"{self._graph.name} has no contour named {self._name!r}.", details={"kind": "contour", "name": self._name})

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


_POINTS_PER = {"pt": 1.0, "cm": 72 / 2.54, "inch": 72.0}


class Length(float):
    """A length on paper: ``op.cm(8)``, ``op.inch(3)``, ``op.pt(200)``.

    As a number it is the length in points (1/72 inch), so it goes wherever
    points do (the places of a page layout's items, say); it also keeps the
    unit it was given in, as ``value`` and ``unit``, which a graph's plot
    area keeps to show it so again.
    """

    def __new__(cls, value, unit="pt"):
        if unit not in _POINTS_PER:
            raise InvalidArgumentError(f"unit must be one of {', '.join(_POINTS_PER)}, not {unit!r}.")
        value = float(value)
        length = super().__new__(cls, value * _POINTS_PER[unit])
        length.value = value
        length.unit = unit
        return length

    def __repr__(self):
        return f"op.{self.unit}({self.value:g})"


def pt(value):
    """A length of ``value`` points (1/72 inch)."""
    return Length(value, "pt")


def cm(value):
    """A length of ``value`` centimetres."""
    return Length(value, "cm")


def inch(value):
    """A length of ``value`` inches (72 points)."""
    return Length(value, "inch")


def _length_parts(value, what):
    if isinstance(value, Length):
        return value.value, value.unit
    if isinstance(value, (int, float, np.number)) and not isinstance(value, bool):
        return float(value), "pt"
    raise TypeError(f"{what} must be a length (op.cm(8), op.inch(3)) or a number of points.")


def _plot_dimension(value, what):
    """A side of the plot area as Python writes it, as the document holds it."""
    if isinstance(value, dict):
        return {_camel(str(key)): _plain(item) for key, item in value.items()}
    if isinstance(value, str):
        if value == "auto":
            return {"mode": "auto"}
        raise InvalidArgumentError(f'{what} must be "auto", a length or a tuple, not {value!r}.')
    if isinstance(value, (tuple, list)) and value and isinstance(value[0], str):
        mode, *rest = value
        try:
            if mode == "absolute":
                if len(rest) == 2:
                    number, unit = rest
                else:
                    (length,) = rest
                    number, unit = _length_parts(length, what)
                return {"mode": "absolute", "value": _plain(number), "unit": unit}
            if mode == "aspect":
                (factor,) = rest
                return {"mode": "aspect", "factor": _plain(factor)}
            if mode == "plan":
                if len(rest) == 1:
                    rest = [*rest, "bottom", "left"]
                factor, haxis, vaxis = rest
                return {"mode": "plan", "factor": _plain(factor), "hAxis": haxis, "vAxis": vaxis}
            if mode in ("per_unit", "perUnit"):
                if len(rest) == 3:
                    number, unit, axis = rest
                else:
                    length, axis = rest
                    number, unit = _length_parts(length, what)
                return {"mode": "perUnit", "value": _plain(number), "unit": unit, "axis": axis}
        except ValueError:
            raise InvalidArgumentError(f"{what}: {_PLOT_FORMS}") from None
        raise InvalidArgumentError(f"{what} has no mode {mode!r}: {_PLOT_FORMS}")
    number, unit = _length_parts(value, what)
    return {"mode": "absolute", "value": number, "unit": unit}


_PLOT_FORMS = (
    '"auto", a length (op.cm(8) or a number of points), ("aspect", f), '
    '("plan", f, haxis, vaxis), or ("per_unit", n, unit, axis).'
)


def _plot_dimension_value(data):
    """A side of the plot area as the document holds it, as Python writes it."""
    mode = data.get("mode")
    if mode == "absolute":
        return Length(data["value"], data["unit"])
    if mode == "aspect":
        return ("aspect", data["factor"])
    if mode == "plan":
        return ("plan", data["factor"], data["hAxis"], data["vAxis"])
    if mode == "perUnit":
        return ("per_unit", data["value"], data["unit"], data["axis"])
    return "auto"


_MARGIN_SIDES = ("left", "bottom", "right", "top")


def _margin(value, what):
    """A margin as Python writes it, in points or None for auto."""
    if value is None or (isinstance(value, str) and value == "auto"):
        return None
    if isinstance(value, str):
        raise InvalidArgumentError(f'{what} must be "auto", a length or a number of points, not {value!r}.')
    number, unit = _length_parts(value, what)
    return number * _POINTS_PER[unit]


class Graph(_Props):
    """A graph window.

    ``width`` and ``height`` size its plot area, the rectangle the axes
    enclose, as Igor's ModifyGraph width and height (see ``Graph.set``).
    """

    _props = (
        "font_size",
        "font_family",
        "show_info",
        "width",
        "height",
        "margin_left",
        "margin_bottom",
        "margin_right",
        "margin_top",
        "magnification",
    )

    def __init__(self, name):
        self._name = name

    def set(self, **props):
        """Change several properties at once. Returns self.

        ``font_size``, ``font_family`` and ``show_info`` (the cursor bar);
        ``width`` and ``height`` size the plot area, each one of:

        - ``"auto"``: what the window leaves after the margins (the default).
        - a length: ``op.cm(8)``, ``op.inch(3)``, ``op.pt(200)`` or a
          number of points.
        - ``("aspect", f)``: f times the other side.
        - ``("plan", f, haxis, vaxis)``: one unit of the horizontal axis
          ``haxis`` is f times as long as one unit of the vertical axis
          ``vaxis`` (the axes default to ``"bottom"`` and ``"left"``); for
          the height, one unit of ``vaxis`` is f times one of ``haxis``.
          ``("plan", 1)`` scales X and Y alike, as a Nyquist plot needs.
        - ``("per_unit", n, unit, axis)``: n of ``unit`` ("pt", "cm",
          "inch") for each unit of the axis; ``("per_unit", op.cm(2),
          "bottom")`` says the same. A unit of a log axis is a decade.

        A side that is not auto makes the figure the plot area plus the
        margins, and the window fits it. The two sides cannot both use
        aspect or plan. Reading ``width`` or ``height`` gives the same forms
        back.

        ``margin_left``, ``margin_bottom``, ``margin_right`` and
        ``margin_top`` fix the margins around the plot area, as Igor's
        ModifyGraph margin: a length (``op.cm(1.5)`` or a number of points,
        0 to 360) or ``"auto"`` (``None``), as wide as the axes and their
        labels need. ``margins=`` sets all four: ``"auto"``, one length, or
        ``(left, bottom, right, top)``. Reading a margin gives points, or
        ``None`` for auto.

        ``magnification`` draws the graph bigger or smaller in its window,
        as Igor's expand: 2 doubles it, 1 is none (from 0.125 to 8). The
        window grows with it; the figure, and what is exported, keep their
        size.
        """
        if "margins" in props:
            margins = props.pop("margins")
            if isinstance(margins, (tuple, list)):
                if len(margins) != 4:
                    raise InvalidArgumentError("margins must be (left, bottom, right, top).")
            else:
                margins = (margins,) * 4
            for side, value in zip(_MARGIN_SIDES, margins):
                props.setdefault(f"margin_{side}", value)
        for key in ("width", "height"):
            if key in props:
                props[key] = _plot_dimension(props[key], key)
        for side in _MARGIN_SIDES:
            key = f"margin_{side}"
            if key in props:
                props[key] = _margin(props[key], key)
        return super().set(**props)

    def __getattr__(self, key):
        value = super().__getattr__(key)
        return _plot_dimension_value(value) if key in ("width", "height") else value

    @property
    def name(self):
        return self._name

    @property
    def link(self):
        """How this graph is linked to others (see ``op.link_graphs``), or None.

        A dict of ``graphs`` (all of the group, this one too), ``axes``
        ("x" or "xy") and ``cursors``.
        """
        link = self._info().get("link")
        if not link:
            return None
        graphs = [
            name for name in windows("graph")
            if (Graph(name)._info().get("link") or {}).get("group") == link["group"]
        ]
        return {"graphs": graphs, "axes": link["axes"], "cursors": link["cursors"]}

    def unlink(self):
        """Take this graph out of the graphs it is linked to."""
        unlink_graphs(self._name)

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
            raise NotFoundError(f"{self._name} has no axis named {name!r}. Axes: {', '.join(axes)}.", details={"kind": "axis", "name": name})
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
            raise NotFoundError(f"{self._name} has no image named {name!r}.", details={"kind": "image", "name": name})
        return Image(self, name)

    @property
    def contours(self):
        return [Contour(self, item["name"]) for item in self._info()["contours"]]

    def contour(self, name=None):
        names = [item["name"] for item in self._info()["contours"]]
        if name is None and len(names) == 1:
            name = names[0]
        if name not in names:
            raise NotFoundError(f"{self._name} has no contour named {name!r}.", details={"kind": "contour", "name": name})
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

    def draw(self, kind, points, **props):
        """Draw a shape or text on the graph, as Igor's drawing tools do, and return it.

        ``kind`` is "line", "arrow", "rect", "roundrect", "oval", "polygon"
        or "text". ``points`` are x, y pairs in a flat list: the two ends of a
        line or arrow, two opposite corners of a rectangle or oval, the
        corners of a polygon, the top left corner of text.

        By default the points are fractions of the plot area, from its top
        left corner (0 to 1 across and down): the drawing stays where it is
        when the graph is zoomed. With ``coords="axes"`` they are values on
        the axes ``h_axis`` and ``v_axis`` (bottom and left by default), and
        the drawing moves with the data::

            g.draw("arrow", [2.0, 0.8, 2.6, 0.3], coords="axes", color="red", line_size=2)
            g.draw("rect", [0.1, 0.1, 0.4, 0.3], fill="#ffee88", fill_opacity=0.5)
            g.draw("text", [0.7, 0.05], text="Peak A", text_size=14)

        See ``Drawing`` for the other properties.
        """
        command = {"op": "addDrawing", "graph": self._name, "kind": str(kind)}
        command["points"] = [float(value) for value in np.asarray(points, dtype=float).ravel()]
        unknown = set(props) - set(Drawing._props)
        if unknown:
            raise AttributeError(
                f"A drawing has no property {sorted(unknown)[0]!r}. "
                f"Properties: {', '.join(Drawing._props)}."
            )
        if props:
            command["props"] = {_camel(key): _plain(value) for key, value in props.items()}
        return Drawing(self, _dispatch(command))

    def drawings(self):
        """The shapes and text drawn on the graph, back to front."""
        return [Drawing(self, item["name"]) for item in self._info()["drawings"]]

    def drawing(self, name):
        return Drawing(self, name)

    def save_style(self, name, size=False):
        """Keep this graph's look as a style named ``name`` and return it.

        The style holds the fonts, the look of the axes (ticks, mirror, grid)
        and of the traces in order (color, line, markers), not the data; with
        ``size=True`` also the size the graph is drawn at, and how its plot
        area is sized where that is look (``"auto"``, a length or
        ``("aspect", f)``; a plan or a per unit size follows the data, so the
        style keeps the size it gave instead). A style of that name is
        replaced.
        """
        _dispatch({"op": "saveStyle", "name": name, "graph": self._name, "size": bool(size)})
        return Style(name)

    def save_template(self, name, fixed=()):
        """Keep this graph as a graph template named ``name`` and return it.

        Each wave the graph plots becomes a slot of the template (see
        ``GraphTemplate``); the traces, axes, look, text and size are kept,
        with how the plot area is sized (``width`` and ``height``, plan and
        per unit too).
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
        """The graph as an SVG document; by default at its window's size.

        A side of the plot area sized other than ``"auto"`` keeps its own size
        whatever ``width`` and ``height`` say.
        """
        return _call(
            "graphSvg",
            {"name": self._name, "width": width, "height": height, "cursors": bool(cursors)},
        )[0]

    def kill(self):
        """Kill the window and what it shows (see ``op.kill_window``)."""
        kill_window(self._name)

    def close(self):
        """Close the window, keeping what it shows to reopen (see ``op.close_window``)."""
        close_window(self._name)

    def reopen(self):
        """Open the window again after ``close()``, in front of the others."""
        reopen_window(self._name)

    def rename(self, new_name):
        """Give it and its window another name (see ``op.rename_window``). Returns self."""
        self._name = rename_window(self._name, new_name)
        return self

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {"text/plain": repr(self), "image/svg+xml": self.svg()}

    def __repr__(self):
        return f"Graph({self._name!r})"


class Procedure:
    """A Python file kept in the experiment, shown in a procedure window.

    It is ``<name>.py`` in the working directory: ``run()`` executes it in
    the interactive namespace (as ``from name import *`` would bring its
    names in), and other code can ``import`` it. With ``import_as`` set,
    ``run()`` runs it as a module of its own and binds it to that name
    instead, as ``import name as tl`` would. ``check()`` looks for mistakes
    without running it.
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

    @property
    def import_as(self):
        """The name ``run()`` binds the file to as a module, or None to run it in the namespace."""
        return self._info().get("importAs")

    @import_as.setter
    def import_as(self, value):
        _dispatch(
            {"op": "setProcedure", "name": self._name, "importAs": None if value is None else str(value)}
        )

    def run(self):
        """Run the file: in the interactive namespace, or as a module (see ``import_as``).

        In the namespace, what it defines can be used from the command line
        by its own name. As a module, it starts with ``np`` and ``op`` as the
        command line does, goes in ``sys.modules`` (so ``import name`` gets
        it too) and is bound to the ``import_as`` name: ``tl.area(2)``. An
        error stops it and is reported with the file's name and line; a
        module that fails is not kept.
        """
        import linecache

        from IPython import get_ipython

        __tracebackhide__ = True
        info = self._info()
        code = info["code"]
        alias = info.get("importAs")
        path = f"{self._name}.py"
        # Tracebacks quote the file, so it has to hold what is being run.
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(code)
        linecache.checkcache(path)
        compiled = compile(code, path, "exec")
        namespace = get_ipython().user_ns
        if not alias:
            exec(compiled, namespace)
            return
        import types

        module = types.ModuleType(self._name)
        module.__file__ = os.path.abspath(path)
        module.np = np
        module.op = sys.modules[__name__]
        previous = sys.modules.get(self._name)
        sys.modules[self._name] = module
        try:
            exec(compiled, module.__dict__)
        except BaseException:
            if previous is None:
                sys.modules.pop(self._name, None)
            else:
                sys.modules[self._name] = previous
            raise
        namespace[alias] = module

    def check(self):
        """Look for mistakes without running the file: what Python can tell before it runs.

        Reports a syntax error, and modules it imports that cannot be found
        (neither installed nor a package of the Pyodide distribution, nor
        another procedure). Returns the problems as a list of text, empty
        when there are none; shown, it says so in words. The procedure
        window's Check also shows Ruff's problems (undefined names and the
        like) in the editor.
        """
        import ast
        import importlib.util

        info = self._info()
        file = f"{self._name}.py"
        problems = _CheckReport(file)
        try:
            tree = ast.parse(info["code"], file)
            compile(tree, file, "exec")
        except SyntaxError as error:
            problems.append(f"{file}, line {error.lineno}: SyntaxError: {error.msg}")
            return problems
        procedures = set(_call("listWindows", {"kind": "procedure"})[0])
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            else:
                continue
            for name in names:
                top = name.split(".")[0]
                if top in sys.modules or top in procedures:
                    continue
                try:
                    found = importlib.util.find_spec(top) is not None
                except (ImportError, ValueError):
                    found = False
                if not found:
                    problems.append(
                        f"{file}, line {node.lineno}: no module named {top!r}"
                        " (install it with %pip install, or check the name)"
                    )
        return problems

    def kill(self):
        """Kill the window and what it shows (see ``op.kill_window``)."""
        kill_window(self._name)

    def close(self):
        """Close the window, keeping what it shows to reopen (see ``op.close_window``)."""
        close_window(self._name)

    def reopen(self):
        """Open the window again after ``close()``, in front of the others."""
        reopen_window(self._name)

    def rename(self, new_name):
        """Give it and its window another name (see ``op.rename_window``). Returns self."""
        self._name = rename_window(self._name, new_name)
        return self

    def __repr__(self):
        return f"Procedure({self._name!r})"


class Note:
    """A note: text in Markdown kept in the experiment, shown formatted in its window.

    ::

        n = op.new_note("log", "# Run 12")
        n.append("Baseline from 0 to 5 s.")
        n.append(f"Peak at {r.coef[1]:.3g} eV")

    HTML in the text is shown as text, links go only to http, https and
    mailto addresses, and a picture is shown only when its data is in the
    text (``data:image/png;base64,...``): one at an address is a link.
    """

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    @property
    def text(self):
        """The Markdown of the note."""
        return _call("noteInfo", {"name": self._name})[0]["text"]

    @text.setter
    def text(self, value):
        _dispatch({"op": "setNote", "name": self._name, "text": str(value)})

    def append(self, text):
        """Add a paragraph at the end of the note. Returns self."""
        now = self.text.rstrip("\n")
        self.text = f"{now}\n\n{text}\n" if now else f"{text}\n"
        return self

    def kill(self):
        """Kill the window and what it shows (see ``op.kill_window``)."""
        kill_window(self._name)

    def close(self):
        """Close the window, keeping what it shows to reopen (see ``op.close_window``)."""
        close_window(self._name)

    def reopen(self):
        """Open the window again after ``close()``, in front of the others."""
        reopen_window(self._name)

    def rename(self, new_name):
        """Give it and its window another name (see ``op.rename_window``). Returns self."""
        self._name = rename_window(self._name, new_name)
        return self

    def __repr__(self):
        return f"Note({self._name!r})"


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
        raise NotFoundError(f"{self._layout.name} has no item named {self._name!r}.", details={"kind": "item", "name": self._name})

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
        """Kill the window and what it shows (see ``op.kill_window``)."""
        kill_window(self._name)

    def close(self):
        """Close the window, keeping what it shows to reopen (see ``op.close_window``)."""
        close_window(self._name)

    def reopen(self):
        """Open the window again after ``close()``, in front of the others."""
        reopen_window(self._name)

    def rename(self, new_name):
        """Give it and its window another name (see ``op.rename_window``). Returns self."""
        self._name = rename_window(self._name, new_name)
        return self

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
        raise NotFoundError(f"No page layout named {name!r}.")
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
        """Kill the window and what it shows (see ``op.kill_window``)."""
        kill_window(self._name)

    def close(self):
        """Close the window, keeping what it shows to reopen (see ``op.close_window``)."""
        close_window(self._name)

    def reopen(self):
        """Open the window again after ``close()``, in front of the others."""
        reopen_window(self._name)

    def rename(self, new_name):
        """Give it and its window another name (see ``op.rename_window``). Returns self."""
        self._name = rename_window(self._name, new_name)
        return self

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

    @property
    def attributes(self):
        """The attributes of the sample this folder is: those of the folders it is in, then its own."""
        return attributes(self)

    def set_attributes(self, values=None, **named):
        """Set attributes of this folder, which its waves have too (None removes one). Returns self."""
        set_attributes(self, values, **named)
        return self

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
        raise NotFoundError(f"No data folder named {path!r}.")
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


def _package(module, function):
    """A package of the Pyodide distribution that a loader needs, imported."""
    try:
        return importlib.import_module(module)
    except ImportError:
        raise OresmeError(
            f"{function} needs {module}, which could not be loaded. It is fetched the first "
            "time a line calling it runs; run the line again once online."
        ) from None


def _legal_name(text, fallback):
    """A name the application accepts, made from a name in a file (as the Igor loader does)."""
    name = re.sub(r"[^\w]+", "_", str(text).strip()).strip("_")
    if not name:
        name = fallback
    if not name[0].isalpha():
        name = f"{fallback}_{name}"
    return name[:255]


class _FileNames:
    """Chooses names for what a file brings in, as the Igor loader does.

    Names that are not legal here are made legal; a wave whose name is taken
    gets ``_1``, ``_2``, ... so nothing is overwritten. A data folder that
    exists already is used, but two groups of the file whose names become the
    same here stay apart.
    """

    def __init__(self):
        self._waves = set(_call("listWaves")[0])
        self._folders = set(_call("listFolders")[0])
        self._mapped = {}  # Groups of the file -> the folder here.
        self._claimed = {}  # Folder here -> the groups of the file it holds.

    def folder(self, groups):
        groups = tuple(groups)
        if not groups:
            return ""
        if groups in self._mapped:
            return self._mapped[groups]
        parent = self.folder(groups[:-1])
        base = name = _legal_name(groups[-1], "folder")
        suffix = 0
        while True:
            path = f"{parent}:{name}" if parent else name
            if path not in self._waves and self._claimed.get(path, groups) == groups:
                break
            suffix += 1
            name = _suffixed(base, suffix)
        self._claimed[path] = groups
        self._mapped[groups] = path
        return path

    def wave(self, groups, leaf):
        folder = self.folder(groups)
        base = name = _legal_name(leaf, "wave")
        suffix = 0
        while True:
            path = f"{folder}:{name}" if folder else name
            if path not in self._waves and path not in self._folders and path not in self._claimed:
                break
            suffix += 1
            name = _suffixed(base, suffix)
        self._waves.add(path)
        return path


def _suffixed(base, suffix):
    """``base_<suffix>``, cut short so it stays within the 255 characters a name may have."""
    tag = f"_{suffix}"
    return base[: 255 - len(tag)] + tag


_EXACT = 2**53


def _plural(count, one, many=None):
    return f"{count} {one if count == 1 else (many or one + 's')}"


def _wide_integers(values, remarks):
    """64-bit integers as float64, saying how many were rounded (as the Igor loader does)."""
    if values.dtype.kind == "u":
        big = values[values > _EXACT]
    else:
        big = values[(values > _EXACT) | (values < -_EXACT)]
    inexact = sum(1 for value in big.tolist() if int(float(value)) != value)
    if inexact:
        words = "unsigned 64-bit integer" if values.dtype.kind == "u" else "64-bit integer"
        remarks.append(
            f"{inexact} of the {words} values {'is' if inexact == 1 else 'are'} beyond 2^53 and "
            f"{'was' if inexact == 1 else 'were'} rounded to the nearest float64."
        )
    return values.astype(np.float64)


def _numbers(values, remarks):
    """Numbers of a file as a wave holds them: 64-bit integers and float16 change type."""
    if values.dtype.kind in "iu" and values.dtype.itemsize == 8:
        return _wide_integers(values, remarks)
    if values.dtype == np.float16:
        return values.astype(np.float32)
    return values


def _with_missing(values, missing, count, remarks):
    """Numbers with NaN where the file has no value; integers become float64 to hold it."""
    if not count:
        return values
    if values.dtype.kind not in "fc":
        remarks.append(f"The {values.dtype.name} values are float64 here, to hold NaN.")
        values = values.astype(np.float64)
    else:
        values = values.copy()
    values[missing] = np.nan
    remarks.append(f"{_plural(count, 'missing value')} (null) {'is' if count == 1 else 'are'} NaN.")
    return values


def _as_text(items, remarks, count=0):
    if count:
        empty = "is an empty string" if count == 1 else "are empty strings"
        remarks.append(f"{_plural(count, 'missing value')} (null) {empty}.")
    return np.array(["" if item is None else str(item) for item in items], dtype=str)


_SECONDS = {"s": 1.0, "ms": 1e3, "us": 1e6, "ns": 1e9}


def _arrow_values(column, pa, pc, remarks):
    """A column of an Arrow table as wave values and a unit; None if a wave cannot hold it."""
    kind = column.type
    if pa.types.is_dictionary(kind):
        column = column.dictionary_decode()
        kind = column.type
    count = column.null_count
    missing = column.is_null().to_numpy(zero_copy_only=False) if count else None
    types = pa.types
    is_string_view = getattr(types, "is_string_view", bool)
    if types.is_string(kind) or types.is_large_string(kind) or is_string_view(kind):
        return _as_text(column.to_pylist(), remarks, count), None
    if types.is_boolean(kind):
        values = pc.fill_null(column, False).to_numpy(zero_copy_only=False)
        return _with_missing(values, missing, count, remarks), None
    if types.is_integer(kind) or types.is_floating(kind):
        values = _numbers(pc.fill_null(column, 0).to_numpy(zero_copy_only=False), remarks)
        return _with_missing(values, missing, count, remarks), None
    if types.is_decimal(kind):
        remarks.append("The decimal values are float64 here.")
        values = pc.fill_null(pc.cast(column, pa.float64()), 0).to_numpy(zero_copy_only=False)
        return _with_missing(values, missing, count, remarks), None
    timelike = (types.is_timestamp, types.is_date, types.is_time, types.is_duration)
    if any(test(kind) for test in timelike):
        if types.is_date32(kind):
            ticks, scale = pc.cast(column, pa.int32()), 1 / 86400
        elif types.is_date64(kind):
            ticks, scale = pc.cast(column, pa.int64()), 1e3
        else:
            width = pa.int32() if types.is_time32(kind) else pa.int64()
            ticks, scale = pc.cast(column, width), _SECONDS[kind.unit]
        values = pc.fill_null(ticks, 0).to_numpy(zero_copy_only=False).astype(np.float64) / scale
        if types.is_timestamp(kind) or types.is_date(kind):
            if getattr(kind, "tz", None):
                remarks.append(f"The times are in UTC here (the file gives the time zone {kind.tz}).")
            unit = "dat"
        else:
            unit = "s"
        return _with_missing(values, missing, count, remarks), unit
    return None


def _metadata_lines(metadata):
    """Key-value metadata of a file (bytes or text), as lines for a note."""
    lines = []
    for key, value in (metadata or {}).items():
        if isinstance(key, bytes):
            key = key.decode("utf-8", "replace")
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        lines.append(f"{key}: {_short(value)}")
    return lines


def _short(value, limit=300):
    text = str(value).replace("\r\n", "\n")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _make_loaded(specs):
    """Make the waves a loader planned, once every one of them has been read.

    Each keeps the type of its values when a wave can have it (``op.make``
    alone would make the platform's default integers float64).
    """
    made = []
    for name, values, unit, note in specs:
        kind = getattr(values, "dtype", None)
        dtype = kind.name if kind is not None and kind.name in WAVE_TYPES else None
        # The names are paths from the experiment's root. Said so outright: a
        # group of the file called "root" would otherwise read as the root itself.
        made.append(make(f"root:{name}", values, dtype=dtype, unit=unit, note=note, overwrite=False))
    return made


def load_parquet(source, columns=None, *, table=True, name=None):
    """Load a Parquet file as waves, one per column; returns them in a list.

    ``source`` is a file in the working directory (the files of the
    experiment are there), any other path, or the file's bytes with
    ``name=``. ``columns`` names the columns to read (one name or a list);
    all of them otherwise. Each column becomes a wave named after it (made
    legal, with ``_1`` if the name is taken):

    - integers, floating-point numbers and decimals are numeric waves of
      their type (64-bit integers and decimals become float64, float16
      becomes float32); booleans are uint8 waves of 0 and 1.
    - timestamps and dates are date waves: seconds since 1970-01-01 UTC, unit
      ``dat``. Times of day and durations are seconds, unit ``s``.
    - strings, and categories (dictionary columns), are text waves.
    - nulls are NaN (empty strings in text); a column of integers or
      booleans with nulls is float64 to hold them.

    Each wave's note says which file it came from (with its SHA-256), the
    column's Parquet type, how many nulls became NaN and how many 64-bit
    integers beyond 2^53 were rounded, and the column's metadata. Columns of
    other kinds (lists, structs, binary) are not loaded; a warning names
    them. ``table=False`` makes no table. pyarrow is fetched the first time
    this runs.
    """
    pa = _package("pyarrow", "op.load_parquet")
    pq = importlib.import_module("pyarrow.parquet")
    pc = importlib.import_module("pyarrow.compute")
    data, filename = _read_source(source, name)
    digest = hashlib.sha256(data).hexdigest()
    try:
        parquet = pq.ParquetFile(pa.BufferReader(data))
        schema = parquet.schema_arrow
        if isinstance(columns, str):
            columns = [columns]
        if columns is not None:
            unknown = [column for column in columns if column not in schema.names]
            if unknown:
                raise OresmeError(
                    f"{filename} has no column {', '.join(map(repr, unknown))}. "
                    f"Columns: {', '.join(schema.names)}."
                )
        frame = parquet.read(columns=list(columns) if columns is not None else None)
    except OresmeError:
        raise
    except Exception as error:
        raise OresmeError(f"Could not read {filename} as a Parquet file: {error}") from None

    names = _FileNames()
    specs = []
    skipped = []
    for index, title in enumerate(frame.column_names):
        field = frame.schema.field(index)
        column = frame.column(index).combine_chunks()
        remarks = []
        converted = _arrow_values(column, pa, pc, remarks)
        if converted is None:
            skipped.append(f"{title} ({field.type})")
            continue
        values, unit = converted
        lines = [f"Loaded from {filename} (SHA-256 {digest}): Parquet column {title!r}, {field.type}."]
        lines += remarks
        metadata = _metadata_lines(field.metadata)
        if metadata:
            lines += ["Metadata:", *metadata]
        specs.append((names.wave((), title), values, unit, "\n".join(lines)))
    if not specs:
        raise OresmeError(f"{filename} has no columns that waves can hold.")
    made = _make_loaded(specs)
    if table:
        edit(*made)
    if skipped:
        warnings.warn(f"{filename}: columns not loaded: {', '.join(skipped)}.", stacklevel=2)
    return made


def _attribute_text(value):
    """An HDF5 attribute's value in words, for a note."""
    if isinstance(value, bytes):
        return _short(value.decode("utf-8", "replace"))
    if isinstance(value, np.ndarray):
        if value.dtype.kind == "S":
            value = np.char.decode(value, "utf-8", "replace")
        value = value.tolist()
    elif isinstance(value, np.generic):
        value = value.item()
    return _short(value)


def _attribute_lines(attrs):
    lines = []
    for key in attrs:
        try:
            lines.append(f"{key}: {_attribute_text(attrs[key])}")
        except Exception:  # A reference or a type that h5py does not read.
            lines.append(f"{key}: (not readable)")
    return lines


def _hdf5_values(h5py, dataset, values, remarks):
    """A dataset's values (or given values: a field of it) as wave values and a unit;
    None if a wave cannot hold them."""
    kind = dataset.dtype if values is None else values.dtype
    if h5py.check_string_dtype(kind) is not None or kind.kind in "SU":
        if values is None:
            text = np.asarray(dataset.asstr(errors="replace")[()], dtype=object)
        else:
            items = [
                item.decode("utf-8", "replace") if isinstance(item, bytes) else item
                for item in values.ravel().tolist()
            ]
            text = np.asarray(items, dtype=object).reshape(values.shape)
        if text.ndim > 1:
            remarks.append(
                f"The strings are a 1-D text wave in row-major order (the last index varies "
                f"fastest); the dataset's shape is {'×'.join(map(str, text.shape))}."
            )
        return _as_text(text.ravel().tolist(), remarks), None
    if kind.kind not in "biufcMm" or kind.subdtype is not None:
        return None
    array = np.asarray(dataset[()] if values is None else values)
    if kind.kind == "M":
        return array, "dat"
    if kind.kind == "m":
        return array.astype("timedelta64[ns]").astype(np.float64) / 1e9, "s"
    enum = h5py.check_enum_dtype(kind)
    if enum and kind.kind != "b":
        labels = ", ".join(f"{label} = {number}" for label, number in enum.items())
        remarks.append(f"Enumeration: {labels}.")
    return _numbers(array, remarks), None


def load_hdf5(source, datasets=None, *, name=None):
    """Load the datasets of an HDF5 file (.h5, .hdf5) as waves; returns them in a list.

    ``source`` is a file in the working directory, any other path, or the
    file's bytes with ``name=``. ``datasets`` names the datasets to read, or
    groups to read every dataset in (one path or a list, like
    ``"/run1/signal"``); all of the file's otherwise. Each group becomes a
    data folder (``/run1/signal`` is the wave ``run1:signal``); names are made
    legal and a name that is taken gets ``_1``, as ``op.load_igor`` does.

    A dataset keeps its shape (up to 4 dimensions; ``w[i, j]`` is the
    dataset's ``[i, j]``) and its type: integers, floating-point and complex
    numbers as waves of that type (64-bit integers become float64, float16
    float32), booleans as uint8, NumPy dates stored by h5py as date waves
    (unit ``dat``), strings as text waves (of 1 dimension, in row-major
    order). The fields of a compound dataset become waves named
    ``<dataset>_<field>``. A string attribute ``units`` (or ``unit``) is the
    wave's unit.

    Each wave's note says which file it came from (with its SHA-256), the
    dataset's path, type and shape, how many 64-bit integers beyond 2^53
    were rounded, and the attributes of the dataset and of the groups above
    it. Datasets that waves cannot hold (more than 4 dimensions, references,
    empty datasets) are not loaded; a warning names them. h5py is fetched
    the first time this runs.
    """
    h5py = _package("h5py", "op.load_hdf5")
    data, filename = _read_source(source, name)
    digest = hashlib.sha256(data).hexdigest()
    try:
        handle = h5py.File(io.BytesIO(data), "r")
    except Exception as error:
        raise OresmeError(f"Could not read {filename} as an HDF5 file: {error}") from None
    with handle:
        found = []
        handle.visititems(
            lambda path, item: found.append(path) if isinstance(item, h5py.Dataset) else None
        )
        if isinstance(datasets, str):
            datasets = [datasets]
        if datasets is not None:
            chosen = []
            for wanted in datasets:
                key = str(wanted).strip("/")
                if key not in handle and key != "":
                    raise OresmeError(f"{filename} has no dataset or group {wanted!r}.")
                chosen += [
                    path
                    for path in found
                    if (key == "" or path == key or path.startswith(key + "/")) and path not in chosen
                ]
            found = chosen

        names = _FileNames()
        specs = []
        skipped = []
        group_notes = {}

        def group_lines(groups):
            lines = []
            for depth in range(len(groups) + 1):
                path = "/" + "/".join(groups[:depth])
                if path not in group_notes:
                    group_notes[path] = _attribute_lines(handle[path].attrs)
                if group_notes[path]:
                    lines += [f"Attributes of the group {path}:", *group_notes[path]]
            return lines

        for path in found:
            dataset = handle[path]
            *groups, leaf = path.split("/")
            if dataset.shape is None:
                skipped.append(f"/{path} (empty)")
                continue
            if len(dataset.shape) > 4:
                skipped.append(f"/{path} ({len(dataset.shape)} dimensions)")
                continue
            shape = "×".join(map(str, dataset.shape)) or "scalar"
            if dataset.dtype.names and h5py.check_string_dtype(dataset.dtype) is None:
                record = dataset[()]
                parts = [
                    (field, np.asarray(record[field]), f"field {field!r} of ")
                    for field in dataset.dtype.names
                ]
            else:
                parts = [(None, None, "")]
            attributes = _attribute_lines(dataset.attrs)
            unit = None
            for key in ("units", "unit"):
                if key in dataset.attrs:
                    value = dataset.attrs[key]
                    if isinstance(value, bytes):
                        value = value.decode("utf-8", "replace")
                    if isinstance(value, str):
                        unit = value
                        break
            for field, values, words in parts:
                kind = dataset.dtype if values is None else values.dtype
                label = f"/{path}" + (f" field {field!r}" if field else "")
                remarks = []
                try:
                    converted = _hdf5_values(h5py, dataset, values, remarks)
                except Exception as error:  # A type that h5py itself does not read.
                    skipped.append(f"{label} ({kind}: {error})")
                    continue
                if converted is None:
                    skipped.append(f"{label} ({kind})")
                    continue
                array, own_unit = converted
                lines = [
                    f"Loaded from {filename} (SHA-256 {digest}): {words}HDF5 dataset /{path}, "
                    f"{kind}, shape {shape}.",
                    *remarks,
                ]
                if attributes:
                    lines += ["Attributes:", *attributes]
                lines += group_lines(groups)
                leaf_name = f"{leaf}_{field}" if field else leaf
                specs.append((names.wave(groups, leaf_name), array, own_unit or unit, "\n".join(lines)))
    if not specs:
        raise OresmeError(f"{filename} has no datasets that waves can hold.")
    made = _make_loaded(specs)
    if skipped:
        warnings.warn(f"{filename}: datasets not loaded: {', '.join(skipped)}.", stacklevel=2)
    return made


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
        raise NotFoundError(f"No graph named {name!r}.")
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
        raise NotFoundError(f"No table named {name!r}.")
    return Table(name)


class _CheckReport(list):
    """The problems Procedure.check found: a list of text, shown as a report."""

    def __init__(self, file):
        super().__init__()
        self._file = file

    def __repr__(self):
        if not self:
            return f"{self._file}: no problems found."
        return "\n".join(self)


def new_procedure(name=None, code="", *, auto_run=True, import_as=None):
    """Make a procedure window: a Python file that is saved with the experiment.

    It is the module ``name`` (``import name`` from the command line or
    another procedure); ``Procedure.run()`` runs it in the interactive
    namespace instead. ``auto_run=False`` keeps it from running when the
    experiment opens, as a procedure imported from a file starts.
    ``import_as="tl"`` makes ``run()`` run it as a module bound to ``tl``
    (see ``Procedure.import_as``).
    """
    command = {"op": "newProcedure", "code": str(code)}
    if name is not None:
        command["name"] = name
    if not auto_run:
        command["autoRun"] = False
    if import_as is not None:
        command["importAs"] = str(import_as)
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
        raise NotFoundError(f"No procedure named {name!r}.")
    return Procedure(name)


def new_note(name=None, text=""):
    """Make a note window: Markdown text saved with the experiment (see ``Note``).

    Without a name it is called Note0, Note1, ...
    """
    command = {"op": "newNote", "text": str(text)}
    if name is not None:
        command["name"] = name
    return Note(_dispatch(command))


def notes():
    """Every note of the experiment."""
    return [Note(name) for name in _call("listWindows", {"kind": "note"})[0]]


def note(name=None):
    """A note by name; with no name, the frontmost one."""
    names = _call("listWindows", {"kind": "note"})[0]
    if name is None:
        if not names:
            raise OresmeError("There are no notes.")
        return Note(names[-1])
    if name not in names:
        raise NotFoundError(f"No note named {name!r}.")
    return Note(name)


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


def link_graphs(*graphs, axes="x", cursors=True):
    """Link graphs so that zooming or panning one zooms the others alike.

    ``axes="x"`` links the bottom axes, ``"xy"`` the left ones too. With
    ``cursors``, a cursor set on one graph is set on the others at the point
    nearest the same X: the same moment of a charge curve, a current and a
    temperature shown apart. The graphs start at the first one's range and
    leave any graphs they were linked to before. Returns the group's name.
    """
    names = [graph.name if isinstance(graph, Graph) else graph for graph in graphs]
    if len(names) == 1 and isinstance(names[0], (list, tuple)):
        names = [graph.name if isinstance(graph, Graph) else graph for graph in names[0]]
    return _dispatch(
        {"op": "linkGraphs", "graphs": names, "axes": axes, "cursors": bool(cursors)}
    )


def unlink_graphs(*graphs):
    """Take graphs out of the graphs they are linked to (see ``link_graphs``)."""
    names = [graph.name if isinstance(graph, Graph) else graph for graph in graphs]
    _dispatch({"op": "unlinkGraphs", "graphs": names})


def _attribute_target(target):
    """A wave by name, or a data folder as "path:"; from a Wave or a Folder too."""
    if isinstance(target, Folder):
        if not target.path:
            raise OresmeError("Root has no attributes: give them to a data folder or a wave.")
        return f"{target.path}:"
    if isinstance(target, Wave):
        return target.name
    if isinstance(target, str) and target:
        return target
    raise TypeError("Give a wave, a data folder (op.folder('run1') or 'run1:'), or a name.")


def set_attributes(target, values=None, **named):
    """Set attributes of a sample: a data folder or a wave.

    ``target`` is a wave, a folder (``op.folder("run1")``), a wave's name, or
    a folder's path followed by a colon (``"run1:"``). The attributes are
    given as a dict, keywords, or both: names of letters, digits and _,
    values that are numbers or text; None removes an attribute. A folder's
    attributes are those of every wave in it, below its own:

        op.set_attributes("run1:", thickness=12.5, Mg=0.3, instrument="XPS-2")
        op.wave("run1:spectrum").set_attributes(cycle=3)

    Results have the attributes of the wave they read, so
    ``op.results_table()`` and ``op.plot_results()`` can set them beside the
    parameters.
    """
    given = {**(values or {}), **named}
    plain = {}
    for key, value in given.items():
        if value is not None and not isinstance(value, str):
            if not _is_number(value):
                raise TypeError(f"{key} must be a number, text or None, not {value!r}.")
            value = int(value) if _is_integer(value) and not isinstance(value, float) else float(value)
        plain[str(key)] = value
    _dispatch({"op": "setAttributes", "target": _attribute_target(target), "values": plain})


def attributes(target, *, own=False):
    """The attributes of a wave or a data folder: with those it has from its folders, or with ``own`` only its own."""
    return _call("attributes", {"target": _attribute_target(target), "own": bool(own)})[0]


def kill_window(name):
    """Kill a graph, table, procedure, page layout or panel: its window and what it shows.

    The waves it showed stay. To close the window and keep what it shows,
    use ``close_window``.
    """
    _dispatch({"op": "killWindow", "name": _window_name(name)})


def close_window(name):
    """Close a window but keep what it shows in the experiment.

    A closed graph still follows its waves, a closed procedure can still be
    imported, and ``reopen_window`` (or the Windows menu) brings the window
    back as it is then. ``kill_window`` removes it for good.
    """
    _dispatch({"op": "closeWindow", "name": _window_name(name)})


def reopen_window(name):
    """Open a window that was closed with ``close_window``, in front of the others."""
    _dispatch({"op": "reopenWindow", "name": _window_name(name)})


def rename_window(name, new_name):
    """Give a graph, table, procedure, page layout or panel another name.

    The window and what it shows are renamed together; page layouts that
    show a renamed graph follow it. A procedure's name is also its module's
    name, so it takes only ASCII letters, digits and ``_``. Returns the new
    name.
    """
    return _dispatch({"op": "renameWindow", "name": _window_name(name), "newName": new_name})


def windows(kind=None, *, closed=True):
    """The names of the windows, back to front: all, or those of one ``kind``.

    ``kind`` is "graph", "table", "procedure", "page", "panel" or "note". With
    ``closed=False``, windows that are closed (see ``close_window``) are
    left out.
    """
    return _call("listWindows", {"kind": kind, "closed": bool(closed)})[0]


def _window_name(value):
    name = getattr(value, "name", value)
    if not isinstance(name, str):
        raise TypeError("A window is given by its name, or by the object that stands for it.")
    return name


class Style:
    """A graph style: the look of a graph kept in the experiment under a name.

    ``data`` is what it holds, as a plain dict with any of ``"graph"``
    (``font_size``, ``font_family``), ``"size"`` (``width`` and ``height`` of
    the drawn graph, in pixels), ``"plot"`` (``width`` and ``height`` of the
    plot area as the document holds them: ``{"mode": "auto"}``,
    ``{"mode": "absolute", "value": 8, "unit": "cm"}`` or
    ``{"mode": "aspect", "factor": 0.75}``), ``"axes"`` (by ``"left"``,
    ``"bottom"``, ``"right"``, ``"top"`` and ``"other"`` for added axes:
    ``mirror``, ``ticks``, ``minor``, ``grid``) and ``"traces"``: a list of
    trace looks
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
        raise NotFoundError(f"No style named {name!r}.")
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
_PARAM_TYPES = ("wave", "waves", "number", "integer", "string", "boolean", "choice", "numbers",
                "samples", "json")
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
    def __init__(self, id, version, title, description, params, function, atomic=True):
        self.id = id
        self.version = version
        self.title = title
        self.description = description
        # name -> description, as checked (with "arg" where it is passed under another name).
        self.params = params
        self.function = function
        # Whether a call runs in one op.atomic() block. Running a template does
        # not: each sample goes in by itself, so the GUI sees the run go on.
        self.atomic = atomic

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


def _json_value(value, where):
    """A value made of dicts (with text keys), lists, text, numbers, True/False and None, as plain JSON.

    For the settings of an action that have a structure of their own (a
    fit's ``hold``, ``bounds`` or ``exclude``), which the action checks.
    """
    if value is None or isinstance(value, (bool, np.bool_)):
        return None if value is None else bool(value)
    if isinstance(value, str):
        return value
    if _is_number(value):
        if not math.isfinite(float(value)):
            raise InvalidArgumentError(f"{where} must be made of finite numbers, not {value!r}.")
        return int(value) if _is_integer(value) and not isinstance(value, float) else float(value)
    if isinstance(value, (list, tuple, np.ndarray)):
        return [_json_value(item, f"{where}[{index}]") for index, item in enumerate(value)]
    if isinstance(value, dict):
        plain = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise InvalidArgumentError(f"{where}: keys must be text, not {key!r}.")
            plain[key] = _json_value(item, f"{where}[{key!r}]")
        return plain
    raise InvalidArgumentError(
        f"{where} must be made of dicts, lists, text, numbers, True, False and None, not {value!r}."
    )


def _check_value(spec, value, where, resolve_names=True):
    """The value of one argument as plain JSON, or OresmeError saying what is wrong with it."""
    kind = spec["type"]
    if value is None:
        raise InvalidArgumentError(f"{where} cannot be None (null): leave it out instead.")

    def number(item, what):
        if not _is_number(item):
            raise InvalidArgumentError(f"{what} must be a number, not {item!r}.")
        if not math.isfinite(float(item)):
            raise InvalidArgumentError(f"{what} must be a finite number, not {item!r}.")
        if kind == "integer" and not _is_integer(item):
            raise InvalidArgumentError(f"{what} must be a whole number, not {item!r}.")
        plain = int(item) if kind == "integer" else float(item)
        if "min" in spec and plain < spec["min"]:
            raise InvalidArgumentError(f"{what} must be at least {spec['min']:g}, not {plain:g}.")
        if "max" in spec and plain > spec["max"]:
            raise InvalidArgumentError(f"{what} must be at most {spec['max']:g}, not {plain:g}.")
        return plain

    def wave_name(item, what):
        if isinstance(item, Wave):
            return item.name
        if not isinstance(item, str) or not item:
            raise InvalidArgumentError(f"{what} must be the name of a wave, not {item!r}.")
        return _wave_name(item) if resolve_names else item

    def items():
        if not isinstance(value, (list, tuple)):
            raise InvalidArgumentError(f"{where} must be a list, not {value!r}.")
        if "length" in spec and len(value) != spec["length"]:
            raise InvalidArgumentError(f"{where} must have {spec['length']} items, not {len(value)}.")
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
            raise InvalidArgumentError(f"{where} must be a string, not {value!r}.")
        return value
    if kind == "boolean":
        if not isinstance(value, (bool, np.bool_)):
            raise InvalidArgumentError(f"{where} must be True or False, not {value!r}.")
        return bool(value)
    if kind == "json":
        return _json_value(value, where)
    if kind == "samples":
        # The waves are looked up sample by sample, when each is done.
        rows = []
        for index, row in enumerate(items()):
            if not isinstance(row, dict) or not row:
                raise InvalidArgumentError(f"{where}[{index}] must give a wave for each input, as a dict.")
            rows.append({
                str(slot): wave_name(item, f"{where}[{index}][{slot!r}]")
                for slot, item in row.items()
            })
        return rows
    # A choice: a string matches a string, a number a number.
    if isinstance(value, str) or _is_number(value):
        for choice in spec["choices"]:
            if isinstance(choice, str) == isinstance(value, str) and choice == value:
                return choice
    listed = ", ".join(_py_literal(choice) for choice in spec["choices"])
    raise InvalidArgumentError(f"{where} must be one of {listed}, not {value!r}.")


def _check_spec(action_id, name, spec):
    """A parameter's description, checked, with ``optional`` filled in."""
    where = f"{action_id}: parameter {name!r}"
    if not isinstance(name, str) or not name.isidentifier() or name.startswith("_"):
        raise InvalidArgumentError(f"{action_id}: {name!r} is not a parameter name (letters, digits and _).")
    if not isinstance(spec, dict):
        raise InvalidArgumentError(f"{where} must be described by a dict, such as {{'type': 'wave'}}.")
    unknown = sorted(set(spec) - _PARAM_KEYS)
    if unknown:
        raise InvalidArgumentError(f"{where}: unknown key {unknown[0]!r}. Keys: {', '.join(sorted(_PARAM_KEYS))}.")
    kind = spec.get("type")
    if kind not in _PARAM_TYPES:
        raise InvalidArgumentError(f"{where}: type must be one of {', '.join(_PARAM_TYPES)}, not {kind!r}.")
    checked = {"type": kind}
    for key in ("title", "description", "arg"):
        if key in spec:
            if not isinstance(spec[key], str) or not spec[key]:
                raise InvalidArgumentError(f"{where}: {key} must be a string.")
            checked[key] = spec[key]
    if "arg" in checked and not checked["arg"].isidentifier():
        raise InvalidArgumentError(f"{where}: arg must be the name of a parameter of the function.")
    if "choices" in spec or kind == "choice":
        choices = spec.get("choices")
        if kind != "choice":
            raise InvalidArgumentError(f"{where}: only a choice has choices.")
        if (
            not isinstance(choices, (list, tuple))
            or not choices
            or not all(isinstance(item, str) or _is_number(item) for item in choices)
            or len(set(choices)) != len(choices)
        ):
            raise InvalidArgumentError(f"{where}: choices must be a list of different strings or numbers.")
        checked["choices"] = [_plain(item) for item in choices]
    for key in ("min", "max"):
        if key in spec:
            if kind not in ("number", "integer", "numbers"):
                raise InvalidArgumentError(f"{where}: only numbers have {key}.")
            if not _is_number(spec[key]) or not math.isfinite(spec[key]):
                raise InvalidArgumentError(f"{where}: {key} must be a finite number.")
            checked[key] = _plain(spec[key])
    if "min" in checked and "max" in checked and checked["min"] > checked["max"]:
        raise InvalidArgumentError(f"{where}: min is above max.")
    if "length" in spec:
        if kind not in ("waves", "numbers"):
            raise InvalidArgumentError(f"{where}: only lists (waves, numbers) have a length.")
        if not _is_integer(spec["length"]) or spec["length"] < 0:
            raise InvalidArgumentError(f"{where}: length must be a whole number.")
        checked["length"] = int(spec["length"])
    optional = spec.get("optional", False)
    if not isinstance(optional, bool):
        raise InvalidArgumentError(f"{where}: optional must be True or False.")
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
    - ``"choice"``: one of ``choices``, a list of strings or numbers;
    - ``"samples"``: a list of dicts, each giving the name of a wave for
      each input of a template (see ``Template.run``).
    - ``"json"``: a value with a structure of its own (dicts, lists, text,
      numbers, True/False, and None inside), which the function checks
      itself: a fit's ``hold``, ``bounds`` or ``exclude``, say.

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


def _register_action(id, version, title, params, description, function, atomic=True):
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
        id, int(version), title, description, checked, function, atomic
    )
    _actions_revision += 1


def actions():
    """The registered actions, as plain dicts: id, version, title, description and params.

    Every version of each action is listed, ordered by id and then version.
    ``params`` maps each argument's name to its description (see ``op.action``),
    with ``optional`` always given.
    """
    own = [_actions[id][version].spec() for id in sorted(_actions) for version in sorted(_actions[id])]
    # The plugins' actions run in their own sandboxes; the application knows them.
    return own + _call("pluginActions")[0]


def _plugin_arg(value):
    """An argument of a plugin's action as the application takes it: waves by name."""
    if isinstance(value, Wave):
        return value.name
    if isinstance(value, (list, tuple)):
        return [_plugin_arg(item) for item in value]
    return _plain(value)


def _invoke_plugin(id, args):
    """Runs a plugin's action: in the application, which hands it to the plugin's sandbox.

    The waves it makes go where this code's other changes go: into the open
    ``op.atomic()`` block, if there is one. Returns what the application
    reports: the names of the waves made, the values and the result kept.
    """
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise OresmeError(f"The arguments of {id} are a dict of name: value, not {args!r}.")
    outcome = _call("invokePlugin", {"action": id, "args": {str(key): _plugin_arg(value) for key, value in args.items()}})[0]
    if outcome.get("log"):
        print(outcome["log"], end="" if outcome["log"].endswith("\n") else "\n")
    return {key: outcome[key] for key in ("waves", "values", "result")}


def _plugin_action(id):
    """A plugin's action as one of Python's, for checking a call and making it.

    The plugin runs in its own sandbox; the application knows its actions
    and runs them (see ``_invoke_plugin``). Its waves go into the open
    ``op.atomic()`` block like everything else this code changes.
    """
    for spec in _call("pluginActions")[0]:
        if spec["id"] == id:
            params = {
                name: {**param, "optional": bool(param.get("optional"))}
                for name, param in spec["params"].items()
            }
            return _Action(
                id, spec["version"], spec["title"], spec.get("description"), params,
                lambda **passed: _invoke_plugin(id, passed),
            )
    raise NotFoundError(
        f"No installed plugin has the action {id}, or it is turned off.",
        details={"kind": "action", "name": id},
    )


def _find_action(id, version):
    if isinstance(id, str) and id.startswith("plugin.") and id not in _actions:
        found = _plugin_action(id)
        if version is not None and version != found.version:
            raise OresmeError(f"{id} has no version {version!r} (it has {found.version}).")
        return found
    if not isinstance(id, str) or id not in _actions:
        raise NotFoundError(f"No action named {id!r}.", details={"kind": "action", "name": id})
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
        raise InvalidArgumentError(f"The arguments of {found.id} are a dict of name: value, not {args!r}.")
    for name in args:
        if name not in found.params:
            taken = ", ".join(found.params) or "nothing"
            raise InvalidArgumentError(
                f"{found.id} takes no argument {name!r}. It takes: {taken}.", details={"field": name}
            )
    missing = [name for name, spec in found.params.items() if not spec["optional"] and name not in args]
    if missing:
        raise InvalidArgumentError(
            f"{found.id} needs {', '.join(repr(name) for name in missing)}.",
            details={"field": missing[0], "missing": missing},
        )
    given = {}
    for name, value in args.items():
        try:
            given[name] = _check_value(found.params[name], value, f"{found.id}: {name}")
        except OresmeError as error:
            # Which argument it is, for a dialog to point at.
            raise _with_field(error, name) from None
    passed = {}
    for name, value in given.items():
        arg = found.params[name].get("arg", name)
        if arg in passed:
            other = next(item for item in given if found.params[item].get("arg", item) == arg)
            raise InvalidArgumentError(
                f"{found.id}: give {other!r} or {name!r}, not both.", details={"field": name}
            )
        passed[arg] = value
    # Only now, with every argument right, are the waves looked up.
    for name, value in given.items():
        kind = found.params[name]["type"]
        if kind not in ("wave", "waves"):
            continue
        try:
            resolved = wave(value) if kind == "wave" else [wave(item) for item in value]
        except OresmeError as error:
            raise _with_field(error, name, f"{found.id}: {name}: {error}") from None
        passed[found.params[name].get("arg", name)] = resolved
    return found, given, passed


def _with_field(error, field, message=None):
    """The same refusal, saying which argument (``details["field"]``) it is about."""
    return type(error)(
        str(error) if message is None else message,
        code=error.code,
        details={**error.details, "field": field},
    )


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
    if isinstance(id, str) and id.startswith("plugin.") and id not in _actions:
        return _invoke_plugin(id, args)
    found, _, passed = _prepare_action(id, args, version)
    with atomic() if found.atomic else contextlib.nullcontext():
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
    # An action whose call reads better another way says how to write it.
    if callable(getattr(function, "_oresme_code", None)):
        return function._oresme_code(given)
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
    hold through a ``_json()`` method of their own, and a named tuple becomes
    a dict of its fields. Anything else becomes ``{"repr": text}``.
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
    if isinstance(value, tuple) and callable(getattr(value, "_asdict", None)):
        # A named tuple: its fields by name, so a template's step can take one.
        return _result_json(dict(value._asdict()))
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
            raise NotFoundError(f"No graph template named {source!r}.")
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


# --- Analysis templates and runs ---------------------------------------------
#
# A template is a list of steps, each an action and its arguments, kept in the
# experiment under a name; running it on samples does the steps to one sample
# after another, each sample in a block of its own, and keeps a record of how
# each went (a run). The runner is here, beside the actions, so that the GUI
# and panels start a run like any other action (core.run_template).

_STEP_KEYS = ("id", "action", "version", "args")
# Actions that run templates: a step cannot be one, or a template could run itself.
_RUNNERS = ("core.run_template", "core.retry_run")


class Template:
    """An analysis template: steps of actions to do to one sample after another.

    ``data`` is what it holds, as a dict: ``"description"``, ``"inputs"``
    (the slots a wave is given for in each sample: ``name``, ``title`` and
    ``kind``, which is ``"wave"``) and ``"steps"``, in order. A step has an
    ``id``, the ``action`` it calls with its ``version``, and ``args`` by
    parameter name. An argument is a fixed value, the wave given for a slot
    (``{"$input": "spectrum"}``), or something an earlier step returned
    (``{"$step": "bg", "output": "subtracted"}``)::

        t = op.set_template("XPS", {
            "inputs": ["spectrum"],
            "steps": [
                {"id": "bg", "action": "core.background",
                 "args": {"wave": {"$input": "spectrum"}, "subtract": True}},
                {"id": "fit", "action": "core.fit_peaks",
                 "args": {"y": {"$step": "bg", "output": "subtracted"}, "quiet": True}},
            ],
        })
        run = t.run(["s1", "s2", "s3"])

    What a step returns is what its action returns, as ``op.invoke`` gives it
    to the application: the keys of a dict (a fit's ``"wave"``,
    ``"residuals"``, ...), the fields of a named tuple (``op.background`` with
    ``subtract=True``: ``"background"`` and ``"subtracted"``), ``"wave"`` for
    a wave, ``"0"``, ``"1"``, ... for a list, and ``"value"`` for anything
    else (a number, say). A step that keeps an
    analysis result also gives the waves the result made, by role (``"fit"``,
    ``"residuals"``, ``"peak1"``, ...). A wave stands for its name.
    """

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    def _info(self):
        return _call("templateInfo", {"name": self._name})[0]

    @property
    def data(self):
        """What the template holds, as a dict (a copy: change it with ``op.set_template``)."""
        return self._info()

    @property
    def description(self):
        return self._info()["description"]

    @property
    def inputs(self):
        """The names of the slots, the waves each sample is given for."""
        return [slot["name"] for slot in self._info()["inputs"]]

    @property
    def steps(self):
        """The steps, in order, as dicts: id, action, version and args."""
        return self._info()["steps"]

    def run(self, inputs, on_error="continue", *, name=None, quiet=False):
        """Do the steps to each sample, and return the record of it all (a ``Run``).

        ``inputs`` gives the waves of each sample: a list with a dict for
        each sample, ``[{"spectrum": "s1"}, {"spectrum": "s2"}]``; for a
        template of one input, a list of waves, ``["s1", "s2"]``; or a dict
        of lists by input, ``{"spectrum": ["s1", "s2"], "energy": "E"}``,
        where a single wave goes with every sample.

        The steps of each sample run in one ``op.atomic()`` block: a sample
        that fails leaves nothing, and one that succeeds goes into the
        experiment at once, recorded in the run as it finishes. With
        ``on_error="continue"`` the other samples go on; with ``"stop"``
        the run stops at the first sample that fails, and the rest stay
        pending. Interrupting Python stops it too: the samples done stay, the
        one being done and those not begun are marked cancelled.
        ``run.retry()`` does again only the samples that did not succeed.

        A wave a step makes under the name of a wave that was there before
        the sample began is made under a new name instead, ``<name>_1``
        (``_2``, ...): a run does not replace waves. ``W_coef``,
        ``W_sigma`` and ``W_peaks``, which hold the latest fit, are written
        as usual.

        The template is checked against the actions before anything is done:
        an action that is not registered, an argument it does not take or a
        fixed value of the wrong type refuses the whole run. ``name`` names
        the run (Run0, Run1, ... by default). With ``quiet`` it prints
        nothing; otherwise a line for each sample that did not succeed and
        a count at the end.
        """
        return _run_template(self._name, _sample_rows(self.inputs, inputs), on_error,
                             name=name, quiet=quiet)

    def rename(self, new_name):
        """Give the template another name. Returns self. Runs keep the name it had."""
        _dispatch({"op": "renameTemplate", "name": self._name, "newName": new_name})
        self._name = new_name
        return self

    def remove(self):
        """Delete the template. Runs made from it keep their copy of it."""
        _dispatch({"op": "removeTemplate", "name": self._name})

    def __repr__(self):
        return f"Template({self._name!r})"


def _sample_rows(slots, inputs):
    """The waves of each sample, as a dict by slot, from the ways ``Template.run`` takes them."""
    if isinstance(inputs, dict):
        listed = [value for value in inputs.values() if isinstance(value, (list, tuple))]
        counts = {len(value) for value in listed}
        if len(counts) > 1:
            raise OresmeError("The lists given for the inputs must all have one wave for each sample.")
        count = counts.pop() if counts else 1
        rows = [
            {slot: value[index] if isinstance(value, (list, tuple)) else value
             for slot, value in inputs.items()}
            for index in range(count)
        ]
    elif isinstance(inputs, (list, tuple)):
        rows = []
        for item in inputs:
            if isinstance(item, dict):
                rows.append(item)
            elif len(slots) == 1:
                rows.append({slots[0]: item})
            else:
                raise OresmeError(
                    f"The template has the inputs {', '.join(slots)}: give a dict of "
                    "a wave for each, for each sample."
                )
    else:
        raise OresmeError("Give the samples as a list, or as a dict of lists by input.")
    if not rows:
        raise OresmeError("There are no samples to run the template on.")
    return [{str(slot): _slot_wave(value) for slot, value in row.items()} for row in rows]


def templates():
    """Every analysis template of the experiment."""
    return [Template(name) for name in _call("listTemplates")[0]]


def template(name):
    """The analysis template with this name."""
    if isinstance(name, Template):
        return name
    if name not in _call("listTemplates")[0]:
        raise NotFoundError(f"No template named {name!r}.")
    return Template(name)


def set_template(name, data):
    """Define an analysis template from a dict (see ``Template``) or copy another; returns it.

    A template of that name is replaced. Inputs may be given by name alone
    (``"inputs": ["spectrum"]``). A step without an ``id`` is named
    ``step1``, ``step2``, ... by its place; one without a ``version`` gets
    the highest version of its action registered now. Names, the shape of
    each argument, and references to slots that do not exist or to steps
    that are not earlier are refused here; whether the actions take the
    arguments is checked when the template is run.
    """
    if isinstance(data, Template):
        data = data.data
    if not isinstance(data, dict):
        raise OresmeError("A template is a dict of description, inputs and steps.")
    data = dict(data)
    steps = data.get("steps")
    if isinstance(steps, (list, tuple)):
        filled = []
        for number, step in enumerate(steps, 1):
            if not isinstance(step, dict):
                filled.append(step)
                continue
            step = dict(step)
            step.setdefault("id", f"step{number}")
            if "version" not in step:
                action_id = step.get("action")
                if action_id not in _actions:
                    raise OresmeError(
                        f"Step {step['id']}: no action named {action_id!r} is registered, "
                        "so give the version it is for."
                    )
                step["version"] = max(_actions[action_id])
            if isinstance(step.get("args"), dict):
                step["args"] = {key: _template_value(value) for key, value in step["args"].items()}
                _check_structured(step)
            filled.append(step)
        data["steps"] = filled
    _dispatch({"op": "setTemplate", "name": name, "template": data})
    return Template(name)


def _check_structured(step):
    """Refuses an object as an argument that takes none: only a reference, or a ``json`` setting, is one."""
    params = _actions.get(step.get("action"), {}).get(step.get("version"))
    if params is None:
        return
    for key, value in step["args"].items():
        if not isinstance(value, dict) or "$input" in value or "$step" in value:
            continue
        spec = params.params.get(key)
        if spec is not None and spec["type"] != "json":
            raise OresmeError(
                f"Step {step['id']}: {key} takes a {spec['type']}; an object there must be a "
                '{"$input": slot} or a {"$step": step, "output": key}.'
            )


def _template_value(value):
    """An argument of a step as plain JSON: waves by name, NumPy numbers as numbers."""
    if isinstance(value, Wave):
        return value.name
    if isinstance(value, dict):
        return {key: _template_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_template_value(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


class Run:
    """The record of a template run on samples: kept in the experiment under a name.

    ``copy`` is the template as it was when the run was made, which a retry
    uses whatever the template says now. ``samples`` lists each sample:
    ``inputs`` (a wave by slot), ``fingerprints`` (of each input as it was
    when the sample was last done), ``state`` (``"pending"``,
    ``"succeeded"``, ``"failed"`` or ``"cancelled"``), ``error``,
    ``results`` (the analysis results its steps kept), ``waves`` (those they
    made), ``attempts``, ``finished`` (milliseconds since the epoch) and
    ``changed`` (inputs that are no longer what they were then).
    """

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        return self._name

    def _info(self):
        return _call("runInfo", {"name": self._name})[0]

    @property
    def data(self):
        """The whole record, as a dict (a copy)."""
        info = self._info()
        return {
            "name": info["name"], "template": info["template"], "copy": info["copy"],
            "on_error": info["onError"], "created": info["created"], "samples": self.samples,
        }

    @property
    def template(self):
        """The name of the template the run was made from."""
        return self._info()["template"]

    @property
    def copy(self):
        """The template as it was when the run was made, as a dict."""
        return self._info()["copy"]

    @property
    def on_error(self):
        return self._info()["onError"]

    @property
    def samples(self):
        # Only the keys of the record are respelled: those of inputs are the template's slots.
        return [{_snake(key): value for key, value in sample.items()}
                for sample in self._info()["samples"]]

    @property
    def states(self):
        """The state of each sample, in order."""
        return [sample["state"] for sample in self._info()["samples"]]

    @property
    def counts(self):
        """How many samples are in each state."""
        counts = {"succeeded": 0, "failed": 0, "cancelled": 0, "pending": 0}
        for state in self.states:
            counts[state] += 1
        return counts

    def retry(self, on_error=None, *, quiet=False):
        """Do again the samples that did not succeed, with the run's own copy of the template.

        Only failed, cancelled and pending samples are done; those that
        succeeded stay as they are. The outcome goes into this run, sample by
        sample (``attempts`` counts the times each was done). ``on_error`` is
        the run's own unless given. Returns self.
        """
        return _retry_run(self._name, on_error, quiet=quiet)

    def table(self, name=None, sigma=True):
        """Put the samples side by side in a table, failed ones too, and return it.

        A row for each sample: ``<name>_sample`` (its number), the input
        waves (``<name>_<input>``), ``<name>_state``, ``<name>_error`` and
        ``<name>_result`` (the results kept), then a column for each
        parameter of the results (``<name>_<parameter>``, with ``_sd`` for
        the standard deviation if ``sigma``) and ``<name>_chisq``. A sample
        that did not succeed has NaN for numbers. Where a sample kept more
        than one result with a parameter of the same name, the last step's
        is shown. An input or parameter whose column would have the name of
        another (an input called ``state``, say) gets ``_2``, ``_3``, ...
        ``name`` is the run's name by default.
        """
        return _run_table(self._name, name, sigma)

    def remove(self):
        """Forget the run. The waves and results its samples made stay."""
        _dispatch({"op": "removeRuns", "names": [self._name]})

    def _json(self):
        return {"run": self._name, **self.counts}

    def __repr__(self):
        counts = self.counts
        done = ", ".join(f"{count} {state}" for state, count in counts.items() if count)
        return f"Run({self._name!r}: {done})"


def runs():
    """Every run of the experiment, oldest first."""
    return [Run(name) for name in _call("listRuns")[0]]


def run(name=None):
    """A run by name; with no name, the latest."""
    names = _call("listRuns")[0]
    if isinstance(name, Run):
        return name
    if name is None:
        if not names:
            raise OresmeError("There are no runs yet.")
        return Run(names[-1])
    if name not in names:
        raise NotFoundError(f"No run named {name!r}.")
    return Run(name)


def _plan_template(label, copy):
    """The steps of a template with their actions, checked as far as can be before a sample.

    Every step's action must be registered at its version and take its
    arguments; fixed values must be of the right type and inputs may go
    only where a wave does. What earlier steps return is checked when it is
    known, sample by sample.
    """
    plan = []
    for step in copy["steps"]:
        where = f"{label}, step {step['id']}"
        if step["action"] in _RUNNERS:
            raise OresmeError(f"{where}: a template cannot run templates.")
        try:
            found = _find_action(step["action"], step["version"])
        except OresmeError as error:
            raise OresmeError(f"{where}: {error}") from None
        args = step["args"]
        for key in args:
            if key not in found.params:
                taken = ", ".join(found.params) or "nothing"
                raise OresmeError(f"{where}: {found.id} takes no argument {key!r}. It takes: {taken}.")
        missing = [key for key, spec in found.params.items() if not spec["optional"] and key not in args]
        if missing:
            raise OresmeError(f"{where}: {found.id} needs {', '.join(repr(key) for key in missing)}.")
        for key, value in args.items():
            spec = found.params[key]
            items = value if isinstance(value, list) else [value]
            references = [item for item in items if isinstance(item, dict)]
            if not references:
                _check_value(spec, value, f"{where}: {key}", resolve_names=False)
                continue
            for item in references:
                if "$input" in item and spec["type"] not in ("wave", "waves"):
                    raise OresmeError(
                        f"{where}: the input {item['$input']!r} is a wave, which {key} "
                        f"({spec['type']}) does not take."
                    )
            if isinstance(value, list) and spec["type"] not in ("waves", "numbers"):
                raise OresmeError(f"{where}: {key} ({spec['type']}) does not take a list.")
        plan.append((step, found))
    return plan


def _step_outputs(value):
    """What a step returned, by the keys a later step's ``{"$step": ..., "output": ...}`` names."""

    def plain(item):
        # A wave stands for its name, which is what an action takes.
        if isinstance(item, dict) and set(item) == {"wave"}:
            return item["wave"]
        if isinstance(item, list):
            return [plain(each) for each in item]
        return item

    outputs = {}
    if isinstance(value, dict):
        outputs = {key: plain(item) for key, item in value.items()}
    elif isinstance(value, list):
        outputs = {str(index): plain(item) for index, item in enumerate(value)}
    elif value is not None:
        outputs = {"value": value}
    if isinstance(value, dict) and isinstance(value.get("result"), str):
        with contextlib.suppress(OresmeError):
            info = _call("resultInfo", {"name": value["result"]})[0]
            for role, wave_ in info["outputs"].items():
                outputs.setdefault(role, wave_)
    return outputs


def _resolve(value, inputs, outputs, where):
    """An argument of a step with its references replaced by what they stand for."""
    if isinstance(value, list):
        return [_resolve(item, inputs, outputs, where) for item in value]
    if not isinstance(value, dict):
        return value
    if "$input" in value:
        return inputs[value["$input"]]
    if "$step" not in value:
        # A value with a structure of its own (a fit's bounds), which may hold references.
        return {name: _resolve(item, inputs, outputs, where) for name, item in value.items()}
    step, key = value["$step"], value["output"]
    returned = outputs[step]
    if key not in returned:
        known = ", ".join(returned) or "nothing"
        raise OresmeError(f"{where}: step {step} returned no {key!r} (it returned {known}).")
    if returned[key] is None:
        raise OresmeError(f"{where}: step {step} returned nothing for {key!r}.")
    return returned[key]


def _do_sample(run_name, index, plan, inputs):
    """Do the steps to one sample in one block, and record that it succeeded."""
    global _fresh
    before_waves = set(_call("listWaves")[0])
    before_results = set(_call("listResults")[0])
    outer = _fresh
    _fresh = {"taken": before_waves, "renamed": {}}
    try:
        with atomic():
            outputs = {}
            for step, found in plan:
                where = f"step {step['id']}"
                args = {
                    key: _resolve(value, inputs, outputs, where)
                    for key, value in step["args"].items()
                }
                try:
                    _, _, passed = _prepare_action(found.id, args, found.version)
                except OresmeError as error:
                    raise OresmeError(f"{where}: {error}") from None
                outputs[step["id"]] = _step_outputs(_result_json(found.function(**passed)))
            kept = [name for name in _call("listResults")[0] if name not in before_results]
            # The results' own copies of what they made belong to them, not to the sample.
            copies = tuple(f"results:{name}:" for name in kept)
            made = [
                name for name in _call("listWaves")[0]
                if name not in before_waves and not name.startswith(copies)
            ]
            # In the same block as the outputs: the record and what it records go in together.
            _dispatch({
                "op": "updateRunSample", "run": run_name, "index": index, "state": "succeeded",
                "results": kept, "waves": made, "attempted": True,
            })
    finally:
        _fresh = outer


def _error_text(error):
    if isinstance(error, OresmeError):
        return str(error)
    return f"{type(error).__name__}: {error}"


def _execute_run(run_name, indices, on_error, quiet):
    """Do the samples of a run at these places, one after another, recording each."""
    info = _call("runInfo", {"name": run_name})[0]
    plan = _plan_template(f"{run_name} ({info['template']})", info["copy"])
    samples = info["samples"]
    for position, index in enumerate(indices):
        attempts = samples[index]["attempts"]
        try:
            _do_sample(run_name, index, plan, samples[index]["inputs"])
        except KeyboardInterrupt:
            now = _call("runInfo", {"name": run_name})[0]["samples"]
            for rest in indices[position:]:
                begun = rest == index
                if begun and now[rest]["attempts"] > attempts:
                    continue  # It went in before the interrupt arrived.
                if not begun and now[rest]["state"] != "pending":
                    continue  # A failed sample being retried keeps its own error.
                _dispatch({
                    "op": "updateRunSample", "run": run_name, "index": rest, "state": "cancelled",
                    "error": "Interrupted." if begun else "Not done: the run was interrupted.",
                    "attempted": begun,
                })
            raise
        except Exception as error:
            message = _error_text(error)
            _dispatch({
                "op": "updateRunSample", "run": run_name, "index": index, "state": "failed",
                "error": message, "attempted": True,
            })
            if not quiet:
                label = ", ".join(samples[index]["inputs"].values())
                print(f"{run_name}: sample {index + 1} ({label}) failed: {message}")
            if on_error == "stop":
                break
    result = Run(run_name)
    if not quiet:
        counts = result.counts
        print(f"{run_name}: " + ", ".join(f"{count} {state}" for state, count in counts.items() if count))
    return result


def _run_template(template, samples, on_error="continue", name=None, quiet=False):
    """Run a template on samples (see ``Template.run``); the action ``core.run_template``."""
    template = template.name if isinstance(template, Template) else template
    copy = _call("templateInfo", {"name": template})[0]
    if on_error not in ("continue", "stop"):
        raise OresmeError('on_error must be "continue" or "stop".')
    # Refused before anything is kept: the actions, and the samples' inputs.
    _plan_template(template, copy)
    slots = [slot["name"] for slot in copy["inputs"]]
    for number, sample in enumerate(samples, 1):
        unknown = sorted(set(sample) - set(slots))
        if unknown:
            raise OresmeError(f"Sample {number}: {template} has no input {unknown[0]!r}.")
        missing = [slot for slot in slots if slot not in sample]
        if missing:
            raise OresmeError(f"Sample {number} needs a wave for {', '.join(missing)}.")
    command = {
        "op": "addRun",
        "run": {
            "template": template,
            "copy": copy,
            "onError": on_error,
            "samples": [{"inputs": sample} for sample in samples],
        },
    }
    if name is not None:
        command["name"] = name
    run_name = _dispatch(command)
    return _execute_run(run_name, list(range(len(samples))), on_error, quiet)


def _retry_run(run_name, on_error=None, quiet=False):
    """Do again the samples of a run that did not succeed; the action ``core.retry_run``."""
    run_name = run_name.name if isinstance(run_name, Run) else run_name
    info = _call("runInfo", {"name": run_name})[0]
    on_error = info["onError"] if on_error is None else on_error
    if on_error not in ("continue", "stop"):
        raise OresmeError('on_error must be "continue" or "stop".')
    indices = [index for index, sample in enumerate(info["samples"]) if sample["state"] != "succeeded"]
    if not indices:
        if not quiet:
            print(f"{run_name}: every sample has succeeded; there is nothing to retry.")
        return Run(run_name)
    return _execute_run(run_name, indices, on_error, quiet)


def _clean(key):
    return "".join(char if char.isalnum() or char == "_" else "_" for char in key).strip("_")


def _run_table(run_name, name=None, sigma=True):
    """A table of the samples of a run (see ``Run.table``); the action ``core.run_table``."""
    run_name = run_name.name if isinstance(run_name, Run) else run_name
    info = _call("runInfo", {"name": run_name})[0]
    name = run_name if name is None else name
    samples = info["samples"]
    slots = [slot["name"] for slot in info["copy"]["inputs"]]
    # The parameters of each sample's results, the last step's where two share a name.
    values = []
    parameters = []
    for sample in samples:
        found = {}
        if sample["state"] == "succeeded":
            for result_name in sample["results"]:
                try:
                    result = _call("resultInfo", {"name": result_name})[0]
                except OresmeError:
                    continue  # Deleted since.
                for key, coef, spread in zip(result["names"], result["coef"], result["sigma"]):
                    found[key] = (coef, spread)
                    if key not in parameters:
                        parameters.append(key)
                found["\0chisq"] = (result["chisq"], None)
        values.append(found)

    def number(value):
        return np.nan if value is None else value

    # The fixed columns keep their names. An input or parameter whose column
    # would have one of them, or another's (an input called "state", a
    # parameter "x" next to one "x_sd"), gets _2, _3, ...: no column of the
    # table overwrites another.
    used = {f"{name}_{label}" for label in ("sample", "state", "error", "result", "chisq")}

    def free(wanted):
        found, count = wanted, 2
        while found in used:
            found, count = f"{wanted}_{count}", count + 1
        used.add(found)
        return found

    slot_columns = {slot: free(f"{name}_{_clean(slot)}") for slot in slots}
    parameter_columns = {}
    for key in parameters:
        parameter_columns[key] = free(f"{name}_{_clean(key)}")
        if sigma:
            parameter_columns[key, "sd"] = free(f"{name}_{_clean(key)}_sd")

    columns = [
        make(f"{name}_sample", np.arange(1, len(samples) + 1, dtype=float)),
        *(make(slot_columns[slot], [sample["inputs"][slot] for sample in samples]) for slot in slots),
        make(f"{name}_state", [sample["state"] for sample in samples]),
        make(f"{name}_error", [sample["error"] for sample in samples]),
        make(f"{name}_result", [", ".join(sample["results"]) for sample in samples]),
    ]
    for key in parameters:
        columns.append(make(parameter_columns[key], [number(found.get(key, (None,))[0]) for found in values]))
        if sigma:
            columns.append(
                make(parameter_columns[key, "sd"], [number(found.get(key, (None, None))[1]) for found in values])
            )
    columns.append(make(f"{name}_chisq", [number(found.get("\0chisq", (None,))[0]) for found in values]))
    existing = {table_.name: table_ for table_ in tables()}
    if name in existing:
        # The same table again: it shows the waves as they are now.
        shown = {column.name for column in existing[name].columns}
        missing = [column for column in columns if column.name not in shown]
        if missing:
            existing[name].append(*missing)
        return existing[name]
    return edit(*columns, name=name)


def _run_template_code(given):
    """``op.template(...).run(...)``: how a call of core.run_template reads in the history."""
    samples = given["samples"]
    slots = {slot for sample in samples for slot in sample}
    if len(slots) == 1:
        # One input: the waves alone, as t.run takes them for such a template.
        rows = _py_literal([next(iter(sample.values())) for sample in samples])
    else:
        rows = _py_literal(samples)
    parts = [rows]
    if given.get("on_error", "continue") != "continue":
        parts.append(f"on_error={_py_literal(given['on_error'])}")
    for key in ("name", "quiet"):
        if key in given:
            parts.append(f"{key}={_py_literal(given[key])}")
    return f"op.template({_py_literal(given['template'])}).run({', '.join(parts)})"


def _retry_run_code(given):
    parts = []
    if "on_error" in given:
        parts.append(f"{_py_literal(given['on_error'])}")
    if given.get("quiet"):
        parts.append("quiet=True")
    return f"op.run({_py_literal(given['run'])}).retry({', '.join(parts)})"


def _run_table_code(given):
    parts = [f"name={_py_literal(given['name'])}"] if "name" in given else []
    if given.get("sigma") is False:
        parts.append("sigma=False")
    return f"op.run({_py_literal(given['run'])}).table({', '.join(parts)})"


_run_template._oresme_code = _run_template_code
_retry_run._oresme_code = _retry_run_code
_run_table._oresme_code = _run_table_code

with _registering("core"):
    _register_action(
        "core.run_template", 1, "Run Template",
        {
            "template": {"type": "string", "title": "Template"},
            "samples": {"type": "samples", "title": "Samples",
                        "description": "A wave for each input of the template, for each sample."},
            "on_error": {"type": "choice", "title": "When a sample fails",
                         "choices": ["continue", "stop"], "default": "continue"},
            "name": {"type": "string", "title": "Run name", "optional": True},
            "quiet": {"type": "boolean", "title": "Quiet", "default": False},
        },
        "Do the steps of an analysis template to each sample, keeping a record of each.",
        _run_template,
        atomic=False,
    )
    _register_action(
        "core.retry_run", 1, "Retry Run",
        {
            "run": {"type": "string", "title": "Run", "arg": "run_name"},
            "on_error": {"type": "choice", "title": "When a sample fails",
                         "choices": ["continue", "stop"], "optional": True},
            "quiet": {"type": "boolean", "title": "Quiet", "default": False},
        },
        "Do again the samples of a run that failed, were cancelled or were not done.",
        _retry_run,
        atomic=False,
    )
    _register_action(
        "core.run_table", 1, "Run Table",
        {
            "run": {"type": "string", "title": "Run", "arg": "run_name"},
            "name": {"type": "string", "title": "Table name", "optional": True},
            "sigma": {"type": "boolean", "title": "Standard deviations", "default": True},
        },
        "A table of the samples of a run: inputs, state, error and the parameters of their results.",
        _run_table,
    )


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
    picker, a list of waves, a plot or a button.

    ``value`` is what a field or picker holds (the name of the wave, for a
    wave picker; the names of those selected, for a wave list) and ``data``
    all of its properties, as the panel keeps them. ``set(...)`` changes
    properties: ``label``, ``inline`` (on the line of the control before
    it), its look and place (``color``, ``background``, ``x``, ``y``,
    ``w``, ``h``, ``z``; see ``Panel``), and those of its kind, as the
    panel's methods that add controls take them; ``name`` renames it, and
    the buttons that pass its value follow. ``None`` takes a look or place
    property back to the usual.
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
        raise NotFoundError(f"{self._panel.name} has no control named {self._name!r}.", details={"kind": "control", "name": self._name})

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
        """Put the control at a place in the panel's order, counted from 0 (the top)."""
        _dispatch(
            {"op": "moveControl", "panel": self._panel.name, "control": self._name, "to": _plain(index)}
        )
        return self

    def place(self, x, y, w=None, h=None):
        """Put the control at ``x``, ``y`` pixels from the top left of the panel,
        out of the lines the others flow in; ``w`` and ``h`` give it a size.
        Returns self.
        """
        props = {"x": x, "y": y}
        if w is not None:
            props["w"] = w
        if h is not None:
            props["h"] = h
        return self.set(**props)

    def unplace(self):
        """Put the control back in its line, as the controls without a place flow. Returns self."""
        return self.set(x=None, y=None)

    def _stacked(self, front):
        mine = self.data.get("z", 0)
        others = [item.get("z", 0) for item in self._panel._get()["controls"] if item["name"] != self._name]
        if not others:
            return self
        if front and mine <= max(others):
            self.set(z=max(others) + 1)
        elif not front and mine >= min(others):
            self.set(z=min(others) - 1)
        return self

    def bring_to_front(self):
        """Draw the control in front of the others of the panel (gives it the highest ``z``). Returns self."""
        return self._stacked(True)

    def send_to_back(self):
        """Draw the control behind the others of the panel (gives it the lowest ``z``). Returns self."""
        return self._stacked(False)

    def take_from_graph(self, graph=None):
        """Give a plot the waves a graph draws: the frontmost graph, or ``graph``
        (a Graph or its name). Returns self.
        """
        if self.kind != "plot":
            raise OresmeError(f"{self._name} is a {self.kind}: only a plot takes waves from a graph.")
        source = graph if isinstance(graph, Graph) else globals()["graph"](graph)
        traces = [{"y": item["y"], "x": item["x"]} for item in source._info()["traces"]]
        return self.set(traces=traces)

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

    Each of them also takes the control's look and place, as keywords:
    ``color`` (of its words) and ``background``, as ``"#rrggbb"``, a color
    name or ``(r, g, b)``; ``x`` and ``y``, which place it that many pixels
    from the top left of the panel, out of the lines; ``w`` and ``h``, its
    size in pixels; and ``z``, the order it is drawn in (higher in front)::

        p.button("run", "Fit", action="core.fit", x=20, y=140, w=90,
                 color="white", background="#2a6fd6")

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
            raise NotFoundError(f"{self._name} has no control named {name!r}.", details={"kind": "control", "name": name})
        return Control(self, name)

    def __getitem__(self, name):
        return self.control(name).value

    def __setitem__(self, name, value):
        _dispatch(
            {"op": "setControlValue", "panel": self._name, "control": name, "value": _panel_data(value)}
        )

    def __contains__(self, name):
        return any(item["name"] == name for item in self._get()["controls"])

    _STYLE = ("color", "background", "x", "y", "w", "h", "z")

    def _add(self, kind, name, props, style=None):
        style = style or {}
        unknown = [key for key in style if key not in self._STYLE]
        if unknown:
            raise OresmeError(
                f"A {kind} control has no property {unknown[0]!r}. Its look and place: {', '.join(self._STYLE)}."
            )
        props = {**props, **style}
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

    def heading(self, name, label=None, *, inline=None, **style):
        """A heading: ``label`` in bold."""
        return self._add("heading", name, {"label": label, "inline": inline}, style)

    def text(self, name, label=None, *, inline=None, **style):
        """A paragraph of text: ``label``, which may have several lines."""
        return self._add("text", name, {"label": label, "inline": inline}, style)

    def number(self, name, label=None, *, value=None, min=None, max=None, step=None, inline=None, **style):
        """A field for a number, from ``min`` to ``max`` (inclusive) if given;
        ``step`` is how much the arrows change it.
        """
        props = {"label": label, "value": value, "min": min, "max": max, "step": step, "inline": inline}
        return self._add("number", name, props, style)

    def string(self, name, label=None, *, value=None, inline=None, **style):
        """A field for text."""
        return self._add("string", name, {"label": label, "value": value, "inline": inline}, style)

    def checkbox(self, name, label=None, *, value=None, inline=None, **style):
        """A checkbox: its value is True or False."""
        return self._add("checkbox", name, {"label": label, "value": value, "inline": inline}, style)

    def choice(self, name, options, *, value=None, label=None, inline=None, **style):
        """A menu of ``options`` (texts or numbers); it starts at the first unless ``value`` says."""
        props = {"label": label, "options": list(options), "value": value, "inline": inline}
        return self._add("choice", name, props, style)

    #: The same as ``choice``.
    select = choice

    def wave(self, name, label=None, *, value=None, dims=None, filter=None, inline=None, **style):
        """A wave picker: its value is the name of the wave chosen.

        ``dims`` lists only waves of that many dimensions; ``filter`` only
        those whose names contain it, or match it as a pattern with ``*``
        (``"*_I"``). The picker follows the wave when it is renamed; when
        the wave is killed, the name stays and is shown as missing.
        """
        props = {"label": label, "value": value, "dims": dims, "filter": filter, "inline": inline}
        return self._add("wave", name, props, style)

    def list(self, name, label=None, *, value=None, dims=None, filter=None, multiple=None, inline=None, **style):
        """A list of waves to select from: its value is the list of the names selected.

        ``dims`` and ``filter`` choose the waves listed, as a wave picker's
        do; ``multiple=False`` lets only one be selected. A button passes
        the names to an argument that takes several waves. The list follows
        its waves when they are renamed; a killed wave stays selected and is
        shown as missing.
        """
        if isinstance(value, (Wave, str)):
            value = [value]
        props = {"label": label, "value": value, "dims": dims, "filter": filter, "multiple": multiple, "inline": inline}
        return self._add("list", name, props, style)

    def plot(self, name, label=None, *, traces=None, live=None, inline=None, **style):
        """A small graph in the panel.

        ``traces`` are the waves it draws: each a wave, its name, or a pair
        ``(y, x)``. ``live=True`` draws what the frontmost graph draws
        instead, as it changes. ``Control.take_from_graph()`` (and the
        plot's own button) gives it the waves of the frontmost graph.
        ``label`` is a caption above it; ``w`` and ``h`` its size.
        """
        if traces is not None:
            traces = [
                {"y": item[0], "x": item[1]} if isinstance(item, (list, tuple)) else item for item in traces
            ]
        props = {"label": label, "traces": traces, "live": live, "inline": inline}
        return self._add("plot", name, props, style)

    def button(self, name, label=None, *, action, args=None, version=None, inline=None, **style):
        """A button that calls the action ``action`` with ``args`` when pressed.

        Each argument is a plain value (text, a number, True or False, a
        list or a dict of them) or ``op.control(name)``, the value of a
        control of the panel at the time of the press; ``op.control`` may
        also sit inside a list or dict, as in a template's inputs.
        ``version`` calls that version of the action rather than the highest.
        """
        props = {"label": label, "action": action, "args": args or {}, "version": version, "inline": inline}
        return self._add("button", name, props, style)

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
        """Kill the window and what it shows (see ``op.kill_window``)."""
        kill_window(self._name)

    def close(self):
        """Close the window, keeping what it shows to reopen (see ``op.close_window``)."""
        close_window(self._name)

    def reopen(self):
        """Open the window again after ``close()``, in front of the others."""
        reopen_window(self._name)

    def rename(self, new_name):
        """Give it and its window another name (see ``op.rename_window``). Returns self."""
        self._name = rename_window(self._name, new_name)
        return self

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

from _oresme_packages import install, packages, uninstall  # noqa: E402,F401

__all__ += ["install", "packages", "uninstall"]
