---
title: Use the Python API
description: Browse the public OresmePro Python API by task.
---

Use `import oresme as op` in the Command Window or a procedure. For code you use often see the [Python cheat sheet](./python-cheatsheet/); for what the screen does, [Menus](./menus/) and [Mouse and keys](./mouse-and-keys/); for words, the [Glossary](./glossary/); and when something goes wrong, [Troubleshooting](./troubleshooting/). Python runs in the app's kernel. The JavaScript bridge applies wave and graph operations to the active experiment.

| Task                                                 | Reference                                    | Example                                                                     |
| ---------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| Create arrays and work with their values and scales  | [Wave](./api/wave/)                          | [Your first wave](../getting-started/)                                      |
| Create a graph, add traces, and reuse styles         | [Graph](./api/graph/)                        | [Graph editing](../guides/graphs/)                                          |
| Adjust display mode, color, and error bars           | [Trace](./api/trace/)                        | [Overlay traces](../examples/overlay/)                                      |
| Set limits, ticks, and labels                        | [Axis](./api/axis/)                          | [Multiple axes](../examples/multiple-axes/)                                 |
| Display a numeric grid                               | [Image and Contour](./api/image-contour/)    | [2-D image and contours](../examples/image-contour/)                        |
| Inspect a point on a trace                           | [Cursor](./api/cursor/)                      | [Cursors](../guides/axes-and-annotations/#inspect-points-with-cursors)      |
| Arrange waves as columns                             | [Table](./api/table/)                        | [Tables](../guides/tables/)                                                 |
| Organize waves in a hierarchy                        | [Data Folders and Attributes](./api/folder/) | [Data folders](../guides/waves/#organize-waves-in-folders)                  |
| Fit, summarize, and transform data                   | [Analysis](./api/analysis/)                  | [FFT](../examples/fft/)                                                     |
| Call analyses by name with typed arguments           | [Actions](./api/actions/)                    | [Call analyses by name](../guides/python/#call-analyses-by-name)            |
| Apply the steps of an analysis to many samples       | [Analysis Templates](./api/templates/)       | [Batch runs](../guides/curve-fitting/#apply-the-same-steps-to-many-samples) |
| Build panels of buttons and fields that run analyses | [Panels](./api/panel/)                       | [Panels](../guides/panels/)                                                 |
| Load files                                           | [Loading Files](./api/files/)                | [Import a CSV file](../getting-started/import-csv/)                         |
| Use graph styles and graph templates                 | [Styles and Graph Templates](./api/styles/)  | [Graph templates](../guides/graphs/#graph-templates)                        |
| Arrange graphs and text on a page                    | [Page Layout](./api/layout/)                 | [Layout menu](./menus/#layout)                                              |
| Rename, close and reopen windows                     | [Windows](./api/windows/)                    | [Menus](./menus/#windows)                                                   |
| Work with Python files kept in the experiment        | [Procedures](./api/procedure/)               | [Python](../guides/python/)                                                 |
| Install and list Python packages                     | [Packages](./api/packages/)                  | [Add packages](../guides/python/#add-packages)                              |
| Errors, changes made at once, and time zones         | [General](./api/global/)                     | [Python](../guides/python/)                                                 |

## Signatures and errors

Signatures and docstrings come from the public Python module source. Pass arguments following `*` by keyword. Use creation functions (`op.display`, `op.edit`) or lookup functions (`op.graph`, `op.table`) to obtain objects representing windows.

The app reports rejected operations, such as a missing name, as `op.OresmeError`. Exceptions from NumPy and other Python operations can propagate as well. “Explicit exceptions” lists the `raise` expressions in the documented implementation.
