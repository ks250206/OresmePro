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
- Argument types are those of `op.action` (`wave`, `waves`, `number`, `integer`, `numbers`, `string`, `boolean`, `choice`). Actions are declared here so they can be shown and checked before any code runs
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

Wave arguments arrive as `Wave` objects (`.data` is a read-only NumPy array; `.x`, `.dx`, `.unit` and others are there too). Put `names`, `coef`, and `sigma` under `result` in `values` to keep an analysis result.

An example plugin for electrochemistry (cyclic voltammetry peaks, Tafel slopes, impedance equivalent-circuit fits) is in [examples/plugins/electrochem](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/electrochem).
