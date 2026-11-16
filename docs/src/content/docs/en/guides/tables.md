---
title: Work with tables
sidebar:
  order: 5
---

Choose **Windows → New Table…** and select waves as columns. Editing cells updates the waves in the experiment and refreshes any graph using them. Column waves can have different lengths.

Columns can be added and taken out afterwards: **Table → Append Columns to Table…** and **Remove Columns from Table…** (also in the table's right-click menu) act on the frontmost table. In the Data Browser, right-click waves and choose a table under **Append to Table**. Taking a column out leaves its wave in the experiment.

```python
t = op.table("Table0")
t.append("b", "c")
t.remove("a")
```

## Enter and copy data

- Select cells to edit, copy, or paste a range. The clipboard uses tab-separated text when exchanging data with a spreadsheet.
- Removing a column from a table leaves its wave in the experiment.
- In Python, create a table with `op.edit` and change its columns with `table.append` or `table.remove`.

```python
t = op.make("sample_time", [0, 1, 2], unit="s")
v = op.make("sample_voltage", [1.0, 1.2, 1.4], unit="V")
table = op.edit(t, v, name="Samples")
table.digits = 4
```

Use `table.to_dataframe()` to send columns to pandas and `op.from_dataframe(frame)` to create waves from a DataFrame. Use one-dimensional waves as DataFrame columns. [Table API](../../reference/api/table/)

## Compute values from a formula

Choose **Data → Set Wave Values…**, or right-click a column header or a wave in the Data Browser, to give a wave a formula of other waves (Igor's Set Wave Values and its `R := V / I`). The dialog shows the first values as you type, or where the formula is wrong.

- An **automatic** formula is computed again whenever a wave in it changes, in the same undo step as the change.
- A **manual** formula is marked out of date in the Data Browser (_f\*_) when its waves change, and computed again with **Recalculate** in the context menu.
- When a computation fails, or a wave it reads is deleted, the wave keeps its values and is marked in red (_f!_); the tooltip says why.
- Renaming a wave a formula reads rewrites the name in the formula. Formulas and their state are saved with the experiment.

Formulas are written in a small language of their own: numbers, wave names (`run1:V` in a data folder), `p` (the point number), `x` (its X value), `pi`, `e`, `nan`, `inf`, `+ - * / ^`, comparisons, `&& || !`, `test ? a : b`, and the functions `abs`, `sqrt`, `exp`, `ln`, `log` (base 10), `log10`, the trigonometric and hyperbolic functions, `atan2`, `floor`, `ceil`, `round`, `min`, `max`, `pow`, `hypot`, `sign` and `isnan`. Nothing else can be written: no attributes, no other calls. Quote a wave named like one of those words: `'x'`.

Formulas work point by point, so the waves in one must be numeric 1-D waves with the same number of points and the same X scaling; nothing is interpolated. Division by zero gives NaN, and the number of such points is shown. NaN passes through everything but `isnan`.

```python
r = op.set_formula("R", "V / I")              # automatic
m = op.set_formula("ratio", "run1:A / run2:A", auto=False)
r.formula_info["status"]                       # "ok", "stale", "error" or "missing"
op.recalculate()                               # compute manual formulas again
r.formula = None                               # remove the formula, keep the values
```

Values typed into a wave with an automatic formula are replaced by the formula's at once. Remove the formula first to edit them. [Wave API](../../reference/api/wave/)
