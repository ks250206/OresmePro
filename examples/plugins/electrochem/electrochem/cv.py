"""Peaks of a cyclic voltammogram.

A CV goes back and forth in potential, so the potential is a wave of its
own (it cannot be the X scaling of the current). The record is cut into
sweeps where the potential turns; a positive-going (anodic) sweep holds the
oxidation peak and a negative-going (cathodic) one the reduction peak.

Sign convention: by default anodic (oxidation) currents are positive, as
IUPAC has it; ``convention="cathodic positive"`` reads data recorded the
other way (the older American convention). Peak currents are reported as
heights, positive, above the baseline (or above zero when there is none).
"""

import numpy as np

from oresme_plugin import PluginError, action, wave

from .common import interval, numbers, same_length, volts

#: A turn of the potential smaller than this share of its whole span is noise, not a turn.
TURN_TOLERANCE = 0.02


def sweep_bounds(E):
    """Where the potential turns: indices [0, t1, t2, ..., n-1] that bound monotonic sweeps.

    A zigzag search: the furthest point in the current direction is a turn
    once the potential has come back from it by more than a small share of
    its span, so steps and noise in a measured potential do not cut sweeps.
    """
    n = len(E)
    tolerance = TURN_TOLERANCE * (E.max() - E.min())
    bounds = [0]
    direction = 0
    extreme = 0
    for k in range(1, n):
        if direction == 0:
            if abs(E[k] - E[0]) > tolerance:
                direction = 1 if E[k] > E[0] else -1
                extreme = k
            continue
        if direction * (E[k] - E[extreme]) > 0:
            extreme = k
        elif direction * (E[extreme] - E[k]) > tolerance:
            bounds.append(extreme)
            direction = -direction
            extreme = k
    bounds.append(n - 1)
    return bounds


def sweeps(E):
    """The sweeps as (start, stop, direction), stop included; +1 is positive-going."""
    bounds = sweep_bounds(E)
    span = E.max() - E.min()
    found = []
    for start, stop in zip(bounds[:-1], bounds[1:]):
        if stop - start < 2 or abs(E[stop] - E[start]) <= TURN_TOLERANCE * span:
            continue
        found.append((start, stop, 1 if E[stop] > E[start] else -1))
    return found


def line_through(E, i, low, high, what):
    """Least-squares line i = a + b E over the points with low <= E <= high: (a, b)."""
    inside = (E >= low) & (E <= high)
    if inside.sum() < 2:
        raise PluginError(
            f"The {what} baseline range {low:g} to {high:g} V holds fewer than two points of that sweep."
        )
    b, a = np.polyfit(E[inside], i[inside], 1)
    return a, b


def find_peak(E, i, sign, window, baseline):
    """The peak of one sweep.

    ``sign`` is +1 for a maximum of the current (oxidation, anodic positive)
    and -1 for a minimum. ``baseline`` is (a, b) of a line i = a + b E, or
    None. The highest point is refined by a parabola through the points
    around it that are nearly as high, so the peak potential is not tied to
    the spacing of the points and noise is averaged.

    Returns (Ep, height, current at Ep, warning or None).
    """
    base = np.zeros_like(i) if baseline is None else baseline[0] + baseline[1] * E
    net = sign * (i - base)
    usable = np.ones(len(E), bool) if window is None else (E >= window[0]) & (E <= window[1])
    if usable.sum() < 3:
        raise PluginError("The peak search window holds fewer than three points of a sweep.")
    indices = np.flatnonzero(usable)
    k = indices[np.argmax(net[indices])]
    warning = None
    if k in (indices[0], indices[-1]):
        warning = "at the edge of the sweep or of the window: probably no peak there"
    # The contiguous points around k within three times the noise of the top, and at least
    # two either side. No more than that: peaks are not symmetric (a CV peak rises faster
    # than it falls), and a wider band would pull the vertex towards the slower side. The
    # noise is estimated from second differences of neighbouring points, in which the slope
    # of the curve itself cancels (for white noise their spread is √6 times its own).
    top = net[k]
    noise = np.std(np.diff(net[indices], 2)) / np.sqrt(6)
    floor = top - 3 * noise
    low = k
    while low - 1 >= indices[0] and (net[low - 1] >= floor or k - low < 2):
        low -= 1
    high = k
    while high + 1 <= indices[-1] and (net[high + 1] >= floor or high - k < 2):
        high += 1
    Ep, height = E[k], top
    if high - low >= 2:
        # Around E[k], so the fit is well conditioned whatever the potentials are.
        shift = E[low:high + 1] - E[k]
        c2, c1, c0 = np.polyfit(shift, net[low:high + 1], 2)
        if c2 < 0:
            vertex = -c1 / (2 * c2)
            if shift.min() <= vertex <= shift.max():
                Ep, height = E[k] + vertex, c0 - c1 * c1 / (4 * c2)
    # The current itself at Ep (for a marker on the curve): the baseline plus the height.
    at = (0.0 if baseline is None else baseline[0] + baseline[1] * Ep) + sign * height
    return float(Ep), float(height), float(at), warning


