---
title: Use the Python API
description: Browse the public OresmePro Python API by task.
---

Use `import oresme as op` in the Command Window or a procedure. Python runs in the app's kernel. The JavaScript bridge applies wave and graph operations to the active experiment.

| Task                                                 | Reference                               | Example                                                                |
| ---------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| Create arrays and work with their values and scales  | [Wave](./api/wave/)                     | [Your first wave](../getting-started/)                                 |
| Create a graph, add traces, and reuse styles         | [Graph](./api/graph/)                   | [Graph editing](../guides/graphs/)                                     |
| Adjust display mode, color, and error bars           | [Trace](./api/trace/)                   | [Overlay traces](../examples/overlay/)                                 |
| Set limits, ticks, and labels                        | [Axis](./api/axis/)                     | [Multiple axes](../examples/multiple-axes/)                            |
| Display a numeric grid                               | [Image / Contour](./api/image-contour/) | [2-D image and contours](../examples/image-contour/)                   |
| Inspect a point on a trace                           | [Cursor](./api/cursor/)                 | [Cursors](../guides/axes-and-annotations/#inspect-points-with-cursors) |
| Arrange waves as columns                             | [Table](./api/table/)                   | [Tables](../guides/tables/)                                            |
| Organize waves in a hierarchy                        | [Folder](./api/folder/)                 | [Data folders](../guides/waves/#organize-waves-in-folders)             |
| Fit, summarize, and transform data                   | [Analysis](./api/analysis/)             | [FFT](../examples/fft/)                                                |
| Work with files, procedures, layouts, and time zones | [Global Functions](./api/global/)       | [Import a CSV file](../getting-started/import-csv/)                    |

## Signatures and errors

Signatures and docstrings come from the public Python module source. Pass arguments following `*` by keyword. Use creation functions (`op.display`, `op.edit`) or lookup functions (`op.graph`, `op.table`) to obtain objects representing windows.

The app reports rejected operations, such as a missing name, as `op.OresmeError`. Exceptions from NumPy and other Python operations can propagate as well. “Explicit exceptions” lists the `raise` expressions in the documented implementation.
