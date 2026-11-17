"""The view quant: atomic concentrations from regions of spectra, in a window of its own.

Built only of the application's parts (see docs/design/plugin-views.md):
the spectra at the top (a survey, or narrow scans of each region, with
their energies if their X scaling is not them); the regions in a table
(name, from, to, RSF) with each one's area and atomic %, worked out as
they are edited; a spectrum with its background and the regions' bounds,
which are dragged to move them (a click on the spectrum adds a region
there); and Quantify, which runs the action quantify (recorded in the
history and kept among the results, made again in place each time).
The numbers in the window are the action's own: it is called here on the
waves chosen, as the button will call it.
"""

import numpy as np

from oresme_plugin import PluginError, ui, view, wave

from .common import AL_KA, BACKGROUNDS, binding_energies
from .quantify import quantify

#: Sensitivity factors of common lines for Al Kα, relative to C 1s (Scofield's
#: cross-sections), given to a region named so that has none yet. Check them
#: against those of your instrument: transmission and escape depth are not in them.
RSF = {"C 1s": 1.0, "N 1s": 1.8, "O 1s": 2.93, "F 1s": 4.43}
#: The colours of the regions' bounds, in turn.
COLORS = ("#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e", "#17becf", "#8c564b")
#: How wide a region added by a click is (eV).
WIDTH = 8.0
SETTINGS = ("background", "average", "energy_axis", "photon_energy", "shift", "ke_exponent")


def _fresh():
    return {
        "spectra": [{"y": None, "x": None}],
        "regions": [],
        "show": 0,
        "background": "Shirley", "average": 5, "energy_axis": "binding",
        "photon_energy": AL_KA, "shift": 0.0, "ke_exponent": 0.0,
        "names": None, "energies": None, "text": "", "report": "",
    }


def _restored(last):
    """The state of the last quantification this plugin kept, if that is what it was."""
    state = _fresh()
    if not isinstance(last, dict) or last.get("action") != "quantify":
        return state
    inputs, params = last.get("inputs") or {}, last.get("params") or {}
    spectra = inputs.get("spectra") if isinstance(inputs.get("spectra"), list) else []
    energies = inputs.get("energies") if isinstance(inputs.get("energies"), list) else []
    if spectra:
        state["spectra"] = [{"y": y, "x": energies[i] if i < len(energies) else None}
                            for i, y in enumerate(spectra) if isinstance(y, str)]
    for key in SETTINGS:
        if key in params:
            state[key] = params[key]
    try:
        from .quantify import parse_regions
        state["regions"] = [{"name": name, "low": low, "high": high, "rsf": rsf}
                            for name, low, high, rsf in parse_regions(params.get("regions"))]
    except PluginError:
        pass
    state["report"] = f"Restored from {last.get('result')}."
    return state


def _opened(event):
    saved = event.get("saved")
    if isinstance(saved, dict) and isinstance(saved.get("state"), dict):
        state = _fresh()
        state.update({key: value for key, value in saved["state"].items() if key in state})
        return state
    return _restored(event.get("last"))


def _number(value):
    return float(value) if isinstance(value, (int, float)) and np.isfinite(value) else None


def _regions_text(regions):
    """The regions as the action reads them; those not filled in yet are left out."""
    lines = []
    for row in regions:
        low, high, rsf = _number(row.get("low")), _number(row.get("high")), _number(row.get("rsf"))
        name = str(row.get("name") or "").replace(":", " ").replace(";", " ").strip()
        if not name or low is None or high is None or low == high:
            continue
        lines.append(f"{name}: {min(low, high):g} {max(low, high):g} rsf={rsf if rsf and rsf > 0 else 1:g}")
    return "; ".join(lines)


