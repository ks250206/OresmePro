"""Generate the Starlight reference without importing the Pyodide API."""

import argparse
import ast
import copy
import hashlib
import json
import re
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1]
SOURCE = DOCS.parent / "src/kernel/python"
CONTENT = DOCS / "src/content/docs"
OUTPUT = Path("reference/api")
REPOSITORY = "https://github.com/ks250206/OresmePro/blob/main/src/kernel/python"
# The Japanese of each description (see Japanese).
JAPANESE = DOCS / "scripts/api-ja.json"

# __all__ defines the public module surface. Each export must have one home:
# a page of its own, by what it is for. Each page has an English and a
# Japanese title.
SECTIONS = {
    "wave": ("Wave", "Wave", "Wave make wave waves exists kill set_formula recalculate WAVE_TYPES"),
    "folder": (
        "Data Folders and Attributes",
        "データフォルダと属性",
        "Folder new_folder folder folders set_attributes attributes",
    ),
    "files": (
        "Loading Files",
        "ファイルの読み込み",
        "load_text load_excel load_igor load_parquet load_hdf5",
    ),
    "graph": (
        "Graph",
        "グラフ",
        "Graph display graph graphs Annotation Length pt cm inch link_graphs unlink_graphs",
    ),
    "trace": ("Trace", "トレース", "Trace"),
    "axis": ("Axis", "軸", "Axis"),
    "image-contour": ("Image and Contour", "画像と等高線", "Image Contour image contour"),
    "cursor": ("Cursor", "カーソル", "Cursor"),
    "styles": (
        "Styles and Graph Templates",
        "スタイルとグラフテンプレート",
        (
            "Style style styles set_style apply_style set_default_style default_style "
            "GraphTemplate graph_template graph_templates set_graph_template"
        ),
    ),
    "table": ("Table", "テーブル", "Table edit table tables to_dataframe from_dataframe"),
    "layout": ("Page Layout", "ページレイアウト", "Layout LayoutItem new_layout layout layouts"),
    "windows": (
        "Windows",
        "ウィンドウ",
        "windows rename_window close_window reopen_window kill_window",
    ),
    "analysis": ("Analysis", "解析", None),  # All exports of _oresme_analysis.py.
    "templates": (
        "Analysis Templates",
        "解析テンプレート",
        "Template template templates set_template Run run runs",
    ),
    "actions": ("Actions", "Action", "action actions invoke"),
    "procedure": (
        "Procedures",
        "Procedure",
        "Procedure new_procedure procedure procedures",
    ),
    "notes": ("Notes", "ノート", "Note new_note note notes"),
    "packages": ("Packages", "パッケージ", "install uninstall packages"),
    "panel": ("Panels", "パネル", "Panel Control panel panels new_panel set_panel control"),
    "global": ("General", "全般", "OresmeError atomic time_zone set_time_zone"),
}

# Python protocols intentionally exposed to users.
PROTOCOLS = {"__len__", "__iter__", "__getitem__", "__setitem__"}
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


def assignments(body):
    return {
        target.id: node
        for node in body
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }


def exports(module):
    return ast.literal_eval(assignments(module.body)["__all__"].value)


def signature(node, name, *, method=False):
    args = copy.copy(node.args)
    if method:
        args.posonlyargs = list(args.posonlyargs)
        args.args = list(args.args)
        (args.posonlyargs or args.args).pop(0)
    result = f"{name}({ast.unparse(args)})"
    if node.returns:
        result += f" -> {ast.unparse(node.returns)}"
    return result


def docstring(node):
    return ast.get_docstring(node) or ""


def exceptions(node):
    """Name explicit raises. Calls into NumPy and the JS bridge can raise too."""
    names = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Raise) and isinstance(child.exc, ast.Call):
            name = ast.unparse(child.exc.func).removeprefix("_op.")
            if re.fullmatch(r"[A-Z]\w*", name):
                names.add(name)
    return ", ".join(f"`{name}`" for name in sorted(names))


def attributes(initializer):
    if initializer is None:
        return []
    return sorted(
        {
            target.attr
            for node in ast.walk(initializer)
            if isinstance(node, (ast.Assign, ast.AnnAssign))
            for target in (
                node.targets if isinstance(node, ast.Assign) else [node.target]
            )
            if isinstance(target, ast.Attribute)
            and isinstance(target.value, ast.Name)
            and target.value.id == "self"
            and not target.attr.startswith("_")
        }
    )


