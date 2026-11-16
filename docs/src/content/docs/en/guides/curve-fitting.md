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

## Apply the same steps to many samples

Keep an analysis you settled on for one sample as a named **analysis template**, and apply it to many samples in turn.

1. In **Analysis → Results…**, select a result and choose **Make Template…**. The waves the result read become the template's inputs.
   Select several results to make a template of several steps, in the order they were done; a wave an earlier step made (residuals, say) is passed to the next step as that step's output.
   A template made from fits keeps their `hold`, `bounds` and `exclude`, so the conditions settled on the first sample are those of every other.
   **New…** and **Edit…** in **Analysis → Templates…** make or change a template on screen: add steps from the registered actions and put them in order,
   and take each argument from a value, an input, or what an earlier step returned (`hold` and the like are written as JSON, such as `{"y0": 0}`).
   **Save and Try** tries it on one sample before it is run on all.
2. In **Analysis → Templates…**, select the template and add a row for each sample. **Add Selected Waves** takes the waves selected in the Data Browser;
   **Add from Folder** takes the waves of a folder (for several inputs, each folder holding waves named after the inputs).
3. Choose **Run**. Each sample runs all steps inside `op.atomic()`: a sample that fails leaves nothing, and one that succeeds goes into the experiment at once.
   Choose whether the run goes on or stops when a sample fails.
4. The run record keeps a copy of the template as it was, the inputs with their fingerprints, and the state and error of each sample.
   **Retry Failed** does again only the failed, cancelled, and pending samples with the record's copy, so editing the template later does not change a past run.
   **Make Table** puts the coefficients of the samples that succeeded and the errors of those that failed in one table.

Outputs never replace existing waves. A wave a sample makes under the name of a wave that existed before the sample began gets a `_1`, `_2`, ... suffix instead, as in `fit_s1_1`
(`W_coef`, `W_sigma`, and `W_peaks` excepted).

```python
t = op.result("Fit0").template("Peak")             # from a result
run = t.run(["s1", "s2", "s3"], on_error="continue")
run.counts                                         # {'succeeded': 2, 'failed': 1, ...}
run.retry()                                        # only the samples that did not succeed
run.table()                                        # state, error, and coefficients
```

When you write a template by hand, each step's arguments are fixed values, inputs (`{"$input": "spectrum"}`), or outputs of earlier steps (`{"$step": "bg", "output": "subtracted"}`).

[Templates API](../../reference/api/templates/)
