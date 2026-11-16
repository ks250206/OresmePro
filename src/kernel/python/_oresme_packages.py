"""Python packages for an experiment: put them in, list them, take them out, and put them in again.

``await op.install("pybaselines")`` (or ``%pip install pybaselines``) installs
a package with micropip: from the Pyodide distribution if it is one of its
packages, otherwise from PyPI. What it installed is recorded in the
experiment, by name, exact version, wheel and its SHA-256, so that opening
the experiment again, here or in another browser, installs the same again
(``await op.install()`` with nothing named). Only pure Python wheels and
wheels built for Pyodide install; a package with compiled code of its own
that Pyodide does not ship cannot.
"""

import importlib
import importlib.metadata
import json
import re
import shlex
import sys

import oresme as _op

__all__ = ["install", "uninstall", "packages"]


def _normal(name):
    """A package name as Python packaging normalizes it (PEP 503)."""
    return re.sub(r"[-_.]+", "-", str(name)).strip().lower()


def _installed():
    """Every distribution installed now, by normalized name: its version."""
    found = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata["Name"] if dist.metadata else None
        if name:
            found[_normal(name)] = dist.version
    return found


#: What Python started with (NumPy, IPython and theirs): never recorded.
_BASE = frozenset(_installed())


async def _micropip():
    try:
        import micropip
    except ImportError:
        import pyodide_js

        await pyodide_js.loadPackage("micropip")
        importlib.invalidate_caches()
        import micropip
    return micropip


def _pyodide_version():
    try:
        import pyodide

        return str(pyodide.__version__)
    except (ImportError, AttributeError):
        return "unknown"


def _requirement_name(requirement):
    """The package a requirement names: "pint>=0.24" is pint, a wheel's address is its name."""
    text = str(requirement).strip()
    if text.endswith(".whl"):
        return _normal(text.rsplit("/", 1)[-1].split("-", 1)[0])
    return _normal(re.split(r"[\s\[<>=!~;@]", text, maxsplit=1)[0])


def _freeze(micropip):
    """What micropip knows of every package it could put in, by normalized name."""
    try:
        return {
            _normal(name): entry
            for name, entry in json.loads(micropip.freeze()).get("packages", {}).items()
        }
    except Exception:  # noqa: BLE001 - an older micropip: record what can be had without it.
        return {}


def _record(micropip, names, requested):
    """Record the packages named in the experiment, as micropip found them."""
    listed = micropip.list()
    frozen = _freeze(micropip)
    sources = {_normal(name): getattr(meta, "source", "") for name, meta in listed.items()}
    versions = {_normal(name): meta.version for name, meta in listed.items()}
    versions.update({name: version for name, version in _installed().items() if name not in versions})
    records = []
    for name in sorted(names):
        entry = frozen.get(name, {})
        source = sources.get(name, "")
        records.append({
            "name": name,
            "version": str(entry.get("version") or versions.get(name, "")),
            "source": "pyodide" if source == "pyodide" else "pypi",
            "url": str(entry.get("file_name") or ("" if source == "pyodide" else source)),
            "sha256": str(entry.get("sha256") or ""),
            "depends": [_normal(item) for item in entry.get("depends", [])],
            "requested": name in requested,
        })
    if records:
        _op._dispatch({"op": "recordPackages", "packages": records, "pyodide": _pyodide_version()})
    return records


async def install(*requirements, upgrade=False, quiet=False):
    """Install Python packages and record them in the experiment.

    Each requirement is a package's name, with a version if wanted
    (``"pint"``, ``"emcee==3.1.6"``, ``"pybaselines>=1.1"``), or the address
    of a wheel. Packages of the Pyodide distribution (statsmodels, sympy,
    PyWavelets, ...) come from it; others come from PyPI with what they
    need. What is installed is recorded in the experiment, so it is installed
    again whenever the experiment is opened. Use it with ``await``, or as
    ``%pip install name``::

        await op.install("pybaselines", "impedance")

    With nothing named, installs again what the experiment records, at the
    versions recorded: what happens by itself when an experiment opens.
    """
    if not requirements:
        return await _restore(quiet=quiet)
    micropip = await _micropip()
    before = _installed()
    asked = {_requirement_name(item) for item in requirements}
    if not quiet:
        print(f"Installing {', '.join(str(item) for item in requirements)}…")
    try:
        await micropip.install(list(requirements), keep_going=True, reinstall=bool(upgrade))
    except Exception as error:
        raise _op.OresmeError(_install_problem(error)) from None
    importlib.invalidate_caches()
    after = _installed()
    changed = {name for name, version in after.items() if before.get(name) != version}
    records = _record(micropip, (changed | (asked & set(after))) - _BASE, asked)
    if not quiet:
        made = [f"{item['name']} {item['version']}" for item in records]
        print(f"Installed {', '.join(made)}." if made else "Nothing new to install.")
    return [item["name"] for item in records]


