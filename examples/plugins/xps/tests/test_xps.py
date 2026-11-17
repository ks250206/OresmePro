"""Checks of the XPS plugin on synthetic spectra whose answers are known.

Runs with any Python that has NumPy and SciPy, from the repository:

    python3 examples/plugins/xps/tests/test_xps.py
    uv run --no-project --with numpy --with scipy python -I examples/plugins/xps/tests/test_xps.py

or under pytest. The app's unit tests (src/app/plugins/xps.test.ts) run it
in Pyodide, the Python the plugin runs in. It imports the plugin SDK
(oresme_plugin) from src/sandbox/python, as the sandbox provides it.
"""

import inspect
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
SDK = os.path.normpath(os.path.join(PLUGIN, "..", "..", "..", "src", "sandbox", "python"))
for path in (PLUGIN, SDK):
    if path not in sys.path:
        sys.path.insert(0, path)

import numpy as np  # noqa: E402
from scipy.integrate import quad  # noqa: E402

import oresme_plugin  # noqa: E402
from oresme_plugin import PluginError, Wave  # noqa: E402

import xps  # noqa: E402, F401  (registers the actions)
from xps.common import background  # noqa: E402
from xps.shapes import parse_shape  # noqa: E402

ACTIONS = oresme_plugin._ACTIONS
#: What each check achieved, printed at the end: name -> text.
REPORT = {}


def make(name, values, unit="", x0=0.0, dx=1.0, x_unit=""):
    data = np.asarray(values, dtype=np.float64)
    data.flags.writeable = False
    return Wave(name, data, x0=x0, dx=dx, x_unit=x_unit, unit=unit)


def run(action, **arguments):
    """Runs an action as the sandbox does, and checks that its outcome can be handed back."""
    outcome = ACTIONS[action](**arguments)
    for role, value in outcome.get("waves", {}).items():
        oresme_plugin._output(role, value)
    json.dumps(oresme_plugin._plain(outcome.get("values", {})), allow_nan=False)
    json.dumps(oresme_plugin._plain(outcome.get("graph")), allow_nan=False)
    return outcome


def close(actual, expected, rel=0.0, abs_=0.0, what=""):
    assert abs(actual - expected) <= abs_ + rel * abs(expected), (
        f"{what}: {actual!r} is not {expected!r} (rel {rel}, abs {abs_})"
    )


def refuses(action, message, **arguments):
    try:
        run(action, **arguments)
    except PluginError as error:
        assert message in str(error), (message, str(error))
    else:
        raise AssertionError(f"no error for {arguments}")


def shirley_of(be, net, low, high):
    """The Shirley background that ``net`` (the peaks alone) makes between two levels."""
    order = np.argsort(be)
    x, n = be[order], net[order]
    cumulative = np.concatenate([[0.0], np.cumsum(0.5 * (n[1:] + n[:-1]) * np.diff(x))])
    out = np.empty(len(be))
    out[order] = low + (high - low) * cumulative / cumulative[-1]
    return out


# --- The package and its manifest ------------------------------------------------


def test_manifest_matches_python():
    """Every action of the manifest is registered, and takes exactly the arguments it lists."""
    with open(os.path.join(PLUGIN, "oresme-plugin.json"), encoding="utf-8") as file:
        manifest = json.load(file)
    assert sorted(ACTIONS) == sorted(item["name"] for item in manifest["actions"])
    for item in manifest["actions"]:
        signature = inspect.signature(ACTIONS[item["name"]])
        assert list(signature.parameters) == list(item["params"]), item["name"]
        for name, spec in item["params"].items():
            parameter = signature.parameters[name]
            required = not spec.get("optional") and "default" not in spec
            assert (parameter.default is inspect.Parameter.empty) == required, (item["name"], name)
            if "default" in spec:
                assert parameter.default == spec["default"], (item["name"], name)
    listed = set(manifest["files"])
    on_disk = {
        os.path.relpath(os.path.join(root, name), PLUGIN).replace(os.sep, "/")
        for root, _, names in os.walk(os.path.join(PLUGIN, "xps"))
        for name in names
        if name.endswith(".py")
    }
    assert on_disk <= listed, sorted(on_disk - listed)


