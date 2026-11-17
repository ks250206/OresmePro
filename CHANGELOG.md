# Changelog

All notable changes to OresmePro are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning

The version is `MAJOR.MINOR.PATCH`, kept in `package.json` and shown in **Help › About
OresmePro**. Each release is tagged `vMAJOR.MINOR.PATCH` and published as a GitHub release.

- **PATCH** (0.2.0 → 0.2.1): bug fixes that change nothing else.
- **MINOR** (0.2.0 → 0.3.0): new features that keep what was there working.
- **MAJOR** (0.x → 1.0.0, then 1.x → 2.0.0): changes that break something that worked, such
  as the Python API (`oresme`), the `.oresme` experiment file, or the plugin manifest.

Before 1.0.0, a breaking change may come in a MINOR version, and is then said so under
**Changed** or **Removed**. Experiments saved by an earlier version keep opening in later
ones.

Changes waiting for the next release go under **Unreleased** as they are merged.

## [Unreleased]

### Added

- Plugins can declare **model editors** (`editors` in `oresme-plugin.json`): windows the app
  draws, in the way of CasaXPS, for building a model of a spectrum out of items (peaks,
  components) and fitting it with two of the plugin's actions. The data are drawn with the range
  fitted, its background, each item, the sum and the residual; the range's ends are dragged on
  the plot, an item is added by double-clicking, moved and made taller by dragging its top and
  widened by its half-width handles; the items are a table with a column for each (their fields
  and the constraint of each, a tied value following the item it is tied to), with Create, Copy,
  a tied partner (a doublet, say) and Delete. While the model is edited the plugin's preview
  action computes what is drawn, in its sandbox, recorded nowhere and changing nothing; Fit runs
  its fit action, kept in the history and among the results, and takes what it found back into
  the table and a Report tab. Edits and fits are undone in the window, and data fitted before
  open with their last fit. What dragging does to an item's fields is the plugin's to say
  (`drag`: the field set to X, one scaled with the height or set to it, one set by the width
  and those scaled with it). No code of the plugin runs in the app: the description is data,
  checked field by field when the plugin is installed. Each editor names its kind; the only
  kind so far is `spectrum-fit`. Editors are listed in the Analysis menu
  and in Python › Plugins….
- Plugins can have **views**: editors of kind `view`, whose window their Python builds out of
  the app's parts (rows, columns, splits, tabs, groups, text, number, text and choice fields,
  checkboxes, wave choices, editable tables, plots with log and equal axes, buttons) and whose
  events it answers, in its sandbox, with the state the app keeps for it. What is entered goes
  into the state at once and to the view in turn; edits are undone in the window; only buttons
  that run one of the plugin's actions change the experiment, recorded and kept as any run. The
  app checks every part and prop before drawing, and draws no HTML or script of the plugin. The
  design is in `docs/design/plugin-views.md`.
- Plots in views can have **handles** (points, or lines across the plot) that are dragged to
  move the values of the state they are bound to, by as much (or by the same ratio on a log
  axis), one drag one undo; and `on_click`, which tells the view where the plot was clicked.
- Views have a **nodes** part: a diagram of boxes joined at their ports, edited in the window
  (added from a palette, moved, wired port to port, taken out), its meaning the view's to read.
- What plugins' editors and views hold is **kept in the experiment** with the plugin's name and
  version, and saved with it: opened again, they go on from where they were left. It is not
  undone with the experiment's undo, and a state that cannot be read is left behind.
- The example plugin electrochem (0.3.0) has the view **EIS Circuit Fitting**: a circuit,
  written as text or drawn as a diagram (each following the other), and its parameters, drawn
  on Nyquist and Bode plots at each edit, guessed from the spectrum and fitted with
  `eis_circuit`, the values found coming back into the table.
- The example plugin xps (0.3.0) has the view **XPS Quantification**: regions of a survey or of
  narrow scans, added by clicking the spectrum and moved by dragging their bounds, with their
  areas over a background and atomic % worked out at each edit (Scofield's RSFs for C, N, O and
  F 1s when none is given), and Quantify to keep the result.
