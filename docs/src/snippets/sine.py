import numpy as np
import oresme as op

t = np.arange(400) / 200
sine = op.make("sine", np.sin(2 * np.pi * 3 * t), dx=0.005, x_unit="s", unit="V")
g = op.display(sine, name="Sine")
g.bottom.label = "Time (s)"
g.left.label = "Amplitude (V)"
