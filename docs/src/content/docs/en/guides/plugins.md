---
title: Plugins
sidebar:
  order: 11
---

Plugins add analyses (actions), panels, templates, graph templates, and styles. Install them from a GitHub repository, or from a folder or zip. There is no central registry.

## Install

Open **Python → Plugins…** and choose **Install from GitHub…**, **Install from Folder…**, or **Install from Zip…**.

- For GitHub, enter the repository address. Addresses of the form `…/tree/<branch>/<folder>` work too, and the branch or tag can be given separately
- The branch or tag is fixed to the commit it points at. Every file is fetched from that one commit, so what you installed does not change when the repository does
- Before installing, you see the plugin's name, version, source, commit, actions, the Python packages it uses, and its files. None of its code runs until you choose **Install**

Installed plugins are kept in the browser and are available in every experiment. The SHA-256 of each file is recorded and checked whenever the file is read back, so a file changed in storage is refused, not run.

## Where plugin code runs

A plugin with Python code runs apart from the app, in a sandbox.

- The sandbox is a worker inside an iframe with no origin of its own, running a Pyodide of its own
- It cannot reach the experiments in this browser (OPFS), IndexedDB, or caches
- It has no network. The app loads Pyodide and the packages and hands them over
- The plugin receives only the values, scaling, and units of the waves you choose for an action. It returns new waves and numbers, which the app checks and puts into the experiment. A plugin never reads or changes the experiment itself

In a browser where this cannot be arranged, plugins with code do not run; they are never run in the app's Python instead. Data-only plugins (panels, templates, styles) work everywhere.

Procedures and the command line are different: they run in the app's Python, which can read the experiments in this browser and use the network. Install code you have not written as a plugin, not as a procedure.

## Use

- Select a plugin in **Python → Plugins…** and press **Open** by an action: its form opens in a window of its own. **Python → Plugin Actions** opens it directly too. Choose waves and values and click **Run**
- The window is not modal: graphs, tables and the command window go on working while it is open, and it moves wherever you drag its title bar. It runs as often as you like and keeps what you entered until it is closed. It is not saved with the experiment
- From Python, call `op.invoke("plugin.<plugin>.<action>", {...})`. It also works inside `op.atomic()`
- Returned waves are made next to the first input wave and named `<input>_<role>`. An existing wave is never overwritten; `_1` and so on is added instead
- The only exception is `op.invoke(..., replace=True)`, which a model editor's fit uses. Of the waves the same action of the same plugin made from the same input waves the last time it kept a result, those still equal in values and scaling to the copies that result kept (that is, not changed since) are made again under their names. The graph it made is updated too: its look and axes stay, missing traces are added and those of waves it no longer makes are taken out (and those waves killed, if nothing else shows them). Waves changed or renamed since, and everything else, are left alone and the run's waves get new names. Whether to replace is the app's and the user's choice, never the plugin's
- A plugin with a **model editor** (`editors`, below) has it at the end of the **Analysis** menu and under **Open** in **Python → Plugins…**. Drag its items on the data, write their values and constraints in the table, and **Fit**. Ctrl+Z undoes edits in the window
- A result the plugin returns is kept in **Analysis → Results…** like a fit, with the plugin, version, source, and commit that made it
- Add graph templates and styles to the experiment with **Add … to Experiment**

## Turn off, update, remove

- **Turn Off** makes its actions unavailable and stops its sandbox
- **Update…** fetches the current commit of the branch or tag it was installed from, shows what changed, and replaces it
- **Remove…** deletes the plugin and its files. Waves, graphs, and results it made stay in your experiments. Running such a result again stops and names the plugin it needs
- Opening an experiment never fetches or starts a plugin

## Write a plugin

Put an `oresme-plugin.json` in a folder.

