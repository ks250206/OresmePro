"""Line shapes of synthetic components, written as CasaXPS writes them.

Every shape is a function of u = (BE − E) / F: BE the binding energy, E the
position and F the width parameter (eV). The profile is 1 at u = 0, and u > 0
is the side of higher binding energy (lower kinetic energy). From the
CasaXPS manual (2.3.15, rev 1.3, pp. 55 and 301), with m in percent:

* ``GL(m)``, the product of a Gaussian and a Lorentzian::

      GL(u) = exp(−4 ln2 (1 − m/100) u²) / (1 + 4 (m/100) u²)

* ``SGL(m)``, their sum::

      SGL(u) = (1 − m/100) exp(−4 ln2 u²) + (m/100) / (1 + 4 u²)

* ``GL(m)T(k)`` and ``SGL(m)T(k)``, with a tail towards higher binding
  energy (metals): on the side u > 0 the shape S becomes
  S + (1 − S) exp(−k u), and on the other side it is S itself. A small k
  spreads intensity far towards higher binding energy. (This is how this
  plugin reads the manual's tail function, whose printed form does not decay.)

* ``LA(α, β)``, the asymmetric Lorentzian: a Lorentzian of FWHM F raised to
  the power α on the side of higher binding energy and β on the other::

      LA(u) = (1 + 4 u²)^(−α)   for u ≥ 0
      LA(u) = (1 + 4 u²)^(−β)   for u < 0

  Its area is finite for α, β > 1/2. CasaXPS's third argument m of
  LA(α, β, m) chooses the width of a Gaussian it convolves the shape with, in
  a way the manual does not define, so it is not taken here; a component's
  ``gauss=`` gives that Gaussian's FWHM in eV instead (for any shape).

F is the FWHM parameter that CasaXPS reports; it is the true full width at
half maximum only for GL(0), GL(100), SGL(m) and no tail or Gaussian. The
true width of each component is reported separately (``width``).

The area of a component is the area of its whole profile, over all
energies (a convolution with a Gaussian keeps it), which is what is fitted.
"""

import math
import re

import numpy as np
from scipy.integrate import quad
from scipy.signal import fftconvolve
from scipy.special import gammaln

from oresme_plugin import PluginError

LN2 = math.log(2.0)
#: The standard deviation of a Gaussian of FWHM 1.
SIGMA_PER_FWHM = 1 / (2 * math.sqrt(2 * LN2))

_NUM = r"\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)\s*"
_GL = re.compile(rf"^(S?GL)\({_NUM}\)(?:T\({_NUM}\))?$", re.IGNORECASE)
_LA = re.compile(rf"^LA\({_NUM},{_NUM}(?:,{_NUM})?\)$", re.IGNORECASE)


def _half_lorentz_area(power):
    """∫_0^∞ (1 + 4u²)^(−power) du = (√π / 4) Γ(power − ½) / Γ(power)."""
    return 0.25 * math.sqrt(math.pi) * math.exp(gammaln(power - 0.5) - gammaln(power))


class Shape:
    """A line shape: ``kind`` GL, SGL or LA with its parameters."""

    def __init__(self, kind, m=0.0, k=None, alpha=None, beta=None):
        self.kind = kind
        self.m = float(m)
        self.k = None if k is None else float(k)
        self.alpha = alpha
        self.beta = beta
        self._area = None

    @property
    def text(self):
        """How CasaXPS writes it: GL(30), SGL(20)T(1.5), LA(1.53,243)."""
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
        """The half width at half maximum of the narrower side, in units of F.

        LA(α, β) with a large power is far narrower on one side than F says;
        a convolution has to sample it finely enough.
        """
        if self.kind != "LA":
            return 0.4
        power = max(self.alpha, self.beta)
        return min(0.4, 0.5 * math.sqrt(2 ** (1 / power) - 1))

    @property
    def unit_area(self):
        """The area under the profile for F = 1 (times F for a width F)."""
        if self._area is None:
            mix = self.m / 100.0
            if self.kind == "LA":
                self._area = _half_lorentz_area(self.alpha) + _half_lorentz_area(self.beta)
            elif self.k is None and self.kind == "SGL":
                self._area = (1 - mix) * 0.5 * math.sqrt(math.pi / LN2) + mix * math.pi / 2
            elif self.k is None and mix == 1:
                self._area = math.pi / 2
            else:
                f = lambda u: float(self.profile(u))  # noqa: E731
                low = quad(f, -np.inf, 0, limit=400, epsabs=0, epsrel=1e-12)[0]
                high = quad(f, 0, np.inf, limit=400, epsabs=0, epsrel=1e-12)[0]
                self._area = low + high
        return self._area

    def curve(self, be, position, fwhm, area, gauss=0.0):
        """A component of this shape at the binding energies ``be``.

        With ``gauss`` (eV, FWHM) the shape is convolved with a Gaussian, on a
        grid fine enough for both widths, and read off at ``be``.
        """
        be = np.asarray(be, dtype=np.float64)
        width = max(float(fwhm), 1e-9)
        height = area / (self.unit_area * width)
        if not gauss > 0:
            return height * self.profile((be - position) / width)
        sigma = float(gauss) * SIGMA_PER_FWHM
        reach = 5 * sigma
        low, high = float(np.min(be)) - reach, float(np.max(be)) + reach
        step = min(width * self.sharpness / 15, sigma / 10)
        if (high - low) / step > 400_000:
            step = (high - low) / 400_000
        # The grid goes through the position, so that the samples move with it and the
        # curve changes smoothly as the fit moves the position.
        first = math.floor((low - position) / step)
        last = math.ceil((high - position) / step)
        grid = position + step * np.arange(first, last + 1)
        half = math.ceil(reach / step)
        offsets = step * np.arange(-half, half + 1)
        kernel = np.exp(-0.5 * (offsets / sigma) ** 2)
        kernel /= kernel.sum()
        smoothed = fftconvolve(self.profile((grid - position) / width), kernel, mode="same")
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


def parse_shape(text):
    """The shape that CasaXPS's notation names: GL(30), SGL(20), GL(30)T(1.5), LA(1.53,243)."""
    plain = text.strip().replace(" ", "")
    match = _GL.match(plain)
    if match:
        kind = match.group(1).upper()
        m = float(match.group(2))
        k = None if match.group(3) is None else float(match.group(3))
        if not 0 <= m <= 100:
            raise PluginError(f"The m of {text} is from 0 (Gaussian) to 100 (Lorentzian).")
        if k is not None and not k > 0:
            raise PluginError(f"The tail k of {text} must be more than 0.")
        return Shape(kind, m, k)
    match = _LA.match(plain)
    if match:
        alpha, beta = float(match.group(1)), float(match.group(2))
        if match.group(3) is not None and float(match.group(3)) != 0:
            raise PluginError(
                f"{text}: the third number of CasaXPS's LA(α,β,m) chooses a Gaussian in a way "
                "this plugin cannot reproduce. Write LA(α,β) and give the Gaussian's FWHM in eV "
                "with gauss=, e.g. LA(1.53,243) gauss=0.6."
            )
        if not (alpha > 0.5 and beta > 0.5):
            raise PluginError(f"α and β of {text} must be more than 0.5, for a finite area.")
        return Shape("LA", alpha=alpha, beta=beta)
    raise PluginError(
        f"{text!r} is not a line shape this plugin knows: GL(m), SGL(m), GL(m)T(k), "
        "SGL(m)T(k) (m from 0 to 100, k more than 0) or LA(α,β)."
    )