@view("quant")
def quant_view(state, event, waves):
    kind = event.get("type")
    if kind == "open" or not isinstance(state, dict):
        state = _opened(event)
    message = None
    regions = [row for row in state.get("regions") or [] if isinstance(row, dict)]
    spectra = [item for item in state.get("spectra") or [] if isinstance(item, dict)] or [{}]
    state["regions"], state["spectra"] = regions, spectra

    if kind == "command" and event.get("id") == "add_spectrum" and len(spectra) < 8:
        spectra.append({"y": None, "x": None})
    if kind == "command" and event.get("id") == "remove_spectrum" and len(spectra) > 1:
        spectra.pop()
    if kind == "command" and event.get("id") == "add_region" and isinstance(event.get("x"), (int, float)):
        centre = round(float(event["x"]), 1)
        taken = {row.get("name") for row in regions}
        name = next(f"Region {n}" for n in range(1, 100) if f"Region {n}" not in taken)
        regions.append({"name": name, "low": centre - WIDTH / 2, "high": centre + WIDTH / 2,
                        "rsf": 1.0})
    # A region named after a common line takes its sensitivity factor, if it has none.
    for row in regions:
        if _number(row.get("rsf")) is None and row.get("name") in RSF:
            row["rsf"] = RSF[row["name"]]
        for key in ("area", "percent", "spectrum"):
            row.pop(key, None)

    chosen = [(waves.get(f"spectra.{i}.y"), waves.get(f"spectra.{i}.x")) for i in range(len(spectra))]
    given = [(y, x) for y, x in chosen if y is not None]
    state["names"] = [y.name for y, _ in given] or None
    with_energies = given and all(x is not None for _, x in given)
    state["energies"] = [x.name for _, x in given] if with_energies else None
    if given and not with_energies and any(x is not None for _, x in given):
        message = "Give an energy wave for every spectrum, or for none: these are left out."
    state["text"] = _regions_text(regions)
    settings = {key: state.get(key) for key in SETTINGS}
    if settings["background"] not in BACKGROUNDS:
        settings["background"] = state["background"] = "Shirley"

    found = None
    if given and state["text"]:
        try:
            found = quantify([y for y, _ in given], state["text"],
                             [x for _, x in given] if with_energies else None, **settings)
        except (PluginError, ValueError, TypeError) as error:
            message = str(error)
    elif not given:
        message = None if kind == "open" else "Choose a spectrum."
    else:
        message = "Click the spectrum to add a region there, or add one in the table."
    if found:
        by_name = {row["name"]: row for row in found["values"]["regions"]}
        for row in regions:
            done = by_name.get(str(row.get("name") or "").replace(":", " ").replace(";", " ").strip())
            if done:
                row["area"], row["percent"], row["spectrum"] = done["area"], done["percent"], done["spectrum"]
        warnings = found["values"]["warnings"]
        if warnings:
            message = " ".join(warnings)

    if kind == "done" and event.get("id") == "quantify":
        if event.get("ok"):
            state["report"] = f"Quantified ({event.get('result')})."
        else:
            message = event.get("error") or "The quantification failed."

    # The spectrum shown, with its background and the bounds of the regions it holds.
    show = state.get("show") if isinstance(state.get("show"), int) else 0
    show = state["show"] = min(max(show, 0), max(len(given) - 1, 0))
    arrays, handles = {}, []
    if given:
        y, x = given[show]
        try:
            be, _ = binding_energies(y, x if with_energies else None, settings["energy_axis"],
                                     settings["photon_energy"], settings["shift"])
            arrays["be"], arrays["counts"] = wave(be), wave(np.asarray(y.data, dtype=float))
            role = "background" if len(given) == 1 else f"background{show + 1}"
            if found and role in found["waves"]:
                arrays["bg"] = wave(found["waves"][role].data)
        except PluginError as error:
            message = str(error)
        for index, row in enumerate(regions):
            if row.get("spectrum") not in (None, y.name):
                continue
            color = COLORS[index % len(COLORS)]
            for key in ("low", "high"):
                if _number(row.get(key)) is not None:
                    handles.append(ui.handle(x=row[key], bind_x=f"regions.{index}.{key}", color=color,
                                             label=str(row.get("name") or "") if key == "high" else None))

    layout = ui.view(
        ui.group("Spectra", ui.column(
            *[ui.row(ui.wave(f"Spectrum {i + 1}", f"spectra.{i}.y"),
                     ui.wave(f"Energy {i + 1}", f"spectra.{i}.x", optional=True))
              for i in range(len(spectra))],
            ui.row(ui.button("Add Spectrum", on="add_spectrum"),
                   ui.button("Remove Spectrum", on="remove_spectrum", disabled=len(spectra) < 2)),
        )),
        ui.split(
            ui.column(
                ui.choice("Show", "show", [(y.name, i) for i, (y, _) in enumerate(given)] or [("—", 0)]),
                ui.plot([ui.series("counts", "be", color="#1c2026", label="Spectrum"),
                         ui.series("bg", "be", color="#d62728", label="Background")],
                        x_label="Binding energy (eV)", y_label="Counts", x_reverse=True,
                        height=320, handles=handles, on_click="add_region"),
            ),
            ui.column(
                ui.table("regions", [
                    ui.col("name", "Region"),
                    ui.col("low", "From (eV)", type="number"),
                    ui.col("high", "To (eV)", type="number"),
                    ui.col("rsf", "RSF", type="number"),
                    ui.col("area", "Area", type="number", editable=False),
                    ui.col("percent", "At. %", type="number", editable=False),
                ], add=True, remove=True),
                ui.group("Settings", ui.column(
                    ui.row(ui.choice("Background", "background", list(BACKGROUNDS)),
                           ui.number("Average width", "average", min=1, step=1)),
                    ui.row(ui.choice("Energies are", "energy_axis", ["binding", "kinetic"]),
                           ui.number("Photon energy", "photon_energy", min=0, unit="eV")),
                    ui.row(ui.number("Charge correction", "shift", unit="eV"),
                           ui.number("KE exponent", "ke_exponent")),
                )),
                ui.row(ui.button("Quantify", action="quantify", replace=True, primary=True,
                                 disabled=not (given and state["text"]), args={
                                     "spectra": ui.bind("names"), "energies": ui.bind("energies"),
                                     "regions": ui.bind("text"),
                                     **{key: ui.bind(key) for key in SETTINGS},
                                 })),
                ui.text(state.get("report") or "Drag a region's bounds on the spectrum; Quantify keeps the result.",
                        tone="muted"),
            ),
            ratio=0.55,
        ),
    )
    return {"state": state, "ui": layout, "waves": arrays, "message": message}