# --- Line shapes -----------------------------------------------------------------


def test_shapes_areas_and_widths():
    for text in ("GL(0)", "GL(30)", "GL(100)", "SGL(0)", "SGL(30)", "SGL(100)", "GL(30)T(1.5)",
                 "SGL(20)T(0.8)", "LA(1.53,243)", "LA(1.2,3)"):
        shape = parse_shape(text)
        assert shape.text == text.replace(" ", ""), (shape.text, text)
        f = lambda u, s=shape: float(s.profile(u))  # noqa: E731
        numeric = quad(f, -np.inf, 0, limit=500)[0] + quad(f, 0, np.inf, limit=500)[0]
        close(shape.unit_area, numeric, rel=1e-7, what=f"area of {text}")
        assert float(shape.profile(0.0)) == 1.0
        # The curve has the area asked for, with or without a Gaussian.
        be = np.linspace(-400, 400, 800_001)
        for gauss in (0.0, 0.7):
            y = shape.curve(be, 1.0, 1.3, 5.0, gauss)
            area = float(np.sum(0.5 * (y[1:] + y[:-1]) * np.diff(be)))
            # The heavy tails of LA(1.2, 3) and GL(100) reach past ±400 eV.
            heavy = text.startswith("SGL") or text in ("GL(100)", "LA(1.2,3)")
            close(area, 5.0, rel=3e-3 if heavy else 1e-5,
                  what=f"curve area of {text}, gauss {gauss}")
    # F is the FWHM for the Gaussian, the Lorentzian and every sum; the product GL(30) is narrower.
    for text in ("GL(0)", "GL(100)", "SGL(30)"):
        close(parse_shape(text).width(1.0), 1.0, rel=1e-4, what=f"width of {text}")
    gl30 = parse_shape("GL(30)").width(1.0)
    assert 0.9 < gl30 < 0.99, gl30
    # A Gaussian of FWHM g on a Gaussian of FWHM F: √(F² + g²).
    close(parse_shape("GL(0)").width(1.0, 0.75), math.hypot(1.0, 0.75), rel=1e-3, what="convolved width")
    # Tails and LA lean towards higher binding energy (u > 0).
    for text in ("GL(30)T(1.5)", "LA(1.53,243)"):
        shape = parse_shape(text)
        high = quad(lambda u, s=shape: float(s.profile(u)), 0, np.inf, limit=500)[0]
        low = quad(lambda u, s=shape: float(s.profile(u)), -np.inf, 0, limit=500)[0]
        assert high > 1.5 * low, (text, high, low)
    REPORT["shapes"] = f"GL(30) FWHM = {gl30:.4f} F; LA(1.53,243) area {parse_shape('LA(1.53,243)').unit_area:.4f} F"


def test_shapes_refused():
    for text, message in (
        ("GL(130)", "from 0"),
        ("LA(1.53,243,5)", "gauss="),
        ("LA(0.4,2)", "more than 0.5"),
        ("Voigt", "not a line shape"),
    ):
        try:
            parse_shape(text)
        except PluginError as error:
            assert message in str(error), (message, str(error))
        else:
            raise AssertionError(f"no error for {text}")


# --- Backgrounds -----------------------------------------------------------------


def test_shirley_recovers_its_own_background():
    be = np.linspace(280, 295, 601)
    shape = parse_shape("GL(30)")
    net = shape.curve(be, 285.0, 1.2, 4000.0) + shape.curve(be, 289.0, 1.0, 1500.0)
    true = shirley_of(be, net, 200.0, 650.0)
    got = background(be, true + net, "Shirley", 1)
    close(float(np.max(np.abs(got - true))), 0.0, abs_=1e-3, what="Shirley")
    # The order of the points does not matter.
    flipped = background(be[::-1], (true + net)[::-1], "Shirley", 1)[::-1]
    close(float(np.max(np.abs(flipped - true))), 0.0, abs_=1e-3, what="Shirley, falling energies")
    linear = background(be, true + net, "Linear", 1)
    close(linear[0], 200.0, abs_=1e-6, what="linear start")
    close(linear[-1], 650.0, rel=1e-9, what="linear end")
    REPORT["shirley"] = f"max error {np.max(np.abs(got - true)):.1e} on a step of 450"


