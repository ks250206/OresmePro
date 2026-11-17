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
    # Views are registered beside the actions, as view:<name>.
    views = [f"view:{item['name']}" for item in manifest.get("editors", []) if item["kind"] == "view"]
    assert sorted(ACTIONS) == sorted([item["name"] for item in manifest["actions"]] + views)
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


#: C1S_TABLE as the XPS Peak Fitting window gives it: a list of dicts with CasaXPS's constraints.
C1S_LIST = [
    {"name": "C-C", "shape": "GL(30)", "position": 284.6, "fwhm": 1.4, "area": 25000.0},
    {"name": "C-O", "shape": "GL(30)", "position": 286.1, "fwhm": 1.4, "area": 8000.0,
     "constraints": {"position": "A+1.5", "fwhm": "A"}},
    {"name": "O-C=O", "shape": "GL(30)", "position": 288.6, "fwhm": 1.2, "area": 3000.0,
     "constraints": {"position": "288, 290"}},
]


def test_fit_from_the_windows_list():
    """The window's list of dicts fits as the text table does, and says what it found for the window."""
    be, y = c1s_spectrum()
    spectrum = make("c1s", y, x0=be[0], dx=be[1] - be[0])
    out = run("xps_fit", spectrum=spectrum, components=C1S_LIST, average=1)
    v = out["values"]
    for item, truth in zip(v["items"], C1S.values()):
        close(item["position"], truth["pos"], rel=1e-6, what="position")
        close(item["area"], truth["area"], rel=1e-6, what="area")
    assert v["components"][1]["constraints"]["pos"] == "A+1.5"
    report = v["report"]
    assert len(report["rows"]) == 3 and len(report["rows"][0]) == len(report["columns"])
    assert report["rows"][0][3].startswith("284.8"), report["rows"][0]
    # A start outside its limits begins at the nearest limit; "fixed" holds the value given.
    held = [dict(C1S_LIST[0], constraints={"fwhm": "fixed"}, fwhm=1.1),
            dict(C1S_LIST[2], position=295.0)]
    out = run("xps_fit", spectrum=spectrum, components=held, average=1, region=[282, 292])
    assert out["values"]["items"][0]["fwhm"] == 1.1
    assert out["values"]["components"][0]["fwhm_sigma"] == 0


def test_preview_draws_without_fitting():
    """xps_preview gives the window what to draw: the region, background, each component, envelope."""
    be, y = c1s_spectrum()
    spectrum = make("c1s", y, x0=be[0], dx=be[1] - be[0])
    out = run("xps_preview", spectrum=spectrum, components=C1S_LIST, region=[281, 293])
    waves, v = out["waves"], out["values"]
    assert "result" not in v and "graph" not in out
    count = len(waves["x"].data)
    assert 230 < count < 250 and len(waves["all_x"].data) == 281
    assert {"data", "background", "fit", "residual", "item0", "item1", "item2"} <= set(waves)
    assert v["errors"] == [] and v["problem"] is None
    first, second = v["items"][0], v["items"][1]
    close(second["values"]["position"], first["values"]["position"] + 1.5, abs_=1e-12, what="tie")
    assert second["tied"] == ["position", "fwhm"] and first["tied"] == []
    position, top, base = first["peak"]
    assert position == 284.6 and top > base
    total = waves["background"].data + sum(waves[f"item{k}"].data for k in range(3))
    assert np.allclose(waves["fit"].data, total)
    # A constraint that is wrong is said about its component and field, and the data still drawn.
    broken = [C1S_LIST[0], dict(C1S_LIST[1], constraints={"position": "D+1"})]
    out = run("xps_preview", spectrum=spectrum, components=broken)
    assert out["values"]["errors"][0]["item"] == 1
    assert out["values"]["errors"][0]["field"] == "position"
    assert "no component D" in out["values"]["errors"][0]["message"]
    assert "data" in out["waves"] and "fit" not in out["waves"]
    # No components yet: only the data and its background.
    out = run("xps_preview", spectrum=spectrum, components=[])
    assert out["values"]["items"] == [] and "fit" not in out["waves"]


