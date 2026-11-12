import numpy as np
import oresme as op

theta = np.linspace(0, 2 * np.pi, 300)
x = op.make("theta", theta)
s = op.make("sin_theta", np.sin(theta))
c = op.make("cos_theta", np.cos(theta))
g = op.display(s, x=x, name="Overlay")
g.append(c, x=x).set(color="#b23053", line_style="dash")
g.bottom.label = "Angle (rad)"
g.legend()
