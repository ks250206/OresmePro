---
title: Waves and data folders
sidebar:
  order: 1
---

## Shape and scaling

A wave is a named numeric array (one to four dimensions) or a one-dimensional text array. Numeric waves have a type, shape, units, and scaling. The coordinate of point `i` in a 1-D wave is `x0 + i * dx`. Store unevenly spaced X values in a separate wave. In 2-D, `w[i, j]` indexes X with `i` and Y with `j`.

- `w.data` returns a read-only NumPy array. To edit values, assign through the wave, for example `w[0] = 1.0`, or replace the array with `w.data = values`.
- `np.sin(w)` and `w * 2` return NumPy arrays. Use `op.make` to store a result in the experiment.
- By default, `op.make` replaces an existing wave of the same name. Pass `overwrite=False` to protect existing data.

## Organize waves in folders

Use **Data → New Data Folder…** or `op.new_folder`. Python wave paths use colons between folder levels.

```python
run = op.new_folder("run1")
raw = run.make("voltage", [1.2, 1.6, 2.0], dx=0.5, x_unit="s", unit="V")
raw[0] = 1.3
print(op.wave("run1:voltage").x)
```

To delete a wave used in a graph or table, first remove the trace or column that refers to it. [Wave API](../../reference/api/wave/) · [Folder API](../../reference/api/folder/)
