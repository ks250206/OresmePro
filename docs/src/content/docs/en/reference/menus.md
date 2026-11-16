---
title: Menus
description: Every item of the menu bar, what it does, and the Python that does the same.
sidebar:
  order: 1
---

The items of the menu bar, menu by menu. Most of what is done on screen is written into the Command Window's history as the Python line that does the same (the "Python" column below). Right-clicking the desktop (where there is no window) gives the same menus as submenus. The **?** at the bottom left of a dialog opens its page of this documentation.

## File

| Item                          | Does                                                                      | Python / note       |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------- |
| New Experiment                | Starts a new experiment; the one that was open stays in the browser       |                     |
| Experiments…                  | The experiments kept in the browser: open, rename, delete                 |                     |
| Open Experiment…              | Opens an `.oresme` file (dropping it works too)                           |                     |
| Save Experiment As…           | Saves it as an `.oresme` file under a name you type (**Ctrl+S** / **⌘S**) |                     |
| Go Back to Opening State…     | Returns to the experiment as it was when it was opened                    |                     |
| Add Files for Python…         | Puts any files in the experiment, for Python to open by name              | `open("name.txt")`  |
| Save Graph as PDF / SVG / PNG | Exports the frontmost graph                                               | `g.save("fig.pdf")` |

## Edit

| Item | Does                                                                       |
| ---- | -------------------------------------------------------------------------- |
| Undo | Takes back the last change (**Ctrl+Z** / **⌘Z**); in an editor, its typing |
| Redo | Does it again (**Ctrl+Y** / **⇧⌘Z**)                                       |

## Data

| Item                        | Does                                                          | Python / note                                |
| --------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| Make Waves…                 | Makes waves (points, type, values, scaling)                   | `op.make("w", n=100)`                        |
| Set Wave Values…            | Sets a wave's values from an expression or numbers            | `w.data = ...`                               |
| Recalculate Formulas        | Computes formulas that are not automatic again                | `op.recalculate()`                           |
| Load Delimited Text…        | Loads CSV, TSV or whitespace-delimited text, after a preview  | `op.load_text("data.csv")`                   |
| Load Excel Workbook…        | Loads `.xlsx` / `.xlsm`                                       | `op.load_excel("book.xlsx")`                 |
| Load Igor Files…            | Loads `.ibw`, `.pxp`, `.pxt`                                  | `op.load_igor("run.pxp")`                    |
| Load Parquet or HDF5 Files… | Loads Parquet and HDF5                                        | `op.load_parquet(...)` / `op.load_hdf5(...)` |
| New Data Folder…            | Makes a data folder                                           | `op.new_folder("run1")`                      |
| Sample Attributes…          | A table of the attributes of samples (data folders, waves)    | `op.set_attributes("run1:", thickness=12)`   |
| Time Zone for Dates…        | The time zone dates are shown and typed in                    | `op.set_time_zone("Asia/Tokyo")`             |
| Change Wave Scaling…        | X (and Y) start, step and unit of the wave selected           | `w.set_scale(x0, dx, "s")`                   |
| Change Wave Type…           | Its number type (float32, int16, complex128, ...)             | `w.redimension("float32")`                   |
| Rename or Move Wave…        | Renames it; `folder:name` moves it into a folder              | `w.rename("new")`                            |
| Kill Selected Waves         | Deletes the waves selected (not those a graph or table shows) | `op.kill(w)`                                 |

## Analysis

| Item                                                                                   | Does                                                                       | Python                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| Curve Fitting…                                                                         | Fits a function (hold, bounds, ranges, weights, residuals, band)           | `op.fit("gauss", y)`                   |
| Multi-peak Fit…                                                                        | Fits several peaks at once                                                 | `op.fit_peaks(y)`                      |
| Results…                                                                               | The fits kept: compare, fit again, make templates, plot                    | `op.results()`, `op.plot_results(...)` |
| Templates…                                                                             | Makes and edits analysis templates and runs them on many samples           | `op.template("Peak").run([...])`       |
| Background…                                                                            | Shirley, Tougaard or linear background                                     | `op.background(y, "shirley")`          |
| Onset…                                                                                 | Where an edge starts (its tangent meets the baseline)                      | `op.onset(y, edge=(...))`              |
| Wave Stats… / Differentiate… / Integrate… / Smooth… / FFT… / Histogram… / Interpolate… | Statistics, derivative, integral, smoothing, FFT, histogram, interpolation | `op.stats`, `op.differentiate`, ...    |
| Filter Image…                                                                          | Filters a 2-D wave                                                         | `op.filter_image(img, ...)`            |

## Graph

These act on the frontmost graph.

