---
title: Mouse and keys
description: What the mouse and the keys do in graphs, tables, the command line, procedures, the Data Browser and windows.
sidebar:
  order: 2
---

On macOS read **Ctrl** as **⌘** and **Alt** as **Option**.

## Everywhere

| Do                          | What happens                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| **Ctrl+S**                  | Save Experiment As… (type a file name)                                                        |
| **Ctrl+Z** / **Ctrl+Y**     | Undo / Redo (Redo is **⇧⌘Z** on macOS)                                                        |
| **Ctrl+A**                  | Every axis of the frontmost graph back to automatic; in a page layout, selects every item     |
| **Ctrl+I**                  | Shows or hides the cursor readout of the frontmost graph                                      |
| **Ctrl+C** (Python running) | Stops Python                                                                                  |
| Right-click the desktop     | The menus of the menu bar                                                                     |
| Drop files                  | CSV and Excel open the Load Data dialog; Igor, Parquet and HDF5 load at once; `.oresme` opens |

## Windows

| Do                         | What happens                                                  |
| -------------------------- | ------------------------------------------------------------- |
| Drag the title bar         | Moves it                                                      |
| Drag an edge or a corner   | Resizes it (not a side whose plot area has a size of its own) |
| Double-click the title bar | Renames it                                                    |
| The **×** at the top left  | Asks: Close (keep what it shows) or Kill                      |
| **Alt**-click the **×**    | Kills it without asking                                       |

## Graphs

| Do                                | What happens                                                             |
| --------------------------------- | ------------------------------------------------------------------------ |
| Drag in the plot area             | Draws a box; its menu has Expand, Horiz Expand, Vert Expand, Shrink, ... |
| **Alt**-drag                      | Pans                                                                     |
| Wheel                             | Zooms about the pointer; over an axis, that axis only                    |
| Double-click an axis              | Modify Axis                                                              |
| Double-click a trace              | Modify Trace Appearance (an image or contours: their settings)           |
| Double-click a legend or text     | Edits it; drag it to move it                                             |
| Double-click the margin           | Modify Graph                                                             |
| Drag a cursor (A round, B square) | Moves it to another point                                                |
| **←** / **→**                     | Moves the cursor a point (**Shift**: ten)                                |
| Right-click                       | Cursors, the Modify dialogs, styles, templates, Link Graphs, ...         |
| **Alt+T** (Show Tools)            | Shows or hides the drawing tools; see the guide on drawing shapes        |
| **Ctrl+A** (tools out)            | Selects every drawing (without the tools: autoscales the axes)           |
| **Shift**-click (tools out)       | Adds a drawing to the selection or takes it out                          |

In linked graphs (Link Graphs), zooming, panning and cursors go to the other graphs too.

## Tables

| Do                         | What happens                                          |
| -------------------------- | ----------------------------------------------------- |
| Arrow keys / **Tab**       | Move between cells                                    |
| **Enter** / **F2**         | Starts editing; **Enter** while editing keeps it      |
| **Escape** (editing)       | Stops editing                                         |
| **Delete** / **Backspace** | Clears the cells selected                             |
| Right-click                | Insert or delete rows; display, scale or rename waves |

## Command line

| Do                      | What happens                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------ |
| **Enter**               | Runs it                                                                              |
| **Shift+Enter**         | A new line                                                                           |
| **↑** / **↓**           | History that starts with what is typed                                               |
| **Ctrl+R**              | Searches the history                                                                 |
| **Tab**                 | Completes (indents at the start of a line)                                           |
| **Ctrl+E** / **Ctrl+→** | Accepts the suggestion from the history shown faintly (**Ctrl+→**: a word at a time) |
| `%pip install name`     | Installs a package (also `%pip list / freeze / show / uninstall`)                    |

## Procedure editor

| Do                      | What happens                     |
| ----------------------- | -------------------------------- |
| **Ctrl+Enter**          | Runs the whole procedure         |
| **Shift+Enter**         | Runs the selection (or the line) |
| **Shift+Alt+F**         | Formats it (Ruff)                |
| **Ctrl+/**              | Comments lines in or out         |
| **Ctrl+]** / **Ctrl+[** | Indents / outdents               |
| **Ctrl+F** / **Ctrl+G** | Find and replace / go to line    |
| **Ctrl+Shift+M**        | Lists the problems Ruff found    |

## Data Browser

| Do                                   | What happens                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Type in the search box               | Shows the waves whose path, units, type or note has every word (`text` finds text waves) |
| **↓** / **Enter** in the search box  | Goes to the first wave in the list                                                       |
| **↑** / **↓** / **Home** / **End**   | Moves the selection (**Shift** adds)                                                     |
| **Enter**                            | Shows the waves selected in a table                                                      |
| **Ctrl+A** / **Escape**              | Selects every wave shown / clears the selection                                          |
| Click, **Shift**- and **Ctrl**-click | Selects (a range, more)                                                                  |
| Double-click                         | Shows it in a table                                                                      |
| Drag onto a folder                   | Moves the waves                                                                          |

## Page layouts

| Do                                 | What happens                    |
| ---------------------------------- | ------------------------------- |
| Click, **Shift**-click, draw a box | Selects items                   |
| Drag                               | Moves them (all those selected) |
| **Delete** / **Backspace**         | Takes the items selected off    |
| **Escape**                         | Clears the selection            |