- The arguments of plugins' actions can be of type `json` (lists and dicts), as the app's own.
- `op.invoke(..., replace=True)` makes again, under their names, the waves the last run of the
  same action of the same plugin on the same input waves made (as its result kept them), where
  they are still as that run left them, and updates the graph it made: traces are added and taken
  out, the look and axes stay, and waves no longer made are killed if nothing shows them. Waves
  changed or renamed since, and everything else, are left alone, and new names are used. A model
  editor fits this way. A plugin itself still never chooses what it overwrites.
- The example plugin xps has the model editor **XPS Peak Fitting**, for fitting
  synthetic components with CasaXPS's line shapes and constraints over a Shirley, linear or
  Tougaard background on the spectrum and in a table; `xps_fit` also takes the components as a
  list of dicts with constraints written as in CasaXPS (`"284, 286"`, `"fixed"`, `"A+1.5"`),
  and backgrounds may be Tougaard. A guide to it is in the documentation.
- **Edit › Copy Graph** (⌘C / Ctrl+C with a graph in front, and **Copy** in a graph's menu)
  puts the graph on the clipboard as a PNG, as Save Graph as PNG draws it.
- **Graph › New Graph…**, as in the Windows menu.
- pybaselines comes with the app, like lmfit: `import pybaselines` works offline.
- The electrochem example plugin fits any equivalent circuit written as text, as impedance.py
  writes them (`eis_circuit`: `R0-p(R1,CPE1)-W1`, with R, C, L, CPE, W, Wo and Ws), without
  impedance.py and the matplotlib and altair it needs.
- Optuna is among the recommended packages of **Python › Packages…**.
- An example plugin for XPS peak fitting in the way of CasaXPS (`examples/plugins/xps`):
  `xps_fit` fits synthetic components over a Shirley or linear background in a region, with
  CasaXPS's line shapes (GL, SGL, GL(m)T(k), LA(α,β), optionally convolved with a Gaussian)
  and constraints between components (`pos=A+1.5`, `area=A*0.5`, `fwhm=A`), and draws the fit
  on a reversed binding energy axis with the residual above; `quantify` gives atomic
  concentrations from region areas and sensitivity factors.
- Errors say what kind of refusal they are: a code (`INVALID_ARGUMENT`, `NOT_FOUND`,
  `ALREADY_EXISTS`, `IN_USE`, `CONFLICT`, `UNSUPPORTED`, `PLUGIN_FAILED`, `INTERNAL`) and
  details (what was not found, which argument, what uses it, at which phase a plugin failed),
  from the app through to Python. Python raises a class for each code (`op.NotFoundError`,
  `op.InvalidArgumentError`, ...), all of them `op.OresmeError`; `InvalidArgumentError` is
  also a `ValueError` and `NotFoundError` a `LookupError`. The codes are part of the API.
- A run stopped with Python › Interrupt, or by restarting Python while it ran, is recorded as
  stopped (■), not as failed (red); a plugin stopped while it runs is too.
- A dialog or a plugin action's form marks in red the field a refusal is about (an argument out
  of range, a name that is taken), and moves the focus to it.
- A plugin's failure says where it failed (starting its sandbox, loading, running, the time
  limit, or what it returned), in the history and in the action's form.
- The Python guide explains the codes, their details, stopped runs and plugin failures.
- Igor binary waves of version 7 load, in `.ibw` files and in packed experiments. Igor 8
  and later write them in place of version 5 for a wave whose name or a dimension label is
  longer than 31 bytes; the long name is kept. Versions 6 and 8, Igor's undocumented format
  for waves of 2 GB or more, are refused with a reason.
- The example plugin ternary (0.2.0) draws its points with the marker shape, color, size and
  fill asked for (`marker`, `marker_color`, `marker_size`, `marker_fill`), in the action and
  in its panel.
- A plugin's `wave` or `waves` argument with `"text": true` takes text waves too; its `Wave`
  then holds an array of `str` (`.is_text`). Without it, a text wave is refused before the run,
  naming the argument. Wave pickers and lists in panels list text waves with **Text waves too**
  (`text=True` in Python), as the form of such an argument does.
- A panel's button leaves out an argument the action can do without when its Wave Picker has no
  wave chosen, instead of asking for one.
