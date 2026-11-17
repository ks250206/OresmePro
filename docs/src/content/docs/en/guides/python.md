---
title: Command history and Python scripting
sidebar:
  order: 10
---

## Recall commands

In the Command Window, use **↑ / ↓** to recall commands matching the typed prefix, or **Ctrl+R** to search. Some interface actions are echoed as Python. Check the target wave and window names before replaying a command that modifies data.

## Save scripts as procedures

Choose **Windows → New Procedure…**, enter Python, and click **Run**. **Shift+Enter** executes the selection or current line, and **Ctrl+Enter** (**⌘+Enter** on macOS) executes the entire file. Procedures are stored in the experiment. Use `op.new_procedure(name, code)` to create one from Python.

### Namespaces and import

Each procedure is a file `<name>.py`, and its name is its module name (so it takes only ASCII letters, digits and `_`).

- **Run** (`p.run()`) executes the file **in the command window's namespace**: what it defines can be used from the command line at once.
- `import name` loads it as **a namespace of its own** (a module). Other procedures can use it too, with `import tools` or `from tools import scaled`. A procedure that changes is loaded again before the next input.
- The menu at the right of the procedure window's toolbar chooses how Run runs it, written as the Python it is like: `from tools import *` runs it in the command window's namespace (the default); `import tools as` with a name in the field beside it (`tl`) runs it as a module of its own bound to that name, which leaves the command line's names alone. A module run this way has `np` and `op` as the command line does, and one that fails is not kept. From Python: `p.import_as = "tl"`, or `op.new_procedure("tools", code, import_as="tl")`. Running when the experiment opens follows it too.
- **Check** looks for mistakes without running the file: it opens the list of Ruff's problems (undefined names, unused imports, ...) in the editor, and in Python reports a syntax error or a module that cannot be found (not installed, not in the Pyodide distribution, not another procedure) in the command window (`p.check()`). **Format** only tidies the code with Ruff.

```python
# Procedure "tools"
SCALE = 3
def scaled(x):
    return SCALE * x

# Procedure "analysis"
import tools
result = tools.scaled(2)   # 6; analysis's own SCALE does not clash
```

Renaming a procedure renames its module, so change the procedures that import it too.

### Export and import

Right-click a procedure window and choose **Export as name.py** to save it as a `.py` file. **Windows → Import Procedure…** (or the same right-click menu) makes a procedure of each `.py` file chosen, named after the file (characters a module name cannot have become `_`, and `_0` and so on is added to a name in use).

Imported code **does not run**. It also comes in with running when the experiment opens turned off, so read it, then **Run** it or turn on **Run When the Experiment Opens**. A `.py` file from someone else can hold any code: run only what you trust. From Python, `op.new_procedure(name, code, auto_run=False)` does the same.

The command session starts with `np` and `op` preloaded. Include `import numpy as np` and `import oresme as op` in a procedure to make its dependencies clear. SciPy, pandas, scikit-learn, lmfit and pybaselines load on first use. Use **Python → Interrupt** for a long-running command. Restarting Python clears session variables and leaves the experiment's waves in the app.

### Procedure Browser

**Python → Procedure Browser** lists the experiment's procedures and the classes and functions defined in them, nested as written, as Igor's Procedure Browser does.

- Icons tell the kinds apart: an orange **C** for a class, a purple **ƒ** for a function, a green **m** for a method of a class. The number at the right is the line it is defined on
- Small labels beside a file say the module name it runs as (`as tl`), that its window is closed (`closed`), or that it does not run when the experiment opens (`no auto-run`)
- Typing in the box at the top narrows the list to the functions and classes whose names have those letters
- With **Signatures** on, it shows parameters (`(r, *, pi=3.14)`) and return annotations too
- Clicking a function or class opens its procedure (reopening it if it is closed) with the cursor on the line where it is defined
- Select a file to **Export** it (as `name.py`) or **Run** it; **New…** and **Import…** are there too, and right-click renames it
- The list comes from the editor's own parser: it needs no running Python, and a file with errors shows what can be read of it

## See and drop variables

**Python → Variables** lists the variables your commands and procedures have made, with their types and a short look at their values: a variable explorer. It is refreshed after each input.

