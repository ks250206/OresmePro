"""Checks of the electrochemistry plugin on synthetic data whose answers are known.

Runs with any Python that has NumPy and SciPy, from the repository:

    python3 examples/plugins/electrochem/tests/test_electrochem.py
    uv run --no-project --with numpy --with scipy python -I examples/plugins/electrochem/tests/test_electrochem.py

or under pytest. The app's unit tests (src/app/plugins/electrochem.test.ts)
run it in Pyodide, the Python the plugin runs in. It imports the plugin SDK
(oresme_plugin) from src/sandbox/python, as the sandbox provides it.
"""

import inspect
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
SDK = os.path.normpath(os.path.join(PLUGIN, "..", "..", "..", "src", "sandbox", "python"))
for path in (PLUGIN, SDK):
    if path not in sys.path:
        sys.path.insert(0, path)

import numpy as np  # noqa: E402

import oresme_plugin  # noqa: E402
from oresme_plugin import PluginError, Wave  # noqa: E402

import electrochem  # noqa: E402, F401  (registers the actions)
from electrochem.common import FARADAY, GAS  # noqa: E402

ACTIONS = oresme_plugin._ACTIONS
#: What each check achieved, printed at the end: name -> text.
REPORT = {}


def make(name, values, unit="", dx=1.0):
    data = np.asarray(values, dtype=np.float64)
    data.flags.writeable = False
    return Wave(name, data, dx=dx, unit=unit)


def run(action, **arguments):
    """Runs an action as the sandbox does, and checks that its outcome can be handed back."""
    outcome = ACTIONS[action](**arguments)
    for role, value in outcome.get("waves", {}).items():
        oresme_plugin._output(role, value)
    json.dumps(oresme_plugin._plain(outcome.get("values", {})), allow_nan=False)
    return outcome


def close(actual, expected, rel=0.0, abs_=0.0, what=""):
    assert abs(actual - expected) <= abs_ + rel * abs(expected), (
        f"{what}: {actual!r} is not {expected!r} (rel {rel}, abs {abs_})"
    )


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
        for root, _, names in os.walk(os.path.join(PLUGIN, "electrochem"))
        for name in names
        if name.endswith(".py")
    }
    assert on_disk <= listed, sorted(on_disk - listed)


# --- Cyclic voltammetry ----------------------------------------------------------


def semi_derivative(values, h):
    """Grünwald–Letnikov half derivative of samples spaced by h (values[0] at t = 0)."""
    n = len(values)
    weights = np.empty(n)
    weights[0] = 1.0
    for k in range(1, n):
        weights[k] = weights[k - 1] * (k - 1.5) / k
    return np.convolve(values, weights)[:n] / np.sqrt(h)


def reversible_cv(E0=0.2, start=-0.2, vertex=0.6, rate=0.1, points=4000, n=1, T=298.15,
                  area=0.0707, conc=1e-6, D=1e-5):
    """A CV of a reversible (Nernstian) couple R ⇌ O + n e−, only R in solution at first.

    With equal diffusion coefficients the surface concentrations follow
    Nernst's equation, and the semi-integral of the current is
    nFA√D·C·θ/(1+θ) with θ = exp(nF(E−E0)/RT) (Oldham); the current is its
    half derivative. Units: V, V/s, cm², mol/cm³, cm²/s; current in A,
    anodic positive. Returns (E, i).
    """
    half = points // 2
    E = np.concatenate([np.linspace(start, vertex, half, endpoint=False),
                        np.linspace(vertex, start, points - half)])
    h = (vertex - start) / half / rate
    theta = np.exp(n * FARADAY * (E - E0) / (GAS * T))
    semi_integral = n * FARADAY * area * np.sqrt(D) * conc * theta / (1 + theta)
    return E, semi_derivative(semi_integral, h)


def randles_sevcik(n=1, T=298.15, area=0.0707, conc=1e-6, D=1e-5, rate=0.1):
    """The peak current of a reversible CV: 0.4463 nFAC √(nFvD/RT)."""
    return 0.4463 * n * FARADAY * area * conc * np.sqrt(n * FARADAY * rate * D / (GAS * T))