# --- Peak fits -------------------------------------------------------------------

C1S = {
    "A": {"pos": 284.80, "fwhm": 1.10, "area": 30000.0},
    "B": {"pos": 286.30, "fwhm": 1.10, "area": 9000.0},
    "C": {"pos": 288.90, "fwhm": 1.30, "area": 4000.0},
}
C1S_TABLE = (
    "C-C: GL(30) pos=284.6 fwhm=1.4; "
    "C-O: GL(30) pos=A+1.5 fwhm=A; "
    "O-C=O: GL(30) pos=288.6[288,290] fwhm=1.2 rsf=1"
)


def c1s_spectrum(noise=False, seed=5, energies=None):
    be = np.linspace(280.0, 294.0, 281) if energies is None else energies
    shape = parse_shape("GL(30)")
    net = sum(shape.curve(be, p["pos"], p["fwhm"], p["area"]) for p in C1S.values())
    y = shirley_of(be, net, 1000.0, 1600.0) + net
    if noise:
        y = np.random.default_rng(seed).poisson(y).astype(np.float64)
    return be, y


def test_fit_recovers_c1s_exactly():
    be, y = c1s_spectrum()
    out = run("xps_fit", spectrum=make("c1s", y, "cps", x0=be[0], dx=be[1] - be[0], x_unit="eV"),
              components=C1S_TABLE, background="Shirley", average=1)
    v = out["values"]
    assert v["result"]["converged"], v["result"]
    rows = {row["letter"]: row for row in v["components"]}
    worst = 0.0
    for letter, truth in C1S.items():
        row = rows[letter]
        for key, name in (("pos", "position"), ("fwhm", "fwhm"), ("area", "area")):
            close(row[name], truth[key], rel=1e-6, what=f"{letter} {name}")
            worst = max(worst, abs(row[name] / truth[key] - 1))
    close(rows["B"]["position"] - rows["A"]["position"], 1.5, abs_=1e-9, what="tied position")
    assert rows["B"]["position_sigma"] == rows["A"]["position_sigma"]
    close(sum(row["percent"] for row in v["components"]), 100.0, rel=1e-12, what="percent")
    close(rows["A"]["percent"], 100 * 30000 / 43000, rel=1e-6, what="A percent")
    # The waves cover the region: the envelope lies on the data, components sit on the background.
    waves = out["waves"]
    assert np.allclose(waves["envelope"].data, y, rtol=1e-7)
    assert waves["region"].x0 == be[0] and waves["region"].x_unit == "eV"
    assert np.all(waves["comp_A"].data >= waves["background"].data - 1e-9)
    roles = {trace["y"] for trace in out["graph"]["traces"]}
    assert roles <= set(waves), roles
    assert out["graph"]["axes"]["bottom"]["reverse"] is True
    REPORT["c1s exact"] = f"worst relative error {worst:.1e}"


