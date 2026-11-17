"""The view eis: an equivalent circuit fitted to an impedance spectrum, in a window of its own.

Built only of the application's parts (see docs/design/plugin-views.md):
the spectrum's waves and the circuit at the top; Nyquist and Bode plots of
the data and of the circuit with the parameters as they stand; the
parameters as a table, to edit; Guess, which starts them from the spectrum,
and Fit, which runs the action eis_circuit (recorded in the history, kept
among the results, and made again in place each time) and puts what it
found back into the table. Every edit draws the circuit again. The window
opens again where it was left: the application keeps its state in the
experiment and hands it back on ``open`` as ``saved``.
"""

import numpy as np

from oresme_plugin import PluginError, ui, view, wave

from .circuit import Circuit
from .eis import read_spectrum

#: Circuits offered as you type one.
CIRCUITS = (
    "R0-p(R1,C1)",
    "R0-p(R1,CPE1)",
    "R0-p(R1-W1,CPE1)",
    "R0-p(R1-Wo1,CPE1)",
    "R0-p(R1,CPE1)-p(R2,CPE2)",
)
#: Points of the circuit's curves, spread over the spectrum's frequencies (logarithmically).
CURVE_POINTS = 200


def _fresh():
    return {"frequency": None, "zre": None, "zim": None, "imaginary": "-Z''",
            "circuit": "R0-p(R1,CPE1)", "params": [], "guess": None, "report": ""}


def _restored(last):
    """The state of the last fit this plugin kept with eis_circuit, if that is what it was."""
    state = _fresh()
    if not isinstance(last, dict) or last.get("action") != "eis_circuit":
        return state
    inputs, params = last.get("inputs") or {}, last.get("params") or {}
    for key in ("frequency", "zre", "zim"):
        if isinstance(inputs.get(key), str):
            state[key] = inputs[key]
    if isinstance(params.get("circuit"), str):
        state["circuit"] = params["circuit"]
    if params.get("imaginary") in ("-Z''", "Z''"):
        state["imaginary"] = params["imaginary"]
    fitted = dict(zip(last.get("names") or [], last.get("coef") or []))
    sigma = dict(zip(last.get("names") or [], last.get("sigma") or []))
    state["params"] = [{"name": name, "value": value, "sigma": sigma.get(name)}
                       for name, value in fitted.items()]
    state["report"] = f"Restored from {last.get('result')}."
    return state


def _rows(model, rows):
    """The circuit's parameters as rows, keeping the values of those of the same name."""
    known = {row.get("name"): row for row in rows if isinstance(row, dict)}
    out = []
    for name in model.names:
        row = known.get(name, {})
        value = row.get("value")
        out.append({"name": name,
                    "value": float(value) if isinstance(value, (int, float)) else None,
                    "sigma": row.get("sigma") if isinstance(row.get("sigma"), (int, float)) else None})
    return out


def _opened(event):
    """Where the window was left (kept in the experiment), else the last fit, else afresh."""
    saved = event.get("saved")
    if isinstance(saved, dict) and isinstance(saved.get("state"), dict):
        state = _fresh()
        state.update({key: value for key, value in saved["state"].items() if key in state})
        if not isinstance(state["params"], list):
            state["params"] = []
        return state
    return _restored(event.get("last"))


