"""Analysis operations for OresmePro: curve fitting and common wave operations.

These are part of the ``oresme`` module (``op.fit``, ``op.stats``, ...). They
need only NumPy.
"""

import inspect

import numpy as np

import oresme as _op

__all__ = [
    "FitResult",
    "fit",
    "fit_functions",
    "stats",
    "differentiate",
    "integrate",
    "smooth",
    "fft",
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


def _least_squares(model, x, y, start, max_iterations=200):
    """Levenberg-Marquardt. Returns (parameters, covariance, chi-square, converged)."""
    params = np.array(start, dtype=float)
    with np.errstate(all="ignore"):
        residual = y - model(x, *params)
        chi = float(residual @ residual)
        if not np.isfinite(chi):
            raise _op.OresmeError("The fit function is not finite at the starting guess.")
        damping = 1e-3
        converged = False
        for _ in range(max_iterations):
            jacobian = _jacobian(model, x, params)
            normal = jacobian.T @ jacobian
            gradient = jacobian.T @ residual
            improved = False
            while damping < 1e12:
                try:
                    step = np.linalg.solve(
                        normal + damping * np.diag(np.diag(normal) + 1e-30), gradient
                    )
                except np.linalg.LinAlgError:
                    damping *= 10
                    continue
                trial = params + step
                trial_residual = y - model(x, *trial)
                trial_chi = float(trial_residual @ trial_residual)
                if np.isfinite(trial_chi) and trial_chi <= chi:
                    change = chi - trial_chi
                    params, residual, chi = trial, trial_residual, trial_chi
                    damping = max(damping / 10, 1e-12)
                    improved = True
                    converged = change <= 1e-10 * max(chi, 1e-300)
                    break
                damping *= 10
            if not improved or converged:
                converged = converged or not improved
                break
        jacobian = _jacobian(model, x, params)
        freedom = max(1, len(y) - len(params))
        try:
            covariance = np.linalg.inv(jacobian.T @ jacobian) * chi / freedom
        except np.linalg.LinAlgError:
            covariance = np.full((len(params), len(params)), np.nan)
    return params, covariance, chi, converged


class FitResult:
    """The outcome of ``op.fit``: coefficients, their uncertainties and the fit wave."""

    def __init__(self, function, names, coef, sigma, chisq, points, wave, converged):
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
            lines.append(f"  {name:<{width}} = {value:.6g} ± {error:.3g}")
        return "\n".join(lines)


def fit(function, y, x=None, *, guess=None, range=None, cursors=False, graph=None, name=None,
        quiet=False):
    """Fit a function to a wave by least squares.

    ``function`` is the name of a built-in function (see ``op.fit_functions()``),
    ``"polyN"`` for a polynomial with N terms, or your own
    ``f(x, p1, p2, ...)`` together with ``guess=[...]``.

    ``x`` is an X wave; without it the wave's X scaling is used. ``range=(a, b)``
    limits the fit to points a..b inclusive; ``cursors=True`` uses the points
    between cursors A and B of the graph.

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
    x_fit, y_fit = x_fit[keep], y_fit[keep]
    model, names, start, label = _resolve(function, x_fit, y_fit, guess)
    if len(start) != len(names):
        raise _op.OresmeError(f"{label} has {len(names)} parameters; the guess has {len(start)}.")
    if len(y_fit) <= len(names):
        raise _op.OresmeError(f"{len(y_fit)} points are not enough to fit {len(names)} parameters.")

    params, covariance, chisq, converged = _least_squares(model, x_fit, y_fit, start)
    sigma = np.sqrt(np.abs(np.diag(covariance)))

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

    if target is not None:
        shown = [trace["y"] for trace in target._info()["traces"]]
        if fit_wave.name not in shown:
            source = next(t for t in target._info()["traces"] if t["y"] == y_wave.name)
            target.append(fit_wave, x=x_wave, axis=source["vAxis"], haxis=source["hAxis"])
            target.trace(fit_name.rsplit(":", 1)[-1]).set(color="black")

    result = FitResult(f"{label}({leaf})", names, params, sigma, chisq, len(y_fit), fit_wave, converged)
    if not quiet:
        print(result)
    return result


def _numeric(wave_):
    source = _op.wave(_op._wave_name(wave_))
    values = np.asarray(source.data, dtype=float)
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


def fft(wave_, name=None):
    """The magnitude spectrum, as a new wave ``<name>_FFT`` scaled in frequency."""
    source, values = _numeric(wave_)
    spectrum = np.abs(np.fft.rfft(values)) * 2 / max(1, len(values))
    spacing = abs(source.dx)
    unit = "Hz" if source.x_unit == "s" else (f"1/{source.x_unit}" if source.x_unit else "")
    return _op.make(
        _sibling(source, "_FFT", name),
        spectrum,
        x0=0,
        dx=1 / (len(values) * spacing),
        x_unit=unit,
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