- The example plugin ternary (0.3.0) draws groups apart: `group` names the group of each point
  (a crystal structure, say) in a text or numeric wave, and each group gets a marker and a color
  of its own (`group_markers`, `group_colors`, or else in turn) and a line in the legend.

### Changed

- **Python › Packages…** lists every package in Python until **Imported only** is ticked, folds
  the recommended packages away under **Recommended**, and lets the experiment's own packages be
  folded away too.
- The command window names the kind of error (`NotFoundError: No wave named "x".` where it
  said `OresmeError: ...`), and `ValueError`s the Python API raised for bad arguments are
  `InvalidArgumentError`s, which are still `ValueError`s.
- An action called from the app (`kernel.invoke`) that Python refuses is rejected with the
  message alone (no `OresmeError: ` before it), with its code and details; one that was
  interrupted is rejected as stopped.
- An Igor file that cannot be read (not from Igor, damaged, or of a version this reader does
  not know) is refused as `UNSUPPORTED`, and `op.load_igor` raises `op.UnsupportedError`
  for it, where it was `INTERNAL`.
- Editing a wave's note or unit, or its scaling or name, no longer writes its numbers to the
  browser's storage again or sends them to Python again; editing its note or unit no longer
  computes again the formulas made from it, or its own.

### Fixed

- On a Mac, Shift+Option+F formats a procedure, Option+G goes to a line, and Option+F takes
  the next word of the command line's suggestion. Option turns those keys into other
  characters (Ï, ©, ƒ), so they did nothing; they are now matched by the key's place.
- A plugin's view follows its data: while its window is open, a wave it was given that changes
  (from Python or a table, say) or is killed is told to it as a `change`, as if it had been
  chosen again, rather than staying drawn as it was until the next edit in the window.
- Load Data no longer stalls on a large file: telling its dialog from the one before it
  turned the file's bytes into text, some 12 characters a byte, again at every redraw.

## [0.3.0] - 2026-11-17

### Added

- With the drawing tools out, ⌘A / Ctrl+A selects every drawing, and Shift-click adds to the
  selection; drawings selected are moved and removed together.

### Changed

- Show Tools is ⌥T / Alt+T: browsers keep ⌘T / Ctrl+T for a new tab and never pass it on.

### Fixed

- A drawing pinned to the axes keeps its points as they are: rounding them to six significant
  digits moved it, by over 20 minutes on a date axis.
- Dragging a corner of a rectangle or oval past the opposite corner no longer moves that corner.

## [0.2.0] - 2026-11-17

The first version numbered: OresmePro as it was built up to here.

### Added

- Waves, data folders and sample attributes; tables; graphs with traces, images and contours,
  error bars, fills, color waves, text markers, multiple and hidden axes, labels and their
  rotation, margins, plot area sizes, magnification, cursors, legends, tags and text boxes;
  linked graphs; styles and graph templates; page layouts; notes in Markdown.
- Drawing tools on graphs (Graph › Show Tools): lines, arrows, rectangles, ovals, polygons and
  text, pinned to the plot area or to the axes.
- Analysis: curve fitting (with hold, bounds, ranges, weights), multi-peak fits, backgrounds,
  onsets, statistics, derivatives, integrals, smoothing, FFT, histograms, interpolation, image
  filters; kept results; analysis templates run on many samples.
- Python in the browser (Pyodide) with the `oresme` API: procedures (run in the command line's
  names or as a module), checking them without running them, the Procedure Browser, the
  Variables window, packages from the Pyodide distribution and PyPI (`%pip`), actions and panels.
- Plugins installed from GitHub, a folder or a zip, run in a sandbox, that can return graphs;
  example plugins for electrochemistry and ternary diagrams.
- Loading CSV and other delimited text, Excel, Igor (`.ibw`, `.pxp`), Parquet and HDF5;
  experiments saved in the browser and as `.oresme` files; export to PDF, SVG and PNG.
- Documentation in Japanese and English, with a reference of the Python API.

[Unreleased]: https://github.com/ks250206/OresmePro/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ks250206/OresmePro/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ks250206/OresmePro/releases/tag/v0.2.0