def _install_problem(error):
    text = str(error).strip().splitlines()[-1] if str(error).strip() else type(error).__name__
    if "pure Python 3 wheel" in text or "Can't find a pure Python" in text:
        return (
            f"{text} It has compiled code of its own and no wheel built for Pyodide, so it cannot "
            "run in the browser."
        )
    if "fetch" in text.lower() or "network" in text.lower():
        return f"{text} Installing a package needs the network the first time."
    return text


async def _restore(*, quiet=False):
    """Install what the experiment records, at the versions and from the wheels recorded."""
    env = _op._call("pythonEnv")[0]
    recorded = env.get("packages", [])
    if not recorded:
        return []
    have = _installed()
    missing = [item for item in recorded if have.get(item["name"]) != item["version"]]
    if not missing:
        return []
    import pyodide_js

    if env.get("pyodide") and env["pyodide"] != _pyodide_version() and not quiet:
        print(
            f"The packages were installed under Pyodide {env['pyodide']}; this is "
            f"{_pyodide_version()}. Wheels built for that version may not load.",
            file=sys.stderr,
        )
    names = ", ".join(item["name"] for item in missing)
    _op._oresme_js.progress(f"Installing the experiment's packages: {names}…")
    failed = []
    failed_names = set()
    try:
        bundled = [item["name"] for item in missing if item["source"] == "pyodide"]
        if bundled:
            await pyodide_js.loadPackage(bundled)
        outside = [item for item in missing if item["source"] != "pyodide"]
        if outside:
            micropip = await _micropip()
            for item in outside:
                try:
                    # From the wheel recorded, as it was: what it needs is in the list too.
                    await micropip.install(item["url"] or f"{item['name']}=={item['version']}", deps=False)
                except Exception as error:  # noqa: BLE001 - the others still go in.
                    failed.append(f"{item['name']} ({_install_problem(error)})")
                    failed_names.add(item["name"])
    finally:
        _op._oresme_js.progress("")
        importlib.invalidate_caches()
    if failed:
        print(f"Could not install {'; '.join(failed)}.", file=sys.stderr)
    elif not quiet:
        print(f"Installed the experiment's packages: {names}.")
    return [item["name"] for item in missing if item["name"] not in failed_names]


async def uninstall(*names, quiet=False):
    """Stop using packages: they are no longer recorded in the experiment.

    What only they needed goes too. Modules already imported stay until
    Python restarts (Python › Restart Python).
    """
    if not names:
        raise _op.OresmeError("Name the packages to take out.")
    normal = [_normal(name) for name in names]
    env = _op._call("pythonEnv")[0]
    before = {item["name"] for item in env.get("packages", [])}
    _op._dispatch({"op": "forgetPackages", "names": normal})
    after = {item["name"] for item in _op._call("pythonEnv")[0].get("packages", [])}
    gone = sorted(before - after)
    micropip = await _micropip()
    try:
        micropip.uninstall(gone)
    except Exception:  # noqa: BLE001 - one of the distribution's: it stays until a restart.
        pass
    importlib.invalidate_caches()
    if not quiet:
        print(f"Removed {', '.join(gone)}. Restart Python to unload what was imported.")
    return gone


_last_report = None
_tops = {}


def report():
    """Tell the application which packages are installed and imported, when that has changed."""
    global _last_report, _tops
    installed = _installed()
    if set(installed) != set(_tops):
        _tops = _top_levels()
    state = {
        "installed": installed,
        "imported": sorted(name for name in installed if _imported(name, _tops)),
        "base": sorted(_BASE),
        "python": sys.version.split()[0],
        "pyodide": _pyodide_version(),
    }
    if state != _last_report:
        _op._call("packagesStatus", state)
        _last_report = state


class _Package(dict):
    """A package installed now, as a dict: name, version, source, requested, recorded, imported."""

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key) from None


