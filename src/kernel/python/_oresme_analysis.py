"""Analysis operations for OresmePro: curve fitting and common wave operations.

These are part of the ``oresme`` module (``op.fit``, ``op.stats``, ...). They
need only NumPy.
"""

import inspect

import numpy as np

import oresme as _op

__all__ = [
    "FitResult",
    "PeakFitResult",
    "fit",
    "fit_functions",
    "find_peaks",
    "fit_peaks",
    "interpolate",
    "filter_image",
    "line_profile",
    "stats",
    "differentiate",
    "integrate",
    "smooth",
    "fft",
    "ifft",
    "histogram",
]


def _span(x):
    return float(np.ptp(x)) or 1.0


def _peak(x, y):
    """Baseline, signed height and position of the most prominent peak or dip."""
    base = float(np.median(y))
    up = float(y.max()) - base
    down = base - float(y.min())
    index = int(np.argmax(y) if up >= down else np.argmin(y))
    height = float(y[index]) - base
    # Half the width at half height, measured from the samples.
    above = np.abs(y - base) >= abs(height) / 2
    half_width = max(float(np.ptp(x[above])) / 2, _span(x) / len(x)) if above.any() else _span(x) / 6
    return base, height, float(x[index]), half_width


def _guess_sin(x, y):
    offset = float(y.mean())
    spectrum = np.abs(np.fft.rfft(y - offset))
    frequency = np.fft.rfftfreq(len(y), d=_span(x) / max(1, len(y) - 1))
    peak = int(np.argmax(spectrum[1:]) + 1) if len(spectrum) > 1 else 0
    return [offset, float(np.ptp(y)) / 2, 2 * np.pi * float(frequency[peak]), 0.0]


def _guess_exp(x, y):
    return [float(y[-1]), float(y[0] - y[-1]), _span(x) / 3]


def _guess_sigmoid(x, y):
    rising = y[-1] >= y[0]
    return [
        float(y.min()),
        float(np.ptp(y)),
        float(x[np.argmin(np.abs(y - (y.min() + np.ptp(y) / 2)))]),
        (_span(x) / 10) * (1 if rising else -1),
    ]


# name: (function, parameter names, initial guess, description)
_FUNCTIONS = {
    "line": (
        lambda x, a, b: a + b * x,
        ("a", "b"),
        lambda x, y: [float(y.mean()), 0.0],
        "a + b*x",
    ),
    "gauss": (
        lambda x, y0, A, x0, width: y0 + A * np.exp(-(((x - x0) / width) ** 2)),
        ("y0", "A", "x0", "width"),
        lambda x, y: (lambda b, h, c, w: [b, h, c, w / 0.8326])(*_peak(x, y)),
        "y0 + A*exp(-((x-x0)/width)^2)",
    ),
    "lor": (
        lambda x, y0, A, x0, B: y0 + A / ((x - x0) ** 2 + B),
        ("y0", "A", "x0", "B"),
        lambda x, y: (lambda b, h, c, w: [b, h * w * w, c, w * w])(*_peak(x, y)),
        "y0 + A/((x-x0)^2 + B)",
    ),
    "exp": (
        lambda x, y0, A, tau: y0 + A * np.exp(-x / tau),
        ("y0", "A", "tau"),
        lambda x, y: (lambda p: [p[0], p[1] * np.exp(x[0] / p[2]), p[2]])(_guess_exp(x, y)),
        "y0 + A*exp(-x/tau)",
    ),
    "dblexp": (
        lambda x, y0, A1, tau1, A2, tau2: y0 + A1 * np.exp(-x / tau1) + A2 * np.exp(-x / tau2),
        ("y0", "A1", "tau1", "A2", "tau2"),
        lambda x, y: [
            float(y[-1]),
            float(y[0] - y[-1]) / 2,
            _span(x) / 10,
            float(y[0] - y[-1]) / 2,
            _span(x) / 2,
        ],
        "y0 + A1*exp(-x/tau1) + A2*exp(-x/tau2)",
    ),
    "sin": (
        lambda x, y0, A, f, phi: y0 + A * np.sin(f * x + phi),
        ("y0", "A", "f", "phi"),
        _guess_sin,
        "y0 + A*sin(f*x + phi)",
    ),
    "power": (
        lambda x, y0, A, pow: y0 + A * np.power(x, pow),
        ("y0", "A", "pow"),
        lambda x, y: [0.0, float(y[-1]) / (float(x[-1]) or 1.0), 1.0],
        "y0 + A*x^pow",
    ),
    "sigmoid": (
        lambda x, base, max, xhalf, rate: base + max / (1 + np.exp((xhalf - x) / rate)),
        ("base", "max", "xhalf", "rate"),
        _guess_sigmoid,
        "base + max/(1 + exp((xhalf-x)/rate))",
    ),
}


def fit_functions():
    """The built-in fit functions and their formulas. ``polyN`` fits a polynomial."""
    table = {name: entry[3] for name, entry in _FUNCTIONS.items()}
    table["poly2 ... poly9"] = "K0 + K1*x + K2*x^2 + ..."
    return table


def _resolve(function, x, y, guess):
    """The callable, its parameter names and a starting point."""
    if callable(function):
        names = tuple(inspect.signature(function).parameters)[1:]
        if guess is None:
            raise _op.OresmeError("A custom fit function needs guess=[...], one value per parameter.")
        return function, names, list(guess), getattr(function, "__name__", "custom")
    if isinstance(function, str) and function.startswith("poly") and function[4:].isdigit():
        terms = int(function[4:])
        if not 2 <= terms <= 9:
            raise _op.OresmeError("Polynomial fits are poly2 (a line) to poly9.")
        names = tuple(f"K{index}" for index in range(terms))

        def poly(x, *coefficients):
            return np.polynomial.polynomial.polyval(x, coefficients)

        start = [float(y.mean())] + [0.0] * (terms - 1)
        return poly, names, start if guess is None else list(guess), function
    if function not in _FUNCTIONS:
        raise _op.OresmeError(
            f"Unknown fit function {function!r}. Built in: {', '.join(_FUNCTIONS)}, polyN."
        )
    model, names, guesser, _ = _FUNCTIONS[function]
    return model, names, guesser(x, y) if guess is None else list(guess), function


