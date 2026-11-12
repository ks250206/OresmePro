import numpy as np
import oresme as op

samples = op.make("samples", np.random.default_rng(18).normal(3, 0.6, 2000))
counts = op.histogram(samples, bins=24)
g = op.display(counts, name="Histogram")
g.trace().set(mode="bars")
g.bottom.label = "Value"
g.left.label = "Count"
