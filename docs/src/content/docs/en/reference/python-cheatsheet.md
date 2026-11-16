---
title: Python cheat sheet
description: What you want to do, and the code that does it.
sidebar:
  order: 3
---

`np` (NumPy) and `op` (`import oresme as op`) are there in the command line and in procedures. For every argument, see the [Python API](../).

## Wave

```python
x = np.linspace(0, 10, 501)
y = op.make("signal", np.sin(x), dx=x[1] - x[0], x_unit="s", unit="V")  # make one
y = op.wave("signal")              # by name
y.data                             # a NumPy array (writing to it changes the wave)
y.data = y.data * 2                # replace the values
y.x                                # the X values (from the scaling)
y.set_scale(0, 0.02, "s")          # X start, step and unit
y.unit = "mV"; y.note = "run 1"    # unit, note
y.rename("run1:signal")            # rename, or move into a folder
op.waves()                         # every wave
op.kill(y)                         # delete
op.set_formula("ratio", "a / b")   # a formula (computed again when a or b changes)
```

## Data folders and sample attributes

```python
op.new_folder("run1")
op.folder("run1").make("spectrum", data)            # run1:spectrum
op.set_attributes("run1:", thickness=12.5, Mg=0.3)  # a sample's attributes (a folder ends in :)
op.wave("run1:spectrum").attributes                  # with those from its folders
```

## Loading files

```python
op.load_text("data.csv")             # CSV, TSV, whitespace
op.load_excel("book.xlsx")           # Excel (each sheet)
op.load_igor("run.pxp")              # Igor .ibw, .pxp
op.load_parquet("run.parquet")       # Parquet
op.load_hdf5("scan.h5")              # HDF5
df = op.table("Table0").to_dataframe()   # table -> pandas
op.from_dataframe(df)                     # pandas -> waves
```

## Graphs

```python
g = op.display(y)                          # plot Y (X from its scaling)
g = op.display(y, x=xw, name="Spectrum")   # against an X wave, named
g.append(y2)                               # add a trace
g.trace("signal").set(mode="markers", color="#ab1831", marker="circle")
g.axis("left").set(range=(0, 1), log=False, label="Intensity")
g.axis("bottom").autoscale()
g.axis("left").labels = "axis only"        # hide the tick labels
g.set(width=op.cm(8), height=("aspect", 0.75))   # the plot area's size
g.set(margins=(60, 40, 10, 10), magnification=1.5)
g.legend(); g.textbox("Run 1")
g.cursor("A", g.trace(), 10)               # a cursor
g.save("figure.pdf")                       # export (.pdf / .svg / .png)
print(g.script())                          # the Python that makes it again
op.link_graphs("G1", "G2")                 # link axes and cursors
op.image(matrix); op.contour(matrix)       # a 2-D wave
```

## Tables and windows

```python
t = op.edit(y, y2, name="Raw")           # a table
op.rename_window("Graph0", "Spectrum")
op.close_window("Spectrum")              # close (keeps what it shows)
op.reopen_window("Spectrum")
op.kill_window("Raw")                    # delete
op.windows("graph")                      # the names of windows
```

## Analysis

```python
r = op.fit("gauss", y)                                   # fit
r = op.fit("exp", y, hold={"y0": 0}, bounds={"tau": (0, None)}, xrange=(1, 5))
r.coef, r.sigma, r.converged, r["x0"]
op.fit_peaks(y, peaks=3, shape="voigt")                  # several peaks
op.background(y, "shirley", subtract=True)               # background
op.onset(y, edge=(1.0, 1.5), baseline=(0.0, 0.5))        # onset of an edge
op.stats(y); op.differentiate(y); op.integrate(y)
op.smooth(y, 5); op.fft(y); op.histogram(y, bins=50)
op.results()                                             # the results kept
op.results_table()                                       # results side by side
op.plot_results("A", "thickness")                        # a parameter against an attribute
op.result("Fit0").template("Peak").run(["s1", "s2"])     # the same analysis on many samples
```

## Changes in one step, packages, procedures

```python
with op.atomic():                     # one undo step; nothing stays if it fails
    a = op.make("a", np.arange(10))
    op.display(a)

%pip install pybaselines              # install a package (recorded in the experiment)
await op.install("emcee")
op.packages()

p = op.new_procedure("tools", "def twice(x):\n    return 2 * x\n")
p.run()                               # run in the command line's namespace
import tools                          # as a namespace of its own (a module)
```
