"""The component table: what is fitted, written as CasaXPS's Components page holds it.

One component per line, or per ``;``, lettered A, B, C ... in order::

    C-C:   GL(30) pos=284.8        fwhm=1.1[0.6,2]
    C-O:   GL(30) pos=A+1.5        fwhm=A
    O-C=O: GL(30) pos=288.8[288,290] fwhm=A area=A*0.1[0,1e9]

The name goes before the colon (the letter is the name if there is none),
the line shape anywhere (GL(30) if none is given), and the parameters as
``key=value``:

* ``pos`` (position, binding energy in eV), required
* ``fwhm`` (the width parameter F in eV), 1.5 if not given
* ``area``: estimated from the data if not given
* ``rsf``: the relative sensitivity factor, 1 if not given
* ``gauss``: the FWHM (eV) of a Gaussian to convolve the shape with, 0 if not given

A value is

* ``284.8``: where the fit starts, free within the default limits (pos: the
  region; fwhm: 0.05 to 20 eV; area: 0 or more)
* ``284.8[284.5,285.1]`` or ``[284.5,285.1]``: free between the limits
  (starting halfway when no start is given)
* ``284.8!``: fixed
* ``A+1.5``, ``A-1.5``, ``A*0.5``, ``A/2`` or ``A``: tied to the same
  parameter of component A, as CasaXPS's constraints are (a doublet: the
  2p1/2 at ``pos=A+5.7 area=A*0.5 fwhm=A``)

The XPS Peak Fitting window (the app's model editor) gives the same as a
list of dicts instead, as CasaXPS's Components page holds it::

    [{"name": "C-C", "shape": "GL(30)", "position": 284.8, "fwhm": 1.1, "area": 3000,
      "constraints": {"position": "", "fwhm": "0.6, 2", "area": ""}},
     {"name": "C-O", "position": 286.3, "constraints": {"position": "A+1.5", "fwhm": "A"}}]

where a constraint is ``""`` (free within the default limits), limits
``"284, 286"``, ``"fixed"``, or a tie ``"A"``, ``"A+1.5"``, ``"A-1.5"``,
``"A*0.5"``, ``"A/2"``. A start outside its limits begins at the nearest
limit, as in CasaXPS.
"""

import math
import re

import numpy as np

from oresme_plugin import PluginError

from .shapes import parse_shape

LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
PARAMS = ("pos", "fwhm", "area")
_KEYS = {
    "pos": "pos", "position": "pos", "be": "pos",
    "fwhm": "fwhm", "width": "fwhm",
    "area": "area",
    "rsf": "rsf",
    "gauss": "gauss",
}
_NUM = r"[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?"
_FIXED = re.compile(rf"^({_NUM})!$")
_LIMITED = re.compile(rf"^({_NUM})?\[({_NUM}),({_NUM})\]$")
_TIED = re.compile(rf"^([A-Z])(?:([-+*/])({_NUM}))?$")
_PLAIN = re.compile(rf"^{_NUM}$")
#: Default limits of what is free (pos: the region, filled in when parsing).
FWHM_LIMITS = (0.05, 20.0)
#: The fields of a component as the window names them, and the parameter each is.
FIELDS = {"position": "pos", "fwhm": "fwhm", "area": "area"}
_LIMITS = re.compile(rf"^\[?\s*({_NUM})\s*(?:,|;|:|\.\.|\s+to\s+|\s)\s*({_NUM})\s*\]?$", re.IGNORECASE)
_TIE = re.compile(rf"^([A-Za-z])\s*(?:([-+*/])\s*({_NUM}))?$")


class ComponentError(PluginError):
    """A component that cannot be fitted, with which one (index) and which field it is about."""

    def __init__(self, message, item=None, field=None):
        super().__init__(message)
        self.item = item
        self.field = field


class Value:
    """One parameter of a component: free, fixed or tied to another component's."""

    def __init__(self, kind, start=None, low=-np.inf, high=np.inf, ref=None, op=None, amount=0.0):
        self.kind = kind  # "free", "fixed" or "tied"
        self.start = start
        self.low = low
        self.high = high
        self.ref = ref  # index of the component it is tied to
        self.op = op
        self.amount = amount

    def describe(self):
        """The value as it was written (normalized), for the results."""
        if self.kind == "fixed":
            return f"{self.start:g}!"
        if self.kind == "tied":
            letter = LETTERS[self.ref]
            return letter if self.op is None else f"{letter}{self.op}{self.amount:g}"
        return f"[{self.low:g},{self.high:g}]"


class Component:
    def __init__(self, index, name, shape, values, rsf, gauss):
        self.index = index
        self.letter = LETTERS[index]
        self.name = name
        self.shape = shape
        self.values = values  # by parameter: Value
        self.rsf = rsf
        self.gauss = gauss