@action("cv_peaks")
def cv_peaks(current, potential, cycle=1, window=None, anodic_baseline=None,
             cathodic_baseline=None, convention="anodic positive"):
    i = numbers(current, "The current")
    E, factor = volts(potential, "The potential")
    same_length((i, current.name), (E, potential.name))
    finite = np.isfinite(i) & np.isfinite(E)
    if finite.sum() < 10:
        raise PluginError("A CV needs at least 10 points with numbers.")
    keep = np.flatnonzero(finite)
    i, E = i[keep], E[keep]
    # Ranges are given in volts, whatever the unit of the wave.
    window = interval(window, "The peak search window")
    anodic_range = interval(anodic_baseline, "The anodic baseline")
    cathodic_range = interval(cathodic_baseline, "The cathodic baseline")
    if convention not in ("anodic positive", "cathodic positive"):
        raise PluginError(f"Unknown sign convention {convention!r}.")
    # Oxidation is a maximum of the current under IUPAC's convention, a minimum under the other.
    ox = 1 if convention == "anodic positive" else -1

    found = sweeps(E)
    anodic = [item for item in found if item[2] > 0]
    cathodic = [item for item in found if item[2] < 0]
    cycle = int(cycle)
    if cycle < 1 or cycle > min(len(anodic), len(cathodic)):
        raise PluginError(
            f"There is no cycle {cycle}: the CV has {len(anodic)} positive-going and "
            f"{len(cathodic)} negative-going sweeps."
        )
    peaks = {}
    lines = {}
    warnings = []
    for label, (start, stop, _), sign, given in (
        ("anodic", anodic[cycle - 1], ox, anodic_range),
        ("cathodic", cathodic[cycle - 1], -ox, cathodic_range),
    ):
        Es, is_ = E[start:stop + 1], i[start:stop + 1]
        line = None if given is None else line_through(Es, is_, *given, label)
        Ep, height, at, warning = find_peak(Es, is_, sign, window, line)
        peaks[label] = (Ep, height, at)
        lines[label] = (start, stop, line, given)
        if warning:
            warnings.append(f"The {label} peak is {warning}.")

    Epa, ipa, at_a = peaks["anodic"]
    Epc, ipc, at_c = peaks["cathodic"]
    dEp = Epa - Epc
    E_half = (Epa + Epc) / 2
    ratio = ipa / ipc if ipc != 0 else float("nan")

    waves = {
        # Markers for the two peaks, to plot as peak_i against peak_E over the CV.
        "peak_E": wave(np.array([Epa, Epc]) / factor, like=potential, x0=0.0, dx=1.0),
        "peak_i": wave(np.array([at_a, at_c]), like=current, x0=0.0, dx=1.0),
    }
    if anodic_range or cathodic_range:
        # The baselines, drawn from their range to the peak: plotted against the potential.
        drawn = np.full(len(finite), np.nan)
        for label, (start, stop, line, given) in lines.items():
            if line is None:
                continue
            Ep = peaks[label][0]
            low, high = min(given[0], Ep), max(given[1], Ep)
            Es = E[start:stop + 1]
            on = (Es >= low) & (Es <= high)
            drawn[keep[start:stop + 1][on]] = line[0] + line[1] * Es[on]
        waves["baseline"] = wave(drawn, like=current)

    names = ["Epa", "Epc", "dEp", "E_half", "ipa", "ipc", "ratio"]
    coef = [Epa, Epc, dEp, E_half, ipa, ipc, ratio]
    return {
        "waves": waves,
        "values": {
            **dict(zip(names, coef)),
            "cycle": cycle,
            "sweeps": len(found),
            "warnings": warnings,
            "result": {
                "names": names,
                "coef": coef,
                "sigma": [None] * len(names),
                "points": int(len(E)),
                "freedom": 0,
                "converged": not warnings,
                "reason": " ".join(warnings),
            },
        },
    }