def test_cv_reversible_couple():
    E, i = reversible_cv()
    out = run("cv_peaks", current=make("i", i, "A"), potential=make("E", E, "V"))
    v = out["values"]
    # Theory of a reversible wave at 25 °C: Epa − E0 = 1.109 RT/F = 28.5 mV,
    # ΔEp ≈ 57.4 mV for a switching potential 400 mV past E1/2 (Nicholson & Shain).
    # The simulation itself lags by about a quarter of a step (0.1 mV).
    close(v["Epa"] - 0.2, 1.109 * GAS * 298.15 / FARADAY, abs_=0.3e-3, what="Epa − E0")
    close(v["E_half"], 0.2, abs_=0.4e-3, what="E1/2")
    close(v["dEp"], 0.0574, abs_=0.6e-3, what="ΔEp")
    close(v["ipa"], randles_sevcik(), rel=0.01, what="ipa vs Randles–Ševčík")
    assert not v["warnings"]
    REPORT["cv reversible"] = (
        f"Epa−E0 {1e3 * (v['Epa'] - 0.2):.2f} mV (theory 28.49), ΔEp {1e3 * v['dEp']:.2f} mV, "
        f"E1/2−E0 {1e3 * (v['E_half'] - 0.2):+.2f} mV, ipa/Randles–Ševčík {v['ipa'] / randles_sevcik():.4f}"
    )


def gaussian_cv(noise=0.0, cycles=2, seed=1):
    """A CV of two Gaussian peaks on sloping, capacitive baselines; true values known exactly."""
    rng = np.random.default_rng(seed)
    up = np.linspace(-0.3, 0.7, 501)
    down = up[::-1][1:]
    one = np.concatenate([up, down[:-1]])
    E = np.concatenate([one] * cycles + [up[:1]])
    going_up = np.append(np.diff(E) > 0, True)
    # Capacitive offset ±2 µA with a slope, plus peaks of 10 µA at 0.25 V and 8 µA at 0.17 V.
    base = np.where(going_up, 2e-6 + 3e-6 * E, -2e-6 + 1e-6 * E)
    peak = np.where(going_up, 10e-6 * np.exp(-((E - 0.25) / 0.05) ** 2 / 2),
                    -8e-6 * np.exp(-((E - 0.17) / 0.05) ** 2 / 2))
    i = base + peak + noise * rng.standard_normal(len(E))
    return E, i


def test_cv_baselines_and_cycles():
    E, i = gaussian_cv()
    out = run("cv_peaks", current=make("i", i, "A"), potential=make("E", E, "V"), cycle=2,
              anodic_baseline=[-0.3, -0.05], cathodic_baseline=[0.7, 0.45])
    v = out["values"]
    close(v["Epa"], 0.25, abs_=1e-5, what="Epa")
    close(v["Epc"], 0.17, abs_=1e-5, what="Epc")
    close(v["ipa"], 10e-6, rel=1e-3, what="ipa")
    close(v["ipc"], 8e-6, rel=1e-3, what="ipc")
    close(v["ratio"], 1.25, rel=2e-3, what="ratio")
    close(v["dEp"], 0.08, abs_=2e-5, what="ΔEp")
    close(v["E_half"], 0.21, abs_=1e-5, what="E1/2")
    assert v["sweeps"] == 4
    # Markers sit on the curve; the baseline wave is drawn on the chosen cycle only.
    marks = out["waves"]["peak_i"].data
    close(marks[0], 2e-6 + 3e-6 * 0.25 + 10e-6, rel=1e-3, what="marker of the anodic peak")
    drawn = out["waves"]["baseline"].data
    assert len(drawn) == len(E) and np.isnan(drawn[:500]).all() and np.isfinite(drawn).sum() > 100
    # Without baselines the heights are from zero.
    plain = run("cv_peaks", current=make("i", i, "A"), potential=make("E", E, "V"))["values"]
    close(plain["ipa"], 2e-6 + 3e-6 * 0.25 + 10e-6, rel=2e-3, what="ipa from zero")

    # The other sign convention, with the potential in mV: the same answers.
    flipped = run("cv_peaks", current=make("i", -i, "A"), potential=make("E", 1e3 * E, "mV"),
                  anodic_baseline=[-0.3, -0.05], cathodic_baseline=[0.7, 0.45],
                  convention="cathodic positive")["values"]
    close(flipped["Epa"], 0.25, abs_=1e-5, what="Epa (cathodic positive, mV)")
    close(flipped["ipc"], 8e-6, rel=1e-3, what="ipc (cathodic positive, mV)")

    # With noise (2 % of the peak), the parabola keeps the peak potential within a millivolt.
    E, i = gaussian_cv(noise=0.2e-6)
    noisy = run("cv_peaks", current=make("i", i, "A"), potential=make("E", E, "V"),
                anodic_baseline=[-0.3, -0.05], cathodic_baseline=[0.7, 0.45])["values"]
    close(noisy["Epa"], 0.25, abs_=1e-3, what="Epa with noise")
    close(noisy["Epc"], 0.17, abs_=1e-3, what="Epc with noise")
    close(noisy["ipa"], 10e-6, rel=0.03, what="ipa with noise")
    REPORT["cv gaussian"] = (
        f"exact: Epa err {abs(v['Epa'] - 0.25) * 1e6:.2g} µV, ipa rel err {abs(v['ipa'] / 10e-6 - 1):.1g}; "
        f"2 % noise: Epa err {abs(noisy['Epa'] - 0.25) * 1e3:.2f} mV, ipa rel err {abs(noisy['ipa'] / 10e-6 - 1):.3f}"
    )