def _jacobian(model, x, params):
    columns = []
    for index, value in enumerate(params):
        step = 1e-6 * max(abs(value), 1e-6)
        up = params.copy()
        down = params.copy()
        up[index] += step
        down[index] -= step
        columns.append((model(x, *up) - model(x, *down)) / (2 * step))
    return np.column_stack(columns)


def _damped_step(jacobian, residual, free, damping):
    """The Levenberg-Marquardt step for the ``free`` parameters; the others stay put."""
    step = np.zeros(jacobian.shape[1])
    if not free.any():
        return step
    columns = jacobian[:, free]
    # Columns of unit length, so that the damping weighs every parameter alike
    # and the solve does not depend on the units of the parameters.
    norms = np.sqrt(np.sum(columns**2, axis=0))
    norms[norms == 0] = 1.0
    columns = columns / norms
    target = residual
    if damping:
        columns = np.vstack([columns, np.sqrt(damping) * np.eye(columns.shape[1])])
        target = np.concatenate([residual, np.zeros(columns.shape[1])])
    step[free] = np.linalg.lstsq(columns, target, rcond=None)[0] / norms
    return step


def _least_squares(model, x, y, start, weights=None, lower=None, upper=None, max_iterations=200):
    """Levenberg-Marquardt within bounds. Returns (parameters, covariance, chi-square, converged).

    ``weights`` multiply the residuals (1/sigma per point). ``lower`` and
    ``upper`` bound the parameters. A parameter on a bound that the fit pushes
    outward is held there and the step is solved for the others; it is let go
    once the fit pulls it back inside. ``converged`` is true only where the
    linearised model promises no further reduction of chi-square worth having.
    """
    params = np.array(start, dtype=float)
    lower = np.full(len(params), -np.inf) if lower is None else np.asarray(lower, dtype=float)
    upper = np.full(len(params), np.inf) if upper is None else np.asarray(upper, dtype=float)
    params = np.clip(params, lower, upper)
    scale = 1.0 if weights is None else weights

    def residuals(values):
        return (y - model(x, *values)) * scale

    def jacobian_at(values):
        jacobian = _jacobian(model, x, values)
        return jacobian if weights is None else jacobian * weights[:, None]

    def pushed_out(direction, among):
        """Parameters on a bound that ``direction`` would carry past it."""
        return among & (((params <= lower) & (direction < 0)) | ((params >= upper) & (direction > 0)))

    with np.errstate(all="ignore"):
        residual = residuals(params)
        chi = float(residual @ residual)
        if not np.isfinite(chi):
            raise _op.OresmeError("The fit function is not finite at the starting guess.")
        # Chi-square cannot be resolved more finely than the rounding of the data.
        floor = (16 * np.finfo(float).eps * float(np.linalg.norm(y * scale))) ** 2
        damping = 1e-3
        converged = False
        for _ in range(max_iterations):
            jacobian = jacobian_at(params)
            free = ~pushed_out(jacobian.T @ residual, np.ones(len(params), dtype=bool))
            if not free.any():
                converged = True
                break
            # What a full Gauss-Newton step could still gain: the part of the
            # residual that the free parameters can reach.
            gain = float(np.sum((jacobian @ _damped_step(jacobian, residual, free, 0.0)) ** 2))
            if not gain > 1e-12 * chi + floor:
                converged = True
                break
            improved = False
            while damping < 1e12:
                moving = free.copy()
                step = _damped_step(jacobian, residual, moving, damping)
                # Coupling can still push a parameter on its bound outward;
                # hold it too and solve again for the rest.
                while (outward := pushed_out(step, moving)).any():
                    moving &= ~outward
                    step = _damped_step(jacobian, residual, moving, damping)
                trial = np.clip(params + step, lower, upper)
                trial_residual = residuals(trial)
                trial_chi = float(trial_residual @ trial_residual)
                if np.isfinite(trial_chi) and trial_chi < chi:
                    params, residual, chi = trial, trial_residual, trial_chi
                    damping = max(damping / 10, 1e-12)
                    improved = True
                    break
                damping *= 10
            if not improved:
                break
        jacobian = jacobian_at(params)
        freedom = max(1, len(y) - len(params))
        try:
            covariance = np.linalg.inv(jacobian.T @ jacobian)
            # Without per-point uncertainties, they are estimated from the scatter.
            if weights is None:
                covariance = covariance * chi / freedom
        except np.linalg.LinAlgError:
            covariance = np.full((len(params), len(params)), np.nan)
    return params, covariance, chi, converged


def _index_of(names, name, what):
    if name not in names:
        raise _op.OresmeError(f"{what}: no parameter named {name!r}. Parameters: {', '.join(names)}.")
    return names.index(name)


class FitResult:
    """The outcome of ``op.fit``: coefficients, their uncertainties and the fit wave."""

    def __init__(self, function, names, coef, sigma, chisq, points, wave, converged, held=(),
                 residuals=None, band=None):
        self.held = tuple(held)
        #: The wave of residuals (data minus fit), if ``residuals=True`` was given.
        self.residuals = residuals
        #: The (lower, upper) waves of the confidence band, if ``band`` was given.
        self.band = band
        self.function = function
        self.names = tuple(names)
        self.coef = coef
        self.sigma = sigma
        self.chisq = chisq
        self.points = points
        self.wave = wave
        self.converged = converged

    def __getitem__(self, name):
        return float(self.coef[self.names.index(name)])

    def __repr__(self):
        return f"FitResult({self.function}, chisq={self.chisq:.6g})"

    def __str__(self):
        lines = [f"Fit: {self.function}, {self.points} points, chi-square = {self.chisq:.6g}"]
        if not self.converged:
            lines.append("  (did not converge; showing the best parameters found)")
        width = max(len(name) for name in self.names)
        for name, value, error in zip(self.names, self.coef, self.sigma):
            if name in self.held:
                lines.append(f"  {name:<{width}} = {value:.6g} (held)")
                continue
            lines.append(f"  {name:<{width}} = {value:.6g} ± {error:.3g}")
        return "\n".join(lines)


def _normal_quantile(p):
    """The value below which a standard normal variable falls with probability p (Acklam)."""
    a = (-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00)
    b = (-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00)
    if p < 0.02425:
        q = np.sqrt(-2 * np.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1
        )
    if p > 1 - 0.02425:
        return -_normal_quantile(1 - p)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (
        ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1
    )


