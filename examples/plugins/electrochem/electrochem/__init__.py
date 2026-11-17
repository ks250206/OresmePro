"""Electrochemistry for OresmePro: cyclic voltammetry peaks, Tafel slopes and impedance fits.

Importing the package registers its four actions (see oresme-plugin.json):

* ``cv_peaks``: oxidation and reduction peaks of a cyclic voltammogram (cv.py)
* ``tafel``: Tafel slope and exchange current density (tafel.py)
* ``eis_fit``: equivalent-circuit fit of an impedance spectrum (eis.py)
* ``eis_circuit``: the same for any circuit written as text, R0-p(R1,CPE1)-W1 (eis.py, circuit.py)

and its view ``eis`` (view.py): a window of the application's parts where a
circuit is edited, drawn on Nyquist and Bode plots and fitted with eis_circuit.

Units: potentials in V (a wave whose unit is mV is converted), currents in
the unit of the current wave (A, or A/cm² for a current density),
impedances in Ω, frequencies in Hz.
"""

from . import circuit, cv, eis, tafel, view

__all__ = ["circuit", "cv", "eis", "tafel", "view"]
