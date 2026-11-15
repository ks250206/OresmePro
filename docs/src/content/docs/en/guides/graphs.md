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

## Reuse and export

Apply a saved graph style to another graph in the experiment. `g.script()` returns Python code to recreate the graph in an experiment containing the required waves. Use `g.save("response.svg")` or **File → Save Graph as PDF / SVG / PNG** to share the figure.

## Graph templates

To make the same figure from another sample's data, save the graph as a template. Choose **Save as Template…** from the graph's context menu. Each wave the graph plots becomes a slot (`y`, `x`, `yerr` and `xerr` for error bars, `color` for a color wave, `z` for an image or contours); the traces, axes, look, annotations, and figure size are kept. With several traces, slots are numbered: `y1`, `y2`. For each axis, choose when saving whether its range stays fixed or follows the new data.

In annotations and axis labels, `{y.name}` and `{y.unit}` become the name and unit of the wave in slot `y`. Text that names a wave of the original graph is turned into such a reference when the template is saved, so a figure of another sample does not keep the old sample's name.

Choose **Graph → Make Graphs from Template…**, select a template, and choose a wave for each slot in each row. Each row makes one graph, and one undo removes them all. A warning appears when a wave's unit differs from the one the template was made with. Templates are saved in the experiment and, like styles, can be kept in the browser's library or in JSON files.

```python
t = op.graph_template(g, "IV", fixed="bottom")
t.make(y=["s1_I", "s2_I", "s3_I"], x=["s1_V", "s2_V", "s3_V"])
```

[Graph API](../../reference/api/graph/) · [Trace API](../../reference/api/trace/) · [Overlay example](../../examples/overlay/)
