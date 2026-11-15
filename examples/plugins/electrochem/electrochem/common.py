"""What the actions share: reading waves as numbers, units, and a few constants."""

import numpy as np

from oresme_plugin import PluginError

#: Faraday constant (C/mol) and gas constant (J/(mol K)), CODATA 2018.
FARADAY = 96485.33212
GAS = 8.314462618

#: The factor that turns a potential in a wave's unit into volts.
_TO_VOLTS = {"": 1.0, "V": 1.0, "mV": 1e-3, "µV": 1e-6, "uV": 1e-6, "kV": 1e3}


def numbers(w, what):
    """The values of a 1D real wave as float64; refuses anything else with a plain message."""
    data = np.asarray(w.data)
    if data.ndim != 1:
        raise PluginError(f"{what} ({w.name}) must be a 1D wave, not {data.ndim}D.")
    if np.iscomplexobj(data):
        raise PluginError(f"{what} ({w.name}) must hold real numbers.")
    return data.astype(np.float64)


def volts(w, what):
    """A potential wave in volts, and the factor it was multiplied by (to go back)."""
    factor = _TO_VOLTS.get(w.unit.strip(), 1.0)
    return numbers(w, what) * factor, factor


def same_length(*pairs):
    """Checks that waves that go together (E and i, f and Z) have as many points."""
    lengths = {len(values) for values, _ in pairs}
    if len(lengths) > 1:
        described = ", ".join(f"{name} has {len(values)}" for values, name in pairs)
        raise PluginError(f"The waves must have as many points as each other: {described}.")


def interval(values, what):
    """Two numbers given as a range, in increasing order, or None when not given."""
    if values is None:
        return None
    values = [float(item) for item in values]
    if len(values) != 2 or not all(np.isfinite(values)):
        raise PluginError(f"{what} is a range: two numbers, from and to.")
    low, high = sorted(values)
    if low == high:
        raise PluginError(f"{what} must not be empty ({low} to {high}).")
    return low, high