class _Packages(list):
    def __repr__(self):
        if not self:
            return "No packages beyond those Python starts with."
        rows = [("name", "version", "source", "in experiment", "imported")]
        for item in self:
            rows.append((
                item["name"],
                item["version"],
                item["source"],
                "asked for" if item["requested"] else ("needed" if item["recorded"] else "-"),
                "yes" if item["imported"] else "",
            ))
        widths = [max(len(row[column]) for row in rows) for column in range(5)]
        return "\n".join(
            "  ".join(cell.ljust(width) for cell, width in zip(row, widths)).rstrip() for row in rows
        )


def _imported(name, top_level):
    return any(module in sys.modules for module in top_level.get(name, [name.replace("-", "_")]))


def _top_levels():
    """The modules each distribution brings, by normalized name."""
    found = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata["Name"] if dist.metadata else None
        if not name:
            continue
        text = dist.read_text("top_level.txt") or ""
        modules = [line.strip() for line in text.splitlines() if line.strip()]
        found[_normal(name)] = modules or [_normal(name).replace("-", "_")]
    return found


def packages(everything=False):
    """The packages installed beyond those Python starts with (with ``everything``, all of them).

    Each says its version, where it came from ("pyodide" for the
    distribution, "pypi"), whether the experiment records it (asked for, or
    needed by one that was) and whether it has been imported.
    """
    env = {item["name"]: item for item in _op._call("pythonEnv")[0].get("packages", [])}
    tops = _top_levels()
    listed = []
    try:
        import micropip

        sources = {_normal(name): getattr(meta, "source", "") for name, meta in micropip.list().items()}
    except ImportError:
        sources = {}
    for name, version in sorted(_installed().items()):
        if not everything and name in _BASE and name not in env:
            continue
        recorded = env.get(name)
        source = recorded["source"] if recorded else ("pypi" if sources.get(name) not in ("", "pyodide", None) else "pyodide")
        listed.append(_Package(
            name=name,
            version=version,
            source=source,
            requested=bool(recorded and recorded["requested"]),
            recorded=recorded is not None,
            imported=_imported(name, tops),
        ))
    return _Packages(listed)


def _show(name):
    name = _normal(name)
    try:
        dist = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError:
        raise _op.OresmeError(f"No package named {name!r} is installed.") from None
    meta = dist.metadata
    needs = [re.split(r"[\s;\[<>=!~(]", item, maxsplit=1)[0] for item in (dist.requires or [])
             if "extra ==" not in item]
    lines = [
        f"Name: {meta['Name']}",
        f"Version: {dist.version}",
        f"Summary: {meta.get('Summary', '')}",
        f"Home-page: {meta.get('Home-page') or meta.get('Project-URL', '')}",
        f"License: {meta.get('License', '')}",
        f"Requires: {', '.join(needs)}",
    ]
    return "\n".join(lines)


async def pip(arguments):
    """``%pip install|uninstall|list|freeze|show ...``, as micropip does it for this experiment."""
    words = shlex.split(arguments)
    if not words:
        raise _op.OresmeError("Use %pip install NAME, %pip uninstall NAME, %pip list, %pip freeze or %pip show NAME.")
    command, rest = words[0], words[1:]
    flags = {word for word in rest if word.startswith("-")}
    names = [word for word in rest if not word.startswith("-")]
    if command == "install":
        if "-r" in flags or "--requirement" in flags:
            raise _op.OresmeError("%pip install -r is not supported: name the packages.")
        await install(*names, upgrade=bool(flags & {"-U", "--upgrade"}))
    elif command == "uninstall":
        await uninstall(*names)
    elif command == "list":
        print(repr(packages(everything=True)))
    elif command == "freeze":
        env = _op._call("pythonEnv")[0]
        print("".join(
            f"{item['name']}=={item['version']}\n" for item in env.get("packages", []) if item["requested"]
        ), end="")
    elif command == "show":
        for name in names:
            print(_show(name))
    else:
        raise _op.OresmeError(f"%pip {command} is not supported here: use install, uninstall, list, freeze or show.")


_PIP_LINE = re.compile(r"^(\s*)[%!]pip\s+(.*?)\s*$")


def pip_lines(lines):
    """An IPython input transformer: ``%pip ...`` lines become calls of ``pip`` that are awaited."""
    changed = []
    for line in lines:
        found = _PIP_LINE.match(line.rstrip("\n"))
        if found:
            indent, arguments = found.groups()
            ending = "\n" if line.endswith("\n") else ""
            changed.append(f"{indent}await __import__('_oresme_packages').pip({arguments!r}){ending}")
        else:
            changed.append(line)
    return changed
