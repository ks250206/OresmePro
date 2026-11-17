"""xps_fit: a peak model of one region, as CasaXPS fits one.

A region of the spectrum (binding energies from ... to ...), a background
under it computed from the data (Shirley, linear or none), and synthetic
components on top of it (see components.py for the table and shapes.py for
the line shapes). The positions, widths and areas of the components are
fitted by least squares (scipy.optimize.least_squares, trust region, within
the limits), with the background held as computed. Points are weighted by
1/√counts by default (Poisson noise, as CasaXPS does), or all alike.

Uncertainties of what is free come from the Jacobian at the solution,
scaled by the residual variance; a tied parameter takes the uncertainty of
the one it is tied to (times the factor), and a fixed one has none.
"""

import numpy as np
from scipy.optimize import least_squares

from oresme_plugin import PluginError, action, wave

from .common import AL_KA, binding_energies, interval, numbers, region_slice
from .common import background as make_background
from .components import PARAMS, parse_components

#: Colors of the components in the graph, in turn.
COLORS = ("#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e", "#17becf", "#e377c2", "#8c564b", "#bcbd22")


def _affine(components, area_scale):
    """How each parameter follows from what is fitted: value = coef · u[j] + const.

    Returns maps[i][param] = (j or None, coef, const) and the free parameters
    as (component index, param) in the order of u.
    """
    free = []
    slot = {}
    for c in components:
        for param in PARAMS:
            value = c.values[param]
            if value is None or value.kind == "free":
                slot[(c.index, param)] = len(free)
                free.append((c.index, param))
    done = {}

    def resolve(i, param, seen):
        key = (i, param)
        if key in done:
            return done[key]
        if key in seen:
            chain = " → ".join(f"{components[a].letter}.{p}" for a, p in [*seen, key])
            raise PluginError(f"The constraints go round in a circle: {chain}.")
        value = components[i].values[param]
        if value is None or value.kind == "free":
            out = (slot[key], area_scale if param == "area" else 1.0, 0.0)
        elif value.kind == "fixed":
            out = (None, 0.0, value.start)
        else:
            j, coef, const = resolve(value.ref, param, [*seen, key])
            if value.op is None:
                out = (j, coef, const)
            elif value.op == "+":
                out = (j, coef, const + value.amount)
            else:
                out = (j, coef * value.amount, const * value.amount)
        done[key] = out
        return out

    maps = [{param: resolve(c.index, param, []) for param in PARAMS} for c in components]
    return maps, free


def _value_of(rule, u):
    j, coef, const = rule
    return const if j is None else coef * u[j] + const


