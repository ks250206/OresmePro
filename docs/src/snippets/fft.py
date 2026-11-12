import numpy as np
import oresme as op

dt = 1 / 256
t = np.arange(512) * dt
y = np.cos(2 * np.pi * 12 * t) + 0.45 * np.cos(2 * np.pi * 33 * t)
signal = op.make("signal", y, dx=dt, x_unit="s")
spectrum = op.fft(signal)
g = op.display(spectrum, name="Spectrum")
g.bottom.label = "Frequency (Hz)"
g.left.label = "Amplitude"
