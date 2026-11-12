"""Analysis operations for OresmePro: curve fitting and common wave operations.

These are part of the ``oresme`` module (``op.fit``, ``op.stats``, ...). They
need only NumPy.
"""

import inspect
import math

import numpy as np

import oresme as _op

__all__ = [
    "FitResult",
    "PeakFitResult",
    "Result",
    "result",
    "results",
    "results_table",
    "fit",
    "fit_batch",
    "fit_global",
    "GlobalFitResult",
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
    "background",
    "OnsetResult",
    "onset",
]


def _span(x):
    return float(np.ptp(x)) or 1.0


def _peak(x, y):
    """Baseline, signed height and position of the most prominent peak or dip.

    The baseline is judged from the ends of the range as well as from the
    median. A peak that fills the range (the points between two cursors set
    at its feet) has its median half way up: seen from there it looks like
    two dips at the ends. The ends say where it stands. A peak cut off by
    the edge of the range has one end high instead, and there the median is
    the better judge, so the ends decide only when they speak clearly.
    """
    edge = max(1, len(y) // 20)
    ends = (float(np.mean(y[:edge])) + float(np.mean(y[-edge:]))) / 2
    median = float(np.median(y))
    top, bottom = float(y.max()), float(y.min())
    if top - ends > 2 * (ends - bottom):
        upward = True
    elif ends - bottom > 2 * (top - ends):
        upward = False
    else:
        upward = top - median >= median - bottom
    # Of the two levels, the one further from the peak: the foot, not the flank.
    base = min(ends, median) if upward else max(ends, median)
    index = int(np.argmax(y) if upward else np.argmin(y))
    height = float(y[index]) - base
    # Half the width at half height, measured from the samples.
    above = (y - base) * np.sign(height) >= abs(height) / 2
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


def _weideman(terms):
    """The expansion point and coefficients of Weideman's approximation with ``terms`` terms."""
    count = 2 * terms
    scale = np.sqrt(terms / np.sqrt(2))
    t = scale * np.tan(np.arange(-count + 1, count) * np.pi / (2 * count))
    samples = np.concatenate(([0.0], np.exp(-t * t) * (scale * scale + t * t)))
    coefficients = np.real(np.fft.fft(np.fft.fftshift(samples))) / (2 * count)
    return scale, coefficients[1 : terms + 1][::-1]


_FADDEEVA_SCALE, _FADDEEVA_TERMS = _weideman(40)


def _faddeeva(z):
    """The Faddeeva function w(z) = exp(-z^2) erfc(-iz), for Im z >= 0.

    By the rational approximation of J. A. C. Weideman, "Computation of the
    complex error function", SIAM J. Numer. Anal. 31, 1497 (1994), with 40
    terms. Checked against mpmath at 40 digits at 4000 points with
    0 <= Re z <= 1e6 and 0 <= Im z <= 1e7: the error is below 1e-15 of |w|,
    and below 1e-15 of the peak value Re w(i Im z) of the Voigt profile the
    point belongs to. (With 32 terms, as often quoted, it is 3e-13.)
    """
    z = np.asarray(z, dtype=complex)
    below = _FADDEEVA_SCALE - 1j * z
    series = np.polyval(_FADDEEVA_TERMS, (_FADDEEVA_SCALE + 1j * z) / below)
    return 2 * series / below**2 + 1 / (np.sqrt(np.pi) * below)


def _voigt(u, gauss, lorentz):
    """The Voigt profile of unit height at offset u from its centre.

    The convolution of exp(-(u/gauss)^2) with 1/(1 + (u/lorentz)^2): the
    widths mean what they mean in the Gaussian and Lorentzian shapes.
    """
    u = np.asarray(u, dtype=float)
    gauss, lorentz = abs(float(gauss)), abs(float(lorentz))
    # Once the Gaussian is this much narrower, the profile is the Lorentzian
    # to rounding, and the argument of w would grow without bound.
    if gauss == 0 or lorentz > 1e8 * gauss:
        if lorentz == 0:
            return (u == 0).astype(float)
        return 1 / (1 + (u / lorentz) ** 2)
    return _faddeeva((u + 1j * lorentz) / gauss).real / _faddeeva(1j * lorentz / gauss).real


def _voigt_area(gauss, lorentz):
    """The area under the Voigt profile of unit height."""
    gauss, lorentz = abs(float(gauss)), abs(float(lorentz))
    if gauss == 0 or lorentz > 1e8 * gauss:
        return np.pi * lorentz
    # The normalized profile Re w(z) / (gauss sqrt(pi)) has unit area.
    return gauss * np.sqrt(np.pi) / float(_faddeeva(1j * lorentz / gauss).real)


def _voigt_fwhm(gauss, lorentz):
    """The full width at half maximum of the Voigt profile.

    Olivero and Longbothum's formula (J. Quant. Spectrosc. Radiat. Transfer
    17, 233 (1977); within 0.02%) brackets it, and bisection on the profile
    itself makes it exact.
    """
    gauss_fwhm, lorentz_fwhm = 2 * np.sqrt(np.log(2)) * abs(gauss), 2 * abs(lorentz)
    estimate = 0.5346 * lorentz_fwhm + np.sqrt(0.2166 * lorentz_fwhm**2 + gauss_fwhm**2)
    if estimate == 0:
        return 0.0
    low, high = 0.49 * estimate, 0.51 * estimate
    while _voigt(low, gauss, lorentz) < 0.5:
        low /= 2
    while _voigt(high, gauss, lorentz) > 0.5:
        high *= 2
    for _ in range(60):
        middle = (low + high) / 2
        if _voigt(middle, gauss, lorentz) > 0.5:
            low = middle
        else:
            high = middle
    return float(low + high)


def _pseudo_voigt(u, width, eta):
    """eta * Lorentzian + (1 - eta) * Gaussian, both of half width ``width`` at half maximum."""
    ratio = np.asarray(u, dtype=float) / width
    return eta / (1 + ratio**2) + (1 - eta) * np.exp(-np.log(2) * ratio**2)


def _guess_voigt(x, y):
    """Equal Gaussian and Lorentzian FWHMs that together make the measured FWHM."""
    base, height, centre, half_width = _peak(x, y)
    # By Olivero and Longbothum, equal widths f give a Voigt FWHM of 1.6376 f.
    each = 2 * half_width / 1.6376
    return [base, height, centre, each / (2 * np.sqrt(np.log(2))), each / 2]


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
    "voigt": (
        lambda x, y0, A, x0, gwidth, lwidth: y0 + A * _voigt(x - x0, gwidth, lwidth),
        ("y0", "A", "x0", "gwidth", "lwidth"),
        _guess_voigt,
        "y0 + A*V(x-x0), V of height 1: exp(-(x/gwidth)^2) convolved with 1/(1+(x/lwidth)^2)",
    ),
    "pseudo_voigt": (
        # eta is used within 0..1 whatever its value, so the curve is always a
        # pseudo-Voigt; bounds={"eta": (0, 1)} keeps the parameter there too.
        lambda x, y0, A, x0, width, eta: y0 + A * _pseudo_voigt(x - x0, width, np.clip(eta, 0, 1)),
        ("y0", "A", "x0", "width", "eta"),
        lambda x, y: (lambda b, h, c, w: [b, h, c, w, 0.5])(*_peak(x, y)),
        "y0 + A*(eta/(1+((x-x0)/width)^2) + (1-eta)*exp(-ln2*((x-x0)/width)^2))",
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
    """Derivatives of the model by its parameters, by central differences."""
    eps = np.finfo(float).eps
    columns = []
    for index, value in enumerate(params):
        step = 1e-6 * max(abs(value), 1e-6)
        for _ in range(5):
            up = params.copy()
            down = params.copy()
            up[index] += step
            down[index] -= step
            high, low = model(x, *up), model(x, *down)
            # Rounding blurs the model values by about eps times their size: on
            # a large background a small step changes nothing that survives
            # it. Take a step large enough for the change to stand clear.
            change = float(np.max(np.abs(high - low)))
            blur = eps * max(float(np.max(np.abs(high))), float(np.max(np.abs(low))))
            if not change < 1e4 * blur:
                break
            step *= min(1e6, 1e6 * blur / change) if change > 0 else 1e6
        columns.append((high - low) / (up[index] - down[index]))
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


def _least_squares(model, x, y, start, weights=None, lower=None, upper=None, max_iterations=200,
                   design=None):
    """Levenberg-Marquardt within bounds.

    Returns (parameters, covariance, chi-square, converged, reason), the last
    saying in words why it stopped.

    ``weights`` multiply the residuals (1/sigma per point). ``lower`` and
    ``upper`` bound the parameters. A parameter on a bound that the fit pushes
    outward is held there and the step is solved for the others; it is let go
    once the fit pulls it back inside. ``converged`` is true only where the
    linearised model promises no further reduction of chi-square worth having.

    ``design`` is the matrix of a model that is linear in its parameters (one
    column per parameter). It is then solved directly by linear least
    squares, and only where that answer breaks a bound by iterating.
    """
    params = np.array(start, dtype=float)
    lower = np.full(len(params), -np.inf) if lower is None else np.asarray(lower, dtype=float)
    upper = np.full(len(params), np.inf) if upper is None else np.asarray(upper, dtype=float)
    params = np.clip(params, lower, upper)
    scale = 1.0 if weights is None else weights

    def residuals(values):
        return (y - model(x, *values)) * scale

    def jacobian_at(values):
        jacobian = _jacobian(model, x, values) if design is None else design
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
        if design is not None:
            jacobian = jacobian_at(params)
            trial = params + _damped_step(jacobian, residual, np.ones(len(params), dtype=bool), 0.0)
            if np.all((trial >= lower) & (trial <= upper)):
                trial_residual = residuals(trial)
                params, residual, chi = trial, trial_residual, float(trial_residual @ trial_residual)
        # A linear model's Gauss-Newton step is exact. A nonlinear one starts
        # cautiously, half way to steepest descent: from a guess that is some
        # way off, a full Gauss-Newton step often throws a peak clear of the
        # data, where nothing pulls it back. Tried on peaks, decays and sines
        # from poor guesses, this start reaches the answer far more often than
        # a light damping does, and in fewer evaluations.
        damping = 0.0 if design is not None else 1.0
        converged = False
        reason = "stopped at the limit of iterations"
        for _ in range(max_iterations):
            jacobian = jacobian_at(params)
            if not np.all(np.isfinite(jacobian)):
                # The model cannot be differentiated here: nothing says which way to go.
                reason = "stopped where the function is not finite"
                break
            free = ~pushed_out(jacobian.T @ residual, np.ones(len(params), dtype=bool))
            if not free.any():
                converged = True
                reason = "converged with every parameter on a bound"
                break
            # What a full Gauss-Newton step could still gain: the part of the
            # residual that the free parameters can reach.
            gain = float(np.sum((jacobian @ _damped_step(jacobian, residual, free, 0.0)) ** 2))
            if not gain > 1e-12 * chi + floor:
                converged = True
                reason = "converged"
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
                    damping = max(damping / 3, 1e-12)
                    improved = True
                    break
                damping = max(damping * 10, 1e-3)
            if not improved:
                # No step lowers chi-square any further. On a large background
                # that happens with the test above still out of reach: the
                # rounding of the model hides gains that small. The fit has
                # converged all the same if a step promises no more than the
                # relative reduction MINPACK settles for.
                converged = not gain > 1.5e-8 * chi + floor
                reason = (
                    "converged as far as the precision of the data allows"
                    if converged
                    else "stopped: no step improves the fit, though it is not at a minimum"
                )
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
    return params, covariance, chi, converged, reason


def _index_of(names, name, what):
    if name not in names:
        raise _op.OresmeError(f"{what}: no parameter named {name!r}. Parameters: {', '.join(names)}.")
    return names.index(name)


class FitResult:
    """The outcome of ``op.fit``: coefficients, their uncertainties and the fit wave."""

    def __init__(self, function, names, coef, sigma, chisq, points, wave, converged, held=(),
                 residuals=None, band=None, *, reason="", covariance=None, freedom=None,
                 name=None):
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
        #: Points less fitted parameters.
        self.freedom = points - (len(self.names) - len(self.held)) if freedom is None else freedom
        self.wave = wave
        self.converged = converged
        #: Why the fit stopped, in words.
        self.reason = reason
        #: The covariance of the parameters, in the order of ``names`` (zero for held ones).
        self.covariance = covariance
        #: The name under which the fit is kept among the experiment's results, or None.
        self.name = name

    @property
    def correlation(self):
        """The correlation of the parameters: 1 on the diagonal, NaN for held ones."""
        return _correlation(self.covariance)

    @property
    def result(self):
        """The fit as it is kept in the experiment: ``.rerun()``, ``.apply(waves)``, ``.remove()``."""
        if self.name is None:
            raise _op.OresmeError("This fit was not recorded (record=False).")
        return Result(self.name)

    def rerun(self, **changes):
        """Fit again with the same settings; see ``Result.rerun``."""
        return self.result.rerun(**changes)

    def apply(self, waves, **changes):
        """Fit other waves with the same settings; see ``Result.apply``."""
        return self.result.apply(waves, **changes)

    def __getitem__(self, name):
        return float(self.coef[self.names.index(name)])

    def __repr__(self):
        return f"FitResult({self.function}, chisq={self.chisq:.6g})"

    def __str__(self):
        return _fit_summary(
            f"Fit: {self.function}", self.names, self.coef, self.sigma, self.held, self.chisq,
            self.points, self.converged, self.reason, self.covariance,
        )


def _correlation(covariance):
    if covariance is None:
        return None
    covariance = np.asarray(covariance, dtype=float)
    with np.errstate(all="ignore"):
        spread = np.sqrt(np.diag(covariance))
        correlation = covariance / np.outer(spread, spread)
    correlation[~np.isfinite(correlation)] = np.nan
    return correlation


def _fit_summary(title, names, coef, sigma, held, chisq, points, converged, reason, covariance):
    """What a fit prints: the parameters, and what makes them doubtful."""
    lines = [f"{title}, {points} points, chi-square = {chisq:.6g}"]
    if not converged:
        why = f": {reason}" if reason else ""
        lines.append(f"  (did not converge{why}; showing the best parameters found)")
    width = max(len(name) for name in names)
    for name, value, error in zip(names, coef, sigma):
        if name in held:
            lines.append(f"  {name:<{width}} = {value:.6g} (held)")
            continue
        lines.append(f"  {name:<{width}} = {value:.6g} ± {error:.3g}")
    # Parameters that can stand in for each other are not determined separately.
    correlation = _correlation(covariance)
    if correlation is not None:
        pairs = [
            f"{names[i]} and {names[j]} ({correlation[i, j]:+.3f})"
            for i in range(len(names))
            for j in range(i + 1, len(names))
            if np.isfinite(correlation[i, j]) and abs(correlation[i, j]) > 0.98
        ]
        if pairs:
            lines.append(f"  strongly correlated: {', '.join(pairs)}")
    return "\n".join(lines)


def _incomplete_beta(a, b, x, y):
    """The regularized incomplete beta function I_x(a, b), with y = 1 - x given separately.

    By its continued fraction (modified Lentz). Taking 1 - x from the caller
    keeps its precision when x is close to 1.
    """
    if x <= 0:
        return 0.0
    if y <= 0:
        return 1.0
    # The fraction converges quickly only on this side of the mean.
    if x > (a + 1) / (a + b + 2):
        return 1.0 - _incomplete_beta(b, a, y, x)
    front = math.exp(
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(y)
    ) / a
    tiny = 1e-300
    fraction, c, d = 1.0, 1.0, 0.0
    for index in range(100000):
        m = index // 2
        if index == 0:
            term = 1.0
        elif index % 2 == 0:
            term = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
        else:
            term = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))
        d = 1.0 + term * d
        d = 1.0 / (d if abs(d) > tiny else tiny)
        c = 1.0 + term / c
        c = c if abs(c) > tiny else tiny
        fraction *= c * d
        if abs(1.0 - c * d) < 1e-15:
            break
    return front * (fraction - 1.0)


