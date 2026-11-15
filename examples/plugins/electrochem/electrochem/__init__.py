"""Electrochemistry for OresmePro: cyclic voltammetry peaks, Tafel slopes and impedance fits.

Importing the package registers its three actions (see oresme-plugin.json):

* ``cv_peaks``: oxidation and reduction peaks of a cyclic voltammogram (cv.py)
* ``tafel``: Tafel slope and exchange current density (tafel.py)
* ``eis_fit``: equivalent-circuit fit of an impedance spectrum (eis.py)

Units: potentials in V (a wave whose unit is mV is converted), currents in
the unit of the current wave (A, or A/cm² for a current density),
impedances in Ω, frequencies in Hz.
"""

from . import cv, eis, tafel

__all__ = ["cv", "eis", "tafel"]
