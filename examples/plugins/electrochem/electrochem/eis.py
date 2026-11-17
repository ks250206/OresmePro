"""Equivalent-circuit fits of impedance spectra (EIS).

The impedance is Z = Z′ + j Z″ with j² = −1 and ω = 2π f (f in Hz). A
capacitive arc has Z″ < 0; Nyquist plots usually show −Z″ upwards, and
spectra are often saved that way, so the imaginary wave is read as −Z″ by
default (``imaginary="-Z''"``) or as Z″ itself (``imaginary="Z''"``). The
fitted imaginary part is handed back the same way as it was given, so it
lies over the data in the same plot.

Models (resistances in Ω, C in F, Q in F·s^(n−1), σ in Ω·s^(−1/2)):

* ``R(RC)``:   Z = R0 + R1 / (1 + jω R1 C1)
* ``R(RQ)``:   Z = R0 + R1 / (1 + R1 Q1 (jω)^n1)          (Q1, n1: a constant-phase element)
* ``Randles``: Z = R0 + 1 / (Q1 (jω)^n1 + 1 / (R1 + Zw)),  Zw = σ (1 − j) / √ω

``Randles`` is the usual circuit of a redox reaction at an electrode: the
solution resistance R0 in series with the double layer (a CPE) in parallel
with the charge-transfer resistance R1 and the semi-infinite (Warburg)
diffusion impedance in series.

The fit is a complex nonlinear least-squares fit (scipy.optimize.least_squares,
trust region) of the real and imaginary residuals stacked together. With
``weighting="modulus"`` (the default) each point's residuals are divided by
|Z| there, so that the small impedances at high frequency count as much as
the large ones at low frequency; ``"unit"`` leaves them as they are.
Resistances, capacitances, Q and σ are fitted as log10 (so they stay
positive and of any size), n1 between 0.2 and 1. Uncertainties come from
the Jacobian at the solution, scaled by the residual variance.

``eis_circuit`` fits a circuit written as text instead, such as
``R0-p(R1,CPE1)-W1`` (see circuit.py for how circuits are written), the
same way: from a guess made from the shape of the spectrum, or one given,
and from starts scattered around it.
"""

import numpy as np
from scipy.optimize import least_squares

from oresme_plugin import PluginError, action, wave

from .circuit import Circuit
from .common import numbers, same_length


def z_rc(p, w):
    R0, R1, C1 = p
    return R0 + R1 / (1 + 1j * w * R1 * C1)


def z_rq(p, w):
    R0, R1, Q1, n1 = p
    return R0 + R1 / (1 + R1 * Q1 * (1j * w) ** n1)


def z_randles(p, w):
    R0, R1, Q1, n1, sigma = p
    faradaic = R1 + sigma * (1 - 1j) / np.sqrt(w)
    return R0 + 1 / (Q1 * (1j * w) ** n1 + 1 / faradaic)


#: Each model: its parameters, which of them are fitted as log10, and its impedance.
MODELS = {
    "R(RC)": (("R0", "R1", "C1"), (True, True, True), z_rc),
    "R(RQ)": (("R0", "R1", "Q1", "n1"), (True, True, True, False), z_rq),
    "Randles": (("R0", "R1", "Q1", "n1", "sigma"), (True, True, True, False, True), z_randles),
}

#: Bounds of what is fitted: log10 of the positive parameters, and n itself.
LOG_BOUNDS = (-15.0, 15.0)
N_BOUNDS = (0.2, 1.0)


def from_fitted(u, logs):
    """Parameters from what the fit varies: 10**u for the log10 ones."""
    return np.array([10.0**v if lg else v for v, lg in zip(u, logs)])


def first_apex(minus_imag):
    """The index of the arc's top: the first clear maximum of −Z″ from high frequency down.

    Points are ordered from high to low frequency. A maximum is clear when it
    is above a fifth of the largest −Z″, so noise on the flat start does not
    count; a diffusion tail that rises past the arc does not hide it either.
    """
    n = len(minus_imag)
    smooth = minus_imag.copy()
    if n >= 5:
        smooth[1:-1] = (minus_imag[:-2] + minus_imag[1:-1] + minus_imag[2:]) / 3
    threshold = 0.2 * minus_imag.max()
    for k in range(1, n - 1):
        if smooth[k] > threshold and smooth[k] >= smooth[k - 1] and smooth[k] >= smooth[k + 1]:
            return k
    return int(np.argmax(minus_imag))


