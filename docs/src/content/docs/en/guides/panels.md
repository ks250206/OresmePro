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
| Wave List   | A list of waves, narrowed as a Wave Picker's, to select one or several from |
| Plot        | A small graph, which takes its waves from the active graph                  |
| Choice      | A menu of options                                                           |
| Number      | A number, with a minimum, maximum and step if wanted                        |
| Text Field  | A field for text                                                            |
| Checkbox    | True or false                                                               |
| Button      | Calls a registered action                                                   |

Controls are laid out one to a line from the top; **On the line before** puts a control beside the one before it. Reorder them with ↑ ↓ (**Alt+arrow keys**) and remove them with **Delete**. Press **Done** in the title bar to stop editing; **Edit** in the title bar, or right-click → **Edit Panel**, edits it again.

## Place controls where you want

Besides laying them out in lines, you can put controls anywhere, as in an Igor panel.

- In edit mode, **drag** a control to put it there (x, y: pixels from the panel's top left). A placed control is out of the lines and sits over the other controls; those in lines go on as if it were not there
- Drag the **handle** at the bottom right of the selected control to size it (w, h)
- The **arrow keys** move it a pixel, **Shift+arrow keys** ten. A control in a line that is moved gets a place of its own
- Where controls overlap, the one with the higher z is drawn in front. **Front** / **Back** in the toolbar, or right-click → **Bring to Front** / **Send to Back**, move it in front of or behind the others
- Right-click → **Return to Line** puts a placed control back in its line

**Look and Place** in the form on the right gives a control the color of its words (**Color**) and the color behind it (**Background**), its place (**Placed by x and y**, **X**, **Y**), its size (**Width**, **Height**; empty for the size of its content) and its **Z** as numbers. **None** takes a color away. Each drag, each color picked and each run of arrow keys is one undo step, recorded as `op.panel("free").control("go").set(x=200, y=150)`, say.

## Wave List and Plot

A **Wave List** lists the waves that pass its filter. Its value is the list of the names selected, which a button passes to an argument that takes several waves (`waves`). Clear **Select several** to allow one only. It follows its waves when they are renamed; a killed wave is shown as **missing**.

A **Plot** is a small graph in the panel. **From Graph** at its top right (**Take from Active Graph** in the form) gives it the waves of the traces of the frontmost graph, the active one. A new Plot starts with the waves of the active graph. Its waves can also be written in **Waves** in the form, one on each line as `y` or `y vs x`. With **Live** it draws the active graph itself, as it changes, instead of waves of its own. **Width** and **Height** give its size.

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

A Wave Picker holds a wave's name. It follows the wave when it is renamed; when the wave is killed, the name stays and is shown as **missing**. So do the waves of a Wave List and a Plot.

The place, size, colors and z of the controls are saved with the experiment and in exported JSON too. Those left as they usually are are not written, so a panel that uses none of them can still be read by earlier versions of the app.

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

Each method that adds a control also takes its look and place as keywords: `color` and `background` (`"#rrggbb"`, a color name or `(r, g, b)`), `x` and `y` (where it is placed), `w` and `h` (its size), and `z` (the order of overlapping controls).

```python
# An action that averages the waves selected (registered in a procedure)
@op.action("lab.average", title="Average", params={"waves": {"type": "waves", "title": "Waves"}})
def average(waves):
    return op.make("average", np.mean([w.data for w in waves], axis=0))

p = op.panel("free", title="Free")
p.heading("top", "Spectra", x=10, y=8, color="#2a6fd6")
p.list("waves", "Waves", dims=1, x=10, y=36, w=160, h=140)
pv = p.plot("preview", x=190, y=36, w=280, h=160)
pv.take_from_graph()                     # the waves of the frontmost graph
p.button("run", "Average", action="lab.average", args={"waves": op.control("waves")},
         x=10, y=190, w=160, background="orange")
p.control("top").bring_to_front()        # send_to_back() for behind
p.control("run").place(10, 200)          # unplace() puts it back in its line
```

`p.data` and `op.set_panel(name, data)` read and write each control's `x`, `y`, `w`, `h`, `color`, `background` and `z` as they are.

[Panel API](../../reference/api/panel/) · [Actions API](../../reference/api/actions/) · [Call analyses by name](../python/#call-analyses-by-name)
