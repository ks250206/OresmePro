"""XPS peak fitting in the way of CasaXPS: ``op.xps_fit``.

A region of a spectrum (binding energies from ... to ...), a background under
it worked out from the data (Shirley, linear, Tougaard or none) and held while
fitting, and synthetic components on top of it with CasaXPS's line shapes. A
component's position, FWHM and area are each free (within limits), fixed, or
tied to the same parameter of another component (``A+1.5``, ``A*0.5``, ``A``),
as on CasaXPS's Components page. The XPS Peak Fitting window builds these
calls; ``src/core/xps.ts`` draws the same shapes and backgrounds while the
components are dragged, and must agree with this module.

Line shapes (CasaXPS manual 2.3.15 rev 1.3, pp. 55 and 301), with
u = (BE − E) / F, m in percent, and u > 0 the side of higher binding energy:

- ``GL(m)``: exp(−4 ln2 (1 − m/100) u²) / (1 + 4 (m/100) u²)
- ``SGL(m)``: (1 − m/100) exp(−4 ln2 u²) + (m/100) / (1 + 4u²)
- ``GL(m)T(k)``, ``SGL(m)T(k)``: on the side u > 0, S + (1 − S) exp(−k u)
- ``LA(α,β)``: (1 + 4u²)^−α for u ≥ 0, (1 + 4u²)^−β for u < 0

Any shape can be convolved with a Gaussian of FWHM ``gauss`` (eV). The area
of a component is the area under its whole profile.

It needs only NumPy.
"""

import math
import re

import numpy as np

import _oresme_analysis as _analysis
import oresme as _op

__all__ = ["xps_fit", "XPSFitResult", "XPS_SHAPES"]

LN2 = math.log(2.0)
SIGMA_PER_FWHM = 1 / (2 * math.sqrt(2 * LN2))
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
PARAMS = ("position", "fwhm", "area")
BACKGROUNDS = ("shirley", "linear", "tougaard", "none")
#: Examples of the line shapes, as the window offers them.
XPS_SHAPES = ("GL(30)", "GL(0)", "GL(50)", "GL(100)", "SGL(30)", "GL(30)T(1)", "LA(1.53,243)")
#: Limits of the width parameter F when none are given (eV).
FWHM_LIMITS = (0.05, 20.0)
#: Tougaard's universal cross-section, C in eV²; B is scaled to the data.
TOUGAARD_C = 1643.0
#: Points of the composite Simpson rule on each side of a profile, for its area.
AREA_POINTS = 20000

_NUM = r"[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?"
_UNSIGNED = r"\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\s*"
_GL = re.compile(rf"^(S?GL)\({_UNSIGNED}\)(?:T\({_UNSIGNED}\))?$", re.IGNORECASE)
_LA = re.compile(rf"^LA\({_UNSIGNED},{_UNSIGNED}\)$", re.IGNORECASE)
_TIED = re.compile(rf"^([A-Za-z])\s*(?:([-+*/])\s*({_NUM}))?$")
_LIMITS = re.compile(rf"^\[?\s*({_NUM})\s*(?:,|;|:|\.\.|\s+to\s+|\s)\s*({_NUM})\s*\]?$", re.IGNORECASE)
_COLORS = ("#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e", "#17becf", "#e377c2", "#8c564b", "#bcbd22")


# --- Line shapes -----------------------------------------------------------------