def initial_guesses(model, w, Z):
    """Starting points for the fit, from the shape of the spectrum.

    R0 is the real part at the highest frequency (the high-frequency
    intercept). At the top of an R∥C arc Z′ = R0 + R1/2 and ω R1 C1 = 1, so
    the top gives R1 and C1 (for a CPE, ω^n R1 Q1 = 1). For the Warburg
    coefficient, Z′ rises as σ/√ω at low frequency, past the arc.
    A few starting values of n and σ are tried, and the best fit is kept.
    """
    order = np.argsort(w)[::-1]
    w, Z = w[order], Z[order]
    re, minus_imag = Z.real, -Z.imag
    size = float(np.abs(Z).max())
    R0 = max(float(re[0]), 1e-6 * size)
    k = first_apex(minus_imag)
    R1 = 2 * (re[k] - R0)
    if not R1 > 0:
        R1 = max(float(re[-1] - R0), 0.1 * size)
    wk = w[k]
    if model == "R(RC)":
        return [[R0, R1, 1 / (wk * R1)]]
    if model == "R(RQ)":
        return [[R0, R1, 1 / (R1 * wk**n), n] for n in (0.9, 0.75, 1.0)]
    # Randles: σ from the slope of Z′ against ω^(−1/2) below the dip after the arc.
    dip = k + int(np.argmin(minus_imag[k:]))
    tail = np.arange(dip, len(w))
    sigma = 0.0
    if len(tail) >= 2:
        sigma = float(np.polyfit(w[tail] ** -0.5, re[tail], 1)[0])
    if not sigma > 0:
        sigma = 0.1 * R1 * np.sqrt(w[-1])
    return [
        [R0, R1, 1 / (R1 * wk**n), n, sigma * scale]
        for n in (0.9, 0.75)
        for scale in (1.0, 0.2, 5.0)
    ]


def read_spectrum(frequency, zre, zim, imaginary, weighting, f_min, f_max, k, what):
    """The measured impedance, which points are fitted, and their weights.

    Refuses a spectrum with too few usable frequencies for k parameters.
    """
    if imaginary not in ("-Z''", "Z''"):
        raise PluginError("imaginary is \"-Z''\" (the wave holds −Z″) or \"Z''\".")
    if weighting not in ("modulus", "unit"):
        raise PluginError("weighting is \"modulus\" or \"unit\".")
    f = numbers(frequency, "The frequency")
    re = numbers(zre, "Z′")
    im = numbers(zim, "Z″")
    same_length((f, frequency.name), (re, zre.name), (im, zim.name))
    # The impedance itself: Z″ negative for a capacitive arc.
    Z_all = re + 1j * (-im if imaginary == "-Z''" else im)
    use = np.isfinite(f) & np.isfinite(re) & np.isfinite(im) & (f > 0)
    if f_min is not None:
        use &= f >= float(f_min)
    if f_max is not None:
        use &= f <= float(f_max)
    N = int(use.sum())
    if 2 * N <= k:
        raise PluginError(
            f"The fit of {what} has {k} parameters and needs more than {k / 2:g} frequencies; "
            f"{N} are usable."
        )
    Z = Z_all[use]
    weight = 1 / np.abs(Z) if weighting == "modulus" else np.ones(N)
    if not np.all(np.isfinite(weight)):
        raise PluginError("|Z| is zero at some frequency: modulus weighting cannot be used.")
    return f, 2 * np.pi * f[use], Z, weight


def least_squares_fit(names, logs, impedance, starts, w, Z, weight):
    """The best of the fits from each start: parameters, their σ, χ², and warnings."""
    def residuals(u):
        with np.errstate(all="ignore"):
            d = (impedance(from_fitted(u, logs), w) - Z) * weight
        d = np.concatenate([d.real, d.imag])
        # Where the model overflows, a large residual steers the fit away rather than stopping it.
        return np.where(np.isfinite(d), d, 1e30)

    lower = np.array([LOG_BOUNDS[0] if lg else N_BOUNDS[0] for lg in logs])
    upper = np.array([LOG_BOUNDS[1] if lg else N_BOUNDS[1] for lg in logs])
    best = None
    for start in starts:
        with np.errstate(all="ignore"):
            u0 = np.array([np.log10(v) if lg else v for v, lg in zip(start, logs)], dtype=float)
        if not np.all(np.isfinite(u0)):
            continue
        u0 = np.clip(u0, lower + 1e-9, upper - 1e-9)
        try:
            fit = least_squares(residuals, u0, bounds=(lower, upper), method="trf",
                                x_scale="jac", ftol=1e-14, xtol=1e-14, gtol=1e-14,
                                max_nfev=5000)
        except ValueError:
            continue
        # A later start must do clearly better: on a tie (two branches that can be swapped),
        # the fit from the first start, the guess, is kept.
        if np.isfinite(fit.cost) and (best is None or fit.cost < best.cost * (1 - 1e-9)):
            best = fit
    if best is None:
        raise PluginError("The fit could not start from any initial guess.")

    k = len(names)
    N = len(w)
    p = from_fitted(best.x, logs)
    chisq = 2 * float(best.cost)
    freedom = 2 * N - k
    # Covariance of what was fitted from the Jacobian, scaled by the residual variance;
    # then for the parameters themselves: d(10**u)/du = ln(10) 10**u.
    J = best.jac
    cov_u = np.linalg.pinv(J.T @ J) * (chisq / freedom)
    scale = np.array([np.log(10) * v if lg else 1.0 for v, lg in zip(p, logs)])
    sigma = np.sqrt(np.clip(np.diag(cov_u), 0, None)) * np.abs(scale)

    warnings = []
    for name, active in zip(names, best.active_mask):
        if active != 0:
            warnings.append(f"{name} is at the bound of what it may be.")
    if not best.success:
        warnings.append(f"The fit did not converge: {best.message}")
    return {
        "p": p,
        "sigma": sigma,
        "chisq": chisq,
        "freedom": freedom,
        "frequencies": N,
        "warnings": warnings,
        "converged": bool(best.success),
        "message": str(best.message),
    }