def _student_quantile(p, freedom):
    """The value below which Student's t falls with probability p.

    The upper tail P(T > t) = I_x(n/2, 1/2) / 2, with x = n/(n + t^2) for n
    degrees of freedom, is inverted by bisection. Unlike an expansion in 1/n,
    this stays accurate to near rounding down to n = 1.
    """
    if p < 0.5:
        return -_student_quantile(1 - p, freedom)
    n = float(freedom)

    def tail(t):
        square = t * t
        return 0.5 * _incomplete_beta(n / 2, 0.5, n / (n + square), square / (n + square))

    target = 1.0 - p
    low, high = 0.0, 1.0
    while tail(high) > target:
        low, high = high, 2 * high
    while high - low > 1e-15 * high:
        middle = (low + high) / 2
        if tail(middle) > target:
            low = middle
        else:
            high = middle
    return (low + high) / 2


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


#: Limits a built-in function's parameters have unless others are given.
_DEFAULT_BOUNDS = {"pseudo_voigt": {"eta": (0.0, 1.0)}}


def _limits(function, bounds):
    """The limits of the parameters: those given, on top of the function's own.

    A side given as None has no limit of the user's; the function's own limit
    on that side, if it has one, stays.
    """
    limits = dict(_DEFAULT_BOUNDS.get(function, {})) if isinstance(function, str) else {}
    for key, (low, high) in (bounds or {}).items():
        own_low, own_high = limits.get(key, (None, None))
        limits[key] = (own_low if low is None else low, own_high if high is None else high)
    return limits


def _graph_showing(y_wave, graph):
    """The graph given, or the frontmost one that shows the wave; None if none does."""
    for candidate in [graph] if graph is not None else reversed(_op.graphs()):
        candidate = _op.graph(candidate) if isinstance(candidate, str) else candidate
        if any(trace["y"] == y_wave.name for trace in candidate._info()["traces"]):
            return candidate
    return None


def _spans(spans, what):
    """One (low, high) pair or a list of them, as a list of sorted pairs of numbers."""
    try:
        array = np.asarray(spans, dtype=float)
    except (TypeError, ValueError):
        array = None
    if array is None or array.ndim not in (1, 2) or array.shape[-1] != 2:
        raise _op.OresmeError(f"{what} takes (low, high) in X, or a list of such pairs.")
    return [sorted((float(low), float(high))) for low, high in array.reshape(-1, 2)]


def _selection(x_values, y_values, target, *, range=None, xrange=None, cursors=False,
               exclude=None, mask=None):
    """Which points an analysis uses, and the settings that choose the same points again.

    Returns (use, settings, waves): a boolean per point, the choices as they
    are recorded with the result, and the waves the choice depends on.
    """
    count = len(y_values)
    use = np.ones(count, dtype=bool)
    said = {}
    waves = []
    if cursors:
        if target is None:
            raise _op.OresmeError("cursors=True needs a graph that shows the wave.")
        marks = target._info()["cursors"]
        if "A" not in marks or "B" not in marks:
            raise _op.OresmeError("Put cursors A and B on the graph first.")
        # The cursors may move later: the points they marked are what is recorded.
        range = (marks["A"]["point"], marks["B"]["point"])
    if range is not None:
        first, last = sorted((int(range[0]), int(range[1])))
        first, last = max(0, first), min(count - 1, last)
        use[:first] = False
        use[last + 1 :] = False
        said["range"] = [first, last]
    if xrange is not None:
        (low, high), = _spans(xrange, "xrange")[:1]
        use &= (x_values >= low) & (x_values <= high)
        said["xrange"] = [low, high]
    if exclude is not None:
        said["exclude"] = _spans(exclude, "exclude")
        for low, high in said["exclude"]:
            use &= ~((x_values >= low) & (x_values <= high))
    if mask is not None:
        if isinstance(mask, (str, _op.Wave)):
            mask_wave = _op.wave(_op._wave_name(mask))
            values = np.asarray(mask_wave.data)
            said["mask"] = mask_wave.name
            waves.append(mask_wave.name)
        else:
            values = np.asarray(mask)
            # Not a wave: there is nothing by which to find it again.
            said["mask"] = _UNREPEATABLE
        if values.shape != y_values.shape:
            raise _op.OresmeError("mask needs one value per point: nonzero to use the point.")
        with np.errstate(all="ignore"):
            use &= np.nan_to_num(values.astype(float), nan=0.0) != 0
    return use, said, waves


#: Stands in the recorded settings for a value that was given as data, not as a wave.
_UNREPEATABLE = "<array>"


