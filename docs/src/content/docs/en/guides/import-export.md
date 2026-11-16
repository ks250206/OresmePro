---
title: Import and export data
sidebar:
  order: 8
---

## Inputs and preview

| Input                                              | Menu                                   | Python            |
| -------------------------------------------------- | -------------------------------------- | ----------------- |
| CSV, TSV, whitespace-delimited text                | **Data → Load Delimited Text…**        | `op.load_text`    |
| Excel (.xlsx, .xlsm)                               | **Data → Load Excel Workbook…**        | `op.load_excel`   |
| Igor wave (.ibw) or packed experiment (.pxp, .pxt) | **Data → Load Igor Files…**            | `op.load_igor`    |
| Parquet (.parquet)                                 | **Data → Load Parquet or HDF5 Files…** | `op.load_parquet` |
| HDF5 (.h5, .hdf5)                                  | **Data → Load Parquet or HDF5 Files…** | `op.load_hdf5`    |
| Arbitrary files for Python                         | **File → Add Files for Python…**       | `open`            |

For CSV and Excel, inspect the header, units, and column types in the preview. For text files, check the encoding too. Unreadable cells in a column explicitly set to numeric become NaN. Override the detected type in the preview if necessary. Save settings as a preset for recurring imports. Igor packed experiments provide their waves and data folders.

A loaded file is kept with the experiment, and a line of the history loads it again. A file with the name of a different one kept already (an instrument that always writes `data.csv`, say) does not replace it: it is kept under its name with the first 8 digits of its SHA-256 added (`data-1a2b3c4d.csv`), so each line of the history goes on loading its own file. The same file loaded again keeps its name.

## Parquet and HDF5

Python reads Parquet and HDF5 files with Pyodide's pyarrow and h5py packages, which load the first time you read such a file. A dropped or chosen file goes into the experiment's files, and a line such as `op.load_parquet("run.parquet")` runs and stays in the history. Undo removes the whole load in one step.

- Each Parquet column becomes a wave, shown in a new table. Timestamps and dates become date waves (unit `dat`, UTC), strings and categories text waves, and booleans `uint8` waves. Nulls become NaN (empty strings in text), and the wave note records how many.
- Each HDF5 dataset becomes a wave, and groups become data folders. Datasets keep their shape (up to four dimensions) and type. Attributes go into the note, and a string `units` attribute becomes the wave's unit.
- 64-bit integers beyond 2⁵³ are rounded to `float64`, and the note records how many. The note also records the source file name and its SHA-256.

```python
op.load_parquet("run.parquet", columns=["t", "voltage"], table=False)
op.load_hdf5("scan.h5", datasets="/run1")
```

## Choose an output format

- Share a figure with **File → Save Graph as PDF / SVG / PNG** or `g.save("graph.svg")`.
- Copy columns from a table or call `table.to_dataframe().to_csv("export.csv", index=False)`. Download Python-created files under **Files** in the Data Browser.
- To transfer data, graphs, and scripts together, [save the experiment](../experiments/).

[CSV tutorial](../../getting-started/import-csv/) · [Import functions](../../reference/api/files/#load_text)
