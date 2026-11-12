---
title: Statistics, FFT, smoothing, and calculus
sidebar:
  order: 7
---

| Task       | Python                     | Output                                                                         |
| ---------- | -------------------------- | ------------------------------------------------------------------------------ |
| Statistics | `op.stats(w)`              | Dictionary with mean, sample standard deviation, extrema, and other statistics |
| Histogram  | `op.histogram(w, bins=30)` | Wave with bin centers on X and counts on Y                                     |
| FFT        | `op.fft(w)`                | One-sided amplitude spectrum at non-negative frequencies                       |
| Smoothing  | `op.smooth(w, n=7)`        | Seven-point moving-average wave                                                |
| Derivative | `op.differentiate(w, x=x)` | Derivative with respect to X as a new wave                                     |
| Integral   | `op.integrate(w, x=x)`     | Cumulative trapezoidal integral as a new wave                                  |

## Choose inputs for the operation

Use FFT on a uniformly sampled 1-D signal. Verify the sample spacing `dx` and the X unit. With `x_unit="s"`, the output frequency unit is Hz. To invert a spectrum, keep the complex coefficients with `op.fft(w, output="complex")`.

Differentiate and integrate using the wave's scaling for uniform samples. Supply an X wave or array with one value per point for uneven spacing. Compare a smoothed wave with the original to see how the averaging window changes narrow peaks.

[FFT example](../../examples/fft/) · [Histogram example](../../examples/histogram/) · [Analysis API](../../reference/api/analysis/)
