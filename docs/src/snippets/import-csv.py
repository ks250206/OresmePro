import oresme as op

data = b"time (s),voltage (V)\n0,1.2\n1,1.6\n2,2.0\n3,2.3\n"
t, v = op.load_text(data, name="measurement.csv", delimiter="comma", header=True, units="auto")
op.display(v, x=t, name="Measurement")
