---
title: XPS Peak Fitting
sidebar:
  order: 7
---

The example plugin [xps](https://github.com/ks250206/OresmePro/tree/main/examples/plugins/xps) has an **XPS Peak Fitting** window that builds a peak model of an XPS spectrum the way CasaXPS does: choose a region, put a background under it, place synthetic components on it and fit them. Components can be dragged into place on the spectrum, and their values and constraints written straight into a table. The arithmetic runs in the plugin's sandbox; the app draws the window (a plugin's [model editor](../plugins/#model-editors)).

## Install and open it

In **Python → Plugins…**, choose **Install from GitHub…**, enter `https://github.com/ks250206/OresmePro/tree/main/examples/plugins/xps`, **Fetch** and **Install** (or **Install from Folder…**).

Select a spectrum (a 1-D wave of intensities) in the Data Browser and choose **Analysis → XPS Peak Fitting…**: the window opens on it. At its top, choose the **Spectrum** and the **Energy** (the X wave of XY data, or **X scaling**).

A spectrum fitted before comes back with the region, settings, components and constraints of its last result.

## On the spectrum

The binding energy axis runs from right to left, with the residual above. After every edit the plugin computes the background, each component, the envelope (red) and the residual again, and the window draws them.

| Do this                                        | And                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Drag a blue dashed line (an end of the region) | The region changes; points outside it are grey                       |
| Double-click on a peak                         | A component is added there, as tall as the data                      |
| Drag the square at a component's top           | Left and right move it, up and down change its height (area)         |
| Drag a ◇ (at half height) of the selected one  | Its FWHM changes, its height stays                                   |
| Click a component, or its column's heading     | It is selected                                                       |
| Mouse wheel                                    | Zooms across; **Range** shows the region, **All** the whole spectrum |
| Delete                                         | Removes the selected component                                       |
| Ctrl+Z / Ctrl+Shift+Z (⌘Z / ⇧⌘Z)               | Undoes / redoes edits in the window; a fit is undone like an edit    |

A parameter tied to another component (`A+1.5` below) is not dragged: it follows the one it is tied to.

## Components

As on CasaXPS's Components page, each component is a column (A, B, C, …).

| Row                               | What it is                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Name                              | The component's name (C-C, Ti 2p3/2, …); its letter if empty                                   |
| Line shape                        | `GL(m)`, `SGL(m)`, `GL(m)T(k)`, `SGL(m)T(k)` or `LA(α,β)` (see below)                          |
| Position / FWHM / Area            | Position (eV), the width parameter F (eV) and area; after a fit, the values found              |
| Position / FWHM / Area constraint | The constraint (see below)                                                                     |
| Gauss (eV)                        | FWHM of a Gaussian the line shape is convolved with (0: none), for the instrument's broadening |
| RSF                               | The relative sensitivity factor, for **% Area/RSF** in the Report                              |

Constraints:

| Written          | Means                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| (empty)          | Free: the position within the region, FWHM 0.05 to 20 eV, area 0 or more |
| `284.5, 285.5`   | Free between these                                                       |
| `fixed`          | Held at the table's value                                                |
| `A`              | The same as component A's (the same FWHM, say)                           |
| `A+1.5`, `A-1.5` | Component A's, shifted (spin-orbit splitting, chemical shifts)           |
| `A*0.5`, `A/2`   | A multiple of component A's (area ratios: 2p1/2 is half of 2p3/2)        |

The buttons on the left:

- **Create** adds a component where, in the region, the data stands highest above the model so far
- **Copy** adds a copy of the selected component 1 eV higher
- **Doublet** adds the spin-orbit partner of the selected component X, tied to it: position `X+Δ`, FWHM `X`, area `X*ratio`. Choose Δ (eV) and the ratio (p 1:2, d 2:3, f 3:4) below it
- **Delete** removes the selected component; constraints tied to it are let go, keeping the values they had

**Fit Components** fits and puts the values found in the table.

## Settings

| Item                   | What it is                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Region (eV)            | The region's binding energies; **All the Data** for all of it                                                                                     |
| Energies are           | binding or kinetic; kinetic ones become BE = hν − KE with the **Photon energy** (Al Kα 1486.6 eV, Mg Kα 1253.6 eV)                                |
| Charge correction (eV) | Added to every binding energy: −0.8 when C 1s at 285.6 eV should be at 284.8 eV                                                                   |
| Background             | **Shirley** (rises with the peak area passed), **Linear**, **Tougaard** (universal cross-section, C = 1643 eV², B scaled to the data) or **None** |
| Average width          | How many points at each end give the background's end levels (CasaXPS's Av Width)                                                                 |
| Weighting              | poisson (each point by 1/√counts) or unit                                                                                                         |

