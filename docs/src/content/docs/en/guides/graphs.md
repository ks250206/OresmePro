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

[Graph API](../../reference/api/graph/) · [Trace API](../../reference/api/trace/) · [Overlay example](../../examples/overlay/)
