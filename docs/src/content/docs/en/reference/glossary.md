---
title: Glossary
description: What the words of OresmePro mean.
sidebar:
  order: 4
---

| Word                  | Meaning                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Wave**              | A named array of numbers (or text). Besides its values it has X (and Y) scaling (start, step, unit), a unit for its values, a note, and, if wanted, a formula. The same idea as Igor Pro's waves |
| **Scaling**           | The start and step that give each point its X (`x = x0 + i·dx`), so a wave has an X axis without an X wave                                                                                       |
| **X wave**            | Another wave used as the X values, for data that is not evenly spaced                                                                                                                            |
| **Text wave**         | A wave of text; on a graph it makes a category axis                                                                                                                                              |
| **Data folder**       | A level of the hierarchy waves are kept in; paths are separated by `:`, as in `run1:spectrum`. The top is `root`                                                                                 |
| **Sample attributes** | Named numbers or text (thickness, composition, temperature) given to a data folder or a wave. A wave has those of its folders too                                                                |
| **Formula**           | An expression that computes a wave from others (`ratio := a / b`), computed again when they change                                                                                               |
| **Experiment**        | Everything of a piece of work: waves, graphs, tables, procedures, files, results, the packages it uses. Saved in the browser by itself, and saved and shared as an `.oresme` file                |
| **Graph / trace**     | A graph is a window; a trace is one line (or markers) in it, drawn from a Y wave against an X wave or its scaling                                                                                |
| **Axis**              | left, bottom, right and top, and free axes added. Each has a range, log or not, ticks and a label                                                                                                |
| **Plot area**         | The rectangle the axes enclose. Its size can be Auto, Absolute, Aspect, Plan or Per unit                                                                                                         |
| **Cursor**            | A mark on a point of a trace, A (round) and B (square), to read values and differences and to choose a range                                                                                     |
| **Annotation**        | A legend, text, color scale or tag on a graph                                                                                                                                                    |
| **Style**             | The look of a graph (fonts, lines, colors, ticks) kept under a name; it holds no data                                                                                                            |
| **Graph template**    | A graph with its waves taken out, to make the same graph of other data                                                                                                                           |
| **Link**              | Graphs whose axis ranges and cursors move together                                                                                                                                               |
| **Page layout**       | Graphs and text arranged on paper, for a figure exported as PDF and more                                                                                                                         |
| **Table**             | A window of waves as columns, edited cell by cell                                                                                                                                                |
| **Procedure**         | A Python file kept in the experiment; its name is a module name that can be imported                                                                                                             |
| **Panel**             | A window of your own, of buttons and fields that call actions                                                                                                                                    |
| **Close and Kill**    | Close puts a window away and keeps what it shows, to reopen from the Windows menu; Kill deletes it with what it shows                                                                            |
| **Result**            | The record of an analysis such as a fit: coefficients, uncertainties, settings, fingerprints of its inputs, and copies of the curves it made (`results:<name>`)                                  |
| **Action**            | An analysis registered by name with typed arguments (`core.fit`), which panels, templates and plugins call                                                                                       |
| **Analysis template** | Steps of actions kept under a name, to do to many samples one after another                                                                                                                      |
| **Run**               | The record of a template done to samples: how each went, its error and results; the failed ones can be done again                                                                                |
| **Plugin**            | An extension that adds actions, templates, styles and more at once, run in a sandbox                                                                                                             |
| **Package**           | A Python library: shipped with the app, from the Pyodide distribution or from PyPI, and recorded per experiment                                                                                  |
| **Pyodide**           | Python running in the browser (WebAssembly); no data is sent to a server                                                                                                                         |
| **History**           | What was typed and printed, kept in the Command Window; what is done on screen is there too, as the Python that does the same                                                                    |
| **Undo**              | Takes back changes to the experiment; those in an `op.atomic()` block go back as one                                                                                                             |
