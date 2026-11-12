import numpy as np
import oresme as op

x = np.linspace(-3, 3, 101)
y = np.linspace(-2, 2, 81)
X, Y = np.meshgrid(x, y, indexing="ij")
z = np.exp(-((X - 0.7) ** 2 + 2 * Y**2))
field = op.make("field", z, x0=x[0], dx=x[1] - x[0], y0=y[0], dy=y[1] - y[0])
g = op.image(field, name="Field", color_table="viridis")
g.append_contour(field, levels=[0.2, 0.4, 0.6, 0.8], color="#ffffff")
g.colorscale()