def test_fit_with_poisson_noise():
    be, y = c1s_spectrum(noise=True)
    # The end levels of the background average 10 points: from single noisy points, the
    # background (whose uncertainty the fit does not include) would bias the areas.
    out = run("xps_fit", spectrum=make("c1s", y, x0=be[0], dx=be[1] - be[0]),
              components=C1S_TABLE, average=10)
    v = out["values"]
    rows = {row["letter"]: row for row in v["components"]}
    lines = []
    for letter, truth in C1S.items():
        for key, name in (("pos", "position"), ("fwhm", "fwhm"), ("area", "area")):
            row = rows[letter]
            if row[f"{name}_sigma"] == 0:
                continue
            # σ leaves out the uncertainty of the background, which the noise at the ends of
            # the region brings; it matters most for C, near the end where the step is.
            if letter == "C" and name != "position":
                close(row[name], truth[key], rel=0.05, what=f"C {name} with noise")
                continue
            assert abs(row[name] - truth[key]) < 4 * row[f"{name}_sigma"], (letter, name, row)
            lines.append(abs(row[name] - truth[key]) / row[f"{name}_sigma"])
    # Poisson weights: χ²/ν near 1 (the background from noisy ends adds a little).
    assert 0.7 < v["chisq_reduced"] < 1.6, v["chisq_reduced"]
    REPORT["c1s poisson"] = f"worst |err|/σ {max(lines):.2f}, χ²/ν {v['chisq_reduced']:.3f}"


def test_fit_metal_doublet_with_la():
    """Ti 2p of a metal: LA(1.53,243) convolved with a Gaussian, 2p1/2 tied to 2p3/2."""
    # The tails of LA reach far towards higher binding energy: the region must go on until they
    # have died away, or the background, built from the data at its ends, takes some of them.
    be = np.linspace(445.0, 490.0, 901)
    shape = parse_shape("LA(1.53,243)")
    net = (shape.curve(be, 453.9, 0.8, 20000.0, 0.6)
           + shape.curve(be, 453.9 + 6.1, 0.8 * 1.4, 10000.0, 0.6))
    y = shirley_of(be, net, 3000.0, 5200.0) + net
    table = ("Ti 2p3/2: LA(1.53,243) pos=454.2 fwhm=1 gauss=0.6; "
             "Ti 2p1/2: LA(1.53,243) pos=A+6.1 fwhm=A*1.4 area=A*0.5 gauss=0.6")
    out = run("xps_fit", spectrum=make("ti2p", y, x0=be[0], dx=be[1] - be[0]), components=table,
              average=1)
    rows = out["values"]["components"]
    close(rows[0]["position"], 453.9, abs_=1e-3, what="2p3/2 position")
    close(rows[0]["fwhm"], 0.8, rel=2e-3, what="2p3/2 fwhm")
    close(rows[0]["area"], 20000.0, rel=2e-3, what="2p3/2 area")
    close(rows[1]["area"], 10000.0, rel=2e-3, what="2p1/2 area (tied)")
    close(rows[1]["position"] - rows[0]["position"], 6.1, abs_=1e-9, what="splitting")
    # LA(1.53,243) alone is 0.41 F wide; the Gaussian of 0.6 eV widens it to more than that.
    assert 0.6 < rows[0]["width"] < 0.8, rows[0]["width"]
    REPORT["ti 2p LA"] = (f"pos err {abs(rows[0]['position'] - 453.9) * 1e3:.2f} meV, "
                          f"area rel err {abs(rows[0]['area'] / 20000 - 1):.1e}")


def test_fit_kinetic_energy_xy_and_shift():
    """The same C 1s given as kinetic energies in an XY pair, charged by +0.8 eV."""
    hv = 1253.6
    be_true = np.linspace(280.0, 294.0, 281)
    _, y = c1s_spectrum(energies=be_true)
    ke = hv - (be_true + 0.8)  # what the charged sample showed, as kinetic energies
    out = run("xps_fit", spectrum=make("c1s", y), energy=make("ke", ke, "eV"),
              components=C1S_TABLE, energy_axis="kinetic", photon_energy=hv, shift=-0.8,
              region=[281, 293], average=1)
    rows = {row["letter"]: row for row in out["values"]["components"]}
    close(rows["A"]["position"], 284.8, abs_=1e-3, what="position from kinetic energies")
    assert "be" in out["waves"] and abs(out["waves"]["be"].data[0] - 281.0) < 0.06
    assert all(trace["x"] == "be" for trace in out["graph"]["traces"])
    close(out["values"]["region"][0], 281.0, abs_=0.06, what="region start")


