import numpy as np
import oresme as op

x = np.linspace(-4, 4, 241)
rng = np.random.default_rng(14)
y = 0.3 + 2.4 * np.exp(-((x - 0.7) / 0.9) ** 2)
peak = op.make("peak", y + rng.normal(0, 0.04, x.size), x0=x[0], dx=x[1] - x[0])
g = op.display(peak, name="Gaussian")
g.trace().set(mode="markers", marker_size=2)
fit = op.fit("gauss", peak, graph=g, bounds={"width": (0.001, None)})
print(f"Center = {fit['x0']:.3f}, converged = {fit.converged}")
g.legend()