class Shape:
    """A line shape: ``kind`` GL, SGL or LA, with its parameters."""

    def __init__(self, kind, m=0.0, k=None, alpha=None, beta=None):
        self.kind = kind
        self.m = float(m)
        self.k = None if k is None else float(k)
        self.alpha = alpha
        self.beta = beta
        self._area = None

    @property
    def text(self):
        if self.kind == "LA":
            return f"LA({self.alpha:g},{self.beta:g})"
        tail = "" if self.k is None else f"T({self.k:g})"
        return f"{self.kind}({self.m:g}){tail}"

    def profile(self, u):
        """The shape at u = (BE − E) / F: 1 at the position."""
        u = np.asarray(u, dtype=np.float64)
        if self.kind == "LA":
            base = 1 + 4 * u * u
            return np.where(u >= 0, base ** -self.alpha, base ** -self.beta)
        mix = self.m / 100.0
        if self.kind == "GL":
            body = np.exp(-4 * LN2 * (1 - mix) * u * u) / (1 + 4 * mix * u * u)
        else:
            body = (1 - mix) * np.exp(-4 * LN2 * u * u) + mix / (1 + 4 * u * u)
        if self.k is None:
            return body
        tail = np.exp(-self.k * np.clip(u, 0, None))
        return np.where(u > 0, body + (1 - body) * tail, body)

    @property
    def sharpness(self):
        """The half width at half maximum of the narrower side, in units of F (for sampling)."""
        if self.kind != "LA":
            return 0.4
        power = max(self.alpha, self.beta)
        return min(0.4, 0.5 * math.sqrt(2 ** (1 / power) - 1))

    @property
    def unit_area(self):
        """The area under the profile for F = 1."""
        if self._area is None:
            mix = self.m / 100.0
            if self.kind == "LA":
                self._area = _half_lorentz_area(self.alpha) + _half_lorentz_area(self.beta)
            elif self.k is None and self.kind == "SGL":
                self._area = (1 - mix) * 0.5 * math.sqrt(math.pi / LN2) + mix * math.pi / 2
            elif self.k is None and mix == 1:
                self._area = math.pi / 2
            elif self.k is None and mix == 0:
                self._area = 0.5 * math.sqrt(math.pi / LN2)
            else:
                self._area = _half_area(lambda u: self.profile(u)) + _half_area(
                    lambda u: self.profile(-u)
                )
        return self._area

    def curve(self, be, position, fwhm, area, gauss=0.0):
        """A component of this shape at the binding energies ``be``.

        With ``gauss`` (eV, FWHM) the shape is convolved with a Gaussian on a
        grid through the position, fine enough for both widths, and read off
        at ``be``.
        """
        be = np.asarray(be, dtype=np.float64)
        width = max(float(fwhm), 1e-9)
        height = float(area) / (self.unit_area * width)
        if not gauss > 0 or be.size == 0:
            return height * self.profile((be - position) / width)
        sigma = float(gauss) * SIGMA_PER_FWHM
        reach = 5 * sigma
        low, high = float(np.min(be)) - reach, float(np.max(be)) + reach
        step = min(width * self.sharpness / 15, sigma / 10)
        if (high - low) / step > 400_000:
            step = (high - low) / 400_000
        first = math.floor((low - position) / step)
        last = math.ceil((high - position) / step)
        grid = position + step * np.arange(first, last + 1)
        half = math.ceil(reach / step)
        offsets = step * np.arange(-half, half + 1)
        kernel = np.exp(-0.5 * (offsets / sigma) ** 2)
        kernel /= kernel.sum()
        smoothed = np.convolve(self.profile((grid - position) / width), kernel, mode="same")
        if len(kernel) > len(grid):
            # np.convolve's "same" follows the longer of the two.
            cut = (len(kernel) - len(grid)) // 2
            smoothed = smoothed[cut : cut + len(grid)]
        return height * np.interp(be, grid, smoothed)

    def width(self, fwhm, gauss=0.0):
        """The true full width at half maximum of a component of width parameter ``fwhm``."""
        span = 40 * fwhm + 10 * max(gauss, 0.0)
        be = np.linspace(-span, span, 160_001)
        y = self.curve(be, 0.0, fwhm, 1.0, gauss)
        top = int(np.argmax(y))
        half = y[top] / 2
        above = np.nonzero(y >= half)[0]
        first, last = above[0], above[-1]
        if first == 0 or last == len(y) - 1:
            return float("nan")
        left = np.interp(half, [y[first - 1], y[first]], [be[first - 1], be[first]])
        right = np.interp(half, [y[last + 1], y[last]], [be[last + 1], be[last]])
        return float(right - left)


def _half_lorentz_area(power):
    """∫_0^∞ (1 + 4u²)^(−power) du = (√π / 4) Γ(power − ½) / Γ(power)."""
    return 0.25 * math.sqrt(math.pi) * math.exp(math.lgamma(power - 0.5) - math.lgamma(power))


def _half_area(f):
    """∫_0^∞ f(u) du, by Simpson's rule after u = t / (1 − t), for profiles that fall off by 1/u² or faster."""
    t = np.linspace(0.0, 1.0, 2 * AREA_POINTS + 1)
    inner = t[:-1]
    values = np.empty(len(t))
    values[:-1] = f(inner / (1 - inner)) / (1 - inner) ** 2
    # At t = 1 (u = ∞) the integrand tends to the limit of u² f(u), 0 unless it is Lorentzian.
    far = 1e8
    values[-1] = float(f(np.array([far]))[0]) * far * far
    weights = np.ones(len(t))
    weights[1:-1:2] = 4
    weights[2:-1:2] = 2
    return float(np.sum(weights * values) * (t[1] - t[0]) / 3)


def parse_shape(text):
    """The shape that CasaXPS's notation names: GL(30), SGL(20), GL(30)T(1.5), LA(1.53,243)."""
    if not isinstance(text, str):
        raise _op.InvalidArgumentError(f"A line shape is text such as 'GL(30)', not {text!r}.")
    plain = text.strip().replace(" ", "")
    match = _GL.match(plain)
    if match:
        kind = match.group(1).upper()
        m = float(match.group(2))
        k = None if match.group(3) is None else float(match.group(3))
        if not 0 <= m <= 100:
            raise _op.InvalidArgumentError(f"The m of {text} is from 0 (Gaussian) to 100 (Lorentzian).")
        if k is not None and not k > 0:
            raise _op.InvalidArgumentError(f"The tail k of {text} must be more than 0.")
        return Shape(kind, m, k)
    match = _LA.match(plain)
    if match:
        alpha, beta = float(match.group(1)), float(match.group(2))
        if not (alpha > 0.5 and beta > 0.5):
            raise _op.InvalidArgumentError(f"α and β of {text} must be more than 0.5, for a finite area.")
        return Shape("LA", alpha=alpha, beta=beta)
    raise _op.InvalidArgumentError(
        f"{text!r} is not a line shape: GL(m), SGL(m), GL(m)T(k), SGL(m)T(k) "
        "(m from 0 to 100, k more than 0) or LA(α,β) (both more than 0.5)."
    )