def test_tougaard_background():
    """A Tougaard background is found again from data made of a peak and its own losses."""
    from xps.common import _tougaard

    be = np.linspace(280.0, 310.0, 601)
    net = parse_shape("GL(30)").curve(be, 285.0, 1.2, 5000.0)
    # The data: the peak, and the electrons lost from all that is above the low end, B·∫T/(C+T²)²·(y−100).
    B = 900.0
    y = 100.0 + net
    for _ in range(200):
        y = 100.0 + net + B * _tougaard(be, y - 100.0)
    truth = 100.0 + B * _tougaard(be, y - 100.0)
    made = background(be, y, "Tougaard", 1)
    worst = float(np.max(np.abs(made - truth)))
    assert worst < 1e-6 * (truth[-1] - truth[0]), worst
    # By the same arithmetic, in reverse order of energies.
    close(background(be[::-1], y[::-1], "Tougaard", 1)[0], truth[-1], rel=1e-9, what="reversed")
    REPORT["tougaard"] = f"max error {worst:.1e} on a rise of {truth[-1] - truth[0]:.0f}"


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


def test_quant_view_works_out_regions_as_they_are_dragged():
    """The view quant: regions added by a click, dragged by their bounds, and quantified."""
    be, y = survey()
    view = ACTIONS["view:quant"]
    spectrum = make("survey", y, x0=be[0], dx=be[1] - be[0])

    def call(state, event, with_waves=True):
        paths = json.dumps({"w0": "spectra.0.y"} if with_waves else {})
        outcome = view(json.dumps(state), json.dumps(event), paths,
                       **({"w0": spectrum} if with_waves else {}))
        for role, value in outcome["waves"].items():
            oresme_plugin._output(role, value)
        return outcome, json.loads(outcome["values"]["state"]), json.loads(outcome["values"]["ui"])

    _, state, layout = call(None, {"type": "open", "last": None}, with_waves=False)
    assert state["regions"] == [] and layout["version"] == 1
    state["spectra"][0]["y"] = "survey"
    outcome, state, _ = call(state, {"type": "change", "paths": ["spectra.0.y"]})
    assert "Click the spectrum" in outcome["values"]["message"]
    assert {"be", "counts"} <= set(outcome["waves"])

    # Added where the spectrum was clicked, then named and moved as the window does.
    outcome, state, layout = call(state, {"type": "command", "id": "add_region", "x": 286.0})
    assert state["regions"][0]["low"] == 282.0 and state["regions"][0]["high"] == 290.0
    plot = next(part for part in _parts(layout["body"]) if part["type"] == "plot")
    assert [h["bind_x"] for h in plot["handles"]] == ["regions.0.low", "regions.0.high"]
    state["regions"][0].update(name="C 1s", low=278, high=294)
    state["regions"] += [{"name": "N 1s", "low": 394, "high": 406, "rsf": 1.8},
                         {"name": "O 1s", "low": 524, "high": 540}]
    state["background"], state["average"] = "Linear", 1
    outcome, state, _ = call(state, {"type": "change", "paths": ["regions"]})
    # O 1s, given no RSF, takes Scofield's; the at. % are those of the action itself.
    assert state["regions"][2]["rsf"] == 2.93
    direct = run("quantify", spectra=[spectrum], regions=state["text"], background="Linear",
                 average=1)["values"]["regions"]
    for row, expected in zip(state["regions"], direct):
        close(row["percent"], expected["percent"], abs_=1e-9, what=row["name"])
    assert "bg" in outcome["waves"] and state["names"] == ["survey"] and state["energies"] is None
    button = next(part for part in _parts(layout["body"]) if part.get("action") == "quantify")
    assert button["args"]["regions"] == {"$bind": "text"}

    # Kept by the action: the window says so, and opened again starts from it.
    done = {"type": "done", "id": "quantify", "ok": True, "result": "Plugin0", "args": {},
            "values": {}}
    _, state, _ = call(state, done)
    assert "Plugin0" in state["report"]
    last = {"action": "quantify", "result": "Plugin0", "inputs": {"spectra": ["survey"]},
            "params": {"regions": state["text"], "background": "Linear", "average": 1}}
    _, again, _ = call(None, {"type": "open", "last": last}, with_waves=False)
    assert [row["name"] for row in again["regions"]] == ["C 1s", "N 1s", "O 1s"]
    assert again["spectra"] == [{"y": "survey", "x": None}] and again["background"] == "Linear"


def _parts(node):
    yield node
    for child in node.get("children", []):
        yield from _parts(child)
    for tab in node.get("tabs", []):
        yield from _parts(tab["body"])
    if "body" in node:
        yield from _parts(node["body"])


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