def fit_outputs(names, impedance, fit, f, zre, zim, imaginary, weighting, extra):
    """The waves of the fitted curve and the values of a fit, as an action hands them back."""
    p, sigma, chisq, freedom = fit["p"], fit["sigma"], fit["chisq"], fit["freedom"]
    fitted = np.full(len(f), np.nan + 0j)
    good = np.isfinite(f) & (f > 0)
    with np.errstate(all="ignore"):
        fitted[good] = impedance(p, 2 * np.pi * f[good])
    zim_fit = -fitted.imag if imaginary == "-Z''" else fitted.imag
    return {
        "waves": {
            "zre_fit": wave(fitted.real, like=zre),
            "zim_fit": wave(zim_fit, like=zim),
        },
        "values": {
            **extra["head"],
            **dict(zip(names, p.tolist())),
            **{f"{name}_sigma": float(s) for name, s in zip(names, sigma)},
            **extra["tail"],
            "chisq": chisq,
            "chisq_reduced": chisq / freedom,
            "weighting": weighting,
            "frequencies": fit["frequencies"],
            "warnings": fit["warnings"],
            "result": {
                "names": list(names),
                "coef": p.tolist(),
                "sigma": sigma.tolist(),
                "chisq": chisq,
                "points": 2 * fit["frequencies"],
                "freedom": freedom,
                "converged": fit["converged"],
                "reason": " ".join(fit["warnings"]) or fit["message"],
            },
        },
    }


@action("eis_fit")
def eis_fit(frequency, zre, zim, model="Randles", imaginary="-Z''", weighting="modulus",
            f_min=None, f_max=None):
    if model not in MODELS:
        raise PluginError(f"Unknown model {model!r}; the models are {', '.join(MODELS)}.")
    names, logs, impedance = MODELS[model]
    f, w, Z, weight = read_spectrum(frequency, zre, zim, imaginary, weighting, f_min, f_max,
                                    len(names), model)
    fit = least_squares_fit(names, logs, impedance, initial_guesses(model, w, Z), w, Z, weight)
    params = dict(zip(names, fit["p"].tolist()))
    # The capacitance a CPE amounts to with R1 in parallel (Hsu & Mansfeld / Brug),
    # and the characteristic frequency of the arc.
    if model == "R(RC)":
        c_eff = params["C1"]
        tau = params["R1"] * params["C1"]
    else:
        n = params["n1"]
        c_eff = params["Q1"] ** (1 / n) * params["R1"] ** ((1 - n) / n)
        tau = (params["R1"] * params["Q1"]) ** (1 / n)
    return fit_outputs(names, impedance, fit, f, zre, zim, imaginary, weighting, {
        "head": {"model": model},
        "tail": {"C_eff": c_eff, "f_char": 1 / (2 * np.pi * tau)},
    })


#: How many starts besides the guess, scattered around it, the circuit fit tries.
SCATTERED_STARTS = 15


def scattered(guess, logs, count, seed=0):
    """Starts around a guess: a decade or so either way for log10 parameters, n from 0.6 to 1."""
    rng = np.random.default_rng(seed)
    starts = []
    for _ in range(count):
        starts.append([
            v * 10.0 ** rng.normal(0, 0.8) if lg else rng.uniform(0.6, 1.0)
            for v, lg in zip(guess, logs)
        ])
    return starts


@action("eis_circuit")
def eis_circuit(frequency, zre, zim, circuit="R0-p(R1,CPE1)", guess=None, imaginary="-Z''",
                weighting="modulus", f_min=None, f_max=None):
    model = Circuit(circuit)
    names, logs = model.names, model.logs
    f, w, Z, weight = read_spectrum(frequency, zre, zim, imaginary, weighting, f_min, f_max,
                                    len(names), circuit)
    if guess is not None:
        start = [float(v) for v in guess]
        if len(start) != len(names):
            raise PluginError(
                f"The starting values are {len(start)} numbers; the circuit has {len(names)} "
                f"parameters: {', '.join(names)}."
            )
        for name, value, lg in zip(names, start, logs):
            if lg and not value > 0:
                raise PluginError(f"The starting value of {name} must be positive, not {value:g}.")
            if not lg and not N_BOUNDS[0] <= value <= N_BOUNDS[1]:
                raise PluginError(f"The starting value of {name} must be between "
                                  f"{N_BOUNDS[0]:g} and {N_BOUNDS[1]:g}, not {value:g}.")
    else:
        start = model.initial_guess(w, Z)
    starts = [start, *scattered(start, logs, SCATTERED_STARTS)]
    fit = least_squares_fit(names, logs, model.impedance, starts, w, Z, weight)
    return fit_outputs(names, model.impedance, fit, f, zre, zim, imaginary, weighting, {
        "head": {"circuit": circuit, "parameters": list(names)},
        "tail": {},
    })