# --- Components and their constraints --------------------------------------------


class Value:
    """One parameter of a component: free (within limits), fixed, or tied to another component's."""

    def __init__(self, kind, start=None, low=-np.inf, high=np.inf, ref=None, scale=1.0, offset=0.0):
        self.kind = kind  # "free", "fixed" or "tied"
        self.start = start
        self.low = low
        self.high = high
        self.ref = ref
        self.scale = scale
        self.offset = offset


def parse_constraint(text, start, limits, where, count):
    """A parameter's constraint as CasaXPS's Components page takes it.

    ``""``: free within ``limits``; ``"284, 286"``: free between those;
    ``"fixed"``: fixed at ``start``; ``"A"``, ``"A+1.5"``, ``"A-1.5"``,
    ``"A*0.5"``, ``"A/2"``: tied to the same parameter of component A.
    """
    if text is None:
        text = ""
    if not isinstance(text, str):
        raise _op.InvalidArgumentError(f"{where}: a constraint is text, such as '284, 286', 'fixed' or 'A+1.5'.")
    plain = text.strip()
    if plain.lower() in ("fixed", "fix", "!", "hold", "held"):
        if start is None:
            raise _op.InvalidArgumentError(f"{where} is fixed, so it needs a value.")
        return Value("fixed", start=float(start))
    match = _TIED.match(plain)
    if match:
        letter = match.group(1).upper()
        ref = LETTERS.index(letter)
        if ref >= count:
            raise _op.InvalidArgumentError(f"{where} is tied to {letter}, but there is no component {letter}.")
        op, amount = match.group(2), match.group(3)
        amount = 0.0 if amount is None else float(amount)
        scale, offset = 1.0, 0.0
        if op == "+":
            offset = amount
        elif op == "-":
            offset = -amount
        elif op == "*":
            scale = amount
        elif op == "/":
            if amount == 0:
                raise _op.InvalidArgumentError(f"{where} divides by 0.")
            scale = 1 / amount
        return Value("tied", ref=ref, scale=scale, offset=offset)
    low, high = limits
    if plain:
        match = _LIMITS.match(plain)
        if not match:
            raise _op.InvalidArgumentError(
                f"{where}: {plain!r} is not a constraint. Leave it empty (free), or write limits "
                "'284, 286', 'fixed', or a tie to another component: 'A', 'A+1.5', 'A*0.5'."
            )
        low, high = sorted((float(match.group(1)), float(match.group(2))))
        if not low < high:
            raise _op.InvalidArgumentError(f"{where}: the limits {low:g}, {high:g} leave nothing between them.")
    if start is None:
        return Value("free", start=None, low=low, high=high)
    # A start outside the limits begins at the nearest limit, as CasaXPS does.
    return Value("free", start=float(min(max(float(start), low), high)), low=low, high=high)


class Component:
    def __init__(self, index, name, shape, values, rsf, gauss):
        self.index = index
        self.letter = LETTERS[index]
        self.name = name
        self.shape = shape
        self.values = values
        self.rsf = rsf
        self.gauss = gauss


def _number(value, where, *, positive=False, minimum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise _op.InvalidArgumentError(f"{where} is a number, not {value!r}.")
    value = float(value)
    if not math.isfinite(value):
        raise _op.InvalidArgumentError(f"{where} must be finite.")
    if positive and not value > 0:
        raise _op.InvalidArgumentError(f"{where} must be more than 0.")
    if minimum is not None and value < minimum:
        raise _op.InvalidArgumentError(f"{where} must be {minimum:g} or more.")
    return value


_KEYS = {"name", "shape", "position", "fwhm", "area", "rsf", "gauss", "constraints"}


def parse_components(items, region):
    """The components, checked: a list of dicts with name, shape, position, fwhm, area, rsf, gauss, constraints."""
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, (list, tuple)) or not items:
        raise _op.InvalidArgumentError(
            'Give at least one component: [{"name": "C-C", "shape": "GL(30)", "position": 284.8}].'
        )
    if len(items) > len(LETTERS):
        raise _op.InvalidArgumentError(f"There are {len(items)} components; at most {len(LETTERS)} can be fitted.")
    components = []
    for index, item in enumerate(items):
        letter = LETTERS[index]
        if not isinstance(item, dict):
            raise _op.InvalidArgumentError(f"Component {letter} is a dict of name, shape, position, ..., not {item!r}.")
        unknown = sorted(set(item) - _KEYS)
        if unknown:
            raise _op.InvalidArgumentError(
                f"Component {letter} has {unknown[0]!r}; the keys are {', '.join(sorted(_KEYS))}."
            )
        name = item.get("name") or letter
        if not isinstance(name, str):
            raise _op.InvalidArgumentError(f"Component {letter}'s name is text.")
        where = f"Component {letter} ({name})"
        shape = parse_shape(item.get("shape") or "GL(30)")
        constraints = item.get("constraints") or {}
        if not isinstance(constraints, dict) or set(constraints) - set(PARAMS):
            raise _op.InvalidArgumentError(
                f"{where}: constraints is a dict of position, fwhm and area, such as {{\"position\": \"A+1.5\"}}."
            )
        starts = {}
        for param in PARAMS:
            value = item.get(param)
            starts[param] = None if value is None else _number(value, f"{where}'s {param}")
        limits = {"position": region, "fwhm": FWHM_LIMITS, "area": (0.0, np.inf)}
        values = {}
        for param in PARAMS:
            text = constraints.get(param, "")
            value = parse_constraint(text, starts[param], limits[param], f"{where}'s {param}", len(items))
            if value.kind == "tied" and value.ref == index:
                raise _op.InvalidArgumentError(f"{where}'s {param} is tied to itself.")
            if value.kind == "free" and value.start is None and param != "area":
                if param == "position":
                    raise _op.InvalidArgumentError(f"{where} has no position.")
                value.start = float(min(max(1.5, value.low), value.high))
            values[param] = value
        rsf = _number(item.get("rsf", 1.0), f"{where}'s rsf", positive=True)
        gauss = _number(item.get("gauss", 0.0), f"{where}'s gauss", minimum=0.0)
        components.append(Component(index, name, shape, values, rsf, gauss))
    return components


