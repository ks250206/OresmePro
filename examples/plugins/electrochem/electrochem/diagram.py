"""Circuits as diagrams: boxes joined by wires, for the view's nodes part.

A diagram is what the application's nodes part edits: ``{"nodes": [...],
"edges": [...]}``. Each element is a node with two ports, ``a`` and ``b``,
whose id is its name in the circuit (``R0``, ``CPE1``); the two ends of the
circuit are the fixed nodes ``start`` and ``end``. Wires join ports; ports
joined, directly or through others, are one point of the circuit.

``diagram_of`` lays a circuit out: series from left to right, parallel
branches one under another. ``circuit_of`` reads a diagram back as text, by
taking elements in series (two that alone meet at a point) and in parallel
(two between the same points) together until one is left between the ends.
A diagram that cannot be taken apart so (a bridge, an element with an end
joined to nothing) is said to be so, in words.
"""

from oresme_plugin import PluginError

from .circuit import _ELEMENT, Circuit, Element, Parallel, Series

#: The kinds an element of a diagram can be, with their titles, as the palette lists them.
KINDS = (
    ("R", "Resistor"),
    ("C", "Capacitor"),
    ("L", "Inductor"),
    ("CPE", "Constant-phase element"),
    ("W", "Warburg"),
    ("Wo", "Warburg, finite, open"),
    ("Ws", "Warburg, finite, short"),
)
START, END = "start", "end"
GRID = 10
GAP_X, GAP_Y = 40, 18
HEIGHT = 26


def _width(label):
    """As wide as the application draws a node with this label."""
    return max(44, len(label) * 7 + 18)


def _snap(value):
    return int(round(value / GRID)) * GRID


# --- Laying a circuit out --------------------------------------------------------


def _size(tree):
    if isinstance(tree, Element):
        return _width(tree.name), HEIGHT
    sizes = [_size(part) for part in (tree.parts if isinstance(tree, Series) else tree.branches)]
    if isinstance(tree, Series):
        return sum(w for w, _ in sizes) + GAP_X * (len(sizes) - 1), max(h for _, h in sizes)
    # Room on each side of the branches for the wires that join them.
    return max(w for w, _ in sizes) + 2 * GAP_X, sum(h for _, h in sizes) + GAP_Y * (len(sizes) - 1)


def _place(tree, x, y, nodes, edges):
    """Places a part at x, y; returns the ports at its left end and at its right end."""
    if isinstance(tree, Element):
        nodes.append({"id": tree.name, "kind": tree.kind, "label": tree.name,
                      "x": _snap(x), "y": _snap(y)})
        return [[tree.name, "a"]], [[tree.name, "b"]]
    width, height = _size(tree)
    if isinstance(tree, Series):
        left = right = None
        at = x
        for part in tree.parts:
            w, h = _size(part)
            part_left, part_right = _place(part, at, y + (height - h) / 2, nodes, edges)
            if right is not None:
                edges.append({"from": right[0], "to": part_left[0]})
            left = left or part_left
            right = part_right
            at += w + GAP_X
        return left, right
    lefts, rights = [], []
    at = y
    for branch in tree.branches:
        w, h = _size(branch)
        branch_left, branch_right = _place(branch, x + GAP_X + (width - 2 * GAP_X - w) / 2, at,
                                           nodes, edges)
        if lefts:
            edges.append({"from": lefts[0], "to": branch_left[0]})
            edges.append({"from": rights[0], "to": branch_right[0]})
        lefts.append(branch_left[0])
        rights.append(branch_right[0])
        at += h + GAP_Y
    return lefts, rights


def diagram_of(circuit):
    """A diagram of a circuit (a Circuit, or its text), laid out from the top left."""
    tree = (circuit if isinstance(circuit, Circuit) else Circuit(circuit)).tree
    nodes, edges = [], []
    width, height = _size(tree)
    top = 16 + max(0, (height - HEIGHT) / 2)
    nodes.append({"id": START, "kind": START, "label": "Start", "x": 10, "y": _snap(top),
                  "fixed": True})
    left, right = _place(tree, 100, 16, nodes, edges)
    nodes.append({"id": END, "kind": END, "label": "End", "x": _snap(100 + width + GAP_X),
                  "y": _snap(top), "fixed": True})
    edges.insert(0, {"from": [START, "p"], "to": left[0]})
    edges.append({"from": right[0], "to": [END, "p"]})
    return {"nodes": nodes, "edges": edges}


# --- Reading a diagram ---------------------------------------------------------------


def _reverse(tree):
    kind, parts = tree
    if kind == "el":
        return tree
    if kind == "s":
        return ("s", [_reverse(part) for part in reversed(parts)])
    return ("p", [_reverse(part) for part in parts])