def _value(text, param, where, count, limits):
    text = text.strip()
    match = _FIXED.match(text)
    if match:
        return Value("fixed", start=float(match.group(1)))
    match = _TIED.match(text)
    if match:
        ref = LETTERS.index(match.group(1))
        if ref >= count:
            raise PluginError(f"{where} is tied to {match.group(1)}, but there is no component {match.group(1)}.")
        op = match.group(2)
        amount = float(match.group(3)) if match.group(3) is not None else 0.0
        if op == "/":
            if amount == 0:
                raise PluginError(f"{where} divides by 0.")
            op, amount = "*", 1 / amount
        elif op == "-":
            op, amount = "+", -amount
        return Value("tied", ref=ref, op=op, amount=amount)
    low, high = limits
    match = _LIMITED.match(text)
    if match:
        low, high = float(match.group(2)), float(match.group(3))
        if not low < high:
            raise PluginError(f"{where}: the limits [{low:g},{high:g}] must go from low to high.")
        start = float(match.group(1)) if match.group(1) is not None else None
        if start is None:
            start = 0.5 * (low + high) if np.isfinite(high) else max(low, 0.0)
        if not low <= start <= high:
            raise PluginError(f"{where}: {start:g} is outside its limits [{low:g},{high:g}].")
        return Value("free", start=start, low=low, high=high)
    if _PLAIN.match(text):
        start = float(text)
        if not low <= start <= high:
            raise PluginError(
                f"{where}: {start:g} is outside the limits it has by default, [{low:g},{high:g}]; "
                "give limits as value[low,high]."
            )
        return Value("free", start=start, low=low, high=high)
    raise PluginError(
        f"{where}: {text!r} is not a value: write 284.8, 284.8[284,286], 284.8! or A+1.5."
    )


def _tidy(text):
    """Takes the spaces out of values: '284.8 [284, 286]' -> '284.8[284,286]', 'A + 1' -> 'A+1'."""
    text = re.sub(r"\s*\[\s*", "[", text)
    text = re.sub(r"\s*,\s*(?=[^\[]*\])", ",", text)
    text = re.sub(r"\s*\]", "]", text)
    text = re.sub(r"\s*=\s*", "=", text)
    text = re.sub(r"\b([A-Z])\s*([-+*/])\s*(?=[0-9.])", r"\1\2", text)
    return text


def _constraint(text, start, limits, where, count, index, field):
    """A constraint of the window's table: "", "284, 286", "fixed", "A", "A+1.5", "A*0.5"."""
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise ComponentError(f"{where}: a constraint is text.", index, field)
    plain = text.strip()
    if plain.lower() in ("fixed", "fix", "!"):
        if start is None:
            raise ComponentError(f"{where} is fixed, so it needs a value.", index, field)
        return Value("fixed", start=float(start))
    match = _TIE.match(plain)
    if match:
        letter = match.group(1).upper()
        ref = LETTERS.index(letter)
        if ref >= count:
            raise ComponentError(f"{where} is tied to {letter}, but there is no component {letter}.", index, field)
        if ref == index:
            raise ComponentError(f"{where} is tied to itself.", index, field)
        op, amount = match.group(2), match.group(3)
        amount = 0.0 if amount is None else float(amount)
        if op == "/":
            if amount == 0:
                raise ComponentError(f"{where} divides by 0.", index, field)
            op, amount = "*", 1 / amount
        elif op == "-":
            op, amount = "+", -amount
        return Value("tied", ref=ref, op=op, amount=amount)
    low, high = limits
    if plain:
        match = _LIMITS.match(plain)
        if not match:
            raise ComponentError(
                f"{where}: {plain!r} is not a constraint. Leave it empty (free), or write limits "
                "'284, 286', 'fixed', or a tie to another component: 'A', 'A+1.5', 'A*0.5'.",
                index, field,
            )
        low, high = sorted((float(match.group(1)), float(match.group(2))))
        if not low < high:
            raise ComponentError(f"{where}: the limits {low:g}, {high:g} leave nothing between them.", index, field)
    if start is None:
        if field == "area" and not plain:
            return None  # estimated from the data
        return Value("free", start=0.5 * (low + high) if np.isfinite(high) else max(low, 0.0), low=low, high=high)
    return Value("free", start=min(max(float(start), low), high), low=low, high=high)


def _number(value, where, index, field):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ComponentError(f"{where} is a number, not {value!r}.", index, field)
    return float(value)


_ITEM_KEYS = {"name", "shape", "position", "fwhm", "area", "rsf", "gauss", "constraints"}