def _affine(components, area_scale):
    """How each parameter follows from what is fitted: value = coef · u[j] + const.

    Returns maps[i][param] = (j or None, coef, const), and the free
    parameters as (component index, param) in the order of u.
    """
    free = []
    slot = {}
    for c in components:
        for param in PARAMS:
            if c.values[param].kind == "free":
                slot[(c.index, param)] = len(free)
                free.append((c.index, param))
    done = {}

    def resolve(i, param, seen):
        key = (i, param)
        if key in done:
            return done[key]
        if key in seen:
            chain = " → ".join(f"{components[a].letter}.{p}" for a, p in [*seen, key])
            raise _op.InvalidArgumentError(f"The constraints go round in a circle: {chain}.")
        value = components[i].values[param]
        if value.kind == "free":
            out = (slot[key], area_scale if param == "area" else 1.0, 0.0)
        elif value.kind == "fixed":
            out = (None, 0.0, value.start)
        else:
            j, coef, const = resolve(value.ref, param, [*seen, key])
            out = (j, coef * value.scale, const * value.scale + value.offset)
        done[key] = out
        return out

    maps = [{param: resolve(c.index, param, []) for param in PARAMS} for c in components]
    return maps, free


def _value_of(rule, u):
    j, coef, const = rule
    return const if j is None else coef * u[j] + const


def _describe(value):
    if value.kind == "fixed":
        return "fixed"
    if value.kind == "tied":
        letter = LETTERS[value.ref]
        if value.scale != 1.0:
            return f"{letter}*{value.scale:g}"
        if value.offset:
            return f"{letter}{value.offset:+g}"
        return letter
    if np.isfinite(value.low) and np.isfinite(value.high):
        return f"{value.low:g}, {value.high:g}"
    return f"{value.low:g}, ∞" if np.isfinite(value.low) else ""


# --- Energies, region and background ---------------------------------------------


def binding_energies(y_wave, x_wave, count, energy, photon_energy, shift):
    """The binding energy of each point, charge correction included."""
    if energy not in ("binding", "kinetic"):
        raise _op.InvalidArgumentError('energy is "binding" or "kinetic".')
    if x_wave is not None:
        values = np.asarray(x_wave.data, dtype=float)
        if values.ndim != 1 or len(values) != count:
            raise _op.InvalidArgumentError(
                f"The X wave {x_wave.name} has {values.size} points and the spectrum {count}; "
                "they must have as many."
            )
    else:
        values = y_wave.x0 + y_wave.dx * np.arange(count, dtype=float)
    if energy == "kinetic":
        values = float(photon_energy) - values
    return values + float(shift)


def region_points(be, y, bounds):
    """The run of points (first, stop) whose binding energies lie within ``bounds`` (all if None)."""
    good = np.isfinite(be) & np.isfinite(y)
    inside = good if bounds is None else good & (be >= bounds[0]) & (be <= bounds[1])
    index = np.nonzero(inside)[0]
    if len(index) < 5:
        span = "the spectrum" if bounds is None else f"{bounds[0]:g} to {bounds[1]:g} eV"
        raise _op.InvalidArgumentError(f"The region ({span}) has {len(index)} points with values; it needs at least 5.")
    first, stop = int(index[0]), int(index[-1]) + 1
    if not good[first:stop].all():
        raise _op.InvalidArgumentError("The region has points without values (NaN); choose a region without them.")
    steps = np.diff(be[first:stop])
    if not (np.all(steps > 0) or np.all(steps < 0)):
        raise _op.InvalidArgumentError("The energies must rise or fall steadily across the region.")
    return first, stop


