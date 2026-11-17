"""Equivalent circuits written as text, as impedance.py writes them.

Elements in series are joined by ``-``; elements in parallel are written
``p(a, b, ...)``, where each branch may itself be a series. Each element is a
kind and a label that tells it apart: ``R0``, ``CPE1``, ``W_d``. The label
starts with a digit or ``_``, so ``R_ct`` is a resistor (``Rct`` is not).

    R0-p(R1,C1)                 a resistor, then R1 in parallel with C1
    R0-p(R1-W1,CPE1)            Randles: CPE1 across R1 and a Warburg in series
    R0-p(R1,CPE1)-p(R2,CPE2)    two arcs

The kinds, with their parameters (ω = 2π f; j² = −1):

    R    resistor                   Z = R                        R (Ω)
    C    capacitor                  Z = 1 / (jω C)               C (F)
    L    inductor                   Z = jω L                     L (H)
    CPE  constant-phase element     Z = 1 / (Q (jω)^n)           Q (F·s^(n−1)), n (0.2 to 1)
    Q    the same as CPE
    W    Warburg, semi-infinite     Z = σ (1 − j) / √ω           σ (Ω·s^(−1/2))
    Wo   Warburg, finite, open      Z = Z0 coth(√(jωτ)) / √(jωτ)  Z0 (Ω), τ (s)
    Ws   Warburg, finite, short     Z = Z0 tanh(√(jωτ)) / √(jωτ)  Z0 (Ω), τ (s)

Parameters are named after their element: ``R1``, ``C1``, ``L1``, ``W1``;
a CPE labelled 1 (``CPE1`` or ``Q1``) has ``Q1`` and ``n1``; ``Wo1`` has
``Wo1_Z0`` and ``Wo1_tau``.
"""

import re

import numpy as np

from oresme_plugin import PluginError


def _sqrt_jwt(w, tau):
    return np.sqrt(1j * w * tau)


#: Each kind: its parameters as (suffix of the name, fitted as log10), and its impedance.
KINDS = {
    "R": ((("", True),), lambda p, w: p[0] + 0j * w),
    "C": ((("", True),), lambda p, w: 1 / (1j * w * p[0])),
    "L": ((("", True),), lambda p, w: 1j * w * p[0]),
    "CPE": ((("Q", True), ("n", False)), lambda p, w: 1 / (p[0] * (1j * w) ** p[1])),
    "W": ((("", True),), lambda p, w: p[0] * (1 - 1j) / np.sqrt(w)),
    "Wo": (
        (("_Z0", True), ("_tau", True)),
        lambda p, w: p[0] / (_sqrt_jwt(w, p[1]) * np.tanh(_sqrt_jwt(w, p[1]))),
    ),
    "Ws": (
        (("_Z0", True), ("_tau", True)),
        lambda p, w: p[0] * np.tanh(_sqrt_jwt(w, p[1])) / _sqrt_jwt(w, p[1]),
    ),
}

#: An element: its kind (the longest that matches first) and its label.
_ELEMENT = re.compile(r"(CPE|Wo|Ws|W|R|C|L|Q)([0-9_][A-Za-z0-9_]*)?")


class Element:
    def __init__(self, kind, label):
        self.kind = "CPE" if kind == "Q" else kind
        self.label = label
        self.name = kind + label
        suffixes = KINDS[self.kind][0]
        if self.kind == "CPE":
            # CPE1 and Q1 both have Q1 and n1, as the R(RQ) model names them.
            self.params = [f"{suffix}{label}" for suffix, _ in suffixes]
        else:
            self.params = [f"{self.name}{suffix}" for suffix, _ in suffixes]
        self.logs = [log for _, log in suffixes]

    def impedance(self, p, w):
        return KINDS[self.kind][1](p, w)


class Series:
    def __init__(self, parts):
        self.parts = parts


class Parallel:
    def __init__(self, branches):
        self.branches = branches


