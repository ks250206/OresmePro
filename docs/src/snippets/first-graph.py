import oresme as op

voltage = op.make("voltage", [1.2, 1.6, 2.0, 2.3], dx=0.5, x_unit="s", unit="V")
graph = op.display(voltage, name="FirstGraph")
graph.bottom.label = "Time (s)"
graph.left.label = "Voltage (V)"
