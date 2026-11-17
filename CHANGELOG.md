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

### Changed

- The command window names the kind of error (`NotFoundError: No wave named "x".` where it
  said `OresmeError: ...`), and `ValueError`s the Python API raised for bad arguments are
  `InvalidArgumentError`s, which are still `ValueError`s.
- An action called from the app (`kernel.invoke`) that Python refuses is rejected with the
  message alone (no `OresmeError: ` before it), with its code and details; one that was
  interrupted is rejected as stopped.

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
