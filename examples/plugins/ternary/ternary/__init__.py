"""Ternary diagrams for OresmePro.

Importing the package registers its action ``ternary`` (see
oresme-plugin.json), which turns compositions of three components into the
waves of a ternary diagram and asks the application for the graph (see
diagram.py).
"""

from . import diagram

__all__ = ["diagram"]
