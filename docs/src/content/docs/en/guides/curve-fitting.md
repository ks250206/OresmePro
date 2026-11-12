---
title: Curve fitting
sidebar:
  order: 6
---

## Choose a model and range

Open **Analysis → Curve Fitting…** and select a function and a 1-D Y wave. Without an X wave, the fit uses the Y wave's X scaling. Put cursors A and B on the target trace to restrict the fit between them. In Python, `range` selects inclusive point indices, `xrange` selects an X interval, and `cursors=True` uses the cursor positions.

Call `op.fit_functions()` to see model names and formulas. The `gauss` model uses `y0 + A*exp(-((x-x0)/width)^2)` with a full width at half maximum of `2*sqrt(log(2))*abs(width)`. The `exp` model uses `y0 + A*exp(-x/tau)`.

## Evaluate the result

- Use `hold` to fix parameters and `bounds` to constrain them. Supply known standard deviations of the observations with `sigma`.
- `op.fit` returns a `FitResult`. Inspect `converged`, `reason`, residuals, and parameter correlations before adjusting the starting values or range.
- Coefficients and estimated standard deviations are written to `W_coef` and `W_sigma`. Fits are recorded in the experiment by default and can be compared or repeated via **Analysis → Results…**.
- Pass a built-in model name, a Python callable with a starting guess, or an lmfit model.

[Gaussian example](../../examples/gaussian/) · [Exponential example](../../examples/exponential/) · [Analysis API](../../reference/api/analysis/#fit)