def make_background(be, y, method, average):
    """The background under the points (be, y) of a region, in their order.

    The levels at the two ends are the means of ``average`` points there.
    ``shirley`` rises from the level at low binding energy to the level at
    high binding energy in proportion to the peak area passed on the way;
    ``linear`` is the line through the two averaged ends; ``tougaard`` adds,
    to the level at low binding energy, Tougaard's universal loss function
    (C = 1643 eV²) applied to the peak, with B scaled to meet the level at
    high binding energy; ``none`` is zero.
    """
    if method not in BACKGROUNDS:
        raise _op.InvalidArgumentError(f"background is one of {', '.join(BACKGROUNDS)}.")
    order = np.argsort(be, kind="stable")
    x, data = be[order], y[order]
    out = np.zeros(len(y))
    if method == "none":
        return out
    count = int(average)
    if count < 1 or 2 * count >= len(x):
        raise _op.InvalidArgumentError(
            f"The ends are averaged over {count} points; the region has {len(x)}, "
            f"so it is 1 to {max(1, (len(x) - 1) // 2)}."
        )
    low, high = float(data[:count].mean()), float(data[-count:].mean())
    if method == "linear":
        left, right = float(x[:count].mean()), float(x[-count:].mean())
        curve = low + (high - low) * (x - left) / (right - left)
    elif method == "shirley":
        curve = _analysis._shirley(x, data, low, high, 1e-7, 200)
    else:
        loss = _analysis._tougaard_integral(x, data - low, True, TOUGAARD_C)
        tail = float(loss[-count:].mean())
        if not tail > 0:
            raise _op.InvalidArgumentError("There is no peak to scale the Tougaard background to.")
        curve = low + (high - low) / tail * loss
    out[order] = curve
    return out


# --- The fit -------------------------------------------------------------------------


class XPSFitResult:
    """What ``op.xps_fit`` returns: the components as fitted, and how well they fit.

    ``components`` is a list of dicts (letter, name, shape, position, fwhm,
    area and their ``_sigma``, ``width`` (the true FWHM), rsf, gauss,
    ``percent`` (share of area/RSF) and ``constraints``). ``chisq``,
    ``chisq_reduced``, ``points``, ``converged``, ``reason`` and
    ``warnings`` say how it went; ``waves`` the waves made by role, ``graph``
    the graph and ``name`` the result kept.
    """

    def __init__(self, **fields):
        self.__dict__.update(fields)

    def __getitem__(self, letter):
        for row in self.components:
            if row["letter"] == letter or row["name"] == letter:
                return row
        raise KeyError(letter)

    def _json(self):
        return {
            "result": self.name,
            "components": self.components,
            "region": self.region,
            "background": self.background,
            "chisq": self.chisq,
            "chisq_reduced": self.chisq_reduced,
            "points": self.points,
            "converged": self.converged,
            "reason": self.reason,
            "warnings": self.warnings,
            "waves": self.waves,
            "graph": self.graph,
        }

    def __repr__(self):
        return f"XPSFitResult({len(self.components)} components, chisq={self.chisq:.6g})"

    def __str__(self):
        lines = [
            f"XPS fit of {self.spectrum}: {len(self.components)} components over "
            f"{self.region[0]:g} to {self.region[1]:g} eV, {self.background} background"
        ]
        lines.append(f"  {'':3} {'name':<12} {'shape':<13} {'position':>18} {'FWHM':>16} {'area':>20} {'%':>7}")
        for row in self.components:
            def both(key):
                return _analysis._with_error(row[key], row[f"{key}_sigma"] or 0.0)
            percent = "" if row["percent"] is None else f"{row['percent']:.2f}"
            lines.append(
                f"  {row['letter']:<3} {row['name'][:12]:<12} {row['shape']:<13} {both('position'):>18} "
                f"{both('fwhm'):>16} {both('area'):>20} {percent:>7}"
            )
        lines.append(
            f"  chi-square {self.chisq:.6g} (reduced {self.chisq_reduced:.4g}) over {self.points} points; {self.reason}"
        )
        lines.extend(f"  ! {text}" for text in self.warnings)
        return "\n".join(lines)


def _graph_name(leaf):
    return "XPS_" + re.sub(r"\W", "_", leaf)