def parse_component_list(items, region):
    """Components given as the window gives them: a list of dicts (see the module's text)."""
    if not items:
        raise ComponentError("There are no components: add one.")
    if len(items) > len(LETTERS):
        raise ComponentError(f"There are {len(items)} components; at most {len(LETTERS)} can be fitted.")
    components = []
    for index, item in enumerate(items):
        letter = LETTERS[index]
        if not isinstance(item, dict):
            raise ComponentError(f"Component {letter} is a dict of name, shape, position, ...", index)
        unknown = sorted(set(item) - _ITEM_KEYS)
        if unknown:
            raise ComponentError(
                f"Component {letter} has {unknown[0]!r}; the keys are {', '.join(sorted(_ITEM_KEYS))}.", index
            )
        name = item.get("name") or letter
        if not isinstance(name, str):
            raise ComponentError(f"Component {letter}'s name is text.", index, "name")
        where = f"Component {letter} ({name})"
        try:
            shape = parse_shape(item.get("shape") or "GL(30)")
        except PluginError as error:
            raise ComponentError(str(error), index, "shape") from None
        constraints = item.get("constraints") or {}
        if not isinstance(constraints, dict) or set(constraints) - set(FIELDS):
            raise ComponentError(f"{where}: constraints are given for position, fwhm and area.", index)
        limits = {"position": region, "fwhm": FWHM_LIMITS, "area": (0.0, np.inf)}
        values = {}
        for field, param in FIELDS.items():
            given = item.get(field)
            start = None if given is None else _number(given, f"{where}'s {field}", index, field)
            values[param] = _constraint(
                constraints.get(field, ""), start, limits[field], f"{where}'s {field}", len(items), index, field
            )
        if values["pos"] is None:
            raise ComponentError(f"{where} has no position.", index, "position")
        if values["fwhm"].kind == "free" and item.get("fwhm") is None:
            values["fwhm"].start = min(max(1.5, values["fwhm"].low), values["fwhm"].high)
        rsf = _number(item.get("rsf", 1.0), f"{where}'s rsf", index, "rsf")
        if not rsf > 0:
            raise ComponentError(f"{where}'s rsf must be more than 0.", index, "rsf")
        gauss = _number(item.get("gauss", 0.0), f"{where}'s gauss", index, "gauss")
        if gauss < 0:
            raise ComponentError(f"{where}'s gauss must be 0 or more.", index, "gauss")
        components.append(Component(index, name, shape, values, rsf, gauss))
    return components


def parse_components(text, region):
    """The components, as a table (see the module's text) or as the window's list of dicts.

    Positions are limited to ``region``.
    """
    if isinstance(text, (list, tuple)):
        return parse_component_list(list(text), region)
    if not isinstance(text, str) or not text.strip():
        raise PluginError("The components are empty: give at least one, e.g. \"C-C: GL(30) pos=284.8\".")
    items = [item.strip() for item in re.split(r"[;\n]", text) if item.strip()]
    if len(items) > len(LETTERS):
        raise PluginError(f"There are {len(items)} components; at most {len(LETTERS)} can be fitted.")
    components = []
    for index, item in enumerate(items):
        letter = LETTERS[index]
        name, colon, rest = item.partition(":")
        if not colon:
            name, rest = letter, item
        name = name.strip() or letter
        where = f"Component {letter} ({name})"
        rest = _tidy(rest)
        pairs = {}
        for key, value in re.findall(r"([A-Za-z_]+)=(\S+)", rest):
            canonical = _KEYS.get(key.lower())
            if canonical is None:
                raise PluginError(f"{where} has {key}=; the keys are pos, fwhm, area, rsf and gauss.")
            if canonical in pairs:
                raise PluginError(f"{where} gives {canonical} twice.")
            pairs[canonical] = value
        leftover = re.sub(r"([A-Za-z_]+)=(\S+)", " ", rest).split()
        if len(leftover) > 1:
            raise PluginError(f"{where}: {' '.join(leftover)!r} is not a line shape and a key=value.")
        shape = parse_shape(leftover[0] if leftover else "GL(30)")
        if "pos" not in pairs:
            raise PluginError(f"{where} has no position: give pos=, e.g. pos=284.8.")
        values = {
            "pos": _value(pairs["pos"], "pos", f"{where}'s pos", len(items), region),
            "fwhm": _value(pairs.get("fwhm", "1.5"), "fwhm", f"{where}'s fwhm", len(items), FWHM_LIMITS),
            "area": None if "area" not in pairs
            else _value(pairs["area"], "area", f"{where}'s area", len(items), (0.0, np.inf)),
        }
        for param, value in values.items():
            if value is not None and value.kind == "tied" and value.ref == index:
                raise PluginError(f"{where}'s {param} is tied to itself.")
        rsf = 1.0
        if "rsf" in pairs:
            try:
                rsf = float(pairs["rsf"])
            except ValueError:
                raise PluginError(f"{where}'s rsf is a number, not {pairs['rsf']!r}.") from None
            if not rsf > 0:
                raise PluginError(f"{where}'s rsf must be more than 0.")
        gauss = 0.0
        if "gauss" in pairs:
            try:
                gauss = float(pairs["gauss"])
            except ValueError:
                raise PluginError(f"{where}'s gauss is a FWHM in eV, not {pairs['gauss']!r}.") from None
            if gauss < 0:
                raise PluginError(f"{where}'s gauss must be 0 or more.")
        components.append(Component(index, name, shape, values, rsf, gauss))
    return components
