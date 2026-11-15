"""Tafel analysis: the slope of log10|i| against the potential, and the exchange current.

Far enough from equilibrium (|η| well above RT/F, about 26 mV at 25 °C),
one branch of the Butler–Volmer equation dominates and

    log10 |j| = log10 j0 + η / b,        η = E − E_eq

so a straight line through log10|j| against η over a chosen range gives
the Tafel slope b (in mV per decade of current; positive on the anodic
branch, negative on the cathodic one) and, extrapolated to η = 0, the
exchange current density j0. The transfer coefficient follows from
b = ln(10) R T / (α F).

The line is fitted by ordinary least squares in log10|j|; the
uncertainties come from its covariance matrix scaled by the residual
variance (no error bars are assumed for the data).
"""

import numpy as np

from oresme_plugin import PluginError, action, wave

from .common import FARADAY, GAS, interval, numbers, same_length, volts


@action("tafel")
def tafel(current, potential, e_from, e_to, e_eq=0.0, area=1.0, temperature=298.15):
    i = numbers(current, "The current")
    E, _ = volts(potential, "The potential")
    same_length((i, current.name), (E, potential.name))
    low, high = interval([e_from, e_to], "The fit range")
    area = float(area)
    temperature = float(temperature)
    if not area > 0:
        raise PluginError("The electrode area must be positive.")
    if not temperature > 0:
        raise PluginError("The temperature is in kelvin and must be positive.")

    # Current density (the current itself with area 1) and overpotential, in V.
    j = i / area
    eta = E - float(e_eq)
    inside = np.isfinite(j) & np.isfinite(E) & (E >= low) & (E <= high) & (j != 0)
    n = int(inside.sum())
    if n < 3:
        raise PluginError(
            f"The range {low:g} to {high:g} V holds {n} points with a current that is not zero; "
            "a Tafel fit needs at least 3."
        )
    warnings = []
    signs = np.sign(j[inside])
    if signs.min() != signs.max():
        warnings.append("The current changes sign in the range: it is not a Tafel region.")

    x = eta[inside]
    y = np.log10(np.abs(j[inside]))
    # y = a + b x by least squares, with the covariance of (a, b).
    X = np.column_stack([np.ones(n), x])
    (a, b), *_ = np.linalg.lstsq(X, y, rcond=None)
    residuals = y - (a + b * x)
    rss = float(residuals @ residuals)
    variance = rss / (n - 2) if n > 2 else 0.0
    cov = variance * np.linalg.inv(X.T @ X)
    sigma_a, sigma_b = np.sqrt(np.diag(cov))
    if b == 0:
        raise PluginError("log10|i| does not change in the range: there is no Tafel slope.")

    slope = 1000.0 / b  # mV/dec
    sigma_slope = 1000.0 * sigma_b / b**2
    j0 = 10.0**a
    sigma_j0 = j0 * np.log(10) * sigma_a
    # Transfer coefficient (α n) from b = ln(10) R T / (α F).
    alpha = np.log(10) * GAS * temperature * abs(b) / FARADAY
    sigma_alpha = np.log(10) * GAS * temperature * sigma_b / FARADAY
    r2 = 1 - rss / float(((y - y.mean()) ** 2).sum()) if n > 2 else 1.0

    # |j| of the data, and the line from η = 0 (where it gives j0) to the far end of the range.
    fitted = np.full(len(E), np.nan)
    reach = (eta >= min(0.0, low - float(e_eq))) & (eta <= max(0.0, high - float(e_eq)))
    reach &= np.isfinite(eta)
    fitted[reach] = 10.0 ** (a + b * eta[reach])

    names = ["slope_mV_per_dec", "j0", "log10_j0", "alpha"]
    coef = [slope, j0, a, alpha]
    sigma = [sigma_slope, sigma_j0, sigma_a, sigma_alpha]
    return {
        "waves": {
            "abs": wave(np.abs(j), like=current),
            "fit": wave(fitted, like=current),
        },
        "values": {
            **dict(zip(names, coef)),
            **{f"{name}_sigma": value for name, value in zip(names, sigma)},
            "branch": "anodic" if b > 0 else "cathodic",
            "r_squared": r2,
            "points": n,
            "warnings": warnings,
            "result": {
                "names": names,
                "coef": coef,
                "sigma": sigma,
                "chisq": rss,
                "points": n,
                "freedom": n - 2,
                "converged": not warnings,
                "reason": " ".join(warnings),
            },
        },
    }