def test_cv_refuses_what_it_cannot_do():
    E, i = gaussian_cv(cycles=1)
    for arguments, message in (
        ({"cycle": 3}, "no cycle 3"),
        ({"anodic_baseline": [0.9, 1.0]}, "fewer than two points"),
        ({"window": [0.1, 0.1]}, "must not be empty"),
    ):
        try:
            run("cv_peaks", current=make("i", i), potential=make("E", E), **arguments)
        except PluginError as error:
            assert message in str(error), (message, str(error))
        else:
            raise AssertionError(f"no error for {arguments}")


# --- Tafel -----------------------------------------------------------------------


def butler_volmer(eta, j0, alpha_a, alpha_c, T=298.15):
    f = FARADAY / (GAS * T)
    return j0 * (np.exp(alpha_a * f * eta) - np.exp(-alpha_c * f * eta))


def test_tafel_recovers_slope_and_exchange_current():
    E_eq = 0.45
    E = np.linspace(E_eq - 0.35, E_eq + 0.35, 701)
    i = butler_volmer(E - E_eq, 2e-6, 0.5, 0.6) * 0.5  # an electrode of 0.5 cm²
    anodic = run("tafel", current=make("i", i, "A"), potential=make("E", E, "V"),
                 e_from=E_eq + 0.15, e_to=E_eq + 0.30, e_eq=E_eq, area=0.5)["values"]
    slope = np.log(10) * GAS * 298.15 / (0.5 * FARADAY) * 1e3  # 118.3 mV/dec
    # The other branch adds less than 0.4 % to the current at η = 0.15 V.
    close(anodic["slope_mV_per_dec"], slope, rel=2e-3, what="anodic slope")
    close(anodic["j0"], 2e-6, rel=1e-2, what="j0 (anodic)")
    close(anodic["alpha"], 0.5, rel=2e-3, what="alpha (anodic)")
    assert anodic["branch"] == "anodic"
    cathodic = run("tafel", current=make("i", i, "A"), potential=make("E", E, "V"),
                   e_from=E_eq - 0.30, e_to=E_eq - 0.15, e_eq=E_eq, area=0.5)["values"]
    close(cathodic["slope_mV_per_dec"], -slope / 1.2, rel=2e-3, what="cathodic slope")
    close(cathodic["j0"], 2e-6, rel=1e-2, what="j0 (cathodic)")
    assert cathodic["branch"] == "cathodic"

    # On a pure Tafel line with 2 % noise, the truth is within 3 σ of what is reported.
    rng = np.random.default_rng(7)
    eta = np.linspace(0.1, 0.3, 81)
    j = 1e-5 * 10 ** (eta / 0.060) * (1 + 0.02 * rng.standard_normal(len(eta)))
    noisy = run("tafel", current=make("j", j), potential=make("eta", eta), e_from=0.1, e_to=0.3)
    v = noisy["values"]
    assert abs(v["slope_mV_per_dec"] - 60) < 3 * v["slope_mV_per_dec_sigma"], v
    assert abs(v["j0"] - 1e-5) < 3 * v["j0_sigma"], v
    assert 0 < v["slope_mV_per_dec_sigma"] < 1
    fit = noisy["waves"]["fit"].data
    close(fit[0], 1e-5 * 10 ** (0.1 / 0.060), rel=0.02, what="fitted line")
    REPORT["tafel"] = (
        f"Butler–Volmer: slope rel err {abs(anodic['slope_mV_per_dec'] / slope - 1):.1e}, "
        f"j0 rel err {abs(anodic['j0'] / 2e-6 - 1):.1e}; 2 % noise: "
        f"{v['slope_mV_per_dec']:.2f} ± {v['slope_mV_per_dec_sigma']:.2f} mV/dec (true 60)"
    )