def fit(function, y, x=None, *, guess=None, hold=None, bounds=None, sigma=None, range=None,
        xrange=None, exclude=None, mask=None, cursors=False, graph=None, name=None, quiet=False,
        residuals=False, band=None, result=None, record=True):
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

    ``x`` is an X wave; without it the wave's X scaling is used.

    Which points are fitted, the wave itself staying as it is:
    ``range=(a, b)`` takes points a..b inclusive, ``xrange=(x1, x2)`` those
    with X in that span, ``cursors=True`` the points between cursors A and B
    of the graph. ``exclude=(x1, x2)`` or ``exclude=[(x1, x2), ...]`` leaves
    out the points with X in those spans, and ``mask`` (a wave or array with
    one value per point) leaves out the points where it is zero. They combine.

    ``residuals=True`` also makes ``res_<name>`` (data minus fit) and shows it
    on an axis of its own above the data. ``band=0.95`` makes
    ``fit_<name>_lo`` and ``fit_<name>_hi``, the confidence band of the fitted
    curve at that level, drawn as a shaded band.

    Makes a wave ``fit_<name>`` with the fitted curve and adds it to the graph
    showing the data, and stores the coefficients in ``W_coef`` and their
    standard deviations in ``W_sigma``. Returns a ``FitResult``, which also
    has the covariance and correlation of the parameters and why the fit
    stopped.

    The fit is kept among the experiment's results (``op.results()``) with
    its settings, as ``Fit0``, ``Fit1``, ...; ``result="name"`` names it,
    replacing a result of that name, and ``record=False`` keeps nothing.
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
    target = _graph_showing(y_wave, graph)
    use, chosen, inputs = _selection(
        x_values, y_values, target, range=range, xrange=xrange, cursors=cursors,
        exclude=exclude, mask=mask,
    )
    use &= np.isfinite(x_values) & np.isfinite(y_values)
    weights = None
    said_sigma = None
    if sigma is not None:
        if isinstance(sigma, (str, _op.Wave)):
            sigma_wave = _op.wave(_op._wave_name(sigma))
            said_sigma = sigma_wave.name
            inputs.append(sigma_wave.name)
            sigma = sigma_wave.data
        else:
            said_sigma = float(sigma) if np.ndim(sigma) == 0 else _UNREPEATABLE
        errors = np.broadcast_to(np.asarray(sigma, dtype=float), y_values.shape)
        use &= np.isfinite(errors) & (errors > 0)
        weights = 1.0 / errors[use]
    if not use.any():
        raise _op.OresmeError("No points are left to fit.")
    # The curve and the residuals are drawn from the first point used to the last.
    first, last = (int(index) for index in np.flatnonzero(use)[[0, -1]])
    x_fit, y_fit = x_values[use], y_values[use]
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
    for key, (low, high) in _limits(function, bounds).items():
        at = _index_of(names, key, "bounds")
        lower[at] = -np.inf if low is None else float(low)
        upper[at] = np.inf if high is None else float(high)
        if lower[at] >= upper[at]:
            raise _op.OresmeError(f"bounds: the limits for {key!r} are empty.")

    def reduced(x_, *values):
        trial = full.copy()
        trial[free] = values
        return model(x_, *trial)

    design = None
    if isinstance(function, str) and (function == "line" or function.startswith("poly")):
        # a + b*x and K0 + K1*x + ... are linear in their parameters.
        design = np.vander(x_fit, len(names), increasing=True)[:, free]
    best, free_covariance, chisq, converged, reason = _least_squares(
        reduced, x_fit, y_fit, full[free], weights, lower[free], upper[free], design=design
    )
    params = full.copy()
    params[free] = best
    covariance = np.zeros((len(names), len(names)))
    covariance[np.ix_(free, free)] = free_covariance
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
    level = None
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
                whole[use] = values
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

    stored = None
    if record:
        outputs = {"fit": fit_wave.name}
        if residual_wave is not None:
            outputs["residuals"] = residual_wave.name
        if band_waves is not None:
            outputs["band_low"], outputs["band_high"] = (wave_.name for wave_ in band_waves)
        stored = _record(
            {
                "kind": "fit",
                "label": f"{label}({leaf})",
                "settings": {
                    "function": label,
                    "custom": callable(function),
                    "y": y_wave.name,
                    "x": None if x_wave is None else x_wave.name,
                    "guess": None if guess is None else [float(value) for value in guess],
                    "hold": {key: float(full[names.index(key)]) for key in held},
                    "bounds": {
                        key: [None if low is None else float(low), None if high is None else float(high)]
                        for key, (low, high) in (bounds or {}).items()
                    },
                    "sigma": said_sigma,
                    **chosen,
                    "residuals": bool(residuals),
                    "band": level,
                    "name": name,
                },
                "inputs": [y_wave.name, *([x_wave.name] if x_wave is not None else []), *inputs],
                "names": list(names),
                "coef": params,
                "sigma": sigma,
                "held": held,
                "covariance": covariance,
                "chisq": chisq,
                "points": len(y_fit),
                "freedom": len(y_fit) - len(free),
                "converged": converged,
                "reason": reason,
                "outputs": outputs,
            },
            result,
        )
    outcome = FitResult(
        f"{label}({leaf})", names, params, sigma, chisq, len(y_fit), fit_wave, converged, held,
        residuals=residual_wave, band=band_waves, reason=reason, covariance=covariance,
        freedom=len(y_fit) - len(free), name=stored,
    )
    if not quiet:
        print(outcome)
    return outcome


# --- Results kept in the experiment ---------------------------------------------------


def _plain(value):
    """A value as JSON can hold it: no NumPy types, and None where a number is not finite."""
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if isinstance(value, np.ndarray):
        return _plain(value.tolist())
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        return float(value) if np.isfinite(value) else None
    return value


def _record(payload, name=None):
    """Keeps the outcome of an analysis in the experiment; returns the name it is kept under."""
    command = {"op": "addResult", "result": _plain(payload)}
    if name is not None:
        command["name"] = name
    return _op._dispatch(command)


def _numbers(values):
    return np.array([np.nan if value is None else value for value in values], dtype=float)


class Result:
    """An analysis kept in the experiment: what was asked for and what came out.

    ``names``, ``coef`` and ``sigma`` are the parameters; ``settings`` is what
    the analysis was told; ``changed`` lists the waves it read that are no
    longer what they were then. ``rerun()`` does it again and ``apply(waves)``
    does the same to other waves.
    """

    def __init__(self, name):
        self._name = name

    def _info(self):
        return _op._call("resultInfo", {"name": self._name})[0]

    @property
    def name(self):
        return self._name

    kind = property(lambda self: self._info()["kind"])
    label = property(lambda self: self._info()["label"])
    names = property(lambda self: tuple(self._info()["names"]))
    held = property(lambda self: tuple(self._info()["held"]))
    coef = property(lambda self: _numbers(self._info()["coef"]))
    sigma = property(lambda self: _numbers(self._info()["sigma"]))
    points = property(lambda self: self._info()["points"])
    freedom = property(lambda self: self._info()["freedom"])
    converged = property(lambda self: self._info()["converged"])
    reason = property(lambda self: self._info()["reason"])
    settings = property(lambda self: self._info()["settings"])
    #: The waves the analysis read that have changed (or are gone) since.
    changed = property(lambda self: self._info()["changed"])

    @property
    def chisq(self):
        value = self._info()["chisq"]
        return np.nan if value is None else value

    @property
    def covariance(self):
        rows = self._info()["covariance"]
        return None if rows is None else np.array([_numbers(row) for row in rows])

    @property
    def correlation(self):
        return _correlation(self.covariance)

    @property
    def created(self):
        """When the analysis was done, as a ``datetime`` in UTC."""
        import datetime

        return datetime.datetime.fromtimestamp(
            self._info()["created"] / 1000, tz=datetime.timezone.utc
        )

    @property
    def outputs(self):
        """The waves the analysis made, by role ("fit", "residuals", ...); those since deleted are left out."""
        existing = set(_op._call("listWaves")[0])
        return {
            role: _op.Wave(wave_)
            for role, wave_ in self._info()["outputs"].items()
            if wave_ in existing
        }

    def __getitem__(self, name):
        info = self._info()
        if name not in info["names"]:
            raise KeyError(name)
        value = info["coef"][info["names"].index(name)]
        return np.nan if value is None else value

    def _call(self, **changes):
        """The function that does this kind of analysis and the arguments that repeat it."""
        info = self._info()
        settings = dict(info["settings"])
        unrepeatable = [key for key, value in settings.items() if value == _UNREPEATABLE]
        unrepeatable = [key for key in unrepeatable if key not in changes]
        if unrepeatable:
            raise _op.OresmeError(
                f"{self._name} was given {', '.join(unrepeatable)} as data, which was not kept. "
                f"Give {' and '.join(f'{key}=' for key in unrepeatable)} again, or use a wave next time."
            )
        if info["kind"] == "fit":
            function = settings.pop("function")
            if settings.pop("custom", False) and "function" not in changes:
                function = _user_function(function, self._name)
            call = fit
            settings["function"] = function
        elif info["kind"] == "peaks":
            call = fit_peaks
        else:
            call = fit_global
            function = settings.pop("function")
            if settings.pop("custom", False) and "function" not in changes:
                function = _user_function(function, self._name)
            settings["function"] = function
        settings.update(changes)
        return call, settings

    def rerun(self, replace=False, **changes):
        """Do the analysis again with the same settings, on the data as it is now.

        Keyword arguments change settings (``rerun(hold={"y0": 0})``). The
        outcome is kept as a new result, so that both can be compared, unless
        ``replace=True``.
        """
        call, settings = self._call(**changes)
        if replace:
            settings["result"] = self._name
        return call(**settings)

    def apply(self, waves, table=True, **changes):
        """Do the same analysis on other waves; returns the list of outcomes.

        Each wave takes the place of the one analysed (``y``); everything
        else stays, an X wave included. With ``table`` the outcomes are also
        put side by side in a table (see ``op.results_table``).
        """
        if self.kind == "global":
            raise _op.OresmeError("A fit of several waves at once cannot be applied wave by wave.")
        outcomes = []
        for wave_ in [waves] if isinstance(waves, (str, _op.Wave)) else list(waves):
            call, settings = self._call(**changes)
            settings["y"] = wave_
            settings.setdefault("quiet", True)
            # Each wave's curve is named after the wave, not after the first fit's.
            settings.pop("name", None)
            outcomes.append(call(**settings))
        if table and outcomes:
            results_table(outcomes)
        return outcomes

    def rename(self, name):
        self._name = _op._dispatch({"op": "renameResult", "name": self._name, "newName": name})
        return self

    def remove(self):
        """Forget the result. The waves it made stay."""
        _op._dispatch({"op": "removeResults", "names": [self._name]})

    def __repr__(self):
        return f"Result({self._name!r})"

    def __str__(self):
        info = self._info()
        text = _fit_summary(
            f"{self._name}: {info['label']}", info["names"], _numbers(info["coef"]),
            _numbers(info["sigma"]), info["held"], self.chisq, info["points"], info["converged"],
            info["reason"], self.covariance,
        )
        if info["changed"]:
            text += f"\n  (changed since: {', '.join(info['changed'])})"
        return text


def _user_function(name, result):
    """A fit function of the user's, found again by its name among what they have defined."""
    try:
        from IPython import get_ipython

        namespace = get_ipython().user_ns
    except Exception:  # Outside the command window there is no such namespace.
        namespace = {}
    function = namespace.get(name)
    if not callable(function):
        raise _op.OresmeError(
            f"{result} used your function {name!r}, which is not defined now. "
            "Define it again, or pass function=."
        )
    return function


def results():
    """Every analysis kept in the experiment, oldest first."""
    return [Result(name) for name in _op._call("listResults")[0]]


def result(name=None):
    """A result by name; with no name, the latest."""
    names = _op._call("listResults")[0]
    if name is None:
        if not names:
            raise _op.OresmeError("There are no results yet.")
        return Result(names[-1])
    if name not in names:
        raise _op.OresmeError(f"No result named {name!r}.")
    return Result(name)


def _result_name(item):
    name = item if isinstance(item, str) else getattr(item, "name", None)
    if not isinstance(name, str):
        raise _op.OresmeError("Give results by name, or as the objects the fits return.")
    return name