def test_fit_refuses_what_it_cannot_do():
    be, y = c1s_spectrum()
    spectrum = make("c1s", y, x0=be[0], dx=be[1] - be[0])
    for table, message in (
        ("", "empty"),
        ("A: GL(30) fwhm=1", "no position"),
        ("A: pos=285 fwhm=B; B: pos=286 fwhm=A", "circle"),
        ("A: pos=285 fwhm=C", "no component C"),
        ("A: pos=285 height=3", "the keys are"),
        ("A: pos=300", "outside"),
        ("A: pos=285[286,284]", "low to high"),
        ("A: LA(1.53,243,4) pos=285", "gauss="),
    ):
        refuses("xps_fit", message, spectrum=spectrum, components=table)
    refuses("xps_fit", "usable points", spectrum=spectrum, components="A: pos=285",
            region=[300, 310])
    refuses("xps_fit", "points", spectrum=spectrum, components="A: pos=285", average=200)


# --- Quantification --------------------------------------------------------------


def survey():
    be = np.linspace(200.0, 600.0, 4001)
    shape = parse_shape("GL(30)")
    c = shape.curve(be, 284.8, 1.5, 10000.0)
    o = shape.curve(be, 532.0, 1.6, 29300.0)
    n = shape.curve(be, 400.0, 1.4, 1800.0)
    y = 500.0 + 0.5 * (be - 200)
    for net in (c, n, o):
        y = y + net
    return be, y


def test_quantify_survey_and_narrow_scans():
    be, y = survey()
    regions = "C 1s: 278 294 rsf=1; N 1s: 394-406 rsf=1.8; O 1s: 524 to 540 rsf=2.93"
    out = run("quantify", spectra=[make("survey", y, x0=be[0], dx=be[1] - be[0])],
              regions=regions, background="Linear", average=1)
    rows = {row["name"]: row for row in out["values"]["regions"]}
    expected = {"C 1s": 10000 / 1, "N 1s": 1800 / 1.8, "O 1s": 29300 / 2.93}
    total = sum(expected.values())
    for name, part in expected.items():
        close(rows[name]["percent"], 100 * part / total, abs_=0.15, what=f"{name} at%")
    assert "background" in out["waves"] and len(out["waves"]["background"]) == len(y)
    # Narrow scans of each region, as kinetic energies: the same answers.
    hv = 1486.6
    scans, energies = [], []
    for low, high in ((278, 294), (394, 406), (524, 540)):
        inside = (be >= low - 1) & (be <= high + 1)
        scans.append(make(f"s{low}", y[inside]))
        energies.append(make(f"k{low}", hv - be[inside]))
    narrow = run("quantify", spectra=scans, energies=energies, regions=regions,
                 background="Linear", average=1, energy_axis="kinetic")["values"]
    for row in narrow["regions"]:
        close(row["percent"], rows[row["name"]]["percent"], abs_=1e-6, what=f"{row['name']} narrow")
    REPORT["quantify"] = ", ".join(f"{n} {r['percent']:.2f} %" for n, r in rows.items())
    refuses("quantify", "No spectrum covers", spectra=[make("survey", y, x0=be[0], dx=0.1)],
            regions="Si 2p: 95 110")
    refuses("quantify", "not a range", spectra=[make("survey", y)], regions="C 1s: 280")


# --- Running ---------------------------------------------------------------------


def run_all():
    """Runs every check; prints how each went and what it achieved. Returns the failures."""
    failures = []
    for name, check in sorted(globals().items()):
        if not name.startswith("test_") or not callable(check):
            continue
        try:
            check()
            print(f"ok    {name}")
        except Exception as error:  # noqa: BLE001  (every failure is reported)
            failures.append(f"{name}: {type(error).__name__}: {error}")
            print(f"FAIL  {name}: {type(error).__name__}: {error}")
    for name, text in REPORT.items():
        print(f"      {name}: {text}")
    return failures


if __name__ == "__main__":
    sys.exit(1 if run_all() else 0)
