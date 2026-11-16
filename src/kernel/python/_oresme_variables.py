"""The variables of the interactive namespace, for the Variables window.

After each input the kernel tells the application what the user's variables
are now (when that has changed): their names, types and a short description
of each. What Python starts with (``np``, ``op``, IPython's own names),
names starting with ``_`` and modules are left out: they are not the user's
work, and dropping them would leave Python unusable.

Describing a value must never run much code or fail: arrays are described
by their shape and type, collections by their length, and anything else by
a shortened ``repr`` that is given up on if it raises.
"""

import inspect
import reprlib
import types

import numpy as np

#: The most variables listed; past it, the list says how many more there are.
LIMIT = 500
#: Characters of a description.
WIDTH = 80

_short = reprlib.Repr()
_short.maxstring = WIDTH
_short.maxother = WIDTH
_short.maxlist = _short.maxtuple = _short.maxdict = _short.maxset = 6

#: Names Python has before any input of the user's: set by ``start``.
_baseline = frozenset()
_last = None


def start(namespace):
    """Remember what the namespace holds before the user's first input."""
    global _baseline, _last
    _baseline = frozenset(namespace)
    _last = None


def shown(name, value, namespace=None):
    """Whether a name of the namespace is listed: the user's own, not Python's or the app's."""
    if name.startswith("_") or name in _baseline:
        return False
    if isinstance(value, types.ModuleType):
        return False
    return True


def _clip(text):
    text = " ".join(str(text).split())
    return text if len(text) <= WIDTH else text[: WIDTH - 1] + "…"


def describe(value):
    """The type of a value and a short description of it, as (type, summary)."""
    kind = type(value).__name__
    try:
        if isinstance(value, np.ndarray):
            shape = "×".join(str(size) for size in value.shape) or "scalar"
            return "ndarray", f"{shape} {value.dtype}"
        if isinstance(value, np.generic):
            return kind, _clip(repr(value.item()))
        module = type(value).__module__ or ""
        if module.startswith("pandas") and hasattr(value, "shape"):
            return kind, "×".join(str(size) for size in value.shape)
        if module == "oresme" and hasattr(value, "name"):
            return kind, _clip(repr(value))
        if inspect.isclass(value):
            return "class", value.__qualname__
        if inspect.isroutine(value):
            try:
                return "function", f"{value.__name__}{inspect.signature(value)}"
            except (TypeError, ValueError):
                return "function", value.__name__
        if isinstance(value, (list, tuple, dict, set, frozenset)):
            return kind, f"{len(value)} items: {_clip(_short.repr(value))}"
        return kind, _clip(_short.repr(value))
    except Exception:  # A broken __repr__ or the like: still list the variable.
        return kind, ""


def variables(namespace):
    """The user's variables, sorted by name: dicts of name, type and summary."""
    names = sorted(
        (name for name, value in list(namespace.items()) if shown(name, value)),
        key=str.lower,
    )
    listed = []
    for name in names[:LIMIT]:
        kind, summary = describe(namespace[name])
        listed.append({"name": name, "type": kind, "summary": summary})
    return {"variables": listed, "more": max(0, len(names) - LIMIT)}


def report(namespace, call):
    """Tell the application the variables, when they have changed since it was last told."""
    global _last
    state = variables(namespace)
    if state != _last:
        call("variablesStatus", state)
        _last = state


def droppable(names, namespace):
    """Those of the names that are the user's variables: what ``del`` may remove."""
    return [name for name in names if name in namespace and shown(name, namespace[name])]