@action("xps_fit")
def xps_fit(spectrum, components, energy=None, region=None, background="Shirley",
            average=5, energy_axis="binding", photon_energy=AL_KA, shift=0.0,
            weighting="poisson"):
    if weighting not in ("poisson", "unit"):
        raise PluginError('weighting is "poisson" (1/√counts) or "unit".')
    y_all = numbers(spectrum, "The spectrum")
    be_all, scaled = binding_energies(spectrum, energy, energy_axis, photon_energy, shift)
    bounds = interval(region, "The region")
    start, stop = region_slice(be_all, y_all, bounds)
    be, y = be_all[start:stop], y_all[start:stop]
    bg = make_background(be, y, background, average)
    good = np.isfinite(be) & np.isfinite(y) & np.isfinite(bg)
    lo, hi = float(np.nanmin(be[good])), float(np.nanmax(be[good]))
    comps = parse_components(components, (lo, hi))

    net = y - bg
    peak = float(np.nanmax(np.abs(net[good])))
    if not peak > 0:
        raise PluginError("The region has nothing above its background to fit.")
    area_scale = peak  # a peak of this height and 1 eV wide, near enough
    maps, free = _affine(comps, area_scale)
    count = int(good.sum())
    if count <= len(free):
        raise PluginError(
            f"{len(free)} parameters are free but the region has only {count} points."
        )

    # Where the fit starts: the values given, and areas from the data's height at the position.
    u0 = np.zeros(len(free))
    lower = np.zeros(len(free))
    upper = np.zeros(len(free))
    order = np.argsort(be[good])
    for j, (i, param) in enumerate(free):
        value = comps[i].values[param]
        if param != "area" or value is not None:
            scale = area_scale if param == "area" else 1.0
            u0[j], lower[j], upper[j] = value.start / scale, value.low / scale, value.high / scale
    for j, (i, param) in enumerate(free):
        if param == "area" and comps[i].values["area"] is None:
            c = comps[i]
            pos = _value_of(maps[i]["pos"], u0)
            width = _value_of(maps[i]["fwhm"], u0)
            height = max(float(np.interp(pos, be[good][order], net[good][order])), 0.05 * peak)
            u0[j] = height * c.shape.unit_area * max(width, 1e-3) / area_scale
            lower[j], upper[j] = 0.0, np.inf
    span = np.where(np.isfinite(upper - lower), upper - lower, np.abs(u0) + 1.0)
    u0 = np.clip(u0, lower + 1e-9 * span, np.where(np.isfinite(upper), upper - 1e-9 * span, np.inf))

    x, data = be[good], y[good]
    floor = max(1e-3 * float(np.max(np.abs(data))), 1e-300)
    sigma = np.sqrt(np.clip(data, floor, None)) if weighting == "poisson" else np.ones(count)

    def curves(u, energies):
        return [
            c.shape.curve(energies, _value_of(maps[c.index]["pos"], u),
                          _value_of(maps[c.index]["fwhm"], u),
                          _value_of(maps[c.index]["area"], u), c.gauss)
            for c in comps
        ]

    base = bg[good]

    def residuals(u):
        return (base + np.sum(curves(u, x), axis=0) - data) / sigma

    try:
        fit = least_squares(residuals, u0, bounds=(lower, upper), method="trf", x_scale="jac",
                            ftol=1e-12, xtol=1e-12, gtol=1e-12, max_nfev=200 * (len(free) + 1))
    except ValueError as error:
        raise PluginError(f"The fit could not start: {error}") from None
    u = fit.x
    chisq = 2 * float(fit.cost)
    freedom = count - len(free)
    cov = np.linalg.pinv(fit.jac.T @ fit.jac) * (chisq / freedom)
    sigma_u = np.sqrt(np.clip(np.diag(cov), 0, None))

    warnings = []
    for (i, param), active in zip(free, fit.active_mask):
        if active != 0:
            warnings.append(f"{comps[i].letter}'s {param} is at a limit.")
    if not fit.success:
        warnings.append(f"The fit did not converge: {fit.message}")

    def estimate(i, param):
        j, coef, const = maps[i][param]
        value = const if j is None else coef * u[j] + const
        error = 0.0 if j is None else abs(coef) * sigma_u[j]
        return float(value), float(error)

    rows = []
    for c in comps:
        pos, pos_s = estimate(c.index, "pos")
        fwhm, fwhm_s = estimate(c.index, "fwhm")
        area, area_s = estimate(c.index, "area")
        if fwhm <= 0:
            warnings.append(f"{c.letter}'s fwhm came out {fwhm:g}; check its constraint.")
        rows.append({
            "letter": c.letter, "name": c.name, "shape": c.shape.text, "position": pos,
            "position_sigma": pos_s, "fwhm": fwhm, "fwhm_sigma": fwhm_s,
            "width": c.shape.width(fwhm, c.gauss) if fwhm > 0 else None,
            "area": area, "area_sigma": area_s, "rsf": c.rsf, "gauss": c.gauss,
            "constraints": {
                p: (c.values[p].describe() if c.values[p] is not None else "estimated")
                for p in PARAMS
            },
        })
    corrected = np.array([row["area"] / row["rsf"] for row in rows])
    total = corrected.sum()
    for row, part in zip(rows, corrected):
        row["percent"] = 100 * part / total if total > 0 else None

    # The waves, over the region: the data, the background, each component on the
    # background (as CasaXPS draws them), the envelope and the residual.
    parts = curves(u, be)
    envelope = bg + np.sum(parts, axis=0)
    if scaled:
        step = float(be[1] - be[0])
        like = {"x0": float(be[0]), "dx": step, "x_unit": "eV", "unit": spectrum.unit}
    else:
        like = {"unit": spectrum.unit}
    waves = {
        "region": wave(np.where(good, y, np.nan), **like),
        "background": wave(np.where(good, bg, np.nan), **like),
        "envelope": wave(np.where(good, envelope, np.nan), **like),
        "residual": wave(np.where(good, y - envelope, np.nan), **like),
    }
    for c, part in zip(comps, parts):
        waves[f"comp_{c.letter}"] = wave(np.where(good, bg + part, np.nan), **like)
    if not scaled:
        waves["be"] = wave(be, unit="eV")
    x_role = None if scaled else "be"

    traces = [{"y": "region", "x": x_role, "mode": "markers", "marker": "circle",
               "marker_size": 1.5, "color": "#000000", "legend": "Data"}]
    traces.append({"y": "background", "x": x_role, "color": "#808080", "line_size": 1,
                   "legend": f"Background ({background})"})
    for k, c in enumerate(comps):
        traces.append({"y": f"comp_{c.letter}", "x": x_role, "color": COLORS[k % len(COLORS)],
                       "line_size": 1, "legend": f"{c.letter}: {c.name}"})
    traces.append({"y": "envelope", "x": x_role, "color": "#d62728", "line_size": 1.5,
                   "legend": "Envelope"})
    traces.append({"y": "residual", "x": x_role, "axis": "right", "color": "#808080",
                   "line_size": 0.75})
    intensity = f"Intensity ({spectrum.unit})" if spectrum.unit else "Intensity"
    graph = {
        "name": "XPSFit",
        "traces": traces,
        "axes": {
            "bottom": {"label": "Binding Energy (eV)", "reverse": True},
            "left": {"label": intensity, "span": [0, 0.78]},
            "right": {"label": "Residual", "span": [0.82, 1]},
        },
        # At the top left, on the side of higher binding energy, where the background is
        # flat and the peaks seldom reach; moved down below the residual's band.
        "annotations": [{"kind": "legend", "anchor": "LT", "y": 0.2}],
    }

    names, coef, sigmas = [], [], []
    for row in rows:
        for key in ("position", "fwhm", "area"):
            names.append(f"{row['letter']}_{key}")
            coef.append(row[key])
            sigmas.append(row[f"{key}_sigma"])
        names.append(f"{row['letter']}_percent")
        coef.append(row["percent"])
        sigmas.append(None)
    return {
        "waves": waves,
        "values": {
            "components": rows,
            "region": [lo, hi],
            "background": background,
            "shift": float(shift),
            "chisq": chisq,
            "chisq_reduced": chisq / freedom,
            "residual_std": float(np.sqrt(chisq / freedom)),
            "points": count,
            "warnings": warnings,
            "result": {
                "names": names,
                "coef": coef,
                "sigma": sigmas,
                "chisq": chisq,
                "points": count,
                "freedom": freedom,
                "converged": bool(fit.success),
                "reason": " ".join(warnings) or str(fit.message),
            },
        },
        "graph": graph,
    }
