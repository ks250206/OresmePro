"""quantify: atomic concentrations from the areas of regions, as CasaXPS's regions give them.

The regions are written one per line (or per ``;``)::

    C 1s: 280 292 rsf=1
    O 1s: 526-538 rsf=2.93
    N 1s: 396 404 rsf=1.8

Each is looked for in the first spectrum whose energies cover it, so a
survey alone, or narrow scans of each region, both work. Under each region
a background is computed from the data (Shirley, linear or none), and the
area above it is integrated over binding energy. The concentration of each
region is in proportion to area / (RSF · KE^x), where KE = hν − BE at the
region's peak and x is ``ke_exponent`` (0, no correction, by default: for
sensitivity factors that already include the analyser's transmission and the
escape depth).
"""

import re

import numpy as np

from oresme_plugin import PluginError, action, wave

from .common import AL_KA, binding_energies, numbers
from .common import background as make_background

_NUM = r"[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)"
_RANGE = re.compile(rf"^({_NUM})\s*(?:-|–|\.\.|to|,|\s)\s*({_NUM})$")


def parse_regions(text):
    """The regions of a table: (name, low, high, rsf) each."""
    if not isinstance(text, str) or not text.strip():
        raise PluginError('The regions are empty: give at least one, e.g. "C 1s: 280 292 rsf=1".')
    regions = []
    for item in (item.strip() for item in re.split(r"[;\n]", text)):
        if not item:
            continue
        name, colon, rest = item.partition(":")
        if not colon or not name.strip():
            raise PluginError(f"{item!r}: a region is written name: from to rsf=..., e.g. C 1s: 280 292 rsf=1.")
        name = name.strip()
        rsf = 1.0
        match = re.search(r"\brsf\s*=\s*(\S+)", rest, re.IGNORECASE)
        if match:
            try:
                rsf = float(match.group(1))
            except ValueError:
                raise PluginError(f"The rsf of {name} is a number, not {match.group(1)!r}.") from None
            if not rsf > 0:
                raise PluginError(f"The rsf of {name} must be more than 0.")
            rest = rest[: match.start()] + rest[match.end():]
        found = _RANGE.match(rest.strip())
        if not found:
            raise PluginError(f"{name}: {rest.strip()!r} is not a range of binding energies, e.g. 280 292.")
        low, high = sorted((float(found.group(1)), float(found.group(2))))
        if low == high:
            raise PluginError(f"The range of {name} must not be empty.")
        regions.append((name, low, high, rsf))
    if len({name for name, *_ in regions}) != len(regions):
        raise PluginError("Two regions have the same name.")
    return regions


@action("quantify")
def quantify(spectra, regions, energies=None, background="Shirley", average=5,
             energy_axis="binding", photon_energy=AL_KA, shift=0.0, ke_exponent=0.0):
    if energies is not None and len(energies) != len(spectra):
        raise PluginError(
            f"There are {len(spectra)} spectra and {len(energies)} energy waves; give one energy "
            "wave for each spectrum, or none."
        )
    table = parse_regions(regions)
    data = []
    for index, spectrum in enumerate(spectra):
        y = numbers(spectrum, "A spectrum")
        be, _ = binding_energies(
            spectrum, None if energies is None else energies[index], energy_axis,
            photon_energy, shift,
        )
        data.append((spectrum, be, y, np.full(len(y), np.nan)))

    rows = []
    for name, low, high, rsf in table:
        source = None
        for index, (spectrum, be, y, _) in enumerate(data):
            finite = be[np.isfinite(be)]
            if len(finite) and finite.min() <= low and finite.max() >= high:
                source = index
                break
        if source is None:
            raise PluginError(f"No spectrum covers {name} ({low:g} to {high:g} eV).")
        spectrum, be, y, drawn = data[source]
        inside = np.nonzero((be >= low) & (be <= high) & np.isfinite(y))[0]
        if len(inside) < 5:
            raise PluginError(f"{name} ({low:g} to {high:g} eV) has fewer than 5 points.")
        start, stop = int(inside[0]), int(inside[-1]) + 1
        x, values = be[start:stop], y[start:stop]
        bg = make_background(x, values, background, average)
        drawn[start:stop] = np.where(np.isfinite(drawn[start:stop]), drawn[start:stop], bg)
        good = np.isfinite(x) & np.isfinite(values) & np.isfinite(bg)
        order = np.argsort(x[good])
        xs, net = x[good][order], (values - bg)[good][order]
        area = float(np.sum(0.5 * (net[1:] + net[:-1]) * np.diff(xs)))
        top = float(xs[int(np.argmax(net))])
        kinetic = float(photon_energy) - top
        if ke_exponent != 0 and not kinetic > 0:
            raise PluginError(f"The kinetic energy of {name} is not positive; check photon_energy.")
        corrected = area / (rsf * (kinetic ** float(ke_exponent) if ke_exponent != 0 else 1.0))
        rows.append({
            "name": name, "range": [low, high], "spectrum": spectrum.name, "position": top,
            "area": area, "rsf": rsf, "corrected": corrected,
        })
    total = sum(row["corrected"] for row in rows)
    warnings = []
    for row in rows:
        row["percent"] = 100 * row["corrected"] / total if total > 0 else None
        if row["area"] <= 0:
            warnings.append(f"{row['name']} has no area above its background.")

    waves = {}
    for index, (spectrum, _, _, drawn) in enumerate(data):
        if np.isfinite(drawn).any():
            role = "background" if len(data) == 1 else f"background{index + 1}"
            waves[role] = wave(drawn, like=spectrum)
    return {
        "waves": waves,
        "values": {
            "regions": rows,
            "background": background,
            "warnings": warnings,
            "result": {
                "names": [f"{row['name']} %" for row in rows],
                "coef": [row["percent"] for row in rows],
                "sigma": [None for _ in rows],
                "points": len(rows),
                "freedom": 0,
                "converged": not warnings,
                "reason": " ".join(warnings),
            },
        },
    }