# --- Impedance -------------------------------------------------------------------

TRUE = {
    "R(RC)": {"R0": 12.0, "R1": 85.0, "C1": 2.2e-5},
    "R(RQ)": {"R0": 8.0, "R1": 150.0, "Q1": 4e-5, "n1": 0.85},
    "Randles": {"R0": 20.0, "R1": 100.0, "Q1": 2e-5, "n1": 0.9, "sigma": 50.0},
}


def spectrum(model, noise=0.0, seed=3):
    """Z over 100 kHz to 10 mHz, 10 points a decade, with proportional noise on each part."""
    names, _, impedance = electrochem.eis.MODELS[model]
    f = np.logspace(5, -2, 71)
    Z = impedance(np.array([TRUE[model][name] for name in names]), 2 * np.pi * f)
    rng = np.random.default_rng(seed)
    Z = Z.real * (1 + noise * rng.standard_normal(len(f))) + 1j * Z.imag * (
        1 + noise * rng.standard_normal(len(f)))
    return f, Z


def test_eis_recovers_every_model_exactly():
    worst = {}
    for model in TRUE:
        f, Z = spectrum(model)
        out = run("eis_fit", frequency=make("f", f, "Hz"), zre=make("zre", Z.real, "Ω"),
                  zim=make("zim", -Z.imag, "Ω"), model=model)
        v = out["values"]
        errors = [abs(v[name] / value - 1) for name, value in TRUE[model].items()]
        assert max(errors) < 1e-6, (model, v)
        assert v["result"]["converged"], v["result"]
        assert np.allclose(out["waves"]["zre_fit"].data, Z.real, rtol=1e-6)
        assert np.allclose(out["waves"]["zim_fit"].data, -Z.imag, rtol=1e-6)
        worst[model] = max(errors)
    REPORT["eis exact"] = ", ".join(f"{m} {e:.0e}" for m, e in worst.items())


def test_eis_with_noise_and_conventions():
    lines = []
    for model in TRUE:
        f, Z = spectrum(model, noise=0.005)
        # Z″ as measured (negative), with unit weighting this time for R(RC).
        weighting = "unit" if model == "R(RC)" else "modulus"
        out = run("eis_fit", frequency=make("f", f), zre=make("zre", Z.real),
                  zim=make("zim", Z.imag), model=model, imaginary="Z''", weighting=weighting)
        v = out["values"]
        for name, value in TRUE[model].items():
            # Within 4 σ, and σ small: the uncertainties mean something.
            assert abs(v[name] - value) < 4 * v[f"{name}_sigma"], (model, name, v)
            assert v[f"{name}_sigma"] < 0.1 * value, (model, name, v)
        assert out["waves"]["zim_fit"].data[-1] < 0  # handed back as given: Z″ itself
        if weighting == "modulus":
            # Relative residuals of 0.5 %: χ²/ν near 0.005².
            assert 0.5 < v["chisq_reduced"] / 0.005**2 < 2, v["chisq_reduced"]
        lines.append(f"{model} worst |err|/σ "
                     f"{max(abs(v[n] - t) / v[n + '_sigma'] for n, t in TRUE[model].items()):.2f}")
    REPORT["eis 0.5 % noise"] = ", ".join(lines)


