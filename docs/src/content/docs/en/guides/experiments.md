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

1. Choose **File → Save Experiment As…** to download an `.oresme` file.
2. Restore it with **File → Open Experiment…** or drop the file on the workspace.
3. When opening a file with an auto-run procedure, OresmePro asks whether to run it. You can defer execution until you inspect the code.

[Persistence implementation](../../architecture/#opfs-persistence)