def _text(tree, inner=False):
    kind, parts = tree
    if kind == "el":
        return parts
    if kind == "s":
        return "-".join(_text(part, True) for part in parts)
    return "p(" + ",".join(_text(part) for part in parts) + ")"


def _canonical(tree):
    """The same circuit written one way: parallel branches in order of their text."""
    kind, parts = tree
    if kind == "el":
        return parts
    if kind == "s":
        return "-".join(_canonical(part) for part in parts)
    return "p(" + ",".join(sorted(_canonical(part) for part in parts)) + ")"


def _from_tree(node):
    if isinstance(node, Element):
        return ("el", node.name)
    if isinstance(node, Series):
        return ("s", [_from_tree(part) for part in node.parts])
    return ("p", [_from_tree(branch) for branch in node.branches])


def same_circuit(a, b):
    """Whether two circuits' texts are the same circuit, branches in any order."""
    try:
        return _canonical(_from_tree(Circuit(a).tree)) == _canonical(_from_tree(Circuit(b).tree))
    except PluginError:
        return False


def circuit_of(diagram):
    """The text of the circuit a diagram draws, or PluginError saying why it is not one."""
    if not isinstance(diagram, dict):
        raise PluginError("There is no diagram yet.")
    nodes = [node for node in diagram.get("nodes") or [] if isinstance(node, dict)]
    edges = [edge for edge in diagram.get("edges") or [] if isinstance(edge, dict)]
    ids = {node.get("id") for node in nodes}
    if START not in ids or END not in ids:
        raise PluginError("The diagram has lost its start or its end.")

    parent = {}

    def find(point):
        parent.setdefault(point, point)
        while parent[point] != point:
            parent[point] = parent[parent[point]]
            point = parent[point]
        return point

    for edge in edges:
        a, b = edge.get("from"), edge.get("to")
        if isinstance(a, list) and isinstance(b, list) and a[0] in ids and b[0] in ids:
            parent[find(tuple(a))] = find(tuple(b))

    items = []  # [left point, right point, tree], in the order the nodes are listed
    for node in nodes:
        name, kind = node.get("id"), node.get("kind")
        if name in (START, END):
            continue
        match = _ELEMENT.fullmatch(str(name))
        if not match or ("CPE" if match.group(1) == "Q" else match.group(1)) != kind:
            raise PluginError(f"{name} is not the name of a {kind}: call it {kind}1, say.")
        items.append([find((name, "a")), find((name, "b")), ("el", name)])
    if not items:
        raise PluginError("Add elements from the palette, and wire them from the start to the end.")
    start, end = find((START, "p")), find((END, "p"))
    if start == end:
        raise PluginError("The start is wired straight to the end: nothing would be between them.")

    while True:
        for left, right, tree in items:
            if left == right:
                raise PluginError(f"{_text(tree)} has both ends wired together.")
        degree = {}
        for left, right, _ in items:
            for point in (left, right):
                degree[point] = degree.get(point, 0) + 1
        for point in (start, end):
            if degree.get(point, 0) == 0:
                raise PluginError(f"Nothing is wired to the {'start' if point == start else 'end'}.")
        for left, right, tree in items:
            for point in (left, right):
                if degree[point] == 1 and point not in (start, end):
                    raise PluginError(f"{_text(tree)} has an end wired to nothing.")
        if len(items) == 1:
            left, right, tree = items[0]
            if {left, right} != {start, end}:
                raise PluginError("The elements are not all between the start and the end.")
            return _text(tree if left == start else _reverse(tree))
        # In parallel: two between the same points.
        merged = False
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, b = items[i], items[j]
                if {a[0], a[1]} == {b[0], b[1]}:
                    other = b[2] if b[0] == a[0] else _reverse(b[2])
                    branches = [part for tree in (a[2], other)
                                for part in (tree[1] if tree[0] == "p" else [tree])]
                    items[i] = [a[0], a[1], ("p", branches)]
                    del items[j]
                    merged = True
                    break
            if merged:
                break
        if merged:
            continue
        # In series: two that alone meet at a point other than the ends.
        for point, count in degree.items():
            if count != 2 or point in (start, end):
                continue
            i, j = [index for index, item in enumerate(items) if point in item[:2]]
            a, b = items[i], items[j]
            first = a[2] if a[1] == point else _reverse(a[2])
            second = b[2] if b[0] == point else _reverse(b[2])
            left = a[0] if a[1] == point else a[1]
            right = b[1] if b[0] == point else b[0]
            parts = [part for tree in (first, second)
                     for part in (tree[1] if tree[0] == "s" else [tree])]
            items[i] = [left, right, ("s", parts)]
            del items[j]
            merged = True
            break
        if not merged:
            raise PluginError(
                "The diagram cannot be taken apart into parts in series and in parallel "
                "(a bridge between branches, say), so it cannot be written as a circuit."
            )