def fenced(source):
    return f"```python\n{source}\n```"


class Japanese:
    """The Japanese of the descriptions, from api-ja.json, by the name they describe.

    Each entry keeps a hash of the English it translates: when the docstring
    changes, the translation is out of date until it is checked again.
    Signatures, arguments and code stay as they are.
    """

    def __init__(self, entries):
        self.entries = entries
        self.missing = {}

    @staticmethod
    def source(english):
        return hashlib.sha256(english.encode("utf-8")).hexdigest()[:12]

    def __call__(self, key, english):
        if not english:
            return english
        entry = self.entries.get(key)
        if entry and entry.get("source") == self.source(english):
            return entry["ja"]
        self.missing[key] = english
        return english


def render_symbol(name, node, inherited_set, notes, japanese, translate=None):
    def text(key, english):
        return translate(key, english) if japanese and translate else english

    out = [f"## `{name}`"]
    if isinstance(node, FUNCTIONS):
        out.append(fenced(signature(node, f"op.{name}")))
    elif isinstance(node, ast.Assign):
        out.append(fenced(ast.unparse(node)))
    else:
        methods = {
            member.name: member for member in node.body if isinstance(member, FUNCTIONS)
        }
        initializer = methods.pop("__init__", None)
        if initializer:
            out.append(fenced(signature(initializer, f"op.{name}", method=True)))
    if not isinstance(node, ast.Assign) and docstring(node):
        out.append(text(name, docstring(node)))
    if name in notes:
        out.append(notes[name]["ja" if japanese else "en"])
    if isinstance(node, FUNCTIONS):
        raised = exceptions(node)
        if raised:
            label = "明示的な例外" if japanese else "Explicit exceptions"
            out.append(f"**{label}** · {raised}")
    if not isinstance(node, ast.ClassDef):
        return out

    class_assignments = assignments(node.body)
    properties = {}
    for member in node.body:
        if isinstance(member, FUNCTIONS) and any(
            isinstance(decorator, ast.Name) and decorator.id == "property"
            for decorator in member.decorator_list
        ):
            properties[member.name] = member
    for key, member in class_assignments.items():
        value = member.value
        if (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "property"
        ):
            properties[key] = None
    writable = {
        member.name
        for member in node.body
        if isinstance(member, FUNCTIONS)
        and any(
            isinstance(d, ast.Attribute) and d.attr == "setter"
            for d in member.decorator_list
        )
    }
    if properties:
        out.append("**プロパティ**" if japanese else "**Properties**")
        rows = []
        for key, member in properties.items():
            access = "read/write" if key in writable else "read-only"
            description = docstring(member) if member else ""
            detail = " ".join(text(f"{name}.{key}", description).split()) or notes.get(
                f"{name}.{key}", {}
            ).get("ja" if japanese else "en", "")
            rows.append(f"- `{key}` ({access})" + (f" · {detail}" if detail else ""))
        out.append("\n".join(rows))
    if "_props" in class_assignments:
        props = ast.literal_eval(class_assignments["_props"].value)
        label = "設定可能なプロパティ" if japanese else "Configurable properties"
        out.append(f"**{label}** · " + ", ".join(f"`{key}`" for key in props))
    fields = attributes(initializer)
    if fields:
        label = "インスタンス属性" if japanese else "Instance attributes"
        out.append(f"**{label}** · " + ", ".join(f"`{key}`" for key in fields))
    if any(isinstance(base, ast.Name) and base.id == "_Props" for base in node.bases):
        methods.setdefault("set", inherited_set)
    for key, method in methods.items():
        if key in properties or (key.startswith("_") and key not in PROTOCOLS):
            continue
        out.extend([f"### `{name}.{key}`", fenced(signature(method, key, method=True))])
        description = text(f"{name}.{key}", docstring(method)) or notes.get(
            f"{name}.{key}", {}
        ).get("ja" if japanese else "en", "")
        if description:
            out.append(description)
        raised = exceptions(method)
        if raised:
            label = "明示的な例外" if japanese else "Explicit exceptions"
            out.append(f"**{label}** · {raised}")
    return out