def _student_quantile(p, freedom):
    """The same for Student's t with ``freedom`` degrees of freedom (Cornish-Fisher)."""
    z = _normal_quantile(p)
    n = float(freedom)
    return (
        z
        + (z**3 + z) / (4 * n)
        + (5 * z**5 + 16 * z**3 + 3 * z) / (96 * n**2)
        + (3 * z**7 + 19 * z**5 + 17 * z**3 - 15 * z) / (384 * n**3)
    )


def _stack_axis(graph, source, name):
    """An axis for residuals above the data's own axis, made the first time it is needed."""
    axes = graph._info()["axes"]
    if name not in axes:
        low, high = axes[source]["span"]
        graph.add_axis(name, axes[source]["side"])
        split = low + (high - low) * 0.75
        graph.axis(source).span = (low, split - 0.03)
        graph.axis(name).span = (split + 0.03, high)
    return name


def fit(function, y, x=None, *, guess=None, hold=None, bounds=None, sigma=None, range=None,
        cursors=False, graph=None, name=None, quiet=False, residuals=False, band=None):
    """Fit a function to a wave by least squares.

    ``function`` is the name of a built-in function (see ``op.fit_functions()``),
    ``"polyN"`` for a polynomial with N terms, or your own
    ``f(x, p1, p2, ...)`` together with ``guess=[...]``.

    ``hold`` keeps parameters fixed: ``hold={"y0": 0}`` at a value, or
    ``hold=["y0"]`` at its starting guess. ``bounds={"A": (0, None)}`` keeps a
    parameter within limits (None for no limit on that side).

    ``sigma`` weights the points by their standard deviations: a wave or array
    with one value per point, or a single number. The parameter uncertainties
    are then taken from those; without ``sigma`` they are estimated from the
    scatter of the data around the fit.

    ``x`` is an X wave; without it the wave's X scaling is used. ``range=(a, b)``
    limits the fit to points a..b inclusive; ``cursors=True`` uses the points
    between cursors A and B of the graph.

    ``residuals=True`` also makes ``res_<name>`` (data minus fit) and shows it
    on an axis of its own above the data. ``band=0.95`` makes
    ``fit_<name>_lo`` and ``fit_<name>_hi``, the confidence band of the fitted
    curve at that level, drawn as a shaded band.

    Makes a wave ``fit_<name>`` with the fitted curve and adds it to the graph
    showing the data, and stores the coefficients in ``W_coef`` and their
    standard deviations in ``W_sigma``. Returns a ``FitResult``.
    """
    y_wave = _op.wave(_op._wave_name(y))
    x_wave = None if x is None else _op.wave(_op._wave_name(x))
    y_values = np.asarray(y_wave.data, dtype=float)
    if y_values.ndim != 1:
        raise _op.OresmeError("Only 1-D waves can be fitted.")
    x_values = np.asarray(y_wave.x if x_wave is None else x_wave.data, dtype=float)
    if len(x_values) != len(y_values):
        raise _op.OresmeError("The X and Y waves have different lengths.")

    leaf = y_wave.name.rsplit(":", 1)[-1]
    target = None
    for candidate in [graph] if graph is not None else reversed(_op.graphs()):
        candidate = _op.graph(candidate) if isinstance(candidate, str) else candidate
        if any(trace["y"] == y_wave.name for trace in candidate._info()["traces"]):
            target = candidate
            break

    first, last = 0, len(y_values) - 1
    if cursors:
        if target is None:
            raise _op.OresmeError("cursors=True needs a graph that shows the wave.")
        marks = target._info()["cursors"]
        if "A" not in marks or "B" not in marks:
            raise _op.OresmeError("Put cursors A and B on the graph first.")
        first, last = sorted((marks["A"]["point"], marks["B"]["point"]))
    elif range is not None:
        first, last = sorted((int(range[0]), int(range[1])))
    first, last = max(0, first), min(len(y_values) - 1, last)

    x_fit = x_values[first : last + 1]
    y_fit = y_values[first : last + 1]
    keep = np.isfinite(x_fit) & np.isfinite(y_fit)
    weights = None
    if sigma is not None:
        if isinstance(sigma, (str, _op.Wave)):
            sigma = _op.wave(_op._wave_name(sigma)).data
        errors = np.broadcast_to(np.asarray(sigma, dtype=float), y_values.shape)[first : last + 1]
        keep &= np.isfinite(errors) & (errors > 0)
        weights = 1.0 / errors[keep]
    x_fit, y_fit = x_fit[keep], y_fit[keep]
    model, names, start, label = _resolve(function, x_fit, y_fit, guess)
    if len(start) != len(names):
        raise _op.OresmeError(f"{label} has {len(names)} parameters; the guess has {len(start)}.")

    full = np.array(start, dtype=float)
    held = []
    if isinstance(hold, dict):
        for key, value in hold.items():
            full[_index_of(names, key, "hold")] = float(value)
            held.append(key)
    elif hold is not None:
        held = [names[_index_of(names, key, "hold")] for key in hold]
    free = [index for index, key in enumerate(names) if key not in held]
    if not free:
        raise _op.OresmeError("Every parameter is held; there is nothing to fit.")
    if len(y_fit) <= len(free):
        raise _op.OresmeError(f"{len(y_fit)} points are not enough to fit {len(free)} parameters.")
    lower = np.full(len(names), -np.inf)
    upper = np.full(len(names), np.inf)
    for key, (low, high) in (bounds or {}).items():
        at = _index_of(names, key, "bounds")
        lower[at] = -np.inf if low is None else float(low)
        upper[at] = np.inf if high is None else float(high)
        if lower[at] >= upper[at]:
            raise _op.OresmeError(f"bounds: the limits for {key!r} are empty.")

    def reduced(x_, *values):
        trial = full.copy()
        trial[free] = values
        return model(x_, *trial)

    best, free_covariance, chisq, converged = _least_squares(
        reduced, x_fit, y_fit, full[free], weights, lower[free], upper[free]
    )
    params = full.copy()
    params[free] = best
    sigma = np.zeros(len(names))
    sigma[free] = np.sqrt(np.abs(np.diag(free_covariance)))

    fit_name = name or (y_wave.name.rsplit(":", 1)[0] + ":" if ":" in y_wave.name else "") + f"fit_{leaf}"
    with np.errstate(all="ignore"):
        if x_wave is None:
            grid = np.linspace(x_fit.min(), x_fit.max(), 200)
            fit_wave = _op.make(
                fit_name,
                model(grid, *params),
                x0=grid[0],
                dx=(grid[1] - grid[0]) or 1.0,
                x_unit=y_wave.x_unit,
                unit=y_wave.unit,
            )
        else:
            curve = np.full(len(y_values), np.nan)
            curve[first : last + 1] = model(x_values[first : last + 1], *params)
            fit_wave = _op.make(fit_name, curve, unit=y_wave.unit)
    _op.make("W_coef", params)
    _op.make("W_sigma", sigma)

    folder = y_wave.name.rsplit(":", 1)[0] + ":" if ":" in y_wave.name else ""
    source = None
    if target is not None:
        source = next(t for t in target._info()["traces"] if t["y"] == y_wave.name)

    def show(wave_, x_=x_wave, axis=None, **style):
        """Adds a result wave to the graph of the data, once."""
        if target is None or any(t["y"] == wave_.name for t in target._info()["traces"]):
            return
        target.append(wave_, x=x_, axis=axis or source["vAxis"], haxis=source["hAxis"])
        target.trace(wave_.name.rsplit(":", 1)[-1]).set(**style)

    band_waves = None
    if band:
        level = 0.95 if band is True else float(band)
        if not 0 < level < 1:
            raise _op.OresmeError("band must be a confidence level between 0 and 1, such as 0.95.")
        freedom = max(1, len(y_fit) - len(free))
        reach = _student_quantile(0.5 + level / 2, freedom)
        at = np.linspace(x_fit.min(), x_fit.max(), 200) if x_wave is None else x_fit
        with np.errstate(all="ignore"):
            jacobian = _jacobian(reduced, at, best)
            spread = reach * np.sqrt(np.abs(np.einsum("ij,jk,ik->i", jacobian, free_covariance, jacobian)))
            centre = reduced(at, *best)
        made = []
        for suffix, values in (("_hi", centre + spread), ("_lo", centre - spread)):
            if x_wave is None:
                made.append(_op.make(f"{fit_name}{suffix}", values, x0=at[0],
                                     dx=(at[1] - at[0]) or 1.0, x_unit=y_wave.x_unit,
                                     unit=y_wave.unit))
            else:
                whole = np.full(len(y_values), np.nan)
                whole[np.flatnonzero(keep) + first] = values
                made.append(_op.make(f"{fit_name}{suffix}", whole, unit=y_wave.unit))
        band_waves = (made[1], made[0])
        # Upper edge first: it fills down to the next trace, the lower edge.
        show(made[0], color="#999999", line_size=0.5, fill="next", fill_opacity=0.25)
        show(made[1], color="#999999", line_size=0.5)

    show(fit_wave, color="black")

    residual_wave = None
    if residuals:
        with np.errstate(all="ignore"):
            difference = np.full(len(y_values), np.nan)
            difference[first : last + 1] = y_values[first : last + 1] - model(
                x_values[first : last + 1], *params
            )
        scaling = {} if x_wave is not None else {"x0": y_wave.x0, "dx": y_wave.dx, "x_unit": y_wave.x_unit}
        residual_wave = _op.make(f"{folder}res_{leaf}", difference, unit=y_wave.unit, **scaling)
        if target is not None:
            axis = _stack_axis(target, source["vAxis"], f"res_{source['vAxis']}")
            show(residual_wave, axis=axis, color=source["color"])
            target.axis(axis).set(grid="major")

    result = FitResult(
        f"{label}({leaf})", names, params, sigma, chisq, len(y_fit), fit_wave, converged, held,
        residuals=residual_wave, band=band_waves,
    )
    if not quiet:
        print(result)
    return result