def test_eis_frequency_range_and_refusals():
    f, Z = spectrum("R(RC)")
    out = run("eis_fit", frequency=make("f", f), zre=make("zre", Z.real), zim=make("zim", -Z.imag),
              model="R(RC)", f_min=1.0, f_max=1e4)
    assert out["values"]["frequencies"] == 41
    close(out["values"]["R1"], 85.0, rel=1e-6, what="R1 on part of the spectrum")
    # The fitted curve covers every measured frequency, inside the range or not.
    assert np.isfinite(out["waves"]["zre_fit"].data).all()
    for arguments, message in (
        ({"model": "RC"}, "Unknown model"),
        ({"f_min": 1e6}, "needs more than"),
    ):
        try:
            run("eis_fit", frequency=make("f", f), zre=make("zre", Z.real),
                zim=make("zim", -Z.imag), **arguments)
        except PluginError as error:
            assert message in str(error), (message, str(error))
        else:
            raise AssertionError(f"no error for {arguments}")


# --- EIS: circuits written as text ------------------------------------------------

#: Circuits and their true parameters, in the order the circuit names them.
CIRCUITS = {
    "R0-p(R1,C1)": [12.0, 85.0, 2.2e-5],
    "R0-p(R1-W1,CPE1)": [20.0, 100.0, 50.0, 2e-5, 0.9],
    "R0-p(R1,CPE1)-p(R2,CPE2)": [5.0, 40.0, 1e-6, 0.92, 300.0, 1e-3, 0.8],
    "L0-R0-p(R1,CPE1)-Wo1": [2e-6, 10.0, 120.0, 3e-5, 0.88, 80.0, 20.0],
    "R0-p(R1-Ws1,C1)": [10.0, 100.0, 200.0, 5.0, 1e-5],
}


def circuit_spectrum(text, noise=0.0, seed=5):
    circuit = electrochem.circuit.Circuit(text)
    f = np.logspace(5, -2, 71)
    Z = circuit.impedance(CIRCUITS[text], 2 * np.pi * f)
    rng = np.random.default_rng(seed)
    Z = Z.real * (1 + noise * rng.standard_normal(len(f))) + 1j * Z.imag * (
        1 + noise * rng.standard_normal(len(f)))
    return f, Z


def test_circuits_are_read_and_match_the_models():
    Circuit = electrochem.circuit.Circuit
    assert Circuit("R0-p(R1,CPE1)-W1").names == ["R0", "R1", "Q1", "n1", "W1"]
    assert Circuit(" R_s - p( R_ct , Q_dl ) ").names == ["R_s", "R_ct", "Q_dl", "n_dl"]
    assert Circuit("L0-p(R1-Wo1,C1)-Ws2").names == [
        "L0", "R1", "Wo1_Z0", "Wo1_tau", "C1", "Ws2_Z0", "Ws2_tau"]
    # The fixed models are circuits like any other.
    w = 2 * np.pi * np.logspace(5, -2, 30)
    for text, model in (("R0-p(R1,C1)", "R(RC)"), ("R0-p(R1,CPE1)", "R(RQ)")):
        names, _, impedance = electrochem.eis.MODELS[model]
        p = [TRUE[model][name] for name in names]
        assert np.allclose(Circuit(text).impedance(p, w), impedance(p, w), rtol=1e-12), text
    t = TRUE["Randles"]
    p = [t["R0"], t["R1"], t["sigma"], t["Q1"], t["n1"]]
    assert np.allclose(Circuit("R0-p(R1-W1,CPE1)").impedance(p, w),
                       electrochem.eis.z_randles(list(t.values()), w), rtol=1e-12)
    for text, message in (
        ("", "empty"),
        ("R0-Rct", "does not start with a digit or _"),
        ("R0-R0", "R0 twice"),
        ("CPE1-Q1", "Q1 twice"),
        ("R0-p(R1)", "one branch"),
        ("R0-p(R1,C1", "missing )"),
        ("R0-X1", "no element"),
        ("R0-p(R1,C1))", "unexpected"),
    ):
        try:
            Circuit(text)
        except PluginError as error:
            assert message in str(error), (text, message, str(error))
        else:
            raise AssertionError(f"no error for {text!r}")


