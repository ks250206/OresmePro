---
title: Save and open experiments
sidebar:
  order: 9
---

An experiment contains waves, folders, graphs, tables, procedures, attached files, and analysis results.

## Resume work in the browser

Use **File → New Experiment** to start and **File → Experiments…** to reopen an experiment saved in the browser. Check the status bar for save progress. When multiple tabs have the same experiment open, one tab handles saves.

Autosave relies on the browser's OPFS. Clearing site data can remove these copies. Export a file when you need a portable copy.

## Save and restore a file

1. Choose **File → Save Experiment As…** (**Ctrl+S** / **⌘S**), type a file name and download it as an `.oresme` file. The experiment's name is offered, and `.oresme` is added.
2. Restore it with **File → Open Experiment…** or drop the file on the workspace.
3. When opening a file with an auto-run procedure, OresmePro asks whether to run it. You can defer execution until you inspect the code.

## Close, kill and rename windows

The × at the top left of a window asks whether to **Close** or **Kill** it.

- **Close** closes the window and keeps what it shows (the graph, table, procedure and so on) in the experiment. It is listed as "(closed)" under its kind in the **Windows** menu (Graphs, Tables, Procedures, Layouts, Panels), and choosing it opens the window again with the data as it is then, as Igor's window recreation macros do. A closed graph still uses its waves: kill the window to delete them.
- **Kill** removes the window and what it shows. The waves it showed stay.

Both can be undone. Alt-click (Option-click) the × to kill a window without being asked.

Rename a window by double-clicking its title bar, with **Windows → Rename Window…**, or from its right-click menu. Page layouts that show a renamed graph follow it. **New Graph**, **New Table** and **New Procedure** take a name when the window is made.

```python
op.close_window("Graph0")          # or g.close()
op.reopen_window("Graph0")         # g.reopen()
op.rename_window("Graph0", "Spectrum")
op.kill_window("Table0")
op.windows("graph", closed=False)  # the names of the open graphs
```

## Write notes

**Windows → New Note** makes a note: a window of text written in Markdown, as Igor's notebooks are. It is saved with the experiment, so what was done, under which conditions, and what the results mean stay with the data.

- **Split** shows what you type on the left and the formatted text on the right as you type. **Edit** shows only the text, **View** only the formatted note. A note with something in it opens in View
- Headings, emphasis, lists, quotes, code, tables and links work
- Right-click for **Export as name.md**; **Windows → Import Markdown as Note…** takes in `.md` files

So that a note in an experiment from someone else is safe to open, what it shows is limited:

- HTML in the text (`<script>` and the like) is shown as text
- Links go only to http, https and mailto addresses, and open in a new tab
- A picture is shown only when its data is in the text (`data:image/png;base64,...`). One at an address is not loaded: it is shown as a link to it

```python
n = op.new_note("log", "# Run 12")
n.append(f"Peak at {r.coef[1]:.3g} eV")  # adds a paragraph at the end
print(n.text)
```

[Persistence implementation](../../architecture/#opfs-persistence)
