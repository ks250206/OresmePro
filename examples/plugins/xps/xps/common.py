"""What the actions share: energies, regions and backgrounds."""

import numpy as np

from oresme_plugin import PluginError

#: Photon energies of the usual laboratory sources (eV).
AL_KA = 1486.6

BACKGROUNDS = ("Shirley", "Linear", "None")


def numbers(w, what):
    """The values of a 1D real wave as float64; refuses anything else with a plain message."""
    data = np.asarray(w.data)
    if w.is_text:
        raise PluginError(f"{what} ({w.name}) must hold numbers, not text.")
    if data.ndim != 1:
        raise PluginError(f"{what} ({w.name}) must be a 1D wave, not {data.ndim}D.")
    if np.iscomplexobj(data):
        raise PluginError(f"{what} ({w.name}) must hold real numbers.")
    return data.astype(np.float64)


def binding_energies(spectrum, energy, energy_axis, photon_energy, shift):
    """The binding energy of each point of a spectrum, charge correction included.

    The energies are the ``energy`` wave if one is given, or else the
    spectrum's X scaling; kinetic energies are turned into binding energies
    as BE = hν − KE. ``shift`` is added to every binding energy (the charge
    correction: −0.8 when C 1s is seen at 285.6 eV instead of 284.8 eV).
    Returns the energies and whether they come from the scaling.
    """
    if energy_axis not in ("binding", "kinetic"):
        raise PluginError('energy_axis is "binding" or "kinetic".')
    count = len(spectrum)
    if energy is not None:
        values = numbers(energy, "The energy")
        if len(values) != count:
            raise PluginError(
                f"The energy wave ({energy.name}) has {len(values)} points and the spectrum "
                f"({spectrum.name}) {count}; they must have as many."
            )
    else:
        values = spectrum.x0 + spectrum.dx * np.arange(count, dtype=np.float64)
    if energy_axis == "kinetic":
        values = float(photon_energy) - values
    return values + float(shift), energy is None


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


def region_slice(be, y, bounds, what="The region"):
    """The run of points (start, stop) whose binding energies lie in ``bounds`` (all if None).

    The energies must rise or fall steadily there, as a spectrum's do.
    """
    good = np.isfinite(be) & np.isfinite(y)
    inside = good if bounds is None else good & (be >= bounds[0]) & (be <= bounds[1])
    index = np.nonzero(inside)[0]
    if len(index) < 5:
        span = "the spectrum" if bounds is None else f"{bounds[0]:g} to {bounds[1]:g} eV"
        raise PluginError(f"{what} ({span}) has {len(index)} usable points; it needs at least 5.")
    start, stop = int(index[0]), int(index[-1]) + 1
    steps = np.diff(be[start:stop][good[start:stop]])
    if not (np.all(steps > 0) or np.all(steps < 0)):
        raise PluginError(f"The energies must rise or fall steadily across {what.lower()}.")
    return start, stop


def background(be, y, method, average):
    """The background under the points (be, y) of a region: Shirley, linear or none.

    The levels at the two ends are the means of ``average`` points there. The
    Shirley background rises from the level at the low binding energy end to
    the level at the high end in proportion to the peak area (data above the
    background) at lower binding energy, found by iterating until it settles.
    Points that are not finite stay NaN.
    """
    if method not in BACKGROUNDS:
        raise PluginError(f"The background is one of {', '.join(BACKGROUNDS)}.")
    out = np.full(len(y), np.nan)
    good = np.isfinite(be) & np.isfinite(y)
    order = np.nonzero(good)[0]
    order = order[np.argsort(be[order])]
    x, data = be[order], y[order]
    if method == "None":
        out[order] = 0.0
        return out
    count = int(average)
    if count < 1 or 2 * count > len(x):
        raise PluginError(
            f"The ends are averaged over {count} points; the region has {len(x)}, "
            f"so it is 1 to {len(x) // 2}."
        )
    low, high = float(data[:count].mean()), float(data[-count:].mean())
    if method == "Linear":
        out[order] = low + (high - low) * (x - x[0]) / (x[-1] - x[0])
        return out
    level = np.full(len(x), low)
    tolerance = 1e-7 * max(abs(high - low), abs(high), abs(low), 1e-300)
    for _ in range(200):
        net = data - level
        cumulative = np.concatenate(
            [[0.0], np.cumsum(0.5 * (net[1:] + net[:-1]) * np.diff(x))]
        )
        total = cumulative[-1]
        if not total > 0:
            raise PluginError(
                "There is no peak above the background to build a Shirley background on; "
                "choose a wider region, or a Linear background."
            )
        new = low + (high - low) * cumulative / total
        settled = np.max(np.abs(new - level)) < tolerance
        level = new
        if settled:
            out[order] = level
            return out
    raise PluginError("The Shirley background did not settle in 200 iterations.")
