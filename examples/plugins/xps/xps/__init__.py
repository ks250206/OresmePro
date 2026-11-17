"""XPS peak fitting for OresmePro, in the way CasaXPS works.

Importing the package registers its actions (see oresme-plugin.json):

* ``xps_fit``: a peak model of one region: a background and synthetic
  components with CasaXPS's line shapes and constraints (fit.py)
* ``quantify``: atomic concentrations from the areas of regions (quantify.py)

and its view ``quant``, a window for ``quantify`` (quant_view.py).

Energies are binding energies in eV (kinetic energies are converted with
the photon energy), corrected for charging by ``shift``.
"""

from . import fit, quant_view, quantify

__all__ = ["fit", "quant_view", "quantify"]