def _numeric(wave_):
    """A wave and its values as real numbers (the real parts of a complex wave)."""
    source = _op.wave(_op._wave_name(wave_))
    values = np.asarray(source.data)
    values = np.asarray(values.real if values.dtype.kind == "c" else values, dtype=float)
    return source, values


def _sibling(source, suffix, name):
    return name or f"{source.name}{suffix}"


def stats(wave_, quiet=False):
    """Summary statistics of a wave, printed and returned as a dict."""
    source, values = _numeric(wave_)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        raise _op.OresmeError(f"{source.name} has no finite values.")
    result = {
        "points": int(values.size),
        "nans": int(values.size - finite.size),
        "mean": float(finite.mean()),
        "sdev": float(finite.std(ddof=1)) if finite.size > 1 else 0.0,
        "rms": float(np.sqrt(np.mean(finite**2))),
        "min": float(finite.min()),
        "max": float(finite.max()),
        "sum": float(finite.sum()),
    }
    if values.ndim == 1:
        x = source.x
        result["min_x"] = float(x[int(np.nanargmin(values))])
        result["max_x"] = float(x[int(np.nanargmax(values))])
    if not quiet:
        print(f"Stats of {source.name}:")
        for key, value in result.items():
            print(f"  {key:<6} = {value:g}")
    return result


def differentiate(wave_, name=None):
    """The derivative with respect to X, as a new wave ``<name>_DIF``."""
    source, values = _numeric(wave_)
    return _op.make(
        _sibling(source, "_DIF", name),
        np.gradient(values, source.dx),
        x0=source.x0,
        dx=source.dx,
        x_unit=source.x_unit,
    )


def integrate(wave_, name=None):
    """The running integral over X (trapezoidal), as a new wave ``<name>_INT``."""
    source, values = _numeric(wave_)
    steps = (values[1:] + values[:-1]) / 2 * source.dx
    return _op.make(
        _sibling(source, "_INT", name),
        np.concatenate(([0.0], np.cumsum(steps))),
        x0=source.x0,
        dx=source.dx,
        x_unit=source.x_unit,
    )


