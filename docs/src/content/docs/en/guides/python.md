---
title: Command history and Python scripting
sidebar:
  order: 10
---

## Recall commands

In the Command Window, use **↑ / ↓** to recall commands matching the typed prefix, or **Ctrl+R** to search. Some interface actions are echoed as Python. Check the target wave and window names before replaying a command that modifies data.

## Save scripts as procedures

Choose **Windows → New Procedure**, enter Python, and click **Run**. **Shift+Enter** executes the selection or current line, and **Ctrl+Enter** (**⌘+Enter** on macOS) executes the entire file. Procedures are stored in the experiment. Use `op.new_procedure(name, code)` to create one from Python.

The command session starts with `np` and `op` preloaded. Include `import numpy as np` and `import oresme as op` in a procedure to make its dependencies clear. SciPy, pandas, scikit-learn, and lmfit load on first use. Use **Python → Interrupt** for a long-running command. Restarting Python clears session variables and leaves the experiment's waves in the app.

## Apply changes together

Changes made inside `with op.atomic():` reach the experiment together, as one undo step, when the block ends without an exception. If the block raises, nothing it did is kept. Python inside the block sees its own changes; the interface shows none of them until the block ends.

```python
with op.atomic():
    corrected = op.make("corrected", raw.data - background.data)
    op.display(corrected)
```

Analyses that make waves and results, such as `op.fit`, `op.fit_peaks`, and `op.background`, each run in such a block. Changes made in the interface while a block runs are kept alongside the block's changes when they do not overlap. If a wave the block read has changed meanwhile, nothing is kept and `OresmeError` is raised. Graphs cannot be drawn or saved inside a block.

## Call analyses by name

Analyses are registered as **actions**, each with a name such as `core.fit` and typed arguments. Panels and plugins call them with the name and JSON values instead of Python code. From Python, `op.invoke` does the same.

```python
op.actions()                                                    # the registered actions
r = op.invoke("core.fit", {"function": "gauss", "y": "signal"})  # the same as op.fit("gauss", op.wave("signal"))
```

The arguments are checked before the call. An unknown action or version, an extra or missing argument, a value of the wrong type, a value not among the choices, a number out of range, or a wave that does not exist is refused with `OresmeError`, and nothing is done. A call that passes runs in an `op.atomic()` block.

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

[Using the API](../../reference/) · [Procedure](../../reference/api/global/#procedure) · [atomic](../../reference/api/global/#atomic) · [Actions API](../../reference/api/actions/)
