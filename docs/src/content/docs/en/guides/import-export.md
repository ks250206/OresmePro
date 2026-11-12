---
title: Import and export data
sidebar:
  order: 8
---

## Inputs and preview

| Input                                              | Menu                             | Python          |
| -------------------------------------------------- | -------------------------------- | --------------- |
| CSV, TSV, whitespace-delimited text                | **File → Load Delimited Text…**  | `op.load_text`  |
| Excel (.xlsx, .xlsm)                               | **File → Load Excel Workbook…**  | `op.load_excel` |
| Igor wave (.ibw) or packed experiment (.pxp, .pxt) | **File → Load Igor Files…**      | `op.load_igor`  |
| Arbitrary files for Python                         | **File → Add Files for Python…** | `open`          |

For CSV and Excel, inspect the header, units, and column types in the preview. For text files, check the encoding too. Unreadable cells in a column explicitly set to numeric become NaN. Override the detected type in the preview if necessary. Save settings as a preset for recurring imports. Igor packed experiments provide their waves and data folders.

## Choose an output format

- Share a figure with **File → Save Graph as PDF / SVG / PNG** or `g.save("graph.svg")`.
- Copy columns from a table or call `table.to_dataframe().to_csv("export.csv", index=False)`. Download Python-created files under **Files** in the Data Browser.
- To transfer data, graphs, and scripts together, [save the experiment](../experiments/).

[CSV tutorial](../../getting-started/import-csv/) · [Import functions](../../reference/api/global/#load_text)
