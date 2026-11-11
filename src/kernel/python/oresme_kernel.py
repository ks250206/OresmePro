"""The interactive Python session behind the OresmePro command window.

An IPython shell whose input comes from the command line and whose output
(streams, results, errors) is forwarded to the history view.
"""

import asyncio
import builtins
import importlib
import io
import json
import os
import sys
import time

from IPython.core.displayhook import DisplayHook
from IPython.core.displaypub import DisplayPublisher
from IPython.core.interactiveshell import InteractiveShell
from traitlets import Type

import _oresme_js

_MIME_TYPES = ("text/plain", "image/svg+xml", "image/png")


class _Stream(io.TextIOBase):
    def __init__(self, name):
        self._name = name

    def write(self, text):
        if text:
            _oresme_js.stream(self._name, text)
        return len(text)

    def writable(self):
        return True

    def isatty(self):
        # Lets progress bars redraw in place; the history view understands \r.
        return True

    @property
    def encoding(self):
        return "utf-8"


def _emit_display(data):
    bundle = {key: data[key] for key in _MIME_TYPES if key in data}
    if bundle:
        _oresme_js.display(json.dumps(bundle))


class _DisplayHook(DisplayHook):
    def write_output_prompt(self):
        pass

    def write_format_data(self, format_dict, md_dict=None):
        _emit_display(format_dict)

    def finish_displayhook(self):
        pass


class _DisplayPublisher(DisplayPublisher):
    def publish(self, data, metadata=None, source=None, *, transient=None, update=False,
                **kwargs):
        _emit_display(data)

    def clear_output(self, wait=False):
        pass


class _Shell(InteractiveShell):
    displayhook_class = Type(_DisplayHook)
    display_pub_class = Type(_DisplayPublisher)

    def init_history(self):
        self.config.HistoryManager.hist_file = ":memory:"
        super().init_history()

    def enable_gui(self, gui=None):
        pass

    def _showtraceback(self, etype, evalue, stb):
        name = getattr(etype, "__name__", str(etype))
        _oresme_js.error(name, str(evalue), "\n".join(stb))


# Pyodide replaces time.sleep with a version that runs the event loop while it
# waits. An interrupt arriving then is raised inside the event loop instead of
# in the user's code, which leaves the sleeper stuck forever. A plain blocking
# sleep keeps Ctrl+C working for the usual `while True: ...; time.sleep(x)` loop.
try:
    from pyodide import webloop as _webloop

    time.sleep = _webloop._orig_sleep
except (ImportError, AttributeError):
    pass

sys.stdout = _Stream("stdout")
sys.stderr = _Stream("stderr")

import numpy as np  # noqa: E402

import oresme  # noqa: E402

builtins.input = oresme._input

shell = _Shell.instance()
shell.colors = "lightbg"
shell.run_cell("import numpy as np\nimport oresme as op", store_history=False, silent=True)


# Python works in a directory of its own. What is in it belongs to the
# experiment: the application keeps a copy of every file, saves it with the
# experiment, and puts it back when the experiment is opened again.
WORKDIR = "/experiment"
_MAX_FILE_BYTES = 64 * 1024 * 1024
os.makedirs(WORKDIR, exist_ok=True)
os.chdir(WORKDIR)
if "" not in sys.path:
    sys.path.insert(0, "")

# path -> (size, mtime) of each file as the application last knew it.
_synced = {}
# path -> the application's version of the file that is on disk here.
_versions = {}
# procedure name -> its code as written to <name>.py.
_procedures = {}
_too_large = set()


def _stat(path):
    info = os.stat(os.path.join(WORKDIR, path))
    return (info.st_size, info.st_mtime_ns)


def _write(path, data):
    full = os.path.join(WORKDIR, path)
    os.makedirs(os.path.dirname(full) or WORKDIR, exist_ok=True)
    with open(full, "wb") as handle:
        handle.write(data)


def _remove(path):
    try:
        os.remove(os.path.join(WORKDIR, path))
    except OSError:
        pass


def _pull():
    """Make the working directory match the application before an input runs.

    Procedures become <name>.py, so they can be run and imported. Files that
    were added, replaced or removed in the application (or that came with an
    experiment just opened) are written or deleted here.
    """
    state = oresme._call("filesState")[0]
    procedures = {item["name"]: item["code"] for item in state["procedures"]}
    changed = False
    for name, code in procedures.items():
        if _procedures.get(name) != code:
            _write(f"{name}.py", code.encode("utf-8"))
            # So that `import name` picks up the new text.
            sys.modules.pop(name, None)
            changed = True
    for name in set(_procedures) - set(procedures):
        _remove(f"{name}.py")
        sys.modules.pop(name, None)
        changed = True
    _procedures.clear()
    _procedures.update(procedures)

    files = state["files"]
    for path, version in files.items():
        if _versions.get(path) == version:
            continue
        info, words = oresme._call("readFile", {"path": path})
        _write(path, words.tobytes()[: info["size"]] if words is not None else b"")
        _versions[path] = info["version"]
        _synced[path] = _stat(path)
        changed = True
    for path in set(_versions) - set(files):
        _remove(path)
        _versions.pop(path, None)
        _synced.pop(path, None)
        changed = True
    if changed:
        importlib.invalidate_caches()