@_op.atomic()
def xps_fit(y, components, x=None, *, region=None, background="shirley", average=5,
            energy="binding", photon_energy=1486.6, shift=0.0, weighting="poisson", fit=True,
            graph=True, quiet=False, result=None, record=True):
    """Fit synthetic components over a background in a region of an XPS spectrum, as CasaXPS does.

    ::

        op.xps_fit("C1s", [
            {"name": "C-C", "shape": "GL(30)", "position": 284.8, "fwhm": 1.2},
            {"name": "C-O", "position": 286.3, "constraints": {"position": "A+1.5", "fwhm": "A"}},
        ], region=[281, 292])

    ``components`` is a list of dicts, lettered A, B, C ... in order:

    - ``name``; ``shape``: ``"GL(30)"`` (the default), ``"SGL(m)"``,
      ``"GL(m)T(k)"``, ``"SGL(m)T(k)"`` or ``"LA(α,β)"``
    - ``position`` (binding energy, eV), ``fwhm`` (the width parameter F,
      eV; 1.5 if left out) and ``area``: where the fit starts. An area left
      out is estimated from the height of the data
    - ``constraints``: for ``position``, ``fwhm`` and ``area``, ``""`` (free
      within the region, 0.05 to 20 eV, and 0 or more), limits
      ``"284, 286"``, ``"fixed"``, or a tie to another component: ``"A"``,
      ``"A+1.5"``, ``"A-1.5"``, ``"A*0.5"``, ``"A/2"``
    - ``rsf`` (relative sensitivity factor, 1) and ``gauss`` (FWHM in eV of a
      Gaussian the shape is convolved with, 0)

    ``x`` is an X wave of energies; by default the spectrum's X scaling.
    ``energy="kinetic"`` turns them into binding energies, photon_energy −
    KE, and ``shift`` (the charge correction) is added to every binding
    energy. ``region=[from, to]`` in binding energy (after the shift); the
    whole spectrum by default.

    ``background`` is ``"shirley"``, ``"linear"``, ``"tougaard"`` or
    ``"none"``, worked out from the data with its ends averaged over
    ``average`` points, and held while fitting. ``weighting`` is
    ``"poisson"`` (each point by 1/√counts) or ``"unit"``. ``fit=False``
    only draws the components as given.

    Makes, over the region (NaN outside, the spectrum's length and scaling):
    ``fit_<name>`` (background + every component), ``fit_<name>_bg``,
    ``fit_<name>_A``, ``_B``, ... (each component on the background) and
    ``fit_<name>_res`` (data − fit), and ``fit_<name>_BE``, the binding
    energies, when they are not the spectrum's own X. They are made again by
    the next fit of the same spectrum. With ``graph`` it shows them in the
    graph ``XPS_<name>`` on a reversed energy axis with the residual above.

    Returns an ``XPSFitResult``; the fit is kept among the results as
    ``XPS0``, ``XPS1``, ... unless ``record=False``.
    """
    if weighting not in ("poisson", "unit"):
        raise _op.InvalidArgumentError('weighting is "poisson" (1/√counts) or "unit".')
    if background not in BACKGROUNDS:
        raise _op.InvalidArgumentError(f"background is one of {', '.join(BACKGROUNDS)}.")
    y_wave = _op.wave(_op._wave_name(y))
    x_wave = None if x is None else _op.wave(_op._wave_name(x))
    data_all = np.asarray(y_wave.data)
    if data_all.ndim != 1 or data_all.dtype.kind not in "iuf":
        raise _op.InvalidArgumentError(f"The spectrum {y_wave.name} must be a 1-D wave of real numbers.")
    data_all = data_all.astype(float)
    count_all = len(data_all)
    be_all = binding_energies(y_wave, x_wave, count_all, energy, photon_energy, shift)
    bounds = None
    if region is not None:
        values = [_number(item, "The region") for item in np.atleast_1d(region)]
        if len(values) != 2 or values[0] == values[1]:
            raise _op.InvalidArgumentError("The region is two different binding energies, from and to.")
        bounds = tuple(sorted(values))
    first, stop = region_points(be_all, data_all, bounds)
    be, data = be_all[first:stop], data_all[first:stop]
    bg = make_background(be, data, background, average)
    lo, hi = float(be.min()), float(be.max())
    comps = parse_components(components, (lo, hi))

    net = data - bg
    peak = float(np.max(np.abs(net)))
    area_scale = peak if peak > 0 else 1.0
    maps, free = _affine(comps, area_scale)
    count = len(data)

    # Where the fit starts, in units of area_scale for the areas.
    u0 = np.zeros(len(free))
    lower = np.zeros(len(free))
    upper = np.zeros(len(free))
    pending = []
    for j, (i, param) in enumerate(free):
        value = comps[i].values[param]
        scale = area_scale if param == "area" else 1.0
        lower[j], upper[j] = value.low / scale, value.high / scale
        if value.start is None:
            pending.append(j)
        else:
            u0[j] = value.start / scale
    order = np.argsort(be)
    for j in pending:
        i = free[j][0]
        c = comps[i]
        position = _value_of(maps[i]["position"], u0)
        width = _value_of(maps[i]["fwhm"], u0)
        height = max(float(np.interp(position, be[order], net[order])), 0.05 * peak)
        u0[j] = height * c.shape.unit_area * max(width, 1e-3) / area_scale

    weights = None
    if weighting == "poisson":
        floor = max(1e-3 * float(np.max(np.abs(data))), 1e-300)
        weights = 1 / np.sqrt(np.clip(data, floor, None))

    def parameters(u):
        return [
            (
                _value_of(maps[c.index]["position"], u),
                _value_of(maps[c.index]["fwhm"], u),
                _value_of(maps[c.index]["area"], u),
            )
            for c in comps
        ]

    def curves(u, energies):
        return [
            c.shape.curve(energies, position, fwhm, area, c.gauss)
            for c, (position, fwhm, area) in zip(comps, parameters(u))
        ]

    warnings = []
    if fit and free:
        if count <= len(free):
            raise _op.InvalidArgumentError(f"{len(free)} parameters are free but the region has only {count} points.")

        def model(_x, *u):
            return bg + np.sum(curves(np.asarray(u), be), axis=0)

        u, covariance, chisq, converged, reason = _analysis._least_squares(
            model, be, data, u0, weights, lower, upper, max_iterations=400
        )
        freedom = count - len(free)
        if weights is not None:
            # Scaled by the scatter, as for unweighted fits: counts per second are not counts.
            covariance = covariance * chisq / freedom
        sigma_u = np.sqrt(np.abs(np.diag(covariance)))
        span = upper - lower
        for (i, param), value, low_, high_, width_ in zip(free, u, lower, upper, span):
            tolerance = 1e-9 * (width_ if np.isfinite(width_) else max(abs(value), 1.0))
            if value <= low_ + tolerance or value >= high_ - tolerance:
                warnings.append(f"{comps[i].letter}'s {param} is at a limit.")
        if not converged:
            warnings.append(f"The fit did not converge: {reason}.")
    else:
        u = np.clip(u0, lower, upper)
        sigma_u = np.zeros(len(free))
        residual = (data - bg - np.sum(curves(u, be), axis=0)) * (1.0 if weights is None else weights)
        chisq = float(residual @ residual)
        freedom = max(1, count - len(free))
        converged, reason = True, "not fitted" if not fit else "nothing is free"

    def estimate(i, param):
        j, coef, const = maps[i][param]
        value = const if j is None else coef * u[j] + const
        error = 0.0 if j is None else abs(coef) * sigma_u[j]
        return float(value), float(error)

    rows = []
    for c in comps:
        position, position_s = estimate(c.index, "position")
        fwhm, fwhm_s = estimate(c.index, "fwhm")
        area, area_s = estimate(c.index, "area")
        if not fwhm > 0:
            warnings.append(f"{c.letter}'s fwhm came out {fwhm:g}; check its constraint.")
        rows.append({
            "letter": c.letter, "name": c.name, "shape": c.shape.text,
            "position": position, "position_sigma": position_s,
            "fwhm": fwhm, "fwhm_sigma": fwhm_s,
            "width": c.shape.width(fwhm, c.gauss) if fwhm > 0 else None,
            "area": area, "area_sigma": area_s, "rsf": c.rsf, "gauss": c.gauss,
            "constraints": {param: _describe(c.values[param]) for param in PARAMS},
        })
    corrected = np.array([row["area"] / row["rsf"] for row in rows])
    total = float(corrected.sum())
    for row, part in zip(rows, corrected):
        row["percent"] = float(100 * part / total) if total > 0 else None

    # The waves: the spectrum's length and scaling, NaN outside the region.
    leaf = y_wave.name.rsplit(":", 1)[-1]
    folder = y_wave.name.rsplit(":", 1)[0] + ":" if ":" in y_wave.name else ""
    base = f"{folder}fit_{leaf}"
    parts = curves(u, be)
    envelope = bg + np.sum(parts, axis=0)

    def whole(values):
        out = np.full(count_all, np.nan)
        out[first:stop] = values
        return out

    like = {"x0": y_wave.x0, "dx": y_wave.dx, "x_unit": y_wave.x_unit, "unit": y_wave.unit}
    made = {
        "fit": _op.make(base, whole(envelope), **like).name,
        "background": _op.make(f"{base}_bg", whole(bg), **like).name,
        "residual": _op.make(f"{base}_res", whole(data - envelope), **like).name,
    }
    for c, part in zip(comps, parts):
        made[c.letter] = _op.make(f"{base}_{c.letter}", whole(bg + part), **like).name
    converted = energy == "kinetic" or float(shift) != 0.0
    if x_wave is not None and not converted:
        x_for_graph = x_wave.name
    elif x_wave is None and not converted:
        x_for_graph = None
    else:
        made["energy"] = _op.make(f"{base}_BE", be_all, unit="eV").name
        x_for_graph = made["energy"]
    # Components of an earlier fit with more of them are out of date.
    stale = []
    for letter in LETTERS[len(comps):]:
        name = f"{base}_{letter}"
        if not _op.exists(name):
            break
        stale.append(name)

    shown = None
    if graph:
        shown = _show(y_wave, x_for_graph, made, comps, stale, background, lo, hi)
    for name in stale:
        try:
            _op.kill(name)
        except _op.OresmeError:
            pass

    stored = None
    if record:
        names, coef, sigmas = [], [], []
        for row in rows:
            for key in PARAMS:
                names.append(f"{row['letter']}_{key}")
                coef.append(row[key])
                sigmas.append(row[f"{key}_sigma"])
            names.append(f"{row['letter']}_percent")
            coef.append(row["percent"])
            sigmas.append(None)
        settings = {
            "y": y_wave.name,
            "components": _given(components),
            "x": None if x_wave is None else x_wave.name,
            "region": None if bounds is None else list(bounds),
            "background": background,
            "average": int(average),
            "energy": energy,
            "photon_energy": float(photon_energy),
            "shift": float(shift),
            "weighting": weighting,
            "fit": bool(fit),
        }
        stored = _analysis._record(
            {
                "kind": "xps",
                "label": f"XPS {len(comps)} component{'s' if len(comps) != 1 else ''}({leaf})",
                "settings": settings,
                "inputs": [y_wave.name, *([x_wave.name] if x_wave is not None else [])],
                "names": names,
                "coef": coef,
                "sigma": sigmas,
                "held": [f"{c.letter}_{p}" for c in comps for p in PARAMS if c.values[p].kind == "fixed"],
                "covariance": None,
                "chisq": chisq,
                "points": count,
                "freedom": freedom,
                "converged": bool(converged),
                "reason": " ".join(warnings) or reason,
                "outputs": made,
            },
            result,
        )
    outcome = XPSFitResult(
        spectrum=y_wave.name, components=rows, region=[lo, hi], background=background,
        chisq=float(chisq), chisq_reduced=float(chisq / freedom), points=count,
        converged=bool(converged), reason=reason, warnings=warnings, waves=made,
        graph=shown, name=stored,
    )
    if not quiet:
        print(outcome)
    return outcome