def results_table(results_=None, name="Results", sigma=True):
    """Put results side by side: a row for each, a column for each parameter.

    ``results_`` is a list of results (names, or what the fits returned);
    all of them if left out. Makes text waves ``<name>_result`` and
    ``<name>_data`` (which result, and the wave it was about) and, for each
    parameter, ``<name>_<parameter>`` and (with ``sigma``)
    ``<name>_<parameter>_sd``, then ``<name>_chisq``, and shows them in a
    table, which is returned. A parameter a result does not have is NaN.
    """
    names = [_result_name(item) for item in (results() if results_ is None else results_)]
    if not names:
        raise _op.OresmeError("There are no results to put in a table.")
    infos = [_op._call("resultInfo", {"name": item})[0] for item in names]
    parameters = []
    for info in infos:
        parameters += [key for key in info["names"] if key not in parameters]

    def column(info, key, field):
        if key not in info["names"]:
            return np.nan
        value = info[field][info["names"].index(key)]
        return np.nan if value is None else value

    def clean(key):
        return "".join(char if char.isalnum() or char == "_" else "_" for char in key).strip("_")

    waves = [
        _op.make(f"{name}_result", names),
        _op.make(f"{name}_data", [str(info["settings"].get("y", "")) for info in infos]),
    ]
    for key in parameters:
        waves.append(_op.make(f"{name}_{clean(key)}", [column(info, key, "coef") for info in infos]))
        if sigma:
            waves.append(
                _op.make(f"{name}_{clean(key)}_sd", [column(info, key, "sigma") for info in infos])
            )
    waves.append(
        _op.make(f"{name}_chisq", [np.nan if info["chisq"] is None else info["chisq"] for info in infos])
    )
    existing = {table.name: table for table in _op.tables()}
    if name in existing:
        # The same table again: it shows the waves as they are now.
        shown = {column_.name for column_ in existing[name].columns}
        missing = [wave_ for wave_ in waves if wave_.name not in shown]
        if missing:
            existing[name].append(*missing)
        return existing[name]
    return _op.edit(*waves, name=name)


def fit_batch(function, waves, *, table=True, quiet=True, **options):
    """Fit the same function to several waves, one after another.

    Takes the options of ``op.fit`` (the same ``x`` wave, ranges, holds and
    bounds for all). Returns the list of ``FitResult``; with ``table`` they
    are also put side by side in a table (see ``op.results_table``).
    """
    outcomes = [fit(function, wave_, quiet=quiet, **options) for wave_ in waves]
    if table and outcomes and all(outcome.name for outcome in outcomes):
        results_table(outcomes)
    if not quiet:
        return outcomes
    for outcome in outcomes:
        state = "" if outcome.converged else "  (did not converge)"
        print(f"{outcome.name or '-'}: {outcome.function}, chi-square = {outcome.chisq:.6g}{state}")
    return outcomes


class GlobalFitResult:
    """The outcome of ``op.fit_global``: one row of coefficients per wave.

    ``coef`` and ``sigma`` have a row for each wave and a column for each
    parameter, in the order of ``names``; a shared parameter has the same
    value in every row. ``waves`` are the fitted curves.
    """

    def __init__(self, function, names, shared, held, data, coef, sigma, chisq, points,
                 converged, reason, waves, name=None):
        self.function = function
        self.names = tuple(names)
        self.shared = tuple(shared)
        self.held = tuple(held)
        #: The names of the waves that were fitted, in the order of the rows.
        self.data = tuple(data)
        self.coef = coef
        self.sigma = sigma
        self.chisq = chisq
        self.points = points
        self.converged = converged
        self.reason = reason
        self.waves = waves
        self.name = name

    @property
    def result(self):
        """The fit as it is kept in the experiment: ``.rerun()``, ``.remove()``."""
        if self.name is None:
            raise _op.OresmeError("This fit was not recorded (record=False).")
        return Result(self.name)

    def __getitem__(self, name):
        """A shared parameter as a number, any other as an array with a value per wave."""
        column = self.coef[:, self.names.index(name)]
        return float(column[0]) if name in self.shared else column.copy()

    def __repr__(self):
        return f"GlobalFitResult({self.function}, {len(self.data)} waves, chisq={self.chisq:.6g})"

    def __str__(self):
        lines = [
            f"Global fit: {self.function} to {len(self.data)} waves, {self.points} points, "
            f"chi-square = {self.chisq:.6g}"
        ]
        if not self.converged:
            why = f": {self.reason}" if self.reason else ""
            lines.append(f"  (did not converge{why}; showing the best parameters found)")
        for key in self.shared:
            at = self.names.index(key)
            lines.append(f"  {key} = {self.coef[0, at]:.6g} ± {self.sigma[0, at]:.3g}  (shared)")
        own = [key for key in self.names if key not in self.shared]
        if own:
            width = max(len(leaf) for leaf in self.data)
            lines.append("  " + " " * width + "".join(f"  {key:>24}" for key in own))
            for row, leaf in enumerate(self.data):
                cells = []
                for key in own:
                    at = self.names.index(key)
                    cell = (
                        f"{self.coef[row, at]:.6g} (held)" if key in self.held
                        else f"{self.coef[row, at]:.6g} ± {self.sigma[row, at]:.3g}"
                    )
                    cells.append(f"  {cell:>24}")
                lines.append(f"  {leaf:<{width}}" + "".join(cells))
        return "\n".join(lines)


def fit_global(function, ys, xs=None, *, shared=(), guess=None, hold=None, bounds=None,
               quiet=False, result=None, record=True):
    """Fit one function to several waves at once, with some parameters common to all.

    ``ys`` is a list of waves. ``shared`` names the parameters that have one
    value for all of them (a time constant, a peak position); the others are
    fitted for each wave. ``xs`` is an X wave for all, or a list with one
    for each; without it each wave's X scaling is used.

    ``guess`` is a list with a starting value per parameter, used for every
    wave (needed for a function of your own). ``hold={"y0": 0}`` fixes a
    parameter for every wave, and ``bounds={"A": (0, None)}`` limits it.

    Makes ``fit_<name>`` for each wave and adds it to the graph showing the
    wave. Returns a ``GlobalFitResult``; the fit is kept among the
    experiment's results as ``Global0``, ``Global1``, ....
    """
    y_waves = [_op.wave(_op._wave_name(item)) for item in ys]
    if len(y_waves) < 2:
        raise _op.OresmeError("A global fit needs two waves or more; for one, use op.fit.")
    if xs is None or isinstance(xs, (str, _op.Wave)):
        x_waves = [None if xs is None else _op.wave(_op._wave_name(xs))] * len(y_waves)
    else:
        x_waves = [_op.wave(_op._wave_name(item)) for item in xs]
        if len(x_waves) != len(y_waves):
            raise _op.OresmeError("xs needs one X wave for each wave of ys, or a single one for all.")
    sets = []
    for y_wave, x_wave in zip(y_waves, x_waves):
        values = np.asarray(y_wave.data, dtype=float)
        if values.ndim != 1:
            raise _op.OresmeError("Only 1-D waves can be fitted.")
        at = np.asarray(y_wave.x if x_wave is None else x_wave.data, dtype=float)
        if len(at) != len(values):
            raise _op.OresmeError(f"{y_wave.name} and its X wave have different lengths.")
        keep = np.isfinite(at) & np.isfinite(values)
        if not keep.any():
            raise _op.OresmeError(f"{y_wave.name} has no points to fit.")
        sets.append((at, values, keep))

    count = len(sets)
    model, names, _, label = _resolve(function, sets[0][0][sets[0][2]], sets[0][1][sets[0][2]], guess)
    size = len(names)
    shared = [names[_index_of(names, key, "shared")] for key in shared]
    # A starting point for each wave: its own guess, where the function has one.
    starts = np.array([
        _resolve(function, at[keep], values[keep], guess)[2] for at, values, keep in sets
    ], dtype=float)
    if starts.shape[1] != size:
        raise _op.OresmeError(f"{label} has {size} parameters; the guess has {starts.shape[1]}.")
    held = []
    if isinstance(hold, dict):
        for key, value in hold.items():
            starts[:, _index_of(names, key, "hold")] = float(value)
            held.append(key)
    elif hold is not None:
        held = [names[_index_of(names, key, "hold")] for key in hold]
    low = np.full(size, -np.inf)
    high = np.full(size, np.inf)
    for key, (least, most) in _limits(function, bounds).items():
        at = _index_of(names, key, "bounds")
        low[at] = -np.inf if least is None else float(least)
        high[at] = np.inf if most is None else float(most)

    # The fitted values in one row: each shared parameter once, then the others wave by wave.
    places = []  # (parameter, wave or None for all)
    for index, key in enumerate(names):
        if key in held:
            continue
        if key in shared:
            places.append((index, None))
    for row in np.arange(count):
        places += [(index, int(row)) for index, key in enumerate(names)
                   if key not in held and key not in shared]
    if not places:
        raise _op.OresmeError("Every parameter is held; there is nothing to fit.")
    total = int(sum(keep.sum() for _, _, keep in sets))
    if total <= len(places):
        raise _op.OresmeError(f"{total} points are not enough to fit {len(places)} parameters.")

    def table(values):
        """The coefficients of every wave, from the fitted values."""
        whole = starts.copy()
        for value, (index, row) in zip(values, places):
            if row is None:
                whole[:, index] = value
            else:
                whole[row, index] = value
        return whole

    def joined(_, *values):
        whole = table(values)
        return np.concatenate([
            model(at[keep], *whole[row]) for row, (at, _, keep) in enumerate(sets)
        ])

    first = [float(np.mean(starts[:, index])) if row is None else starts[row, index]
             for index, row in places]
    solved, covariance, chisq, converged, reason = _least_squares(
        joined, np.arange(total, dtype=float),
        np.concatenate([values[keep] for _, values, keep in sets]), first, None,
        [low[index] for index, _ in places], [high[index] for index, _ in places],
        max_iterations=400,
    )
    coef = table(solved)
    errors = np.sqrt(np.abs(np.diag(covariance)))
    sigma = np.zeros_like(coef)
    for error, (index, row) in zip(errors, places):
        if row is None:
            sigma[:, index] = error
        else:
            sigma[row, index] = error

    made = []
    for row, (y_wave, x_wave) in enumerate(zip(y_waves, x_waves)):
        at, values, keep = sets[row]
        leaf = y_wave.name.rsplit(":", 1)[-1]
        folder = y_wave.name.rsplit(":", 1)[0] + ":" if ":" in y_wave.name else ""
        with np.errstate(all="ignore"):
            if x_wave is None:
                grid = np.linspace(at[keep].min(), at[keep].max(), 200)
                curve = _op.make(
                    f"{folder}fit_{leaf}", model(grid, *coef[row]), x0=grid[0],
                    dx=(grid[1] - grid[0]) or 1.0, x_unit=y_wave.x_unit, unit=y_wave.unit,
                )
            else:
                curve = _op.make(f"{folder}fit_{leaf}", model(at, *coef[row]), unit=y_wave.unit)
        made.append(curve)
        target = _graph_showing(y_wave, None)
        if target is not None and not any(t["y"] == curve.name for t in target._info()["traces"]):
            source = next(t for t in target._info()["traces"] if t["y"] == y_wave.name)
            target.append(curve, x=x_wave, axis=source["vAxis"], haxis=source["hAxis"])
            target.trace(curve.name.rsplit(":", 1)[-1]).set(color="black")

    data = [y_wave.name for y_wave in y_waves]
    stored = None
    if record:
        flat_names, flat_coef, flat_sigma = [], [], []
        for key in shared:
            flat_names.append(key)
            flat_coef.append(coef[0, names.index(key)])
            flat_sigma.append(sigma[0, names.index(key)])
        for row in np.arange(count):
            for index, key in enumerate(names):
                if key in shared:
                    continue
                flat_names.append(f"{key}[{row}]")
                flat_coef.append(coef[row, index])
                flat_sigma.append(sigma[row, index])
        stored = _record(
            {
                "kind": "global",
                "label": f"{label}({len(data)} waves)",
                "settings": {
                    "function": label,
                    "custom": callable(function),
                    "ys": data,
                    "xs": (
                        None if xs is None
                        else x_waves[0].name if isinstance(xs, (str, _op.Wave))
                        else [x_wave.name for x_wave in x_waves]
                    ),
                    "shared": shared,
                    "guess": None if guess is None else [float(value) for value in guess],
                    "hold": {key: float(starts[0, names.index(key)]) for key in held},
                    "bounds": {
                        key: [None if least is None else float(least),
                              None if most is None else float(most)]
                        for key, (least, most) in (bounds or {}).items()
                    },
                },
                "inputs": data + [x_wave.name for x_wave in x_waves if x_wave is not None],
                "names": flat_names,
                "coef": flat_coef,
                "sigma": flat_sigma,
                "held": [f"{key}[{row}]" for row in np.arange(count) for key in held
                         if key not in shared],
                "covariance": None,
                "chisq": chisq,
                "points": total,
                "freedom": total - len(places),
                "converged": converged,
                "reason": reason,
                "outputs": {f"fit{row}": curve.name for row, curve in enumerate(made)},
            },
            result,
        )
    outcome = GlobalFitResult(
        label, names, shared, held, data, coef, sigma, chisq, total, converged, reason, made,
        name=stored,
    )
    if not quiet:
        print(outcome)
    return outcome


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
        # Infinities are left out here too, so the positions belong to min and max.
        counted = np.where(np.isfinite(values), values, np.nan)
        result["min_x"] = float(x[int(np.nanargmin(counted))])
        result["max_x"] = float(x[int(np.nanargmax(counted))])
    if not quiet:
        print(f"Stats of {source.name}:")
        for key, value in result.items():
            print(f"  {key:<6} = {value:g}")
    return result


