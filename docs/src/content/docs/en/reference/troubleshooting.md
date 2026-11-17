---
title: Troubleshooting
description: Common problems, what causes them and what to do.
sidebar:
  order: 5
---

## Python

| Problem                                                                     | Cause and what to do                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The status bar stays at "Starting Python…" or "Loading NumPy and IPython…"  | The first time, Python and its packages are downloaded; after that the browser keeps them. If nothing moves, reload the page                                                                                                                                             |
| A long computation does not stop                                            | **Python → Interrupt** (**Ctrl+C**); pressing it again restarts Python. Waves and graphs stay                                                                                                                                                                            |
| `ModuleNotFoundError`                                                       | Packages of the Pyodide distribution (SciPy, pandas, ...) load when imported. Install others with `%pip install name` or **Python → Packages…**                                                                                                                          |
| `%pip install` says "No wheel that runs in the browser for: …"              | The package has compiled code of its own and no wheel built for Pyodide (pymatgen-core, Numba, PyTorch, say). It cannot run in the browser; use another Python. [Packages in Pyodide](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) lists those that can |
| Packages do not install offline                                             | A package installed for the first time needs the network. Those installed before, and those the app ships (keep them ahead of time with **Python → Keep Optional Packages for Offline Use**), install offline                                                            |
| Opening an experiment asks "uses Python packages from PyPI … Install them?" | An `.oresme` file from someone else uses packages from PyPI, whose code runs when imported. To install them later: **Python → Packages… → Install Them**                                                                                                                 |
| `await` does not work                                                       | In the command line `await` works as it is. It does not inside a procedure (`p.run()`): record the packages in the experiment so they install when it opens, or install them from the command line                                                                       |

## Data and graphs

| Problem                                           | Cause and what to do                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A wave cannot be killed (in use by …)             | A graph or table uses it. Take the trace or column away, or kill the window. A closed window still uses its waves                                                  |
| A CSV column comes in as text                     | Set the column's type in the Load Data preview; keep the settings of a recurring file as a preset                                                                  |
| A fit's uncertainties are NaN                     | Its parameters are not determined independently (its reason says the uncertainties could not be estimated). Use fewer parameters or hold some, or change the range |
| A graph's window cannot be resized                | Its plot area's width or height has a size of its own (**Modify Graph → Plot area**)                                                                               |
| An exported figure is another size than on screen | Magnification (**Modify Graph → Magnification**) is for the screen only; exports are at the graph's own size                                                       |
| A window is gone                                  | A closed window is listed as "(closed)" under its kind in the **Windows** menu                                                                                     |

## Saving

| Problem                                                                 | Cause and what to do                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The Experiment Is Not Saved" when opening another experiment           | It could not be saved in the browser (no room, say). **Try Again**, **Save as File…** to keep a `.oresme` copy, or leave without saving                                                                                |
| The status bar says "The saved experiment could not be read: not saved" | Some of its saved files are missing; what could be read is there. Choose **Go Back to Backup** (the session before) or **Start Afresh** (save it as it is now). Nothing is saved over until you do                     |
| The status bar says "Open in another tab: not saved here"               | The experiment is open in another tab too, and only one tab saves it. **Save Here Instead** makes this tab the one. A tab that does not save asks before it opens another experiment or closes with changes of its own |
| The status bar says "Not saved: …"                                      | It could not be saved in the browser. **Try Again**; if the browser is out of room, delete experiments you do not need in **File → Experiments…**, or save to a file                                                   |
| Clearing the browser's data lost an experiment                          | Saving is in the browser (OPFS). Keep what you take elsewhere as a file with **File → Save Experiment As…**                                                                                                            |