def test_eis_circuit_recovers_every_circuit_from_its_own_guess():
    worst = {}
    for text, true in CIRCUITS.items():
        f, Z = circuit_spectrum(text)
        out = run("eis_circuit", frequency=make("f", f, "Hz"), zre=make("zre", Z.real, "Ω"),
                  zim=make("zim", -Z.imag, "Ω"), circuit=text)
        v = out["values"]
        names = v["parameters"]
        errors = [abs(v[name] / value - 1) for name, value in zip(names, true)]
        assert max(errors) < 1e-5, (text, {name: v[name] for name in names})
        assert v["result"]["converged"], v["result"]
        assert np.allclose(out["waves"]["zim_fit"].data, -Z.imag, rtol=1e-5)
        worst[text] = max(errors)
    REPORT["eis circuits exact"] = ", ".join(f"{t} {e:.0e}" for t, e in worst.items())


def test_eis_circuit_with_noise_and_a_guess():
    text = "R0-p(R1,CPE1)-p(R2,CPE2)"
    f, Z = circuit_spectrum(text, noise=0.005)
    true = CIRCUITS[text]
    out = run("eis_circuit", frequency=make("f", f), zre=make("zre", Z.real),
              zim=make("zim", Z.imag), circuit=text, imaginary="Z''")
    v = out["values"]
    for name, value in zip(v["parameters"], true):
        assert abs(v[name] - value) < 4 * v[f"{name}_sigma"], (name, v)
    # Each point's two weighted residuals add up to about noise² (Z′² + Z″² = |Z|²),
    # over two residuals a point: χ²/ν near noise²/2.
    assert 0.25 < v["chisq_reduced"] / 0.005**2 < 1, v["chisq_reduced"]
    REPORT["eis circuit 0.5 % noise"] = (
        f"{text} worst |err|/σ "
        f"{max(abs(v[n] - t) / v[n + '_sigma'] for n, t in zip(v['parameters'], true)):.2f}")
    # Starting values given: the same answer.
    given = run("eis_circuit", frequency=make("f", f), zre=make("zre", Z.real),
                zim=make("zim", Z.imag), circuit=text, imaginary="Z''",
                guess=[4, 50, 2e-6, 0.9, 200, 2e-3, 0.85])["values"]
    for name in v["parameters"]:
        close(given[name], v[name], rel=1e-4, what=name)
    for arguments, message in (
        ({"guess": [1, 2, 3]}, "the circuit has 7 parameters"),
        ({"guess": [4, -50, 2e-6, 0.9, 200, 2e-3, 0.85]}, "R1 must be positive"),
        ({"guess": [4, 50, 2e-6, 1.5, 200, 2e-3, 0.85]}, "n1 must be between"),
        ({"circuit": "R0-p(R1,C1)", "f_max": 1e-2}, "needs more than"),
    ):
        try:
            run("eis_circuit", frequency=make("f", f), zre=make("zre", Z.real),
                zim=make("zim", Z.imag), **{"circuit": text, **arguments})
        except PluginError as error:
            assert message in str(error), (message, str(error))
        else:
            raise AssertionError(f"no error for {arguments}")