def _x_data(x, length):
    """The values and unit of an X given as a wave, a wave's name or an array."""
    if isinstance(x, (str, _op.Wave)):
        source = _op.wave(_op._wave_name(x))
        values, unit = np.asarray(source.data, dtype=float), source.unit
    else:
        # An array is used as it is: making a wave of it would leave one behind.
        values, unit = np.asarray(x, dtype=float), ""
    if values.shape != (length,):
        raise _op.OresmeError(f"The X values must be 1-D with {length} points, like the wave.")
    return values, unit


def _checked_x(x_values, y_values):
    """X must be a number wherever Y is; where Y is missing it is a gap anyway."""
    loose = ~np.isfinite(x_values) & np.isfinite(y_values)
    if loose.any():
        raise _op.OresmeError(
            f"The X wave is NaN or infinite at point {int(np.flatnonzero(loose)[0])}, where Y has a value."
        )


def _units(y_unit, x_unit, joint):
    """``Y/X`` or ``Y·X``; nothing unless both are known.

    Dates on X are seconds. A compound unit is bracketed where joining it
    would change how it reads (``mAh/(g·V)`` must not read as ``mAh/g·V``).
    """
    x_unit = "s" if x_unit == "dat" else x_unit
    if not y_unit or not x_unit:
        return ""
    if joint == "/":
        return f"{y_unit}/({x_unit})" if any(mark in x_unit for mark in "/·* ") else f"{y_unit}/{x_unit}"
    return f"({y_unit})·{x_unit}" if "/" in y_unit else f"{y_unit}·{x_unit}"


def differentiate(wave_, name=None, *, x=None):
    """The derivative with respect to X, as a new wave ``<name>_DIF``.

    Central differences inside, one-sided at the two ends. ``x`` (a wave or an
    array with one value per point) differentiates against those values
    instead of the X scaling, e.g. ``op.differentiate(capacity, x=voltage)``
    for dQ/dV. The spacing may be uneven and X may turn back: each point uses
    the three-point formula for uneven steps, which is second-order accurate
    (``np.gradient(y, x)``, first order at the ends as without ``x``). Where
    two neighbouring X values are equal, or X turns back to the value it had
    two points before, the slope has no value and the result is NaN there.
    The result is then a plain wave with one point per point of the data,
    meant to be plotted against the same X wave.

    A NaN in the data leaves NaN in the derivative at it and its neighbours.
    The unit is ``Y/X`` when both units are known.
    """
    source, values = _numeric(wave_)
    if x is None:
        # Along X: for a matrix, down each column (np.gradient over every
        # dimension would give one array per dimension, not a wave).
        others = (
            {"y0": source.y0, "dy": source.dy, "y_unit": source.y_unit} if values.ndim > 1 else {}
        )
        return _op.make(
            _sibling(source, "_DIF", name),
            np.gradient(values, source.dx, axis=0),
            x0=source.x0,
            dx=source.dx,
            x_unit=source.x_unit,
            unit=_units(source.unit, source.x_unit, "/"),
            **others,
        )
    if values.ndim != 1 or len(values) < 2:
        raise _op.OresmeError("Differentiating against X needs a 1-D wave of at least 2 points.")
    x_values, x_unit = _x_data(x, len(values))
    _checked_x(x_values, values)
    steps = np.diff(x_values)
    with np.errstate(all="ignore"):
        slope = np.gradient(values, x_values)
    # A zero step, or a turn of X that comes back to the same value, would
    # divide by zero in the formula of the points that use it.
    undefined = np.zeros(len(values), dtype=bool)
    undefined[:-1] |= steps == 0
    undefined[1:] |= steps == 0
    undefined[1:-1] |= steps[:-1] + steps[1:] == 0
    slope[undefined] = np.nan
    return _op.make(
        _sibling(source, "_DIF", name),
        slope,
        x0=0,
        dx=1,
        x_unit="",
        unit=_units(source.unit, x_unit, "/"),
    )