def smooth(wave_, n=5, name=None):
    """A moving average over ``n`` points (odd), as a new wave ``<name>_smth``."""
    source, values = _numeric(wave_)
    n = max(1, int(n)) | 1
    padded = np.pad(values, n // 2, mode="edge")
    return _op.make(
        _sibling(source, "_smth", name),
        np.convolve(padded, np.ones(n) / n, mode="valid"),
        x0=source.x0,
        dx=source.dx,
        x_unit=source.x_unit,
        unit=source.unit,
    )


def fft(wave_, name=None, output="magnitude"):
    """The spectrum of a wave, as a new wave ``<name>_FFT`` scaled in frequency.

    ``output="magnitude"`` gives the amplitude of each frequency component.
    ``output="complex"`` keeps the spectrum itself as a complex wave: the
    non-negative frequencies, not normalized (``np.fft.rfft``), which
    ``op.ifft`` turns back into the signal.
    """
    source, values = _numeric(wave_)
    if values.ndim != 1:
        raise _op.OresmeError("The FFT here is for 1-D waves.")
    if output not in ("magnitude", "complex"):
        raise _op.OresmeError('output must be "magnitude" or "complex".')
    spectrum = np.fft.rfft(values)
    if output == "magnitude":
        spectrum = np.abs(spectrum) * 2 / max(1, len(values))
    spacing = abs(source.dx)
    unit = "Hz" if source.x_unit == "s" else (f"1/{source.x_unit}" if source.x_unit else "")
    return _op.make(
        _sibling(source, "_FFT", name),
        spectrum,
        x0=0,
        dx=1 / (len(values) * spacing),
        x_unit=unit,
        unit=source.unit,
        # So the inverse can restore an odd number of points.
        note=f"points={len(values)}" if output == "complex" else "",
    )


def ifft(wave_, name=None, n=None):
    """The signal whose spectrum a complex wave holds, as ``<name>_IFFT``.

    The inverse of ``op.fft(w, output="complex")``. ``n`` is the number of
    points of the result; by default the number the spectrum was made from.
    """
    source = _op.wave(_op._wave_name(wave_))
    spectrum = np.asarray(source.data)
    if spectrum.ndim != 1:
        raise _op.OresmeError("The inverse FFT here is for 1-D waves.")
    if n is None:
        note = source.note
        n = int(note[7:]) if note.startswith("points=") and note[7:].isdigit() else 2 * (len(spectrum) - 1)
    n = int(n)
    if n < 1:
        raise _op.OresmeError("There are not enough points for an inverse FFT.")
    signal = np.fft.irfft(spectrum, n)
    unit = source.x_unit
    back = "s" if unit == "Hz" else (unit[2:] if unit.startswith("1/") else "")
    return _op.make(
        _sibling(source, "_IFFT", name),
        signal,
        x0=0,
        dx=1 / (n * abs(source.dx)),
        x_unit=back,
        unit=source.unit,
    )


def histogram(wave_, bins=50, name=None):
    """Counts of the values in ``bins`` equal bins, as a new wave ``<name>_Hist``."""
    source, values = _numeric(wave_)
    counts, edges = np.histogram(values[np.isfinite(values)], bins=int(bins))
    width = float(edges[1] - edges[0]) or 1.0
    return _op.make(
        _sibling(source, "_Hist", name),
        counts.astype(float),
        x0=float(edges[0]) + width / 2,
        dx=width,
        x_unit=source.unit,
    )


# --- Peaks -----------------------------------------------------------------

_SHAPES = {
    # name: (shape of unit height at offset u = (x - x0) / width, FWHM / width, area / (height * width))
    "gauss": (lambda u: np.exp(-u * u), 2 * np.sqrt(np.log(2)), np.sqrt(np.pi)),
    "lor": (lambda u: 1 / (1 + u * u), 2.0, np.pi),
}


def find_peaks(wave_, x=None, *, min_height=None, min_prominence=None, smooth=0, negative=False):
    """Find the peaks of a 1-D wave. Returns a list of dicts, tallest first.

    Each has ``point``, ``x``, ``height`` (above the surrounding baseline, its
    prominence) and ``width`` (the full width at half that height).

    ``min_prominence`` is how far a peak must stand above the higher of the
    valleys beside it; by default four times the noise (estimated from the
    point-to-point scatter), and at least 2% of the wave's range. ``min_height`` is a floor for the value itself.
    ``smooth`` box-smooths over that many points first, which steadies the
    search in noisy data. ``negative=True`` finds dips instead.
    """
    source, values = _numeric(wave_)
    if values.ndim != 1:
        raise _op.OresmeError("Peaks are found in 1-D waves.")
    x_values = np.asarray(source.x if x is None else _op.wave(_op._wave_name(x)).data, dtype=float)
    return _find_peaks(x_values, values, min_height, min_prominence, smooth, negative)


def _find_peaks(x_values, values, min_height=None, min_prominence=None, smooth=0, negative=False):
    y = -values if negative else values.copy()
    y = np.where(np.isfinite(y), y, np.nanmin(y) if np.isfinite(y).any() else 0.0)
    if len(y) < 3:
        return []
    if min_prominence is None:
        # The scatter between neighbouring points, which the peaks themselves
        # hardly affect. Measured before smoothing: smoothed noise still
        # wanders by a good part of this.
        steps = np.diff(y)
        noise = 1.4826 * np.median(np.abs(steps - np.median(steps))) / np.sqrt(2)
        min_prominence = max(4 * noise, 0.02 * float(np.ptp(y)))
    if smooth and smooth > 1:
        width = int(smooth) | 1
        padded = np.pad(y, width // 2, mode="edge")
        y = np.convolve(padded, np.ones(width) / width, mode="valid")

    # Local maxima, counting a flat top once.
    rising = np.diff(y) > 0
    falling = np.diff(y) < 0
    candidates = []
    index = 1
    while index < len(y) - 1:
        if rising[index - 1]:
            end = index
            while end < len(y) - 1 and not rising[end] and not falling[end]:
                end += 1
            if end < len(y) - 1 and falling[end]:
                candidates.append((index + end) // 2)
            index = end + 1
        else:
            index += 1

    found = []
    for at in candidates:
        top = y[at]
        if min_height is not None and top < min_height:
            continue
        # Walk out each way to the nearest higher point; the lowest value on the way is that side's valley.
        left = at
        valley_left = top
        while left > 0 and y[left - 1] <= top:
            left -= 1
            valley_left = min(valley_left, y[left])
        right = at
        valley_right = top
        while right < len(y) - 1 and y[right + 1] <= top:
            right += 1
            valley_right = min(valley_right, y[right])
        base = max(valley_left, valley_right)
        prominence = top - base
        if prominence < min_prominence:
            continue
        half = top - prominence / 2
        lo = at
        while lo > 0 and y[lo] > half:
            lo -= 1
        hi = at
        while hi < len(y) - 1 and y[hi] > half:
            hi += 1
        found.append(
            {
                "point": int(at),
                "x": float(x_values[at]),
                "height": float(-prominence if negative else prominence),
                "width": float(abs(x_values[hi] - x_values[lo])) or float(abs(x_values[1] - x_values[0])),
            }
        )
    return sorted(found, key=lambda peak: -abs(peak["height"]))


class PeakFitResult:
    """The outcome of ``op.fit_peaks``: one row per peak, and the waves it made."""

    def __init__(self, shape, peaks, baseline, chisq, points, wave, components, converged):
        self.shape = shape
        #: A list of dicts: x, height, width (FWHM), area, and their uncertainties.
        self.peaks = peaks
        self.baseline = baseline
        self.chisq = chisq
        self.points = points
        self.wave = wave
        self.components = components
        self.converged = converged

    def __len__(self):
        return len(self.peaks)

    def __getitem__(self, index):
        return self.peaks[index]

    def __repr__(self):
        return f"PeakFitResult({len(self.peaks)} {self.shape} peaks, chisq={self.chisq:.6g})"

    def __str__(self):
        lines = [
            f"Multi-peak fit: {len(self.peaks)} {self.shape} peak{'s' if len(self.peaks) != 1 else ''}, "
            f"{self.points} points, chi-square = {self.chisq:.6g}"
        ]
        if not self.converged:
            lines.append("  (did not converge; showing the best parameters found)")
        lines.append(f"  {'#':>2}  {'position':>12}  {'height':>12}  {'FWHM':>12}  {'area':>12}")
        for number, peak in enumerate(self.peaks, 1):
            lines.append(
                f"  {number:>2}  {peak['x']:>12.6g}  {peak['height']:>12.6g}  "
                f"{peak['width']:>12.6g}  {peak['area']:>12.6g}"
            )
        if self.baseline:
            terms = ", ".join(f"{key} = {value:.6g}" for key, value in self.baseline.items())
            lines.append(f"  baseline: {terms}")
        return "\n".join(lines)


def fit_peaks(y, x=None, *, peaks=None, shape="gauss", baseline="constant", range=None,
              cursors=False, graph=None, components=True, quiet=False, **find):
    """Fit several peaks at once: a sum of Gaussians or Lorentzians on a baseline.

    ``peaks`` says where to start: nothing to find them (see ``op.find_peaks``,
    whose options can be given here), a number to take that many of the
    tallest, or a list of X positions. ``shape`` is ``"gauss"`` or ``"lor"``;
    ``baseline`` is ``"constant"``, ``"linear"`` or ``None``.

    Makes ``fit_<name>`` (the sum), ``fit_<name>_p1``, ``_p2``, ... (each peak
    on the baseline, if ``components``), and ``W_peaks``: one row per peak with
    position, height, full width at half maximum and area. Returns a
    ``PeakFitResult`` listing the peaks from left to right.
    """
    if shape not in _SHAPES:
        raise _op.OresmeError(f"shape must be one of {', '.join(_SHAPES)}.")
    if baseline not in ("constant", "linear", None):
        raise _op.OresmeError('baseline must be "constant", "linear" or None.')
    profile, fwhm_factor, area_factor = _SHAPES[shape]
    y_wave = _op.wave(_op._wave_name(y))
    x_wave = None if x is None else _op.wave(_op._wave_name(x))
    y_values = np.asarray(y_wave.data, dtype=float)
    if y_values.ndim != 1:
        raise _op.OresmeError("Only 1-D waves can be fitted.")
    x_values = np.asarray(y_wave.x if x_wave is None else x_wave.data, dtype=float)
    leaf = y_wave.name.rsplit(":", 1)[-1]

    target = None
    for candidate in [graph] if graph is not None else reversed(_op.graphs()):
        candidate = _op.graph(candidate) if isinstance(candidate, str) else candidate
        if any(trace["y"] == y_wave.name for trace in candidate._info()["traces"]):
            target = candidate
            break
    first, last = 0, len(y_values) - 1
    if cursors:
        if target is None:
            raise _op.OresmeError("cursors=True needs a graph that shows the wave.")
        marks = target._info()["cursors"]
        if "A" not in marks or "B" not in marks:
            raise _op.OresmeError("Put cursors A and B on the graph first.")
        first, last = sorted((marks["A"]["point"], marks["B"]["point"]))
    elif range is not None:
        first, last = sorted((int(range[0]), int(range[1])))
    first, last = max(0, first), min(len(y_values) - 1, last)
    keep = np.isfinite(x_values[first : last + 1]) & np.isfinite(y_values[first : last + 1])
    x_fit = x_values[first : last + 1][keep]
    y_fit = y_values[first : last + 1][keep]

    # Starting points: found, or the positions given.
    if peaks is None or isinstance(peaks, (int, np.integer)):
        found = _find_peaks(x_fit, y_fit, **find)
        if isinstance(peaks, (int, np.integer)):
            found = found[: int(peaks)]
        starts = [(peak["x"], peak["height"], peak["width"]) for peak in found]
    else:
        floor = float(np.median(y_fit))
        starts = []
        for position in np.atleast_1d(np.asarray(peaks, dtype=float)):
            nearest = int(np.argmin(np.abs(x_fit - position)))
            starts.append((float(position), float(y_fit[nearest]) - floor, _span(x_fit) / 20))
    if not starts:
        raise _op.OresmeError("No peaks were found. Give peaks=[positions], or lower min_prominence.")
    starts.sort()
    count = len(starts)
    base_terms = {"constant": 1, "linear": 2, None: 0}[baseline]
    if len(y_fit) <= 3 * count + base_terms:
        raise _op.OresmeError(f"{len(y_fit)} points are not enough to fit {count} peaks.")
    centre = float(x_fit.mean())

    def model(x_, *values):
        total = np.zeros_like(x_, dtype=float)
        if base_terms >= 1:
            total = total + values[0]
        if base_terms == 2:
            total = total + values[1] * (x_ - centre)
        for number in np.arange(count):
            height, position, width = values[base_terms + 3 * number : base_terms + 3 * number + 3]
            total = total + height * profile((x_ - position) / width)
        return total

    start = []
    lower = []
    upper = []
    span = _span(x_fit)
    if base_terms >= 1:
        start.append(float(np.min(y_fit)) if starts[0][1] > 0 else float(np.max(y_fit)))
        lower.append(-np.inf)
        upper.append(np.inf)
    if base_terms == 2:
        start.append(0.0)
        lower.append(-np.inf)
        upper.append(np.inf)
    for position, height, width in starts:
        start += [height, position, width / fwhm_factor]
        # A peak keeps its sign, stays in the data, and stays narrower than the data.
        lower += [0.0 if height > 0 else -np.inf, float(x_fit.min()), span * 1e-6]
        upper += [np.inf if height > 0 else 0.0, float(x_fit.max()), span]
    best, covariance, chisq, converged = _least_squares(
        model, x_fit, y_fit, start, None, lower, upper, max_iterations=400
    )
    errors = np.sqrt(np.abs(np.diag(covariance)))

    rows = []
    for number in np.arange(count):
        at = base_terms + 3 * number
        height, position, width = (float(value) for value in best[at : at + 3])
        d_height, d_position, d_width = (float(value) for value in errors[at : at + 3])
        rows.append(
            {
                "x": position,
                "height": height,
                "width": abs(width) * fwhm_factor,
                "area": height * abs(width) * area_factor,
                "x_sigma": d_position,
                "height_sigma": d_height,
                "width_sigma": d_width * fwhm_factor,
            }
        )
    order = np.argsort([row["x"] for row in rows])
    rows = [rows[index] for index in order]
    base = {}
    if base_terms >= 1:
        base["offset"] = float(best[0])
    if base_terms == 2:
        base["slope"] = float(best[1])
        # Reported at x = 0 rather than at the middle of the data.
        base["offset"] = float(best[0] - best[1] * centre)

    folder = y_wave.name.rsplit(":", 1)[0] + ":" if ":" in y_wave.name else ""
    if x_wave is None:
        grid = np.linspace(x_fit.min(), x_fit.max(), max(400, 20 * count))
        scaling = {"x0": grid[0], "dx": (grid[1] - grid[0]) or 1.0, "x_unit": y_wave.x_unit}
    else:
        grid = x_values
        scaling = {}

    def curve(values):
        with np.errstate(all="ignore"):
            result = np.asarray(model(grid, *values), dtype=float)
        if x_wave is not None:
            result = result.copy()
            result[:first] = np.nan
            result[last + 1 :] = np.nan
        return result

    fit_wave = _op.make(f"{folder}fit_{leaf}", curve(best), unit=y_wave.unit, **scaling)
    parts = []
    if components:
        for position_in_table, index in enumerate(order, 1):
            only = np.array(best, dtype=float)
            for other in np.arange(count):
                if other != index:
                    only[base_terms + 3 * other] = 0.0
            parts.append(
                _op.make(f"{folder}fit_{leaf}_p{position_in_table}", curve(only), unit=y_wave.unit,
                         **scaling)
            )
    _op.make(
        "W_peaks",
        np.array([[row["x"], row["height"], row["width"], row["area"]] for row in rows]),
    )

    if target is not None:
        source = next(t for t in target._info()["traces"] if t["y"] == y_wave.name)
        shown = {trace["y"] for trace in target._info()["traces"]}
        for part in parts:
            if part.name not in shown:
                target.append(part, x=x_wave, axis=source["vAxis"], haxis=source["hAxis"])
                target.trace(part.name.rsplit(":", 1)[-1]).set(color="#0000ff", line_style="dash")
        if fit_wave.name not in shown:
            target.append(fit_wave, x=x_wave, axis=source["vAxis"], haxis=source["hAxis"])
            target.trace(fit_wave.name.rsplit(":", 1)[-1]).set(color="black")

    result = PeakFitResult(shape, rows, base, chisq, len(y_fit), fit_wave, parts, converged)
    if not quiet:
        print(result)
    return result


# --- Interpolation -----------------------------------------------------------


def _spline(x, y, at):
    """A natural cubic spline through (x, y), evaluated at ``at``. x must increase."""
    n = len(x)
    h = np.diff(x)
    # Second derivatives at the knots: a tridiagonal system, zero at both ends.
    lower = h[:-1].copy()
    diagonal = 2 * (h[:-1] + h[1:])
    upper = h[1:].copy()
    right = 6 * (np.diff(y[1:]) / h[1:] - np.diff(y[:-1]) / h[:-1])
    for index in np.arange(1, n - 2):
        factor = lower[index] / diagonal[index - 1]
        diagonal[index] -= factor * upper[index - 1]
        right[index] -= factor * right[index - 1]
    second = np.zeros(n)
    for index in np.arange(n - 3, -1, -1):
        following = second[index + 2] if index < n - 3 else 0.0
        second[index + 1] = (right[index] - upper[index] * following) / diagonal[index]
    piece = np.clip(np.searchsorted(x, at) - 1, 0, n - 2)
    width = h[piece]
    a = (x[piece + 1] - at) / width
    b = (at - x[piece]) / width
    return (
        a * y[piece]
        + b * y[piece + 1]
        + ((a**3 - a) * second[piece] + (b**3 - b) * second[piece + 1]) * width**2 / 6
    )


def interpolate(wave_, x=None, *, n=None, at=None, kind="linear", name=None):
    """Values between the points of a wave, as a new wave ``<name>_interp``.

    With ``n``, the result has n evenly spaced points over the same X range,
    which also turns XY data into a wave with X scaling. With ``at`` (a wave
    or array of X values) it has one point at each of those. ``kind`` is
    ``"linear"`` or ``"cubic"`` (a natural spline). Outside the data the
    result is NaN.
    """
    source, values = _numeric(wave_)
    if values.ndim != 1:
        raise _op.OresmeError("Only 1-D waves can be interpolated.")
    if kind not in ("linear", "cubic"):
        raise _op.OresmeError('kind must be "linear" or "cubic".')
    x_values = np.asarray(source.x if x is None else _op.wave(_op._wave_name(x)).data, dtype=float)
    if len(x_values) != len(values):
        raise _op.OresmeError("The X and Y waves have different lengths.")
    good = np.isfinite(x_values) & np.isfinite(values)
    order = np.argsort(x_values[good], kind="stable")
    xs = x_values[good][order]
    ys = values[good][order]
    # Repeated X values cannot be interpolated between: keep the first of each.
    distinct = np.concatenate(([True], np.diff(xs) > 0))
    xs, ys = xs[distinct], ys[distinct]
    if len(xs) < (3 if kind == "cubic" else 2):
        raise _op.OresmeError("There are not enough points to interpolate between.")

    if (n is None) == (at is None):
        raise _op.OresmeError("Give either n (a number of points) or at (X values).")
    if n is not None:
        if int(n) < 2:
            raise _op.OresmeError("n must be at least 2.")
        targets = np.linspace(xs[0], xs[-1], int(n))
    else:
        if isinstance(at, (str, _op.Wave)):
            at = _op.wave(_op._wave_name(at)).data
        targets = np.asarray(at, dtype=float).reshape(-1)
    inside = (targets >= xs[0]) & (targets <= xs[-1])
    result = np.full(len(targets), np.nan)
    if kind == "linear":
        result[inside] = np.interp(targets[inside], xs, ys)
    else:
        result[inside] = _spline(xs, ys, targets[inside])
    scaling = {}
    if n is not None:
        unit = source.x_unit if x is None else _op.wave(_op._wave_name(x)).unit
        scaling = {"x0": targets[0], "dx": (targets[1] - targets[0]) or 1.0, "x_unit": unit}
    return _op.make(_sibling(source, "_interp", name), result, unit=source.unit, **scaling)


# --- Images ------------------------------------------------------------------


def _matrix(wave_):
    source = _op.wave(_op._wave_name(wave_))
    values = np.asarray(source.data, dtype=float)
    if values.ndim != 2:
        raise _op.OresmeError(f"{source.name} is not a 2-D wave.")
    return source, values


def _like(source, name, values):
    """A matrix wave with the X and Y scaling of ``source``."""
    return _op.make(
        name,
        values,
        x0=source.x0,
        dx=source.dx,
        x_unit=source.x_unit,
        y0=source.y0,
        dy=source.dy,
        y_unit=source.y_unit,
        unit=source.unit,
    )


def filter_image(wave_, kind="gauss", size=3, name=None):
    """Smooth or sharpen a 2-D wave; the result is ``<name>_filt``.

    ``kind`` is ``"gauss"`` (``size`` is the standard deviation in pixels),
    ``"mean"`` or ``"median"`` (``size`` is the side of a square window, an
    odd number), or ``"sharpen"`` (unsharp mask; ``size`` is the blur's
    standard deviation). Edges are handled by repeating the border.
    """
    source, values = _matrix(wave_)

    def blur(data, sigma):
        radius = max(1, int(np.ceil(3 * sigma)))
        offsets = np.arange(-radius, radius + 1)
        kernel = np.exp(-(offsets**2) / (2 * sigma * sigma))
        kernel /= kernel.sum()
        for axis in (0, 1):
            padding = [(0, 0), (0, 0)]
            padding[axis] = (radius, radius)
            padded = np.pad(data, padding, mode="edge")
            data = np.zeros_like(data)
            for weight, offset in zip(kernel, offsets):
                window = [slice(None), slice(None)]
                window[axis] = slice(radius + offset, radius + offset + data.shape[axis])
                data = data + weight * padded[tuple(window)]
        return data

    if kind in ("gauss", "sharpen"):
        sigma = float(size)
        if not sigma > 0:
            raise _op.OresmeError("size must be greater than 0.")
        smooth = blur(values, sigma)
        result = smooth if kind == "gauss" else values + (values - smooth)
    elif kind in ("mean", "median"):
        side = int(size)
        if side < 1 or side % 2 == 0:
            raise _op.OresmeError("size must be an odd number of pixels: 3, 5, 7, ...")
        padded = np.pad(values, side // 2, mode="edge")
        windows = np.lib.stride_tricks.sliding_window_view(padded, (side, side))
        result = windows.mean(axis=(2, 3)) if kind == "mean" else np.median(windows, axis=(2, 3))
    else:
        raise _op.OresmeError('kind must be "gauss", "mean", "median" or "sharpen".')
    return _like(source, _sibling(source, "_filt", name), result)


def line_profile(wave_, start, end, n=None, name=None):
    """The values of a 2-D wave along a straight line, as ``<name>_prof``.

    ``start`` and ``end`` are (x, y) in the wave's scaled coordinates. The
    profile has ``n`` points (by default one per pixel crossed), bilinearly
    interpolated, with X scaling that is the distance along the line.
    """
    source, values = _matrix(wave_)
    # In pixel units.
    x0 = (float(start[0]) - source.x0) / source.dx
    y0 = (float(start[1]) - source.y0) / source.dy
    x1 = (float(end[0]) - source.x0) / source.dx
    y1 = (float(end[1]) - source.y0) / source.dy
    count = int(n) if n is not None else int(np.ceil(np.hypot(x1 - x0, y1 - y0))) + 1
    if count < 2:
        raise _op.OresmeError("The line is too short for a profile.")
    column = np.linspace(x0, x1, count)
    row = np.linspace(y0, y1, count)
    inside = (column >= 0) & (column <= values.shape[0] - 1) & (row >= 0) & (row <= values.shape[1] - 1)
    i = np.clip(np.floor(column).astype(int), 0, values.shape[0] - 2)
    j = np.clip(np.floor(row).astype(int), 0, values.shape[1] - 2)
    u = column - i
    v = row - j
    profile = (
        values[i, j] * (1 - u) * (1 - v)
        + values[i + 1, j] * u * (1 - v)
        + values[i, j + 1] * (1 - u) * v
        + values[i + 1, j + 1] * u * v
    )
    profile = np.where(inside, profile, np.nan)
    length = float(np.hypot(float(end[0]) - float(start[0]), float(end[1]) - float(start[1])))
    return _op.make(
        _sibling(source, "_prof", name),
        profile,
        x0=0.0,
        dx=length / (count - 1) or 1.0,
        x_unit=source.x_unit if source.x_unit == source.y_unit else "",
        unit=source.unit,
    )
