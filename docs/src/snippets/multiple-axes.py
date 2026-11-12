import numpy as np
import oresme as op

t = np.linspace(0, 6, 200)
voltage = op.make("voltage", 2.5 + 0.4 * np.sin(t), dx=t[1] - t[0])
current = op.make("current", 120 * np.exp(-t / 2), dx=t[1] - t[0])
g = op.display(voltage, name="TwoAxes")
g.add_axis("current_axis", "right").label = "Current (mA)"
g.append(current, axis="current_axis").set(color="#b23053")
g.left.label = "Voltage (V)"
g.bottom.label = "Time (s)"
g.legend()
