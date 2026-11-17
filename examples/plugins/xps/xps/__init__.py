"""XPS peak fitting for OresmePro, in the way CasaXPS works.

Importing the package registers its two actions (see oresme-plugin.json):

* ``xps_fit``: a peak model of one region: a background and synthetic
  components with CasaXPS's line shapes and constraints (fit.py)
* ``quantify``: atomic concentrations from the areas of regions (quantify.py)

Energies are binding energies in eV (kinetic energies are converted with
the photon energy), corrected for charging by ``shift``.
"""

from . import fit, quantify

__all__ = ["fit", "quantify"]