def generate():
    files = ("oresme.py", "_oresme_analysis.py", "_oresme_packages.py")
    modules = [ast.parse((SOURCE / file).read_text(encoding="utf-8")) for file in files]
    symbols = {}
    for file, module in zip(files, modules, strict=True):
        nodes = assignments(module.body)
        nodes.update(
            {
                node.name: node
                for node in module.body
                if isinstance(node, (*FUNCTIONS, ast.ClassDef))
            }
        )
        for name in exports(module):
            if name in symbols:
                raise ValueError(f"Duplicate export: {name}")
            symbols[name] = (file, nodes[name])
    categorized = [
        name
        for _, _, group in SECTIONS.values()
        for name in (group.split() if group else exports(modules[1]))
    ]
    if len(set(categorized)) != len(categorized) or set(categorized) != symbols.keys():
        raise ValueError(
            f"Update SECTIONS for __all__: missing={sorted(symbols.keys() - set(categorized))}, "
            f"unknown={sorted(set(categorized) - symbols.keys())}, "
            f"duplicates={sorted(name for name in set(categorized) if categorized.count(name) > 1)}"
        )
    base = next(
        node
        for node in modules[0].body
        if isinstance(node, ast.ClassDef) and node.name == "_Props"
    )
    inherited_set = next(
        node for node in base.body if isinstance(node, FUNCTIONS) and node.name == "set"
    )
    notes = json.loads((DOCS / "scripts/api-notes.json").read_text(encoding="utf-8"))
    translate = Japanese(json.loads(JAPANESE.read_text(encoding="utf-8")) if JAPANESE.is_file() else {})
    pages = {}
    for index, (slug, (title, japanese_title, group)) in enumerate(SECTIONS.items(), start=1):
        names = group.split() if group else exports(modules[1])
        source_links = ", ".join(
            f"[`{file}`]({REPOSITORY}/{file})"
            for file in sorted({symbols[name][0] for name in names})
        )
        for japanese in (True, False):
            prefix = Path() if japanese else Path("en")
            out = [
                f"---\ntitle: {japanese_title if japanese else title}\nsidebar:\n  order: {index}\neditUrl: false\n---",
                "<!-- Generated by scripts/generate-api.py. -->",
                f"[API の使い方](../../) · {source_links}"
                if japanese
                else f"[Using the API](../../) · {source_links}",
            ]
            for name in names:
                out.extend(
                    render_symbol(
                        name, symbols[name][1], inherited_set, notes, japanese, translate
                    )
                )
            pages[CONTENT / prefix / OUTPUT / f"{slug}.md"] = "\n\n".join(out) + "\n"
    return pages, translate.missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="fail if checked-in files differ"
    )
    parser.add_argument(
        "--untranslated",
        metavar="FILE",
        help="write the English of the descriptions without Japanese (or with outdated Japanese) to FILE",
    )
    args = parser.parse_args()
    pages, missing = generate()
    if args.untranslated:
        Path(args.untranslated).write_text(
            json.dumps(
                {key: {"source": Japanese.source(english), "en": english} for key, english in missing.items()},
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
    existing = set((CONTENT / OUTPUT).glob("*.md")) | set(
        (CONTENT / "en" / OUTPUT).glob("*.md")
    )
    stale = existing - pages.keys()
    mismatches = set(stale)
    for path, expected in pages.items():
        if args.check:
            if not path.is_file() or path.read_bytes() != expected.encode("utf-8"):
                mismatches.add(path)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(expected, encoding="utf-8", newline="\n")
    if not args.check:
        for path in stale:
            path.unlink()
    if mismatches:
        for path in sorted(mismatches):
            print(path.relative_to(DOCS))
        parser.exit(1, "API reference is out of date. Run pnpm docs:api.\n")
    if missing and args.check:
        for key in sorted(missing):
            print(key)
        parser.exit(
            1,
            f"{len(missing)} descriptions have no Japanese, or Japanese of an older docstring, in "
            "scripts/api-ja.json. Write --untranslated FILE to list them.\n",
        )
    print(
        f"{'Checked' if args.check else 'Generated'} {len(pages)} API reference pages."
    )


if __name__ == "__main__":
    main()