def integrate(wave_, name=None, *, x=None):
    """The running integral over X (trapezoidal), as a new wave ``<name>_INT``.

    It starts at 0 at the first point. ``x`` (a wave or an array with one
    value per point) integrates against those values instead of the X
    scaling, e.g. ``op.integrate(current, x=time)`` for the charge. X may be
    unevenly spaced and need not increase: where it goes back, the area
    counts negative, as in a charge-discharge loop. The result is then a
    plain wave with one point per point of the data, meant to be plotted
    against the same X wave.

    A NaN in the data makes the running integral NaN from there on. The unit
    is ``Y·X`` when both units are known.
    """
    source, values = _numeric(wave_)
    if x is None:
        steps = (values[1:] + values[:-1]) / 2 * source.dx
        return _op.make(
            _sibling(source, "_INT", name),
            np.concatenate(([0.0], np.cumsum(steps))),
            x0=source.x0,
            dx=source.dx,
            x_unit=source.x_unit,
            unit=_units(source.unit, source.x_unit, "·"),
        )
    if values.ndim != 1:
        raise _op.OresmeError("Integrating against X needs a 1-D wave.")
    x_values, x_unit = _x_data(x, len(values))
    _checked_x(x_values, values)
    with np.errstate(invalid="ignore"):
        steps = (values[1:] + values[:-1]) / 2 * np.diff(x_values)
    return _op.make(
        _sibling(source, "_INT", name),
        np.concatenate(([0.0], np.cumsum(steps))),
        x0=0,
        dx=1,
        x_unit="",
        unit=_units(source.unit, x_unit, "·"),
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

    ``output="magnitude"`` gives the amplitude of each frequency component:
    ``A*cos(2*pi*f*x)`` shows as A at f, and a constant offset as its value at 0.
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
        # A cosine of amplitude A puts A/2 in each of the bins k and N-k; the
        # one-sided spectrum folds them together. DC, and the Nyquist bin of
        # an even length, have no mirror image and are not doubled.
        doubled = np.full(len(spectrum), 2.0)
        doubled[0] = 1.0
        if len(values) % 2 == 0:
            doubled[-1] = 1.0
        spectrum = np.abs(spectrum) * doubled / max(1, len(values))
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

class _Shape:
    """A peak shape of ``fit_peaks``, given by its width parameters.

    ``profile(u, *widths)`` is the peak of unit height at offset u = x - x0.
    The first width parameter is the one the shape is named for; ``more``
    names the others, which are reported with each peak. ``fwhm`` and
    ``area`` are those of the peak of unit height, ``start`` makes the width
    parameters from a measured FWHM, and ``bounds`` gives their limits for
    data spanning ``span`` in X.
    """

    def __init__(self, profile, fwhm, area, start, bounds, more=(), report=None):
        self.profile = profile
        self.fwhm = fwhm
        self.area = area
        self.start = start
        self.bounds = bounds
        self.more = more
        # (key, heading, value from the width parameters) for each extra column.
        self.report = report or ()


_GAUSS_FWHM = 2 * np.sqrt(np.log(2))

_SHAPES = {
    "gauss": _Shape(
        lambda u, width: np.exp(-((u / width) ** 2)),
        lambda width: _GAUSS_FWHM * width,
        lambda width: np.sqrt(np.pi) * width,
        lambda fwhm: [fwhm / _GAUSS_FWHM],
        lambda span: [(span * 1e-6, span)],
    ),
    "lor": _Shape(
        lambda u, width: 1 / (1 + (u / width) ** 2),
        lambda width: 2.0 * width,
        lambda width: np.pi * width,
        lambda fwhm: [fwhm / 2.0],
        lambda span: [(span * 1e-6, span)],
    ),
    # Gaussian width as in "gauss", Lorentzian half width as in "lor".
    "voigt": _Shape(
        _voigt,
        _voigt_fwhm,
        _voigt_area,
        # Equal Gaussian and Lorentzian FWHMs f make a Voigt FWHM of 1.6376 f.
        lambda fwhm: [fwhm / 1.6376 / _GAUSS_FWHM, fwhm / 1.6376 / 2],
        lambda span: [(span * 1e-6, span), (0.0, span)],
        more=("lorentz",),
        report=(
            ("gauss_fwhm", "Gauss FWHM", lambda gauss, lorentz: _GAUSS_FWHM * gauss),
            ("lorentz_fwhm", "Lor. FWHM", lambda gauss, lorentz: 2 * lorentz),
        ),
    ),
    # The width is the half width at half maximum that both parts share.
    "pseudo_voigt": _Shape(
        _pseudo_voigt,
        lambda width, eta: 2 * width,
        lambda width, eta: width * (eta * np.pi + (1 - eta) * np.sqrt(np.pi / np.log(2))),
        lambda fwhm: [fwhm / 2, 0.5],
        lambda span: [(span * 1e-6, span), (0.0, 1.0)],
        more=("eta",),
        report=(("eta", "eta", lambda width, eta: eta),),
    ),
}


def _spread(function, values, covariance):
    """The standard deviation of function(*values), by linear propagation."""
    values = np.asarray(values, dtype=float)
    slopes = np.zeros(len(values))
    for index, value in enumerate(values):
        step = 1e-6 * max(abs(value), 1e-12)
        up, down = values.copy(), values.copy()
        up[index] += step
        # A width resting on 0 is not stepped through it, where only its size counts.
        if not 0 <= value < step:
            down[index] -= step
        slopes[index] = (function(*up) - function(*down)) / (up[index] - down[index])
    return float(np.sqrt(abs(slopes @ covariance @ slopes)))


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

    def __init__(self, shape, peaks, baseline, chisq, points, wave, components, converged,
                 columns=(), reason="", name=None):
        #: Why the fit stopped, in words.
        self.reason = reason
        #: The name under which the fit is kept among the experiment's results, or None.
        self.name = name
        self.shape = shape
        #: A list of dicts: x, height, width (FWHM), area, their uncertainties,
        #: and what the shape adds (the Gaussian and Lorentzian FWHMs of a
        #: Voigt peak, eta of a pseudo-Voigt).
        self.peaks = peaks
        #: (key, heading) of the columns the shape adds to the table.
        self.columns = tuple(columns)
        self.baseline = baseline
        self.chisq = chisq
        self.points = points
        self.wave = wave
        self.components = components
        self.converged = converged

    @property
    def result(self):
        """The fit as it is kept in the experiment: ``.rerun()``, ``.apply(waves)``, ``.remove()``."""
        if self.name is None:
            raise _op.OresmeError("This fit was not recorded (record=False).")
        return Result(self.name)

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
            why = f": {self.reason}" if self.reason else ""
            lines.append(f"  (did not converge{why}; showing the best parameters found)")
        extra = "".join(f"  {heading:>12}" for _, heading in self.columns)
        lines.append(f"  {'#':>2}  {'position':>12}  {'height':>12}  {'FWHM':>12}  {'area':>12}{extra}")
        for number, peak in enumerate(self.peaks, 1):
            extra = "".join(f"  {peak[key]:>12.6g}" for key, _ in self.columns)
            lines.append(
                f"  {number:>2}  {peak['x']:>12.6g}  {peak['height']:>12.6g}  "
                f"{peak['width']:>12.6g}  {peak['area']:>12.6g}{extra}"
            )
        if self.baseline:
            terms = ", ".join(f"{key} = {value:.6g}" for key, value in self.baseline.items())
            lines.append(f"  baseline: {terms}")
        return "\n".join(lines)


def _triples(ties, what):
    """Ties between two peaks, given as {(i, j): value} or [(i, j, value), ...], as a list."""
    if ties is None:
        return []
    items = [(*key, value) for key, value in ties.items()] if isinstance(ties, dict) else list(ties)
    try:
        return [(int(first), int(second), float(value)) for first, second, value in items]
    except (TypeError, ValueError):
        raise _op.OresmeError(
            f"{what} takes {{(i, j): value}} or [(i, j, value), ...], with peaks numbered from 1."
        ) from None


def fit_peaks(y, x=None, *, peaks=None, shape="gauss", baseline="constant", range=None,
              xrange=None, exclude=None, mask=None, cursors=False, graph=None, components=True,
              same_width=False, spacing=None, area_ratio=None, quiet=False, result=None,
              record=True, **find):
    """Fit several peaks at once: a sum of peaks of one shape on a baseline.

    ``peaks`` says where to start: nothing to find them (see ``op.find_peaks``,
    whose options can be given here), a number to take that many of the
    tallest, or a list of X positions. ``baseline`` is ``"constant"``,
    ``"linear"`` or ``None``.

    ``shape`` is ``"gauss"``, ``"lor"``, ``"voigt"`` or ``"pseudo_voigt"``.
    A Voigt peak (a Gaussian convolved with a Lorentzian) has a Gaussian and
    a Lorentzian width of its own, both fitted; each peak also reports their
    FWHMs as ``gauss_fwhm`` and ``lorentz_fwhm``. A pseudo-Voigt peak is
    ``eta * Lorentzian + (1 - eta) * Gaussian`` with one FWHM, and reports
    ``eta`` (kept within 0..1).

    Peaks can be tied to each other, as the lines of a multiplet are. Peaks
    are numbered from 1, left to right as they start out:

    - ``same_width=True`` gives every peak the width (all width parameters) of the first;
    - ``spacing={(1, 2): 1.2}`` keeps peak 2 at 1.2 to the right of peak 1;
    - ``area_ratio={(1, 2): 0.5}`` keeps the area of peak 2 at half that of peak 1.

    A tied quantity is not fitted: it follows the peak it is tied to, and its
    uncertainty is carried over from that peak's.

    ``range``, ``xrange``, ``exclude``, ``mask`` and ``cursors`` choose the
    points, as for ``op.fit``.

    Makes ``fit_<name>`` (the sum), ``fit_<name>_p1``, ``_p2``, ... (each peak
    on the baseline, if ``components``), and ``W_peaks``: one row per peak with
    position, height, full width at half maximum and area, then the columns
    the shape adds. Returns a ``PeakFitResult`` listing the peaks from left to
    right. The fit is kept among the experiment's results as ``Peaks0``,
    ``Peaks1``, ... (see ``op.results()``), unless ``record=False``.
    """
    if shape not in _SHAPES:
        raise _op.OresmeError(f"shape must be one of {', '.join(_SHAPES)}.")
    if baseline not in ("constant", "linear", None):
        raise _op.OresmeError('baseline must be "constant", "linear" or None.')
    form = _SHAPES[shape]
    # Height, position, then the width parameters.
    size = 3 + len(form.more)
    y_wave = _op.wave(_op._wave_name(y))
    x_wave = None if x is None else _op.wave(_op._wave_name(x))
    y_values = np.asarray(y_wave.data, dtype=float)
    if y_values.ndim != 1:
        raise _op.OresmeError("Only 1-D waves can be fitted.")
    x_values = np.asarray(y_wave.x if x_wave is None else x_wave.data, dtype=float)
    leaf = y_wave.name.rsplit(":", 1)[-1]

    target = _graph_showing(y_wave, graph)
    use, chosen, inputs = _selection(
        x_values, y_values, target, range=range, xrange=xrange, cursors=cursors,
        exclude=exclude, mask=mask,
    )
    use &= np.isfinite(x_values) & np.isfinite(y_values)
    if not use.any():
        raise _op.OresmeError("No points are left to fit.")
    first, last = (int(index) for index in np.flatnonzero(use)[[0, -1]])
    x_fit = x_values[use]
    y_fit = y_values[use]

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
    if len(y_fit) <= size * count + base_terms:
        raise _op.OresmeError(f"{len(y_fit)} points are not enough to fit {count} peaks.")
    centre = float(x_fit.mean())

    def model(x_, *values):
        total = np.zeros_like(x_, dtype=float)
        if base_terms >= 1:
            total = total + values[0]
        if base_terms == 2:
            total = total + values[1] * (x_ - centre)
        for number in np.arange(count):
            at = base_terms + size * number
            total = total + values[at] * form.profile(x_ - values[at + 1], *values[at + 2 : at + size])
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
        start += [height, position, *form.start(width)]
        # A peak keeps its sign, stays in the data, and stays narrower than the data.
        limits = form.bounds(span)
        lower += [0.0 if height > 0 else -np.inf, float(x_fit.min()), *(low for low, _ in limits)]
        upper += [np.inf if height > 0 else 0.0, float(x_fit.max()), *(high for _, high in limits)]
    start, lower, upper = (np.array(values, dtype=float) for values in (start, lower, upper))

    # Ties: a tied parameter is left out of the fit and worked out from the others.
    def at_peak(number, what):
        if not 1 <= number <= count:
            raise _op.OresmeError(f"{what}: there is no peak {number}; the peaks are 1 to {count}.")
        return base_terms + size * (number - 1)

    ties = {}

    def tie(index, rule, what):
        if index in ties:
            raise _op.OresmeError(f"{what}: that peak is tied twice over.")
        ties[index] = rule

    if same_width:
        for number in np.arange(2, count + 1):
            for offset in np.arange(2, size):
                tie(int(at_peak(number, "same_width") + offset),
                    ("copy", int(at_peak(1, "same_width") + offset)), "same_width")
    spacings = _triples(spacing, "spacing")
    for one, other, distance in spacings:
        tie(at_peak(other, "spacing") + 1, ("offset", at_peak(one, "spacing") + 1, distance), "spacing")
    ratios = _triples(area_ratio, "area_ratio")
    for one, other, ratio in ratios:
        tie(at_peak(other, "area_ratio"), ("area", at_peak(one, "area_ratio"), ratio), "area_ratio")
    fitted = [index for index in np.arange(len(start)) if index not in ties]

    def expand(values):
        """Every parameter, from the fitted ones."""
        whole = np.full(len(start), np.nan)
        whole[fitted] = values
        pending = dict(ties)
        # A tie can hang on another tie (a chain of spacings): go round until all are settled.
        while pending:
            settled = False
            for index, rule in list(pending.items()):
                source = rule[1]
                if rule[0] == "area":
                    # Areas need the heights and the widths of both peaks.
                    needed = [source, *np.arange(source + 2, source + size),
                              *np.arange(index + 2, index + size)]
                    if any(np.isnan(whole[item]) for item in needed):
                        continue
                    own = form.area(*np.abs(whole[index + 2 : index + size]))
                    whole[index] = (
                        rule[2] * whole[source]
                        * form.area(*np.abs(whole[source + 2 : source + size])) / own
                    )
                elif np.isnan(whole[source]):
                    continue
                else:
                    whole[index] = whole[source] + (rule[2] if rule[0] == "offset" else 0.0)
                del pending[index]
                settled = True
            if not settled:
                raise _op.OresmeError("The ties between the peaks go round in a circle.")
        return whole

    expand(start[fitted])
    if len(y_fit) <= len(fitted):
        raise _op.OresmeError(f"{len(y_fit)} points are not enough to fit {count} peaks.")
    solved, fitted_covariance, chisq, converged, reason = _least_squares(
        (lambda x_, *values: model(x_, *expand(values))) if ties else model,
        x_fit, y_fit, start[fitted], None, lower[fitted], upper[fitted], max_iterations=400,
    )
    best = expand(solved)
    if ties:
        # The uncertainty of the tied parameters follows from those they are tied to.
        spread = np.column_stack([
            (expand(solved + step) - expand(solved - step)) / (2 * step[index])
            for index, step in enumerate(
                np.diag(1e-6 * np.maximum(np.abs(solved), 1e-6))
            )
        ])
        covariance = spread @ fitted_covariance @ spread.T
    else:
        covariance = fitted_covariance
    errors = np.sqrt(np.abs(np.diag(covariance)))

    rows = []
    for number in np.arange(count):
        at = base_terms + size * number
        height, position = float(best[at]), float(best[at + 1])
        widths = np.abs(best[at + 2 : at + size])
        block = covariance[at : at + size, at : at + size]
        row = {
            "x": position,
            "height": height,
            "width": float(form.fwhm(*widths)),
            "area": height * float(form.area(*widths)),
            "x_sigma": float(errors[at + 1]),
            "height_sigma": float(errors[at]),
            "width_sigma": _spread(form.fwhm, widths, block[2:, 2:]),
            "area_sigma": _spread(
                lambda h, *w: h * form.area(*w), np.concatenate(([height], widths)),
                np.delete(np.delete(block, 1, 0), 1, 1),
            ),
        }
        for key, _, value in form.report:
            row[key] = float(value(*widths))
            row[f"{key}_sigma"] = _spread(value, widths, block[2:, 2:])
        rows.append(row)
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
                    only[base_terms + size * other] = 0.0
            parts.append(
                _op.make(f"{folder}fit_{leaf}_p{position_in_table}", curve(only), unit=y_wave.unit,
                         **scaling)
            )
    _op.make(
        "W_peaks",
        np.array(
            [[row["x"], row["height"], row["width"], row["area"]] + [row[key] for key, _, _ in form.report]
             for row in rows]
        ),
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

    stored = None
    if record:
        # One parameter per column of the table, peak by peak, so that fits of
        # several samples line up when their results are put side by side.
        names, values, spreads = [], [], []
        for number, row in enumerate(rows, 1):
            for key, title in (("x", "x"), ("height", "height"), ("width", "fwhm"), ("area", "area"),
                               *((key, key) for key, _, _ in form.report)):
                names.append(f"{title}{number}")
                values.append(row[key])
                spreads.append(row[f"{key}_sigma"])
        if base_terms >= 1:
            names.append("offset")
            values.append(base["offset"])
            # For a sloping baseline the offset is given at x = 0, away from the middle of the data.
            spreads.append(
                errors[0] if base_terms == 1 else np.sqrt(abs(
                    covariance[0, 0] + centre**2 * covariance[1, 1] - 2 * centre * covariance[0, 1]
                ))
            )
        if base_terms == 2:
            names.append("slope")
            values.append(base["slope"])
            spreads.append(errors[1])
        outputs = {"fit": fit_wave.name}
        for number, part in enumerate(parts, 1):
            outputs[f"peak{number}"] = part.name
        stored = _record(
            {
                "kind": "peaks",
                "label": f"{count} {shape} peak{'s' if count != 1 else ''}({leaf})",
                "settings": {
                    "y": y_wave.name,
                    "x": None if x_wave is None else x_wave.name,
                    # Where the peaks started, so that fitting again starts there too.
                    "peaks": [float(position) for position, _, _ in starts],
                    "shape": shape,
                    "baseline": baseline,
                    **chosen,
                    "components": bool(components),
                    "same_width": bool(same_width),
                    "spacing": [list(item) for item in spacings],
                    "area_ratio": [list(item) for item in ratios],
                },
                "inputs": [y_wave.name, *([x_wave.name] if x_wave is not None else []), *inputs],
                "names": names,
                "coef": values,
                "sigma": spreads,
                "held": [],
                "covariance": None,
                "chisq": chisq,
                "points": len(y_fit),
                "freedom": len(y_fit) - len(fitted),
                "converged": converged,
                "reason": reason,
                "outputs": outputs,
            },
            result,
        )
    outcome = PeakFitResult(shape, rows, base, chisq, len(y_fit), fit_wave, parts, converged,
                            [(key, heading) for key, heading, _ in form.report],
                            reason=reason, name=stored)
    if not quiet:
        print(outcome)
    return outcome


# --- Spectra -------------------------------------------------------------------


def _showing(y_wave, graph):
    """The graph given, or the frontmost graph with a trace of the wave; None if there is none."""
    for candidate in [graph] if graph not in (None, True) else reversed(_op.graphs()):
        candidate = _op.graph(candidate) if isinstance(candidate, str) else candidate
        if any(trace["y"] == y_wave.name for trace in candidate._info()["traces"]):
            return candidate
    return None


def _points_between(x_values, low, high):
    """The first and last point with X within low..high (inclusive, either way round)."""
    low, high = sorted((float(low), float(high)))
    finite = x_values[np.isfinite(x_values)]
    # Scaled X is computed, so 280 may come out as 280.00000000001.
    slack = 1e-9 * (float(np.ptp(finite)) if finite.size else 0.0)
    inside = np.flatnonzero((x_values >= low - slack) & (x_values <= high + slack))
    if inside.size == 0:
        raise _op.OresmeError(f"No points have X between {low:g} and {high:g}.")
    return int(inside[0]), int(inside[-1])


def _segment(wave_, x, range, cursors, graph, what):
    """The wave, its X values, and the first and last point of the part to work on."""
    source, values = _numeric(wave_)
    if values.ndim != 1:
        raise _op.OresmeError(f"{what} needs a 1-D wave.")
    x_values = np.asarray(source.x, dtype=float) if x is None else _x_data(x, len(values))[0]
    first, last = 0, len(values) - 1
    if cursors:
        target = _showing(source, graph)
        if target is None:
            raise _op.OresmeError("cursors=True needs a graph that shows the wave.")
        marks = target._info()["cursors"]
        if "A" not in marks or "B" not in marks:
            raise _op.OresmeError("Put cursors A and B on the graph first.")
        first, last = sorted((marks["A"]["point"], marks["B"]["point"]))
    elif range is not None:
        first, last = _points_between(x_values, *range)
    return source, values, x_values, first, last


def _shirley(x, y, low, high, tolerance, iterations):
    """The Shirley background from level ``low`` at the first point to ``high`` at the last.

    At each point the background has gone the fraction of the way from one
    level to the other that the peak area above the background, counted from
    the first point, has reached. That is a fixed point, found by iterating.
    """
    steps = np.abs(np.diff(x))
    background = np.full(len(y), float(low))
    target = tolerance * max(abs(high - low), np.finfo(float).eps * float(np.max(np.abs(y))))
    for _ in np.arange(iterations):
        peak = y - background
        area = np.concatenate(([0.0], np.cumsum((peak[1:] + peak[:-1]) / 2 * steps)))
        if not (np.isfinite(area[-1]) and area[-1] != 0):
            raise _op.OresmeError("There is no peak above the background to build a Shirley background on.")
        following = low + (high - low) * area / area[-1]
        change = float(np.max(np.abs(following - background)))
        background = following
        if change <= target:
            return background
    raise _op.OresmeError(f"The Shirley background did not settle in {iterations} iterations.")


def _tougaard_integral(x, y, losses_up, C):
    """For each point, the integral of T/(C + T^2)^2 * y over the points it loses energy from.

    T is the energy lost. Electrons appear at a point after losing energy on
    the way from the points on its no-loss side, which are those of lower X
    if ``losses_up`` (X in binding energy) and of higher X otherwise.
    """
    order = np.argsort(x if losses_up else -x, kind="stable")
    xs, ys = x[order], y[order]
    integral = np.zeros(len(xs))
    # One point at a time keeps the memory to the length of the spectrum.
    for index in np.arange(1, len(xs)):
        lost = np.abs(xs[index] - xs[: index + 1])
        integrand = lost / (C + lost**2) ** 2 * ys[: index + 1]
        integral[index] = np.sum((integrand[1:] + integrand[:-1]) / 2 * np.abs(np.diff(xs[: index + 1])))
    result = np.empty(len(xs))
    result[order] = integral
    return result


def background(wave_, method="shirley", *, x=None, range=None, cursors=False, graph=None,
               average=5, subtract=False, energy=None, B=2866.0, C=1643.0, scale=True,
               tolerance=1e-6, name=None):
    """The background under the peaks of a spectrum, as a new wave ``<name>_bg``.

    ``method`` is ``"shirley"``, ``"tougaard"`` or ``"linear"``. The
    background is made over ``range=(x1, x2)``, the points with X from x1 to
    x2 (X values, not point numbers), or between cursors A and B with
    ``cursors=True``, or else over the whole wave. Its two end levels are the
    means of ``average`` points at each end of that range. Outside the range
    the result is NaN. It has the scaling of the data; ``x`` is an X wave (or
    array) for XY data, which must run one way across the range.

    ``"linear"`` is the straight line through the two averaged ends.

    ``"shirley"`` changes from the level at one end to the level at the other
    in proportion to the peak area (data above the background) passed on the
    way, which it finds by iterating until it moves by less than
    ``tolerance`` times the step between the levels. It rises toward the end
    where the data is higher: in XPS, the high binding energy (low kinetic
    energy) side, where inelastically scattered electrons accumulate. Since
    this rule gives the same background counted from either end, it does not
    matter which way X runs.

    ``"tougaard"`` adds, to the level at the end where electrons have lost no
    energy, the electrons lost from every point on that side:
    ``B * integral of T/(C + T^2)^2 * (data - level)`` over the energy loss T,
    with Tougaard's universal cross-section, ``B = 2866`` and ``C = 1643``
    eV^2. X must be in eV. With ``scale=True`` (the usual practice) B is then
    scaled so that the background meets the data at the far end, averaged
    over the same points as the level there. ``energy`` says which way
    electrons lose energy: ``"binding"`` (toward higher X) or ``"kinetic"``
    (toward lower X); by default, toward the end where the data is higher.
    The B used is written in the note of the background wave.

    ``subtract=True`` also makes ``<name>_sub``, the data minus the
    background, and returns (background, subtracted).
    """
    if method not in ("shirley", "tougaard", "linear"):
        raise _op.OresmeError('method must be "shirley", "tougaard" or "linear".')
    if energy not in (None, "binding", "kinetic"):
        raise _op.OresmeError('energy must be "binding" or "kinetic" (or None to tell from the data).')
    source, values, x_values, first, last = _segment(wave_, x, range, cursors, graph, "A background")
    xs, ys = x_values[first : last + 1], values[first : last + 1]
    count = int(average)
    if count < 1:
        raise _op.OresmeError("average must be at least 1 point.")
    if len(ys) < 2 * count + 1:
        raise _op.OresmeError(
            f"The range has {len(ys)} points: too few to average {count} at each end and leave a peak between."
        )
    if not (np.all(np.isfinite(xs)) and np.all(np.isfinite(ys))):
        raise _op.OresmeError("The range has NaN or infinite values; choose a range without them.")
    steps = np.diff(xs)
    if not (np.all(steps > 0) or np.all(steps < 0)):
        raise _op.OresmeError("X must increase or decrease steadily across the range.")
    start, end = float(ys[:count].mean()), float(ys[-count:].mean())
    note = f"{method} background over x = {xs[0]:g} to {xs[-1]:g}, ends averaged over {count} points"

    if method == "linear":
        left, right = float(xs[:count].mean()), float(xs[-count:].mean())
        curve = start + (end - start) * (xs - left) / (right - left)
    elif method == "shirley":
        curve = _shirley(xs, ys, start, end, float(tolerance), 200)
    else:
        # Electrons lose energy toward the end where the data is higher, unless told.
        rising = xs[-1] > xs[0]
        losses_up = (end >= start) == rising if energy is None else energy == "binding"
        # Whether the range runs from the side electrons come from to the side they lose energy toward.
        onward = rising == losses_up
        # The level on the side electrons come from is the background of other peaks there.
        level, far = (start, end) if onward else (end, start)
        loss = _tougaard_integral(xs, ys - level, losses_up, float(C))
        strength = float(B)
        if scale:
            tail = loss[-count:] if onward else loss[:count]
            if not tail.mean() > 0:
                raise _op.OresmeError("There is no peak to scale the Tougaard background to.")
            strength = (far - level) / float(tail.mean())
            if strength < 0:
                raise _op.OresmeError(
                    "The data is lower at the end electrons lose energy toward than at the other; "
                    "check energy= or the range."
                )
        curve = level + strength * loss
        note += f", B = {strength:.6g} eV^2, C = {float(C):g} eV^2"

    whole = np.full(len(values), np.nan)
    whole[first : last + 1] = curve
    scaling = {"x0": source.x0, "dx": source.dx, "x_unit": source.x_unit, "unit": source.unit}
    made = _op.make(_sibling(source, "_bg", name), whole, note=note, **scaling)
    if not subtract:
        return made
    return made, _op.make(f"{source.name}_sub", values - whole, note=f"data minus {note}", **scaling)


def _with_error(value, error):
    """A value written to the digits its uncertainty leaves meaningful: ``4.5123 ± 0.0023``."""
    if not (np.isfinite(error) and error > 0 and np.isfinite(value)):
        return f"{value:.6g}"
    error_place = int(np.floor(np.log10(error)))
    decimals = max(0, 1 - error_place)
    if decimals <= 8:
        return f"{value:.{decimals}f} ± {error:.2g}"
    # An error this small is often rounding: fixed decimals would run on.
    value_place = int(np.floor(np.log10(abs(value)))) if value else error_place
    return f"{value:.{min(10, max(1, value_place - error_place + 2))}g} ± {error:.2g}"


def _straight_line(x, y, what):
    """The least-squares line through the points, about their mean X.

    Returns (centre, value at the centre, its variance, slope, its
    variance); the value and slope are uncorrelated about the centre. The
    variances come from the scatter of the points about the line.
    """
    if len(x) < 3:
        raise _op.OresmeError(f"The {what} range has {len(x)} points; a line with an uncertainty needs 3.")
    centre = float(x.mean())
    offsets = x - centre
    spread = float(offsets @ offsets)
    if spread == 0:
        raise _op.OresmeError(f"The points of the {what} range all have the same X.")
    level = float(y.mean())
    slope = float(offsets @ (y - level)) / spread
    residual = y - level - slope * offsets
    scatter = float(residual @ residual) / (len(x) - 2)
    return centre, level, scatter / len(x), slope, scatter / spread


class OnsetResult:
    """The outcome of ``op.onset``: where the edge line crosses the baseline, and both lines."""

    def __init__(self, name, x, x_sigma, y, edge, baseline, x_unit="", waves=()):
        self.name = name
        #: Where the lines cross, and its standard deviation.
        self.x = x
        self.x_sigma = x_sigma
        #: The value of both lines there.
        self.y = y
        #: The edge line: slope, intercept (at x = 0), their standard
        #: deviations, and the points and X range it was fitted to.
        self.edge = edge
        #: The baseline: a line like the edge, or ``{"level": value}``.
        self.baseline = baseline
        self.x_unit = x_unit
        #: The waves drawn on a graph: the two lines and the crossing.
        self.waves = tuple(waves)

    def __float__(self):
        return float(self.x)

    def __repr__(self):
        return f"OnsetResult({self.name}, x={self.x:.6g})"

    def __str__(self):
        unit = f" {self.x_unit}" if self.x_unit else ""
        lines = [f"Onset of {self.name}: x = {_with_error(self.x, self.x_sigma)}{unit} (y = {self.y:.6g})"]
        for label, line in (("edge", self.edge), ("baseline", self.baseline)):
            if "level" in line:
                lines.append(f"  {label + ':':<10} level {line['level']:.6g}")
                continue
            lines.append(
                f"  {label + ':':<10} slope = {_with_error(line['slope'], line['slope_sigma'])}, "
                f"intercept = {_with_error(line['intercept'], line['intercept_sigma'])} "
                f"({line['points']} points, x = {line['range'][0]:g} to {line['range'][1]:g})"
            )
        return "\n".join(lines)


def onset(wave_, x=None, *, edge, baseline=None, graph=None, quiet=False):
    """Where a rising or falling edge starts, by extrapolating it to the baseline.

    For thresholds such as the secondary-electron cutoff or the HOMO and
    LUMO onsets of UPS and LEIPS spectra. A straight line is fitted to the
    points with X in ``edge=(x1, x2)``, and another to those in
    ``baseline=(x3, x4)``; ``baseline`` may instead be a number, a constant
    level, and is 0 if left out. The ranges are X values, not point numbers.
    ``x`` is an X wave (or array) for XY data.

    The uncertainty of the crossing propagates those of the two lines,
    taken from the scatter of the points about each (each point independent,
    with the same scatter throughout its range), to first order: it is the
    spread of the two lines where they cross, divided by the difference of
    their slopes. It holds while that is small next to the ranges, and says
    nothing of how the ranges were chosen, which often matters more.

    Nothing is drawn unless ``graph`` is given: a graph (or its name), or
    True for the frontmost graph showing the wave. The two lines are then
    added as ``<name>_edge`` and ``<name>_base``, each over its range and on
    past the crossing, and the crossing as ``<name>_onset``, a marker with a
    tag. Returns an ``OnsetResult``; ``r.x`` is the crossing.
    """
    source, values = _numeric(wave_)
    if values.ndim != 1:
        raise _op.OresmeError("An onset needs a 1-D wave.")
    if x is None:
        x_values, x_unit = np.asarray(source.x, dtype=float), source.x_unit
    else:
        x_values, x_unit = _x_data(x, len(values))
    good = np.isfinite(x_values) & np.isfinite(values)

    def fitted(limits, what):
        low, high = sorted(float(value) for value in limits)
        # Scaled X is computed, so 4.2 may come out as 4.2000000000000002.
        slack = 1e-9 * _span(x_values[good])
        inside = good & (x_values >= low - slack) & (x_values <= high + slack)
        fit = _straight_line(x_values[inside], values[inside], what)
        centre, level, level_var, slope, slope_var = fit
        line = {
            "slope": slope,
            "intercept": level - slope * centre,
            "slope_sigma": float(np.sqrt(slope_var)),
            "intercept_sigma": float(np.sqrt(level_var + centre * centre * slope_var)),
            "points": int(inside.sum()),
            "range": (low, high),
        }
        return line, fit

    edge_line, (c1, v1, var_v1, s1, var_s1) = fitted(edge, "edge")
    if baseline is None or np.ndim(baseline) == 0:
        level = 0.0 if baseline is None else float(baseline)
        base_line, (c2, v2, var_v2, s2, var_s2) = {"level": level}, (0.0, level, 0.0, 0.0, 0.0)
    else:
        base_line, (c2, v2, var_v2, s2, var_s2) = fitted(baseline, "baseline")
    if s1 == s2:
        raise _op.OresmeError("The edge and the baseline are parallel; they do not cross.")
    # Each line is fitted about its own centre, where its value and slope are uncorrelated.
    crossing = (v2 - v1 + s1 * c1 - s2 * c2) / (s1 - s2)
    height = v1 + s1 * (crossing - c1)
    spread = var_v1 + (crossing - c1) ** 2 * var_s1 + var_v2 + (crossing - c2) ** 2 * var_s2
    crossing_sigma = float(np.sqrt(spread)) / abs(s1 - s2)

    waves_ = []
    if graph is not None and graph is not False:
        target = _showing(source, graph)
        if target is None:
            if graph is True:
                raise _op.OresmeError("graph=True needs a graph that shows the wave.")
            target = _op.graph(graph) if isinstance(graph, str) else graph
        trace = next((t for t in target._info()["traces"] if t["y"] == source.name), None)
        axes = {"axis": trace["vAxis"], "haxis": trace["hAxis"]} if trace else {}
        reach = max(abs(crossing - end) for end in edge_line["range"])
        scaling = {"x_unit": x_unit, "unit": source.unit}

        def drawn(suffix, line, low, high):
            """A line over low..high with a little to spare, as a wave with X scaling."""
            margin = 0.05 * (high - low)
            grid = np.linspace(low - margin, high + margin, 50)
            if "level" in line:
                values_ = np.full(grid.size, line["level"])
            else:
                values_ = line["intercept"] + line["slope"] * grid
            return _op.make(f"{source.name}{suffix}", values_, x0=grid[0], dx=grid[1] - grid[0], **scaling)

        waves_.append(drawn("_edge", edge_line, min(crossing, *edge_line["range"]),
                            max(crossing, *edge_line["range"])))
        if "level" in base_line:
            # A level has no range of its own: it is drawn as far either side of the crossing as the edge.
            waves_.append(drawn("_base", base_line, crossing - reach, crossing + reach))
        else:
            waves_.append(drawn("_base", base_line, min(crossing, *base_line["range"]),
                                max(crossing, *base_line["range"])))
        marker = _op.make(f"{source.name}_onset", [height], x0=crossing, dx=1, **scaling)
        waves_.append(marker)
        shown = {t["y"]: t["name"] for t in target._info()["traces"]}
        for made, style in zip(waves_, ({"color": "#cc0000"}, {"color": "#cc0000", "line_style": "dash"},
                                        {"mode": "markers", "marker": "circle", "color": "#cc0000"})):
            if made.name not in shown:
                shown[made.name] = target.append(made, **axes).name
                target.trace(shown[made.name]).set(**style)
        text = f"onset {_with_error(crossing, crossing_sigma)}" + (f" {x_unit}" if x_unit else "")
        tag = next(
            (a for a in target._info()["annotations"]
             if a["kind"] == "tag" and a["trace"] == shown[marker.name]),
            None,
        )
        if tag is None:
            target.tag(shown[marker.name], 0, text)
        else:
            _op.Annotation(target, tag["name"]).text = text

    result = OnsetResult(source.name, float(crossing), crossing_sigma, float(height), edge_line, base_line,
                         x_unit, waves_)
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