```json
{
  "manifestVersion": 1,
  "name": "scale",
  "title": "Scale",
  "version": "1.0.0",
  "python": { "entry": "scale", "packages": [] },
  "files": ["scale.py"],
  "actions": [
    {
      "name": "scale",
      "title": "Scale a wave",
      "params": {
        "y": { "type": "wave", "title": "Wave" },
        "factor": { "type": "number", "default": 2 }
      }
    }
  ]
}
```

- List every file of the package in `files`; files not listed are not part of it
- Argument types are those of `op.action` (`wave`, `waves`, `number`, `integer`, `numbers`, `string`, `boolean`, `choice`, `json`). A `json` argument holds structure (lists and dicts), which the plugin checks itself. Actions are declared here so they can be shown and checked before any code runs
- A `wave` or `waves` argument takes numeric waves. With `"text": true` it takes text waves too (sample names or crystal structures, say). A text wave given to an argument without it is refused before anything runs
- In Python, register a function for each action

```python
from oresme_plugin import action, wave

@action("scale")
def scale(y, factor=2.0):
    return {
        "waves": {"scaled": wave(y.data * factor, like=y)},
        "values": {"result": {"names": ["factor"], "coef": [factor], "sigma": [0.0]}},
    }
```

Wave arguments arrive as `Wave` objects (`.data` is a read-only NumPy array; `.x`, `.dx`, `.unit` and others are there too). A text wave's `.data` is a 1-D array of `str`, and its `.is_text` is `True`. Put `names`, `coef`, and `sigma` under `result` in `values` to keep an analysis result.

A list of strings (or a NumPy array of them) given to `wave(...)` makes a text wave: the labels of text markers, say.

### Return a graph

Besides `waves` and `values`, an action may return `"graph"`. The app makes that graph from the waves the action returned, named by their roles.

```python
return {
    "waves": {"x": wave(x), "y": wave(y), "label": wave(["P1", "P2"])},
    "graph": {
        "name": "Peaks",
        "traces": [
            {"y": "y", "x": "x", "mode": "markers", "legend": "Peaks"},
            {"y": "y", "x": "x", "mode": "markers", "text_marker": "label", "text_anchor": "LB"},
        ],
        "axes": {"left": {"label": "Intensity"}, "bottom": {"min": 0}},
        "graph": {"margin_left": 40},
        "annotations": [{"kind": "legend", "anchor": "RT"}],
    },
}
```

- A trace takes the properties of the app's traces (`mode`, `color`, `line_size`, `marker`, `text_marker`, ...), with roles where they name waves. `axis` and `haxis` choose the sides of its axes, and traces given a `legend` are listed in a legend
- `axes` and `graph` take the properties of axes and of the graph, in snake_case as in Python
- The app checks all of it as it checks what Python asks for. A bad property leaves nothing of the run behind

### Model editors

A plugin can declare, under `editors`, a window for building a model of peaks or components by dragging them on the data and writing their values and constraints in a table, and fitting it, like CasaXPS's Components page. The app draws the window; the plugin's code only computes, in Python in its sandbox. None of the plugin's JavaScript runs. Like `actions`, the declaration is shown before installing and checked field by field.

```json
"editors": [{
  "kind": "spectrum-fit",
  "name": "xps",
  "title": "XPS Peak Fitting",
  "preview": "xps_preview",
  "fit": "xps_fit",
  "data": "spectrum",
  "x": "energy",
  "range": "region",
  "items": {
    "param": "components",
    "title": "Component",
    "fields": [
      {"key": "name", "title": "Name", "type": "text"},
      {"key": "shape", "title": "Line shape", "type": "text", "default": "GL(30)", "choices": ["GL(30)", "LA(1.53,243)"]},
      {"key": "position", "title": "Position (eV)", "constraint": true},
      {"key": "fwhm", "title": "FWHM (eV)", "default": 1.2, "constraint": true, "min": 0.05},
      {"key": "area", "title": "Area", "constraint": true, "min": 0}
    ],
    "drag": {
      "x": "position",
      "height": {"field": "area", "rule": "proportional"},
      "width": {"field": "fwhm", "rule": "full", "scale": ["area"]}
    },
    "coef": "{letter}_{key}"
  },
  "partner": {"title": "Doublet", "offset": "Δ (eV)", "ratios": [["p (1:2)", 0.5]],
              "ties": {"position": "{ref}+{offset}", "fwhm": "{ref}", "area": "{ref}*{ratio}"}},
  "settings": ["background", "shift"],
  "axis": {"label": "Binding Energy (eV)", "reverse": true}
}]
```