def _given(components):
    """The components as given, as plain values, to keep with the result."""
    if isinstance(components, dict):
        components = [components]
    return _analysis._plain([dict(item) for item in components])


def _show(y_wave, x_name, made, comps, stale, background, lo, hi):
    """The graph XPS_<name>, made or brought up to date; returns its name."""
    leaf = y_wave.name.rsplit(":", 1)[-1]
    name = _graph_name(leaf)
    existing = [g.name for g in _op.graphs()]
    labels = [(made[c.letter], f"{c.letter}: {c.name}") for c in comps]
    if name not in existing:
        g = _op.display(y_wave, x=x_name, name=name)
        g.trace(y_wave.name.rsplit(":", 1)[-1]).set(
            mode="markers", marker="circle", marker_size=1.5, color="#000000"
        )
        g.append(made["background"], x=x_name)
        g.trace(made["background"].rsplit(":", 1)[-1]).set(color="#808080", line_size=1)
        for k, (wave_name, _) in enumerate(labels):
            g.append(wave_name, x=x_name)
            g.trace(wave_name.rsplit(":", 1)[-1]).set(color=_COLORS[k % len(_COLORS)], line_size=1)
        g.append(made["fit"], x=x_name)
        g.trace(made["fit"].rsplit(":", 1)[-1]).set(color="#d62728", line_size=1.5)
        g.append(made["residual"], x=x_name, axis="right")
        g.trace(made["residual"].rsplit(":", 1)[-1]).set(color="#808080", line_size=0.75)
        g.bottom.set(label="Binding Energy (eV)", reverse=True, min=lo, max=hi)
        g.left.set(label=f"Intensity ({y_wave.unit})" if y_wave.unit else "Intensity", span=(0, 0.78))
        g.right.set(label="Residual", span=(0.82, 1))
        g.legend(_legend(labels, made, background), anchor="LT", y=0.2)
        return name
    g = _op.graph(name)
    traces = g._info()["traces"]
    on_graph = {trace["y"] for trace in traces}
    for trace in traces:
        if trace["y"] in stale:
            g.remove(trace["name"])
    for k, (wave_name, _) in enumerate(labels):
        if wave_name not in on_graph:
            g.append(wave_name, x=x_name)
            g.trace(wave_name.rsplit(":", 1)[-1]).set(color=_COLORS[k % len(_COLORS)], line_size=1)
    for role in ("background", "fit"):
        if made[role] not in on_graph:
            g.append(made[role], x=x_name)
    if made["residual"] not in on_graph:
        g.append(made["residual"], x=x_name, axis="right")
    for item in g._info()["annotations"]:
        if item.get("kind") == "legend":
            g.annotation(item["name"]).set(text=_legend(labels, made, background))
            break
    return name