The background is worked out from the data and held while fitting, as in CasaXPS.

## Report

Each component's position, FWHM, true full width at half maximum (Width) and area with their standard deviations, its RSF and share of area/RSF, and χ² and reduced χ². **Copy** copies it as a tab-separated table. Uncertainties come from the Jacobian at the solution, scaled by the residual variance, and leave out the background's.

## What it makes

Each fit makes, next to the spectrum and over the region: `<name>_region` (the data), `_background`, `_comp_A`, `_comp_B`, … (each component on the background), `_envelope`, `_residual`, and `_be` (binding energies) when an X wave is used; and the graph `XPSFit`, with a reversed binding energy axis, the residual above and a legend. The fit is kept among the results (**Analysis → Results…**) as `Plugin0`, `Plugin1`, ….

Fitting again from the window makes again, under their names, the waves of the fit before that have not been changed since, and updates its graph (keeping colors and axes you changed). With fewer components, the waves of those no longer there leave the graph and are killed. Waves you changed or renamed are left alone and new names are used ([the rule for plugins](../plugins/#use)). Each result keeps copies of the waves it made in `results:<result>`.

## From Python

A fit from the window is this call, kept in the history:

```python
op.invoke("plugin.xps.xps_fit", {
    "spectrum": "C1s",
    "region": [281, 293],
    "components": [
        {"name": "C-C", "position": 284.8, "fwhm": 1.1, "area": 3000},
        {"name": "C-O", "position": 286.3, "area": 900,
         "constraints": {"position": "A+1.5", "fwhm": "A"}},
    ],
    "shift": -0.4,
}, replace=True)
```

Without `replace=True`, the waves before are left alone and new names are used.

## Line shapes

u = (BE − E)/F, m in %, and u > 0 is the side of higher binding energy (CasaXPS manual 2.3.15 rev 1.3, pp. 55 and 301).

| Shape        | Formula                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `GL(m)`      | exp(−4 ln2 (1 − m/100) u²) / (1 + 4 (m/100) u²) (product of a Gaussian and a Lorentzian)            |
| `SGL(m)`     | (1 − m/100) exp(−4 ln2 u²) + (m/100) / (1 + 4u²) (their sum)                                        |
| `GL(m)T(k)`  | GL + (1 − GL) exp(−k u) on the high binding energy side; a smaller k, a longer tail                 |
| `SGL(m)T(k)` | The same tail on SGL                                                                                |
| `LA(α,β)`    | (1 + 4u²)^(−α) on the high binding energy side, (1 + 4u²)^(−β) on the other: asymmetric metal peaks |

- The area is that of the whole line shape; convolving with a Gaussian keeps it
- F is the true FWHM only for GL(0), GL(100) and SGL(m) without a tail or Gaussian (GL(30): 0.961 F); the true width is the Report's **Width**
- The m of CasaXPS's `LA(α,β,m)` is not documented, so give the Gaussian's FWHM in eV as **Gauss** instead

## Limits

- One region of one spectrum is fitted. Quantification from a survey (atomic concentrations from the areas and RSFs of several regions) is the plugin's action **XPS Quantification** (`quantify`)
- The background is held while fitting (no active Shirley), and the uncertainties leave out the background's

[Plugins](../plugins/) · [Curve fitting](../curve-fitting/)
