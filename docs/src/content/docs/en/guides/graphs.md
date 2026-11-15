---
title: Create and edit graphs
sidebar:
  order: 2
---

Choose **Windows → New Graph…** and select a Y wave. Supply an X wave or use each Y wave's own scaling. With the graph selected, choose **Graph → Append Traces…** to add traces.

## Edit traces

Open the plot's context menu to edit a trace or axis. Changing the line color, marker, or display mode leaves the wave values intact. For X or Y error bars, supply a wave with the corresponding number of points. To display complex values, choose the real part, imaginary part, magnitude, or phase.

```python
y = op.make("response", [0.1, 0.3, 0.7, 0.8])
g = op.display(y, name="Response")
g.trace().set(mode="lines+markers", color="#ab1831")
```

## Plot area size

By default the plot area (the rectangle the axes enclose) is what the window leaves after the margins. To give it a length, as a figure for a paper needs, choose a mode for its width and its height under **Plot area** in **Modify Graph**. The modes follow Igor Pro's ModifyGraph `width` and `height`.

| Mode     | Meaning                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto     | Follow the window (the default)                                                                                                                                            |
| Absolute | A fixed length (pt, cm or inch; 1 inch = 72 pt)                                                                                                                            |
| Aspect   | f times the other side                                                                                                                                                     |
| Plan     | One unit of the horizontal axis is f times as long as one unit of the vertical axis (the other way round for the height); f = 1 scales both alike, as a Nyquist plot needs |
| Per unit | A length for each unit of an axis (2 cm per volt, say)                                                                                                                     |

The margins stay automatic. In a side that is not Auto, the figure is the plot area plus the margins and the window is resized to fit it; resizing the window by hand does not change that side. Plan and Per unit follow the axes' ranges, so the size changes when a range or the autoscale does. A unit of a log axis is a decade. The width and the height cannot both be Aspect or Plan.

One layout unit is a CSS pixel (1/96 inch) on screen and in SVG and PNG files, and a graph's PDF is written at 0.75 pt to the unit, so 8 cm is 8 cm on screen and in the PDF (rounded to whole pixels, within 0.13 mm). Absolute lengths go from 12 to 3000 pt, and computed sizes are held between 16 and 4000 pixels. In a page layout the plot area has the same length on paper, drawn from the top left of the graph's box. A style saved with its size keeps Auto, Absolute and Aspect; graph templates and `g.script()` keep every mode.

```python
g.set(width=op.cm(8), height=("aspect", 0.75))
g.set(width=("plan", 1, "bottom", "left"), height=op.cm(6))
g.set(width=("per_unit", 2, "cm", "bottom"))
g.set(width="auto")
g.width   # read back in the same form: op.cm(8), ('aspect', 0.75), ...
```

## Reuse and export

Apply a saved graph style to another graph in the experiment. `g.script()` returns Python code to recreate the graph in an experiment containing the required waves. Use `g.save("response.svg")` or **File → Save Graph as PDF / SVG / PNG** to share the figure.

## Graph templates

To make the same figure from another sample's data, save the graph as a template. Choose **Save as Template…** from the graph's context menu. Each wave the graph plots becomes a slot (`y`, `x`, `yerr` and `xerr` for error bars, `color` for a color wave, `z` for an image or contours); the traces, axes, look, annotations, and figure size are kept. With several traces, slots are numbered: `y1`, `y2`. For each axis, choose when saving whether its range stays fixed or follows the new data.

In annotations and axis labels, `{y.name}` and `{y.unit}` become the name and unit of the wave in slot `y`. Text that names a wave of the original graph, or a unit in parentheses such as `(A)`, is turned into such a reference when the template is saved, so a figure of another sample does not keep the old sample's name.

Choose **Graph → Make Graphs from Template…**, select a template, and choose a wave for each slot in each row. Each row makes one graph, and one undo removes them all. A warning appears when a wave's unit differs from the one the template was made with. Templates are saved in the experiment and, like styles, can be kept in the browser's library or in JSON files.

```python
t = op.graph_template(g, "IV", fixed="bottom")
t.make(y=["s1_I", "s2_I", "s3_I"], x=["s1_V", "s2_V", "s3_V"])
```

[Graph API](../../reference/api/graph/) · [Trace API](../../reference/api/trace/) · [Overlay example](../../examples/overlay/)
