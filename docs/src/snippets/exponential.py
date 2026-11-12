import numpy as np
import oresme as op

t = np.linspace(0, 8, 161)
rng = np.random.default_rng(16)
y = 0.2 + 1.8 * np.exp(-t / 1.4) + rng.normal(0, 0.02, t.size)
decay = op.make("decay", y, dx=t[1] - t[0], x_unit="s")
g = op.display(decay, name="Exponential")
g.trace().set(mode="markers", marker_size=2)
fit = op.fit("exp", decay, graph=g, bounds={"tau": (0.01, None)})
print(f"Time constant = {fit['tau']:.3f} s, converged = {fit.converged}")
g.bottom.label = "Time (s)"
g.legend()