def _scan():
    found = {}
    for folder, folders, names in os.walk(WORKDIR):
        folders[:] = [name for name in folders if name != "__pycache__"]
        for name in names:
            path = os.path.relpath(os.path.join(folder, name), WORKDIR).replace(os.sep, "/")
            try:
                found[path] = _stat(path)
            except OSError:
                pass
    return found


def _push():
    """Tell the application what the input wrote to or deleted from the working directory."""
    found = _scan()
    # Asked again: the input may have made a procedure, whose file is here already.
    procedures = {item["name"] for item in oresme._call("filesState")[0]["procedures"]}
    for path, stat in found.items():
        if _synced.get(path) == stat:
            continue
        name, extension = os.path.splitext(path)
        if extension == ".py" and name in procedures:
            # A procedure's text lives in its window, not in the file store.
            _synced[path] = stat
            continue
        if stat[0] > _MAX_FILE_BYTES:
            if path not in _too_large:
                _too_large.add(path)
                print(
                    f"{path} is larger than {_MAX_FILE_BYTES >> 20} MB and is not kept with the experiment.",
                    file=sys.stderr,
                )
            _synced[path] = stat
            continue
        with open(os.path.join(WORKDIR, path), "rb") as handle:
            data = handle.read()
        words = np.frombuffer(data + b"\0" * (-len(data) % 8), dtype=np.float64)
        _versions[path] = oresme._call("putFile", {"path": path, "size": len(data)}, words)[0]
        _synced[path] = stat
    for path in set(_synced) - set(found):
        _synced.pop(path, None)
        if _versions.pop(path, None) is not None:
            oresme._call("removeFile", {"path": path})


def _sync(step):
    try:
        step()
    except Exception as error:  # The input itself must still run, and report.
        print(f"Could not sync the experiment's files: {error}", file=sys.stderr)


_current_task = None
# idle: nothing to interrupt. pending: an input has been handed over but its
# task has not started. running: the task is executing the input.
_state = "idle"
_interrupt_requested = False


def prepare():
    """Announce that execute() is about to be called."""
    global _state, _interrupt_requested
    _state = "pending"
    _interrupt_requested = False


def interrupt():
    """Cancel the running input while it is waiting on `await`.

    Synchronous code is interrupted separately, through Pyodide's interrupt
    buffer; this covers the case where Python is idle inside the event loop
    and a signal would have nowhere sensible to land.

    A request that arrives after the input was handed over but before its
    task starts is remembered and honoured when the task begins. One that
    arrives after the input has finished is for nothing, and is dropped: it
    must not be left to hit whatever runs next.
    """
    global _interrupt_requested
    if _state == "running" and _current_task is not None and not _current_task.done():
        _current_task.cancel()
    elif _state == "pending":
        _interrupt_requested = True


async def execute(code):
    """Run one input. Returns True if it finished without an error."""
    global _current_task, _state, _interrupt_requested
    _current_task = asyncio.current_task()
    _state = "running"
    try:
        if _interrupt_requested:
            raise asyncio.CancelledError
        _sync(_pull)
        try:
            return await _execute(code)
        finally:
            _sync(_push)
    except asyncio.CancelledError:
        _oresme_js.error("KeyboardInterrupt", "", "KeyboardInterrupt")
        return False
    finally:
        _current_task = None
        _state = "idle"
        _interrupt_requested = False


async def _execute(code):
    exc_tuple = None
    try:
        transformed = shell.transform_cell(code)
    except Exception:
        transformed = code
        exc_tuple = sys.exc_info()
    result = await shell.run_cell_async(
        code,
        store_history=True,
        transformed_cell=transformed,
        preprocessing_exc_tuple=exc_tuple,
    )
    return bool(result.success)


def complete(code, cursor):
    """Completions at a cursor offset, as JSON."""
    from IPython.core.completer import provisionalcompleter

    items = []
    seen = set()
    with provisionalcompleter():
        for item in shell.Completer.completions(code, cursor):
            text, start = item.text, item.start
            # Attribute completions come back as ".name" replacing ".prefix".
            if text.startswith(".") and code[start : start + 1] == ".":
                text, start = text[1:], start + 1
            key = (start, item.end, text)
            if key in seen:
                continue
            seen.add(key)
            items.append({"text": text, "start": start, "end": item.end, "type": item.type})
            if len(items) >= 200:
                break
    return json.dumps(items)
