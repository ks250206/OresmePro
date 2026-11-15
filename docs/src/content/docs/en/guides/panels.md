---
title: Panels
sidebar:
  order: 11
---

A panel is a window of buttons and fields that runs analyses: the counterpart of an Igor control panel. Use one to let people who do not write Python run an analysis your lab has settled on.

## Build a panel

**Windows → New Panel** opens an empty panel in edit mode. Add controls with **Add ▾**, and click a control to change it in the form on the right.

| Control     | What it is                                                                  |
| ----------- | --------------------------------------------------------------------------- |
| Heading     | A heading                                                                   |
| Text        | A paragraph (several lines)                                                 |
| Wave Picker | A choice of wave, narrowed by dimensions and name (a pattern such as `*_I`) |
| Choice      | A menu of options                                                           |
| Number      | A number, with a minimum, maximum and step if wanted                        |
| Text Field  | A field for text                                                            |
| Checkbox    | True or false                                                               |
| Button      | Calls a registered action                                                   |

Controls are laid out one to a line from the top; **On the line before** puts a control beside the one before it. Reorder them with ↑ ↓ (**Alt+arrow keys**) and remove them with **Delete**. Press **Done** in the title bar to stop editing; **Edit** in the title bar, or right-click → **Edit Panel**, edits it again.

## Give a button an analysis

Select a button and pick the analysis it calls under **Action** (`core.fit`, say); its arguments are listed. For each argument choose:

- **Leave out**: not passed (optional arguments only)
- **Fixed value**: a value of your choice
- **Control**: the value a control of the panel has when the button is pressed
- **New control**: a control made for the argument and bound to it: a Wave Picker for a wave, a menu of the choices for a choice, a Number with the argument's range for a number

A button holds only the action's name and its arguments, never Python code. When it is pressed, the arguments are made from the controls' values and checked against the action's argument types before the call. What is missing ("Choose a wave for Spectrum.") or wrong is shown under the button, and nothing runs.

While a call runs, the panel's buttons cannot be pressed: pressing twice runs once. Values changed during the call do not change it. If it fails, the error is shown under the button and the values stay as they are. The call is recorded in the history as the Python that does the same (`op.fit("gauss", op.wave("sig"))`, say).

## Values, saving and undo

The controls' values are saved with the experiment and come back when it is opened. Changing a value can be undone and is recorded as `op.panel("quick_fit")["model"] = "lor"`. Typing into a field is one undo step for the whole edit of the field.

A Wave Picker holds a wave's name. It follows the wave when it is renamed; when the wave is killed, the name stays and is shown as **missing**.

## Data only, or contains code

A panel whose buttons call only `core.` actions (the application's analyses) and `plugin.` actions (plugins, run in isolation) is **Data only**. A button that calls an action registered by a procedure with `@op.action` makes it **Contains code**: pressing it runs this experiment's Python. Edit mode shows which in its toolbar.

To have a button run your own Python, register the function as an action in a procedure and pick that action for the button.

```python
@op.action("lab.normalize", title="Normalize", params={"wave": {"type": "wave", "title": "Wave"}})
def normalize(wave):
    return op.make(f"{wave.name}_norm", wave.data / np.nanmax(wave.data))
```

## Share a panel

**Export…** in edit mode saves the panel as a JSON file (`<name>.panel.json`); **Windows → Import Panel…** reads one. A panel whose name is taken comes in under another. Importing a panel that contains code says in the history which actions it calls.

## Build one from Python

```python
p = op.panel("quick_fit", title="Quick Fit")
p.wave("target", label="Spectrum", dims=1)
p.choice("model", ["gauss", "lor"], label="Model")
with p.row():
    p.number("n", "Points", value=5, min=1)
    p.checkbox("quiet", "Quiet", value=True)
p.button("run", "Fit", action="core.fit",
         args={"function": op.control("model"), "y": op.control("target")})
p["model"] = "lor"
r = p.press("run")
```

When the panel has a control of that name and kind already, the methods that add controls change its settings and keep its value, so a procedure that builds a panel can run again without losing what people have set.

[Panel API](../../reference/api/panel/) · [Actions API](../../reference/api/actions/) · [Call analyses by name](../python/#call-analyses-by-name)