| Item                                             | Does                                                                                | Python                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| Append Traces… / Append Image… / Append Contour… | Adds traces, an image or contours                                                   | `g.append(y)`, `g.append_image(m)`         |
| Add Axis…                                        | Adds a free axis                                                                    | `g.add_axis("right2", "right")`            |
| Modify Trace Appearance…                         | Lines, markers, colors, error bars, fills                                           | `g.trace().set(color="red")`               |
| Modify Axis…                                     | Range, log, ticks, label, which labels show (on / axis only / off), label direction | `g.axis("left").set(log=True)`             |
| Modify Graph…                                    | Font, plot area size, margins, magnification                                        | `g.set(width=op.cm(8))`                    |
| Autoscale Axes                                   | Every axis back to automatic (**Ctrl+A** / **⌘A**)                                  | `g.axis("left").autoscale()`               |
| Show Cursor Info                                 | Shows or hides the cursor readout (**Ctrl+I** / **⌘I**)                             | `g.show_info = True`                       |
| Add Legend / Add Text… / Add Color Scale         | Puts a legend, text or a color scale                                                | `g.legend()`, `g.textbox("...")`           |
| Styles…                                          | Saves, gives and sets the default graph style                                       | `op.set_style(...)`, `op.apply_style(...)` |
| Save as Template… / Make Graphs from Template…   | Keeps a graph template and makes graphs of other data from it                       | `op.graph_template("T").make(...)`         |
| Recreation Script…                               | Shows the Python that makes this graph again                                        | `g.script()`                               |
| Link Graphs…                                     | Links the axes and cursors of graphs                                                | `op.link_graphs(g1, g2)`                   |

## Layout

These act on the frontmost page layout: adding graphs and text, aligning the items selected (edges and centers), distributing them, making them the same width, height or size, **Arrange in Grid…** and **Select All**. In Python, use `op.new_layout()` and the methods of `Layout`.

## Windows

| Item                                                          | Does                                                                        | Python                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| New Graph… / New Image Plot… / New Contour Plot… / New Table… | Makes a window (with a name if you give one)                                | `op.display(y)`, `op.edit(y)`                 |
| New Procedure…                                                | Makes a procedure (a Python file kept in the experiment)                    | `op.new_procedure("tools")`                   |
| New Note                                                      | Makes a note written in Markdown                                            | `op.new_note()`                               |
| New Page Layout / New Panel                                   | Makes a page layout or a panel                                              | `op.new_layout()`, `op.new_panel()`           |
| Import Procedure… / Import Panel…                             | Takes in a `.py` file or a panel's JSON; imported code does not run         |                                               |
| Import Markdown as Note…                                      | Takes in `.md` files as notes                                               |                                               |
| Rename Window…                                                | Renames the frontmost window (double-clicking its title bar too)            | `op.rename_window("G0", "Spectrum")`          |
| Close Window…                                                 | Close (keep what it shows) or Kill                                          | `op.close_window(...)`, `op.kill_window(...)` |
| Data Browser / Command Window                                 | Shows or hides them                                                         |                                               |
| Graphs / Tables / Procedures / Layouts / Panels / Notes       | The windows of each kind; closed ones say "(closed)" and reopen when chosen | `op.reopen_window(...)`                       |

## Python

| Item                                   | Does                                                                           | Python / note       |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------------------- |
| Interrupt                              | Stops Python (**Ctrl+C**); again restarts it                                   |                     |
| Restart Python                         | Restarts Python; waves, graphs and tables stay                                 |                     |
| Packages…                              | The experiment's packages, everything in Python, installing and removing       | `%pip install name` |
| Plugins…                               | Installs, manages and runs plugins                                             |                     |
| Plugin Actions                         | Opens the form of an action of a plugin turned on, in a window you can move    |                     |
| Keep Optional Packages for Offline Use | Keeps the packages the app ships (SciPy and more) in the browser ahead of time |                     |

## Help

**Documentation** (this site), **Python API Reference**, **Put an Example in the Command Line**, **OresmePro on GitHub**, **Report a Problem…** (a GitHub issue) and **About OresmePro**. The GitHub mark at the right end of the menu bar opens the repository too.

## Right-click menus of windows

| Where        | Main items                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph        | Modify Trace / Axis / Graph, Rename Graph…, Link Graphs…, Apply Style, cursors, zooming in and out                                                                     |
| Table        | Display, Set Wave Values…, Change Wave Scaling…, Rename or Move…, insert and delete rows, Rename Table…                                                                |
| Procedure    | Editing, formatting, find, Run Procedure, Run Selection, Run When the Experiment Opens, Rename Procedure…, Export as name.py, Import Procedure…                        |
| Note         | Rename Note…, Export as name.md, Import Markdown…                                                                                                                      |
| Page layout  | The items of the Layout menu, editing and removing items                                                                                                               |
| Data Browser | Waves: Display, Edit, Attributes…, Change Wave Scaling…, Rename or Move…, Duplicate…, Kill. Folders: Make Waves…, New Data Folder…, Attributes…, Rename or Move…, Kill |