class Circuit:
    """A circuit read from its text: its elements, parameters, and impedance."""

    def __init__(self, text):
        self.text = text
        self.tree = _Parser(text).parse()
        self.elements = list(_elements(self.tree))
        self.names = [name for element in self.elements for name in element.params]
        self.logs = [log for element in self.elements for log in element.logs]
        seen = set()
        for name in self.names:
            if name in seen:
                raise PluginError(
                    f"The circuit {text!r} has {name} twice: give each element its own label."
                )
            seen.add(name)

    def impedance(self, p, w):
        """Z of the circuit at angular frequencies w, with the parameters p in the order of names."""
        values = iter(np.asarray(p, dtype=np.float64))
        bound = {id(e): [next(values) for _ in e.params] for e in self.elements}
        return _impedance(self.tree, bound, np.asarray(w, dtype=np.float64))

    def initial_guess(self, w, Z):
        """Starting values from the shape of the spectrum, for a circuit of any shape.

        Resistors in the main series share the high-frequency intercept; those
        inside parallel branches share the span of Z′ the arcs cover. A
        capacitor or CPE takes the time constant of the arc's top (ω R C = 1),
        a Warburg the size of the low-frequency tail. With several capacitors
        or CPEs, those written first get the shorter time constants: the arcs
        at higher frequency, as circuits are usually written. (Where swapping
        two branches gives the same circuit, this is what decides which label
        gets which arc.)
        """
        order = np.argsort(w)[::-1]
        w, Z = w[order], Z[order]
        size = float(np.abs(Z).max())
        r_inf = max(float(Z.real[0]), 1e-6 * size)
        span = float(Z.real.max() - r_inf)
        if not span > 0:
            span = 0.1 * size
        k = _first_apex(-Z.imag)
        wk = float(w[k])
        main = [e for e in _top_series(self.tree) if isinstance(e, Element) and e.kind == "R"]
        inner = [e for e in self.elements if e.kind == "R" and e not in main]
        r_main = r_inf / max(len(main), 1)
        r_inner = span / max(len(inner), 1)
        storing = [e for e in self.elements if e.kind in ("C", "CPE")]
        # Time constants a hundredfold apart, centred on the arc's top.
        omega = {
            id(e): wk * 100.0 ** ((len(storing) - 1) / 2 - index)
            for index, e in enumerate(storing)
        }
        guess = []
        for element in self.elements:
            if element.kind == "R":
                guess.append(r_main if element in main else r_inner)
            elif element.kind == "C":
                guess.append(1 / (omega[id(element)] * r_inner))
            elif element.kind == "L":
                guess.append(1e-3 * r_inf / float(w[0]))
            elif element.kind == "CPE":
                guess += [1 / (r_inner * omega[id(element)] ** 0.9), 0.9]
            elif element.kind == "W":
                guess.append(0.1 * span * np.sqrt(float(w[-1])))
            else:  # Wo, Ws
                guess += [span, 1 / float(w[-1])]
        return guess


def _elements(node):
    if isinstance(node, Element):
        yield node
    elif isinstance(node, Series):
        for part in node.parts:
            yield from _elements(part)
    else:
        for branch in node.branches:
            yield from _elements(branch)


def _top_series(node):
    return node.parts if isinstance(node, Series) else [node]


def _impedance(node, bound, w):
    if isinstance(node, Element):
        return node.impedance(bound[id(node)], w)
    if isinstance(node, Series):
        return sum(_impedance(part, bound, w) for part in node.parts)
    return 1 / sum(1 / _impedance(branch, bound, w) for branch in node.branches)


def _first_apex(minus_imag):
    """The index of the first clear maximum of −Z″ from high frequency down (see eis.first_apex)."""
    from .eis import first_apex

    return first_apex(minus_imag)


class _Parser:
    """series := term ('-' term)* ;  term := element | 'p(' series (',' series)+ ')'"""

    def __init__(self, text):
        if not isinstance(text, str) or not text.strip():
            raise PluginError("The circuit is empty: write it as R0-p(R1,C1), say.")
        if len(text) > 500:
            raise PluginError("The circuit is longer than 500 characters.")
        self.text = text
        self.s = re.sub(r"\s+", "", text)
        self.i = 0

    def fail(self, what):
        shown = self.s[: self.i] + " ⟨here⟩ " + self.s[self.i:]
        raise PluginError(f"The circuit {self.text!r} cannot be read: {what} at {shown.strip()!r}.")

    def parse(self):
        node = self.series()
        if self.i != len(self.s):
            self.fail("unexpected " + repr(self.s[self.i]))
        return node

    def series(self):
        parts = [self.term()]
        while self.peek("-"):
            self.i += 1
            parts.append(self.term())
        return parts[0] if len(parts) == 1 else Series(parts)

    def term(self):
        if self.s.startswith("p(", self.i):
            self.i += 2
            branches = [self.series()]
            while self.peek(","):
                self.i += 1
                branches.append(self.series())
            if not self.peek(")"):
                self.fail("a missing )")
            self.i += 1
            if len(branches) < 2:
                self.fail("p(…) with one branch (it needs two or more, separated by commas)")
            return Parallel(branches)
        match = _ELEMENT.match(self.s, self.i)
        if not match:
            self.fail("no element (R, C, L, CPE, Q, W, Wo, Ws or p(…))")
        self.i = match.end()
        # A letter right after the kind is a label that does not start with a digit or _.
        if self.i < len(self.s) and self.s[self.i].isalpha():
            self.fail(
                f"a label of {match.group(1)} that does not start with a digit or _ "
                f"(write {match.group(1)}_{self.s[self.i]}… or {match.group(1)}1)"
            )
        return Element(match.group(1), match.group(2) or "")

    def peek(self, char):
        return self.i < len(self.s) and self.s[self.i] == char