- Arrays show their shape and type (`2×3 float64`), lists and dicts their length and first items, functions their parameters
- Double-click a variable (or right-click → **Show Value**) to show its value in the Command Window
- Tick variables and **Drop** them to run `del a, b`; **Drop All…** asks, then drops every variable listed. Both are written in the history
- What Python starts with (`np`, `op`, IPython's names) and names starting with `_` are never listed, so they cannot be dropped by mistake and leave Python unusable
- Modules you imported (`import tools as tl`) are listed as "module" (`tools (procedure)` for a procedure). Dropping one only takes the name away: importing it again brings it back

## Add packages

Packages of the Pyodide distribution (NumPy, SciPy, pandas, scikit-learn, lmfit, pybaselines and more) load when they are imported.
Add others with **Python → Packages…**, or `%pip` in the command line.

```python
%pip install pint emcee                 # from PyPI, with what they need
%pip install statsmodels                # one of Pyodide's comes from Pyodide
%pip list                               # everything in Python
%pip freeze                             # what this experiment uses (name==version)
%pip show pint
%pip uninstall pint
await op.install("emcee==3.1.6")        # from Python; see op.packages()
```

- What is installed is **recorded in the experiment**: name, version, wheel, SHA-256 and what it needs. Whenever the experiment opens or Python restarts, the versions recorded are installed again before its procedures run (the history shows `await op.install()`).
- The browser keeps the wheels from PyPI, shared by every experiment that uses them, so a package installed once installs again offline.
- Opening an `.oresme` file from someone else that uses packages from PyPI asks first, as importing them runs their code. Declined, they can be installed later with **Install Them** in **Python → Packages…**.
- **Python → Packages…** shows the experiment's packages with what each brought, as a tree, and how each stands in Python (not installed, installed, imported). Recommended packages (statsmodels, PyWavelets, uncertainties, emcee, Optuna, iminuit, pint, sympy and more), folded under **Recommended**, install with one click, and **Copy Requirements** copies the list. Its **In Python now** table lists Python's packages with their versions and state (imported, loaded, not loaded yet): pre-installed ones (NumPy, IPython), those the app ships that load when first imported (SciPy, pandas, scikit-learn, lmfit, pybaselines, shown before they are), and the experiment's.
- Pure Python wheels and wheels built for Pyodide install. [Packages in Pyodide](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) lists the packages of the distribution. A package with compiled code of its own that Pyodide does not ship (Numba, PyTorch) cannot run.
- `%pip uninstall` takes a package out of the record. Modules already imported stay until Python restarts.

## Apply changes together

Changes made inside `with op.atomic():` reach the experiment together, as one undo step, when the block ends without an exception. If the block raises, nothing it did is kept. Python inside the block sees its own changes; the interface shows none of them until the block ends.

```python
with op.atomic():
    corrected = op.make("corrected", raw.data - background.data)
    op.display(corrected)
```

Analyses that make waves and results, such as `op.fit`, `op.fit_peaks`, and `op.background`, each run in such a block. Changes made in the interface while a block runs are kept alongside the block's changes when they do not overlap. If a wave the block read has changed meanwhile, nothing is kept and `ConflictError` (an `OresmeError`) is raised. Graphs cannot be drawn or saved inside a block.

## Call analyses by name

Analyses are registered as **actions**, each with a name such as `core.fit` and typed arguments. Panels and plugins call them with the name and JSON values instead of Python code. From Python, `op.invoke` does the same.

```python
op.actions()                                                    # the registered actions
r = op.invoke("core.fit", {"function": "gauss", "y": "signal"})  # the same as op.fit("gauss", op.wave("signal"))
```

The arguments are checked before the call. An unknown action or version, an extra or missing argument, a value of the wrong type, a value not among the choices, a number out of range, or a wave that does not exist is refused with `OresmeError` (`InvalidArgumentError` for arguments, `NotFoundError` for what is not there), and nothing is done. A call that passes runs in an `op.atomic()` block.

A procedure can register its own functions with `@op.action`. Names starting with `core.` belong to the app and `plugin.` to plugins, so use another lowercase dotted name.

```python
@op.action("lab.normalize", title="Normalize", params={
    "wave": {"type": "wave", "title": "Wave"},
    "to": {"type": "number", "default": 1.0, "min": 0},
})
def normalize(wave, to=1.0):
    return op.make(f"{wave.name}_norm", wave.data / np.nanmax(wave.data) * to)
```

The argument types are `wave`, `waves`, `number`, `integer`, `numbers`, `string`, `boolean`, and `choice`. Numbers can have `min` and `max`, lists a `length`, and a choice its `choices`. A `default` must equal the function's own default. An argument that is left out is not passed to the function.

An action called from the interface appears in the history as the equivalent Python, such as `op.fit("gauss", op.wave("signal"))`. The buttons of a panel call actions too ([Panels](../panels/)).

## Tell errors apart

When the app refuses a request, the exception carries a code for the kind of refusal (`error.code`) and details of what it is about (`error.details`). Tell errors apart with `except` and the code instead of reading the message. The codes are part of the API: changing or removing one is a breaking change.

| Code               | Class                  | When                                              | `details`                                               | What to do                   |
| ------------------ | ---------------------- | ------------------------------------------------- | ------------------------------------------------------- | ---------------------------- |
| `INVALID_ARGUMENT` | `InvalidArgumentError` | A value, name or argument that is not allowed     | `field`: the argument or property                       | Correct that value           |
| `NOT_FOUND`        | `NotFoundError`        | Something asked for by name is not there          | `kind`, `name` (and `field` when passed as an argument) | Check the name               |
| `ALREADY_EXISTS`   | `AlreadyExistsError`   | The name is taken                                 | `kind`, `name`                                          | Use another name             |
| `IN_USE`           | `InUseError`           | It cannot be removed while other things use it    | `kind`, `name`, `users`                                 | Remove it from `users` first |
| `CONFLICT`         | `ConflictError`        | A wave a step was computed from changed meanwhile | —                                                       | Run it again                 |
| `UNSUPPORTED`      | `UnsupportedError`     | A file, format or package the app cannot handle   | —                                                       | Use another format           |
| `PLUGIN_FAILED`    | `PluginFailedError`    | A plugin failed                                   | `phase`: where it failed (see below)                    | Look at `phase`              |
| `INTERNAL`         | `InternalError`        | A fault of the app itself                         | —                                                       | Report it as a bug           |

```python
try:
    op.invoke("core.smooth", {"wave": "signal", "n": 0})
except op.InvalidArgumentError as error:
    print(error.details["field"])  # 'n'
except op.ConflictError:
    pass  # a wave it read changed: calling it again may work
```

`InvalidArgumentError` is also a `ValueError` and `NotFoundError` a `LookupError`, so code that catches those keeps working. Errors from NumPy, SciPy and Python itself arrive as they are.

In the interface, the command window names the kind of error (`NotFoundError: No wave named "x".`). In a dialog or a plugin action's form, the field `details.field` names turns red until its value is changed.

### Stopped runs

A run stopped with **Python → Interrupt**, or by restarting Python while it ran, is recorded as stopped, not failed: its mark is ■, not red. Inside Python it is still a `KeyboardInterrupt`. Stopping a template run leaves the samples it had not finished as `cancelled`. A plugin stopped while it runs (turned off, say) is stopped too. **Interrupt** also stops the plugins' runs started from windows (a panel or a dialog, say), which the status bar shows while they run. A plugin that Python called with `op.invoke` stops when Python is interrupted or restarted, and nothing it was making goes into the experiment.

### Plugin failures

A plugin that fails raises `PluginFailedError`, and `details["phase"]` says where it failed. The history shows it with the phase, as `PluginFailedError (timeout): ...`, and so does the action's form.

| `phase`          | Meaning                                 |
| ---------------- | --------------------------------------- |
| `start`          | Its sandbox did not start               |
| `load`           | Its code did not load                   |
| `run`            | The action raised an error              |
| `timeout`        | It did not finish in time               |
| `stopped`        | It was stopped (taken as a stopped run) |
| `invalid_output` | It returned what the app cannot take    |

[Using the API](../../reference/) · [Procedure](../../reference/api/procedure/) · [atomic](../../reference/api/global/#atomic) · [Actions API](../../reference/api/actions/) · [Errors](../../reference/api/errors/)