@view("eis")
def eis_view(state, event, waves):
    kind = event.get("type")
    if kind == "open" or not isinstance(state, dict):
        state = _opened(event)
    message = None

    try:
        model = Circuit(state.get("circuit") or "")
    except PluginError as error:
        model, message = None, str(error)
    if model is not None:
        # Values edited by hand are the user's: their uncertainties no longer apply.
        edited = set(event.get("paths") or [])
        state["params"] = _rows(model, state.get("params") or [])
        for index, row in enumerate(state["params"]):
            if f"params.{index}.value" in edited or "circuit" in edited:
                row["sigma"] = None

    spectrum = None
    chosen = [waves.get(key) for key in ("frequency", "zre", "zim")]
    if all(item is not None for item in chosen):
        try:
            f, w, Z, _ = read_spectrum(*chosen, state.get("imaginary", "-Z''"), "unit", None, None,
                                       len(model.names) if model else 0, state.get("circuit"))
            spectrum = (f, w, Z)
        except PluginError as error:
            message = str(error)
    elif kind != "open":
        message = "Choose the frequency, Z′ and Z″ waves."

    if model is not None and spectrum is not None:
        missing = any(row["value"] is None for row in state["params"])
        if (kind == "command" and event.get("id") == "guess") or missing:
            for row, value in zip(state["params"], model.initial_guess(spectrum[1], spectrum[2])):
                if kind == "command" or row["value"] is None:
                    row["value"], row["sigma"] = float(value), None

    if kind == "done" and event.get("id") == "eis_circuit":
        # The fit is of what was shown when Fit was pressed. If the waves, the circuit or the
        # values were changed since, its values are not this table's: the result keeps them.
        args = event.get("args") or {}
        now = {key: state.get(key) for key in ("frequency", "zre", "zim", "circuit", "imaginary")}
        current = [row["value"] for row in state.get("params", [])]
        stale = any(args.get(key) != value for key, value in now.items()) or (
            args.get("guess") is not None and args.get("guess") != current
        )
        if event.get("ok") and stale:
            message = (f"The circuit or its spectrum changed while it was fitted, so the values "
                       f"found were not put in the table; {event.get('result')} keeps them.")
        elif event.get("ok"):
            values = event.get("values") or {}
            for row in state["params"]:
                if isinstance(values.get(row["name"]), (int, float)):
                    row["value"] = values[row["name"]]
                    row["sigma"] = values.get(f"{row['name']}_sigma")
            warnings = values.get("warnings") or []
            state["report"] = (
                f"Fitted ({event.get('result')}): χ² {values.get('chisq', float('nan')):.4g}, "
                f"reduced {values.get('chisq_reduced', float('nan')):.4g}, "
                f"{values.get('frequencies')} frequencies."
                + "".join(f"\n! {text}" for text in warnings)
            )
        else:
            message = event.get("error") or "The fit failed."

    values = [row["value"] for row in state.get("params", [])]
    state["guess"] = values if values and all(isinstance(v, (int, float)) for v in values) else None

    arrays = {}
    if spectrum is not None:
        _, w, Z = spectrum
        used = w / (2 * np.pi)  # the frequencies of the points that are used
        arrays.update(
            data_re=wave(Z.real), data_im=wave(-Z.imag), data_f=wave(used),
            data_mod=wave(np.abs(Z)), data_phase=wave(-np.degrees(np.angle(Z))),
        )
        if model is not None and state["guess"] is not None:
            low, high = float(np.min(used)), float(np.max(used))
            grid = np.logspace(np.log10(low), np.log10(high), CURVE_POINTS)
            with np.errstate(all="ignore"):
                curve = model.impedance(np.array(state["guess"], dtype=float), 2 * np.pi * grid)
            arrays.update(
                model_re=wave(curve.real), model_im=wave(-curve.imag), model_f=wave(grid),
                model_mod=wave(np.abs(curve)), model_phase=wave(-np.degrees(np.angle(curve))),
            )

    def data_and_model(x, y, label):
        return [
            ui.series(f"data_{y}", f"data_{x}", mode="markers", color="#1c2026", label="Data"),
            ui.series(f"model_{y}", f"model_{x}", color="#d62728", label=label),
        ]

    layout = ui.view(
        ui.row(
            ui.wave("Frequency (Hz)", "frequency"),
            ui.wave("Z′ (Ω)", "zre"),
            ui.wave("Z″ or −Z″ (Ω)", "zim"),
            ui.choice("The imaginary wave holds", "imaginary", [("−Z″", "-Z''"), ("Z″", "Z''")]),
            ui.string("Circuit", "circuit", suggestions=CIRCUITS),
        ),
        ui.split(
            ui.tabs(
                ("Nyquist", ui.plot(data_and_model("re", "im", state.get("circuit", "")),
                                    x_label="Z′ (Ω)", y_label="−Z″ (Ω)", equal=True, height=330)),
                ("Bode", ui.column(
                    ui.plot(data_and_model("f", "mod", "|Z|"), x_label="Frequency (Hz)",
                            y_label="|Z| (Ω)", x_log=True, y_log=True, height=170),
                    ui.plot(data_and_model("f", "phase", "Phase"), x_label="Frequency (Hz)",
                            y_label="−Phase (°)", x_log=True, height=150),
                )),
            ),
            ui.column(
                ui.table("params", [
                    ui.col("name", "Parameter", editable=False),
                    ui.col("value", "Value", type="number"),
                    ui.col("sigma", "σ", type="number", editable=False),
                ]),
                ui.row(
                    ui.button("Guess", on="guess"),
                    ui.button("Fit", action="eis_circuit", replace=True, primary=True,
                              disabled=spectrum is None or model is None, args={
                                  "frequency": ui.bind("frequency"), "zre": ui.bind("zre"),
                                  "zim": ui.bind("zim"), "circuit": ui.bind("circuit"),
                                  "imaginary": ui.bind("imaginary"), "guess": ui.bind("guess"),
                              }),
                ),
                ui.text(state.get("report") or "Edit a value to see the circuit change; Fit fits it.",
                        tone="muted", mono=bool(state.get("report"))),
            ),
            ratio=0.62,
        ),
    )
    return {"state": state, "ui": layout, "waves": arrays, "message": message}