def _legend(labels, made, background):
    def symbol(wave_name):
        return f"\\s({wave_name.rsplit(':', 1)[-1]})"

    lines = [f"{symbol(made['background'])} Background ({background})"]
    lines.extend(f"{symbol(wave_name)} {label}" for wave_name, label in labels)
    lines.append(f"{symbol(made['fit'])} Envelope")
    return "\n".join(lines)


with _op._registering("core"):
    _op.action(
        "core.xps_fit", title="XPS Peak Fit",
        description="Fit synthetic components over a background in a region of an XPS spectrum, as CasaXPS does.",
        params={
            "y": _analysis._wave_param("Spectrum"),
            "components": {"type": "json", "title": "Components",
                           "description": 'A list of {"name", "shape", "position", "fwhm", "area", "rsf", '
                                          '"gauss", "constraints"}.'},
            "x": _analysis._wave_param("Energy wave", "Energies of the points instead of the X scaling.", True),
            "region": {"type": "numbers", "length": 2, "title": "Region (eV)", "optional": True,
                       "description": "Binding energies from and to; the whole spectrum by default."},
            "background": {"type": "choice", "title": "Background", "choices": list(BACKGROUNDS),
                           "default": "shirley"},
            "average": {"type": "integer", "title": "Points averaged at each end", "min": 1, "default": 5},
            "energy": {"type": "choice", "title": "Energies are", "choices": ["binding", "kinetic"],
                       "default": "binding"},
            "photon_energy": {"type": "number", "title": "Photon energy (eV)", "min": 0, "default": 1486.6},
            "shift": {"type": "number", "title": "Charge correction (eV)", "default": 0.0},
            "weighting": {"type": "choice", "title": "Weighting", "choices": ["poisson", "unit"],
                          "default": "poisson"},
            "fit": {"type": "boolean", "title": "Fit", "default": True,
                    "description": "False only draws the components as given."},
            "graph": {"type": "boolean", "title": "Graph", "default": True},
            "quiet": {"type": "boolean", "title": "Quiet", "default": False},
            "result": {"type": "string", "title": "Result name", "optional": True},
            "record": {"type": "boolean", "title": "Keep the result", "default": True},
        },
    )(xps_fit)