def test_circuit_diagrams_read_back_as_the_circuits_they_draw():
    """A circuit laid out as a diagram reads back as itself; one that is not a circuit says why."""
    from electrochem.diagram import circuit_of, diagram_of, same_circuit
    for text in ("R0-p(R1,C1)", "R0-p(R1-W1,CPE1)", "R0-p(R1,CPE1)-p(R2,CPE2)",
                 "L0-R0-p(R1,CPE1)-Wo1", "R0-p(R1-p(R2,C2),C1)", "R0", "p(R1,C1,L1)"):
        assert same_circuit(circuit_of(diagram_of(text)), text), text
    assert same_circuit("p(R1,C1)", "p(C1,R1)") and not same_circuit("R0-C1", "R0-p(R1,C1)")

    def wired(text, change):
        diagram = diagram_of(text)
        change(diagram)
        return diagram

    def add(diagram, *nodes, edges=()):
        diagram["nodes"].extend({"id": name, "kind": kind, "x": 0, "y": 0} for name, kind in nodes)
        diagram["edges"].extend({"from": list(a), "to": list(b)} for a, b in edges)

    # Drawn in parallel with R1 and C1: a third branch, written so.
    third = wired("R0-p(R1,C1)", lambda d: add(d, ("W1", "W"),
                                                edges=[(("W1", "a"), ("C1", "a")), (("W1", "b"), ("C1", "b"))]))
    assert same_circuit(circuit_of(third), "R0-p(R1,C1,W1)")
    # Put in series after the end's last element, the end wired to it instead.
    def series(d):
        d["edges"] = [e for e in d["edges"] if e["to"] != ["end", "p"]]
        add(d, ("L0", "L"), edges=[(("R1", "b"), ("L0", "a")), (("L0", "b"), ("end", "p"))])
    assert same_circuit(circuit_of(wired("R0-p(R1,C1)", series)), "R0-p(R1,C1)-L0")
    cases = [
        (lambda d: add(d, ("R2", "R")), "R2 has an end wired to nothing"),
        (lambda d: d.update(edges=[e for e in d["edges"] if e["to"] != ["end", "p"]]),
         "Nothing is wired to the end"),
        (lambda d: add(d, ("R5", "C")), "not the name of a C"),
        (lambda d: add(d, edges=[(("start", "p"), ("end", "p"))]), "straight to the end"),
        (lambda d: d["nodes"].pop(0), "lost its start"),
    ]
    # A bridge: R2 across the middles of two branches of two elements each.
    def bridge(d):
        d["nodes"] = [n for n in d["nodes"] if n["id"] in ("start", "end")]
        add(d, ("R1", "R"), ("R2", "R"), ("R3", "R"), ("R4", "R"), ("C1", "C"))
        d["edges"] = []
        add(d, edges=[(("start", "p"), ("R1", "a")), (("start", "p"), ("C1", "a")),
                      (("R1", "b"), ("R3", "a")), (("C1", "b"), ("R4", "a")),
                      (("R3", "b"), ("end", "p")), (("R4", "b"), ("end", "p")),
                      (("R2", "a"), ("R1", "b")), (("R2", "b"), ("C1", "b"))])
    cases.append((bridge, "cannot be taken apart"))
    for change, message in cases:
        try:
            circuit_of(wired("R0-p(R1,C1)", change))
        except PluginError as error:
            assert message in str(error), (message, str(error))
        else:
            raise AssertionError(f"no error for {message}")


# --- Running ---------------------------------------------------------------------


