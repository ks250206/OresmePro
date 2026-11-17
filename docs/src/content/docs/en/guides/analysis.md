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

## Example plugin: electrochemistry

[`examples/plugins/electrochem`](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/electrochem) in the repository is an example plugin whose Python runs in the plugin sandbox.

| Action        | What it does                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `cv_peaks`    | Oxidation and reduction peaks of a CV: Epa, Epc, ΔEp, E1/2, ipa/ipc (with optional baselines)                                |
| `tafel`       | Tafel slope (mV/dec) and exchange current density over a chosen range, with uncertainties                                    |
| `eis_fit`     | Equivalent-circuit fit of an impedance spectrum (R(RC), R(RQ), Randles): parameters, uncertainties, χ², and fitted Z′ and Z″ |
| `eis_circuit` | The same for any circuit written as text, as impedance.py writes them: `R0-p(R1,CPE1)-W1` (R, C, L, CPE, W, Wo, Ws)          |

It also brings a Nyquist graph template. Install it from **Python › Plugins…**: paste the address above into **Install from GitHub…**, or pick the folder with **Install from Folder…**. From Python, call it as `op.invoke("plugin.electrochem.eis_fit", {"frequency": "f", "zre": "zre", "zim": "zim"})`. The README in that folder describes the inputs, models, and sign conventions.
