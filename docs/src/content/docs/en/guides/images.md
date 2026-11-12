---
title: Image and contour plots
sidebar:
  order: 4
---

Choose **Windows → New Image Plot…** or **New Contour Plot…** and select a numeric wave. An image maps grid values to colors. A contour shows where the field crosses a specified value. Overlay the two in one graph when their coordinate systems match.

## Set coordinates, colors, and slices

- The first and second dimensions of the wave carry its X and Y scales. Use `np.meshgrid(x, y, indexing="ij")` to create coordinate arrays in that order.
- Set the color map and value range with `color_table`, `z_min`, and `z_max`. Use the same limits when comparing samples.
- Select a slice of a 3-D or 4-D wave with `layer` and `chunk`.
- `g.append_contour(field, levels=[0.2, 0.5, 0.8])` draws lines at three levels. Use `g.colorscale()` to add a color scale.

[Runnable 2-D example](../../examples/image-contour/) · [Image / Contour API](../../reference/api/image-contour/)