- `preview` and `fit` name two of the plugin's actions, which take the same arguments: `data` (the data, a `wave`), `x` (X values, a `wave`, optional), `range` (`numbers` of length 2, dragged on the plot as dashed lines), `items.param` (`json`, the list of items) and `settings` (plain arguments, set in the Settings tab)
- `kind` is which window it is: `"spectrum-fit"` (items on a background, over a range of data) or `"view"` (below); a plugin with an editor of a kind the app does not know is not installed
- Items are lettered A, B, C …, a column each in the table. A field's `type` is `"number"` (the default) or `"text"`; `"constraint": true` gives it a row for its constraint
- `drag` says what dragging on the plot does to the fields; the app follows it and knows nothing of what they mean. `x`: the field set to the X where the square at an item's top is dropped. `height`: the field moving that square up and down changes: `"proportional"` multiplies it by the new height over the old (an area, which grows with the height), `"value"` sets it to the height (the top above the background, as the preview gives it). `width`: the field the ◇ change: `"full"` is the distance between them (a FWHM), `"half"` from the item's X to one of them; the fields in `scale` are multiplied by the new width over the old (to keep the height of a shape whose area grows with its width)
- Each item is passed as `{"<key>": value, …, "constraints": {"<key>": "text"}}`. A field at its default (other than those `drag` changes) is left out, so a plugin takes a missing field as its default. What a constraint means is the plugin's, except that a capital letter standing alone names an item, which the app renames when an item is taken out
- `preview` is called after each edit, recorded nowhere and changing nothing in the experiment. It returns the waves `x` (X across the range), `data`, `background`, `fit`, `residual`, `item0`, `item1`, … (each item alone, without the background) and `all_x`, `all_y` (all of the data, drawn grey), and in its `values`: `items` (for each, `values`: its numbers as the constraints leave them, `tied`: the fields tied to another item, `peak`: `[x, the top, the background under it]`), `errors` (a list of `{"item", "field", "message"}`) and `problem` (text or null)
- `fit` is an ordinary run of an action, kept in the history and among the results. The `items` of its `values` (each item's numbers found) go back into the table, and its `report` (`columns`, `rows`, `lines`, `warnings`) into the Report tab. With `coef`, an editor opened again reads the values back from the coefficients of the result kept (`A_position`, say)
- The window fits with `replace=True` (below)

### Views built of the app's parts

Where `spectrum-fit` is a window of a fixed layout, an editor of `kind: "view"` has its window and its answers to what is done in it decided by the plugin's Python. Only the app's own parts are drawn (layouts, tabs, fields, wave choices, editable tables, plots, buttons); none of the plugin's HTML or JavaScript runs. The design is in [docs/design/plugin-views.md](https://github.com/ks250206/OresmePro/blob/main/docs/design/plugin-views.md).

```json
"editors": [{"kind": "view", "name": "eis", "title": "EIS Circuit Fitting"}]
```

```python
from oresme_plugin import ui, view, wave

@view("eis")
def eis_view(state, event, waves):
    if event["type"] == "open":
        state = {"frequency": None, "circuit": "R0-p(R1,CPE1)", "params": []}
    ...
    return {
        "state": state,
        "ui": ui.view(
            ui.row(ui.wave("Frequency (Hz)", "frequency"), ui.string("Circuit", "circuit")),
            ui.split(ui.plot([ui.series("im", "re", mode="markers")], equal=True),
                     ui.table("params", [ui.col("name", editable=False), ui.col("value", type="number")])),
            ui.button("Fit", action="eis_circuit", args={"circuit": ui.bind("circuit")}, replace=True),
        ),
        "waves": {"re": wave(...), "im": wave(...)},
        "message": None,
    }
```

- The handler is called with `(state, event, waves)` for each event of the window. `state` is kept by the app and given each time; the handler remembers nothing. `waves` are **copies** of the waves chosen in the window's `ui.wave` parts, by their `bind`, and nothing else
- `event` is `open` (`saved`: what the experiment kept of this window, `{"state", "version"}` with the version of the plugin that left it, or null; `last`: the last result this plugin kept), `change` (`paths`: what changed; `"*"` after an undo), `command` (`id`: a `ui.button(on=...)`; for a plot's `on_click`, also `x` and `y`, where it was clicked) or `done` (a `ui.button(action=...)` run ended: `args`, what it ran with, to check the result is for what is shown now; `ok`, `values`, `result`, `error`). When the handler chooses waves in the state itself (restoring them on `open`, say), the app sends a `change` next, with those waves
- `state`, `ui` and `message` left out stay as they were; `waves` are the arrays this answer draws (they do not go into the experiment). A `bind` is a path of the state (`params.2.value`): what is entered goes into the state at once and to the handler in turn. Ctrl+Z undoes edits in the window
- Only a `ui.button(action=...)` changes the experiment: it runs one of the plugin's actions with its `args` (`ui.bind(path)` is the state's value when pressed), recorded as `op.invoke(...)`, with the rule above when `replace=True`
- The parts are `ui.view`, `column`, `row`, `split`, `tabs`, `group`, `text`, `number`, `string`, `choice`, `checkbox`, `wave`, `table` (columns by `ui.col`), `plot` (series by `ui.series`; `x_log`, `y_log`, `equal`, `x_reverse`, `handles`, `on_click`), `nodes` and `button`. The app refuses a view with a part or prop it does not know, and says why
- `ui.plot(..., handles=[ui.handle(x=280, bind_x="regions.0.low")])` puts marks to drag on a plot: a point with both `x` and `y`, a line across the plot with one. Dragged, they move the values at `bind_x` and `bind_y` by as much (by the same ratio on a log axis), told to the handler as a `change`; one drag is one undo. `on_click="add"` sends a `command` with the place clicked, away from the handles
- `ui.nodes(label, bind, palette)` edits a diagram of boxes (nodes) joined at their ports. The value at `bind` is `{"nodes": [{"id", "kind", "label", "x", "y", "fixed"}], "edges": [{"from": [id, port], "to": [id, port]}]}`; `palette` is made of `ui.kind(kind, title, ports=("a", "b"))`. Nodes are added with the palette's buttons (the id is the kind and the least number not taken: `R0`, `R1`), moved by dragging, joined by dragging from port to port, and taken out with Delete (not `fixed` ones). What the diagram means (a circuit, say) is the Python's to read
- A view's state is kept in the experiment with the plugin's name and version (not undone with the experiment). Opened again, the window gets it as `saved` in `open`, to go on from; how to read the state of another version is the plugin's to decide

Example plugins:

- Electrochemistry (cyclic voltammetry peaks, Tafel slopes, impedance equivalent-circuit fits): [examples/plugins/electrochem](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/electrochem). Its view **EIS Circuit Fitting** edits a circuit, as text or as a diagram, and its parameters on Nyquist and Bode plots and fits them
- Ternary diagrams: [examples/plugins/ternary](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/ternary). The frame, grid, tick labels and corner names are ordinary traces and text markers, returned as a graph
- XPS peak fitting in the way of CasaXPS (a region, a Shirley or Tougaard background, GL/SGL/LA line shapes, constraints between components, quantification with RSFs): [examples/plugins/xps](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/xps). It has the model editor **XPS Peak Fitting** and the view **XPS Quantification**, where the bounds of regions are dragged on the spectrum to give atomic % ([how to use them](../xps/)) and returns a graph with a reversed binding energy axis and the residual above