def test_eis_view_draws_guesses_and_takes_a_fit_back():
    Circuit = electrochem.circuit.Circuit
    """The view eis: it guesses from the spectrum, draws the circuit, and takes in what eis_circuit found."""
    view = ACTIONS["view:eis"]
    f = np.logspace(-1, 5, 60)
    truth = np.array([10.0, 100.0, 1e-5, 0.9])
    Z = Circuit("R0-p(R1,CPE1)").impedance(truth, 2 * np.pi * f)
    paths = json.dumps({"w0": "frequency", "w1": "zre", "w2": "zim"})
    given = {"w0": make("f", f), "w1": make("re", Z.real), "w2": make("im", -Z.imag)}

    def call(state, event, with_waves=True):
        outcome = view(json.dumps(state), json.dumps(event), paths if with_waves else "{}",
                       **(given if with_waves else {}))
        for role, value in outcome["waves"].items():
            oresme_plugin._output(role, value)
        return outcome, json.loads(outcome["values"]["state"]), json.loads(outcome["values"]["ui"])

    outcome, state, layout = call(None, {"type": "open", "last": None}, with_waves=False)
    assert layout["version"] == 1 and outcome["waves"] == {}
    assert state["circuit"] == "R0-p(R1,CPE1)" and state["params"][0]["value"] is None

    state.update(frequency="f", zre="re", zim="im")
    outcome, state, _ = call(state, {"type": "change", "paths": ["frequency", "zre", "zim"]})
    assert [row["name"] for row in state["params"]] == ["R0", "R1", "Q1", "n1"]
    assert all(row["value"] is not None for row in state["params"]) and state["guess"]
    assert {"data_re", "data_im", "model_re", "model_im", "model_mod"} <= set(outcome["waves"])

    # An edited value is drawn as it is; a circuit changed keeps the values of the same names.
    state["params"][0]["value"] = 50.0
    outcome, state, _ = call(state, {"type": "change", "paths": ["params.0.value"]})
    assert abs(outcome["waves"]["model_re"].data[-1] - 50.0) < 1.0
    state["circuit"] = "R0-p(R1,C1)"
    outcome, state, _ = call(state, {"type": "change", "paths": ["circuit"]})
    assert [row["name"] for row in state["params"]] == ["R0", "R1", "C1"]
    assert state["params"][0]["value"] == 50.0

    # Fitted with eis_circuit: the values found go into the table, with their σ.
    state["circuit"] = "R0-p(R1,CPE1)"
    _, state, _ = call(state, {"type": "change", "paths": ["circuit"]})
    fit = run("eis_circuit", frequency=given["w0"], zre=given["w1"], zim=given["w2"],
              circuit=state["circuit"], guess=state["guess"])
    args = {key: state[key] for key in ("frequency", "zre", "zim", "circuit", "imaginary", "guess")}
    done = {"type": "done", "id": "eis_circuit", "ok": True, "result": "Plugin0", "args": args,
            "values": oresme_plugin._plain(fit["values"])}
    # Had a value been changed while it was fitted, the values found would not go into the table.
    edited = json.loads(json.dumps(state))
    edited["params"][0]["value"] = 12.0
    outcome, kept, _ = call(edited, done)
    assert kept["params"][0]["value"] == 12.0 and "changed while it was fitted" in outcome["values"]["message"]
    _, state, _ = call(state, done)
    for row, value in zip(state["params"], truth):
        close(row["value"], value, rel=1e-6, what=row["name"])
    assert "Plugin0" in state["report"]
    # A circuit that cannot be read is said, and nothing breaks.
    state["circuit"] = "R0-p(R1"
    outcome, _, _ = call(state, {"type": "change", "paths": ["circuit"]})
    assert outcome["values"]["message"]

    # The diagram: drawn from the circuit, and a circuit drawn in it is the circuit.
    state["circuit"] = "R0-p(R1,CPE1)"
    _, state, layout = call(state, {"type": "change", "paths": ["circuit"]})
    assert {node["id"] for node in state["diagram"]["nodes"]} == {"start", "R0", "R1", "CPE1", "end"}
    assert "nodes" in json.dumps(layout)
    state["diagram"]["nodes"].append({"id": "W1", "kind": "W", "x": 0, "y": 0})
    # W1 put after R1 in its branch: R1 no longer wired to CPE1 and the end, W1 is.
    state["diagram"]["edges"] = [
        {"from": ["W1", "b"] if edge["from"] == ["R1", "b"] else edge["from"],
         "to": ["W1", "b"] if edge["to"] == ["R1", "b"] else edge["to"]}
        for edge in state["diagram"]["edges"]
    ] + [{"from": ["R1", "b"], "to": ["W1", "a"]}]
    outcome, state, _ = call(state, {"type": "change", "paths": ["diagram"]})
    assert state["circuit"] == "R0-p(R1-W1,CPE1)", state["circuit"]
    assert [row["name"] for row in state["params"]] == ["R0", "R1", "W1", "Q1", "n1"]
    # One being drawn, not yet a circuit: said, and the circuit stays.
    state["diagram"]["nodes"].append({"id": "C2", "kind": "C", "x": 0, "y": 0})
    outcome, state, _ = call(state, {"type": "change", "paths": ["diagram"]})
    assert state["circuit"] == "R0-p(R1-W1,CPE1)" and "C2 has an end" in outcome["values"]["message"]
    assert any(node["id"] == "C2" for node in state["diagram"]["nodes"])

    # Opened again, it starts from the last fit kept.
    last = {"action": "eis_circuit", "result": "Plugin0",
            "inputs": {"frequency": "f", "zre": "re", "zim": "im"},
            "params": {"circuit": "R0-p(R1,CPE1)"}, "names": ["R0", "R1", "Q1", "n1"],
            "coef": truth.tolist(), "sigma": [0.0] * 4}
    _, state, _ = call(None, {"type": "open", "last": last}, with_waves=False)
    assert state["frequency"] == "f" and state["params"][1]["value"] == 100.0
    # Where it was left, when the experiment kept that, comes before the last fit.
    left = dict(state, circuit="R0-p(R1,C1)", params=[{"name": "R0", "value": 7.0}], extra=1)
    saved = {"state": left, "version": "0.2.0"}
    _, state, _ = call(None, {"type": "open", "last": last, "saved": saved}, with_waves=False)
    assert state["circuit"] == "R0-p(R1,C1)" and state["params"][0]["value"] == 7.0
    assert "extra" not in state


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
