---
title: Work with tables
sidebar:
  order: 5
---

Choose **Windows → New Table…** and select waves as columns. Editing cells updates the waves in the experiment and refreshes any graph using them. Column waves can have different lengths.

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
