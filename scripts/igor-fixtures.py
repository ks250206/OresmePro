#!/usr/bin/env python3
"""Writes the Igor Pro files that the unit tests read, into src/core/io/testdata/igor/.

Run it from the repository root, with NumPy installed:

    python3 scripts/igor-fixtures.py

The files are written here from the formats as WaveMetrics describes them:
Technical Note TN003 for binary waves (.ibw, versions 1, 2, 3 and 5) and
PTN003 for packed experiments (.pxp). Beside them, expected.json says what
each file holds, in the terms the reader (src/core/io/igor.ts) gives it:
values in C order of Igor's dimensions (rows outermost), text in Igor's
point order, notes with "\\n" line ends. The tests compare the reader with
that; checking the files with another Igor reader shows that they are what
Igor would read.

The files are small and are committed; running this again writes the same bytes.
"""

import json
import pathlib
import struct

import numpy as np

OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "core" / "io" / "testdata" / "igor"

# Number types (TN003).
NT_CMPLX, NT_FP32, NT_FP64, NT_I8, NT_I16, NT_I32, NT_UNSIGNED, NT_I64 = (
    0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80)
CODES = {
    "float32": NT_FP32, "float64": NT_FP64, "int8": NT_I8, "uint8": NT_I8 | NT_UNSIGNED,
    "int16": NT_I16, "uint16": NT_I16 | NT_UNSIGNED, "int32": NT_I32, "uint32": NT_I32 | NT_UNSIGNED,
    "int64": NT_I64, "uint64": NT_I64 | NT_UNSIGNED,
}
WORDS = {
    "float32": "32-bit float", "float64": "64-bit float", "int8": "8-bit integer",
    "uint8": "8-bit unsigned integer", "int16": "16-bit integer", "uint16": "16-bit unsigned integer",
    "int32": "32-bit integer", "uint32": "32-bit unsigned integer", "int64": "64-bit integer",
    "uint64": "64-bit unsigned integer",
}
# The type a wave of each kind has in the app, real and complex.
APP_TYPE = {
    "float32": ("float32", "complex64"), "float64": ("float64", "complex128"),
    "int8": ("int8", "complex64"), "uint8": ("uint8", "complex64"),
    "int16": ("int16", "complex64"), "uint16": ("uint16", "complex64"),
    "int32": ("int32", "complex128"), "uint32": ("uint32", "complex128"),
    "int64": ("float64", "complex128"), "uint64": ("float64", "complex128"),
}


def number(value):
    """A value for JSON: what is not finite is written as text."""
    value = float(value)
    if np.isnan(value):
        return "NaN"
    if np.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def checksum(header):
    """The value that makes the 16-bit words of the headers add up to zero."""
    total = sum(struct.unpack(f"<{len(header) // 2}h", header))
    return struct.unpack("<h", struct.pack("<H", -total & 0xFFFF))[0]


class Wave:
    """A wave to write, and what the reader should make of it."""

    def __init__(self, name, values=None, *, kind=None, complex_=False, text=None, shape=None,
                 scaling=None, dim_units=None, unit=b"", note=b"", formula=b"", long_unit=b"",
                 long_dim_units=None, labels=None, save_values=True, expect=None):
        self.name = name.encode() if isinstance(name, str) else name
        self.kind = kind
        self.complex = complex_
        self.text = text
        if text is not None:
            self.shape = list(shape or [len(text)])
        else:
            # Values are indexed [row, column, ...] as in Igor.
            self.values = np.asarray(values)
            self.shape = list(self.values.shape)
        self.scaling = scaling or [(0.0, 1.0)] * len(self.shape)
        self.dim_units = dim_units or [b""] * len(self.shape)
        self.unit, self.note, self.formula = unit, note, formula
        self.long_unit = long_unit
        self.long_dim_units = long_dim_units or [b""] * 4
        self.labels = labels or [b""] * 4
        self.save_values = save_values
        self.expect = expect or {}

    @property
    def npnts(self):
        return int(np.prod(self.shape)) if self.shape else 0

    def code(self):
        return 0 if self.text is not None else CODES[self.kind] | (NT_CMPLX if self.complex else 0)

    def value_bytes(self, order):
        """The values as they lie in the file: the first index fastest, complex as pairs."""
        if self.text is not None:
            return b"".join(self.text)
        dtype = np.dtype(self.kind).newbyteorder(order)
        flat = self.values.flatten(order="F")
        if self.complex:
            pairs = np.empty(flat.size * 2, dtype=dtype)
            pairs[0::2] = flat.real
            pairs[1::2] = flat.imag
            return pairs.tobytes()
        return flat.astype(dtype).tobytes()

    def expected(self, version, order):
        """What the reader gives for this wave."""
        little = order == "<"
        dims = [
            {"size": size, "start": start, "delta": delta,
             "unit": (self.long_dim_units[d] or self.dim_units[d]).decode("utf-8")}
            for d, (size, (start, delta)) in enumerate(zip(self.shape, self.scaling))
        ]
        note = self.expect["note"] if "note" in self.expect else self.note.decode("utf-8")
        result = {
            "name": self.expect.get("name", self.name.decode("utf-8")),
            "version": version,
            "littleEndian": little,
            "igorType": "text" if self.text is not None
            else WORDS[self.kind] + (", complex" if self.complex else ""),
            "dims": dims,
            "unit": self.expect["unit"] if "unit" in self.expect
            else (self.long_unit or self.unit).decode("utf-8"),
            "note": note.replace("\r\n", "\n").replace("\r", "\n"),
            "formula": self.formula.rstrip(b"\0").decode("utf-8"),
            "missingValues": not self.save_values,
        }
        if self.text is not None:
            result.update(type="float64", shape=[len(self.text)], imag=None,
                          text=self.expect["text"] if "text" in self.expect
                          else [item.decode("utf-8") for item in self.text])
        elif not self.save_values:
            result.update(type=APP_TYPE[self.kind][self.complex], shape=[0], values=[], imag=None,
                          text=None)
        else:
            flat = self.values.flatten(order="C")
            real = flat.real if self.complex else flat
            result.update(
                type=APP_TYPE[self.kind][self.complex], shape=self.shape, text=None,
                values=[number(value) for value in real.astype(np.float64)],
                imag=[number(value) for value in flat.imag.astype(np.float64)] if self.complex else None,
            )
        return result

    def write(self, version, order):
        if version == 5:
            return self.write5(order)
        return self.write2(version, order)

    def write2(self, version, order):
        """Versions 1 to 3: BinHeader1/2/3, then WaveHeader2 (110 bytes before the values)."""
        values = self.value_bytes(order) if self.save_values else b""
        header = bytearray(126)
        struct.pack_into(order + "h", header, 0, self.code())
        header[6:6 + len(self.name)] = self.name
        header[34:34 + len(self.unit)] = self.unit
        header[38:38 + len(self.dim_units[0])] = self.dim_units[0]
        struct.pack_into(order + "l", header, 42, self.npnts)
        start, delta = self.scaling[0]
        struct.pack_into(order + "dd", header, 48, delta, start)
        struct.pack_into(order + "L", header, 96, 3_000_000_000)  # creation date
        struct.pack_into(order + "L", header, 102, 3_000_000_001)  # modification date
        # WaveHeader2 ends with 16 bytes of values; wfmSize counts them, and 16
        # bytes of padding follow the values.
        wfm = bytes(header[:110]) + values + bytes(16)
        wfm_size = 126 + len(values)
        if version == 1:
            fields, size = (version, wfm_size, 0), "hlh"
        elif version == 2:
            fields, size = (version, wfm_size, len(self.note), 0, 0), "hlllh"
        else:
            fields, size = (version, wfm_size, len(self.note), len(self.formula), 0, 0), "hllllh"
        bin_header = struct.pack(order + size, *fields)
        words = bin_header + wfm[:126]
        check = checksum(bytes(np.frombuffer(words, dtype=np.dtype("i2").newbyteorder(order))
                               .astype("<i2").tobytes()))
        bin_header = bin_header[:-2] + struct.pack(order + "h", check)
        tail = b"" if version == 1 else self.note + (self.formula if version == 3 else b"")
        return bin_header + wfm + tail

    def write5(self, order):
        """Version 5: BinHeader5, WaveHeader5 (320 bytes), values, then the sections."""
        values = self.value_bytes(order) if self.save_values else b""
        header = bytearray(320)
        struct.pack_into(order + "LLl", header, 4, 3_000_000_000, 3_000_000_001, self.npnts)
        struct.pack_into(order + "h", header, 16, self.code())
        struct.pack_into(order + "h", header, 26, 1)  # whVersion
        header[28:28 + len(self.name)] = self.name
        shape = (self.shape + [0, 0, 0, 0])[:4] if self.npnts else [0, 0, 0, 0]
        struct.pack_into(order + "4l", header, 68, *shape)
        scaling = (self.scaling + [(0.0, 1.0)] * 4)[:4]
        struct.pack_into(order + "4d", header, 84, *[delta for _, delta in scaling])
        struct.pack_into(order + "4d", header, 116, *[start for start, _ in scaling])
        header[148:148 + len(self.unit)] = self.unit
        for d, unit in enumerate(self.dim_units[:4]):
            header[152 + 4 * d:152 + 4 * d + len(unit)] = unit
        indices = b""
        if self.text is not None:
            ends = np.cumsum([len(item) for item in self.text]).astype(np.dtype("i4").newbyteorder(order))
            indices = ends.tobytes()
        sizes = [320 + len(values), len(self.formula), len(self.note), len(self.long_unit),
                 *[len(unit) for unit in self.long_dim_units], *[len(label) for label in self.labels],
                 len(indices), 0, 0]
        bin_header = struct.pack(order + "hhl" + "l" * 14, 5, 0, *sizes)
        words = np.frombuffer(bin_header + bytes(header), dtype=np.dtype("i2").newbyteorder(order))
        check = checksum(words.astype("<i2").tobytes())
        bin_header = bin_header[:2] + struct.pack(order + "h", check) + bin_header[4:]
        return (bin_header + bytes(header) + values + self.formula + self.note + self.long_unit
                + b"".join(self.long_dim_units) + b"".join(self.labels) + indices)


def record(order, kind, data, superseded=False, version=0):
    """A record of a packed experiment: type, version, size, then the data."""
    return struct.pack(order + "Hhl", kind | (0x8000 if superseded else 0), version, len(data)) + data


def variables(order, numbers, strings):
    """A version 2 variables record: user numeric variables and user strings, no system ones."""
    data = struct.pack(order + "hhhhhh", 2, 0, len(numbers), len(strings), 0, 0)
    for name, value in numbers:
        data += name.ljust(32, b"\0") + struct.pack(order + "hhddl", 1, NT_FP64, value, 0.0, 0)
    for name, value in strings:
        data += name.ljust(32, b"\0") + struct.pack(order + "l", len(value)) + value
    # A record version that is not zero shows other readers the byte order.
    return record(order, 1, data, version=1)


def label_block(labels):
    """Dimension labels: 32 bytes each, the first for the dimension itself."""
    return b"".join(label.ljust(32, b"\0") for label in labels)


def single_waves():
    """The .ibw files: (file name, version, byte order, wave)."""
    ramp = np.arange(8) * 0.125 - 0.5
    cube = np.fromfunction(lambda i, j, k: i + 10 * j + 100 * k, (4, 3, 2))
    four = np.arange(3 * 2 * 2 * 2, dtype=np.uint16).reshape((3, 2, 2, 2), order="F")
    matrix = (np.arange(6).reshape((3, 2), order="F") + 1j * (np.arange(6).reshape((3, 2), order="F") - 10))
    return [
        ("v1-be.ibw", 1, ">", Wave("old", np.array([1.5, -2.5, 3.25]), kind="float32",
                                   scaling=[(10.0, 0.5)], dim_units=[b"s"], unit=b"V")),
        ("v2-le.ibw", 2, "<", Wave("sig 1", np.array([0.1, np.nan, np.inf, -np.inf, 1e300, -0.0, 5e-324, 2]),
                                   kind="float64", scaling=[(-1.0, 0.25)], dim_units=[b"ms"],
                                   unit=b"mV", note=b"first line\rsecond line\r\nthird")),
        ("v2-be-int16.ibw", 2, ">", Wave("counts", np.array([-32768, -1, 0, 1, 32767]), kind="int16")),
        ("v3-le-formula.ibw", 3, "<", Wave("twice", ramp * 2, kind="float32",
                                           formula=b"ramp*2\0", note=b"made from ramp")),
        ("v3-be-dependent.ibw", 3, ">", Wave("dependent", np.zeros(10), kind="float32",
                                             formula=b" K0\0", save_values=False)),
        ("v5-be-3d.ibw", 5, ">", Wave(
            "cube", cube, kind="float64",
            scaling=[(0.5, 0.1), (-1.0, 2.0), (5.0, 0.5)], dim_units=[b"", "µm".encode(), b"K"],
            long_unit=b"counts per second", long_dim_units=[b"nanometre", b"", b"", b""],
            labels=[label_block([b"", b"first", b"second", b"", b""]), b"", b"", b""],
            note="測定 1\r温度 300 K".encode())),
        ("v5-le-4d-uint16.ibw", 5, "<", Wave("frames", four, kind="uint16")),
        ("v5-le-complex.ibw", 5, "<", Wave("spectrum", matrix, kind="float32", complex_=True,
                                           scaling=[(0.0, 2.5), (100.0, -1.0)], dim_units=[b"Hz", b"s"])),
        ("v5-be-cint16.ibw", 5, ">", Wave("iq", np.array([1 - 2j, -32768 + 32767j, 0j]), kind="int16",
                                          complex_=True)),
        ("v5-le-text.ibw", 5, "<", Wave("labels", text=[b"alpha", b"", "µm".encode(), "日本語".encode(), b"x"],
                                        note=b"names")),
        ("v5-be-text-legacy.ibw", 5, ">", Wave(
            "legacy", text=[b"\xb5s", b"\xa1C", "温度".encode("shift_jis"), b"plain"], shape=[2, 2],
            unit=b"\xb5A", note="°C".encode("mac_roman"),
            expect={"text": ["µs", "°C", "温度", "plain"], "unit": "µA", "note": "°C"})),
        ("v5-le-text-1252.ibw", 5, "<", Wave(
            "western", text=[b"\xb5s", b"\xb0C"], expect={"text": ["µs", "°C"]})),
        ("v5-le-zero.ibw", 5, "<", Wave("empty", np.zeros(0), kind="float32")),
        ("v5-le-float64.ibw", 5, "<", Wave("long", np.sin(np.arange(1000) / 10), kind="float64",
                                           scaling=[(0.0, 0.001)], dim_units=[b"s"], unit=b"V")),
        ("v5-le-int64.ibw", 5, "<", Wave("big", np.array(
            [-(2**63), -1, 0, 2**53, 2**53 + 1, 2**63 - 1], dtype=np.int64), kind="int64")),
        ("v5-be-uint64.ibw", 5, ">", Wave("ubig", np.array([0, 2**53, 2**64 - 1], dtype=np.uint64),
                                          kind="uint64")),
        ("v5-le-dependent.ibw", 5, "<", Wave("dependent5", np.zeros(4), kind="float64",
                                             formula=b"sin(x)\0", save_values=False)),
    ]


def experiment(order):
    """A packed experiment with waves in nested data folders, and the other kinds of record."""
    types = ["int8", "uint8", "int16", "uint16", "int32", "uint32", "float32", "float64"]
    records, waves, folders = [], [], []

    def wave(folder, item, version=5, superseded=False):
        records.append(record(order, 3, item.write(version, order), superseded))
        if not superseded:
            waves.append({"folder": folder, **item.expected(version, order)})

    def start(path, long=False):
        name = path[-1].encode()
        data = struct.pack(order + "L", len(name)) + name if long else name.ljust(32, b"\0")
        # Igor 8 gives data folder records version 1.
        records.append(record(order, 101 if long else 9, data, version=1))
        folders.append(path)

    def end():
        records.append(record(order, 10, b""))

    records.append(variables(order, [(b"gain", 2.5)], [(b"label", b"abc")]))
    wave([], Wave("wave0", np.array([1.0, 2.0, 3.0]), kind="float64"))
    wave([], Wave("old", np.array([9.0]), kind="float64"), superseded=True)
    wave([], Wave("my wave", np.array([1, 2]), kind="int16", unit=b"V"), version=2)
    wave([], Wave("a b", np.array([1.0]), kind="float32"))
    wave([], Wave("a_b", np.array([2.0]), kind="float32"))
    wave([], Wave("2nd", np.array([3.0]), kind="float32"))
    wave([], Wave("dup", np.array([4.0]), kind="float32"))
    wave([], Wave("dep", np.zeros(3), kind="float32", formula=b"wave0*2\0", save_values=False), version=3)
    start(["raw data"])
    records.append(variables(order, [(b"offset", -1.0)], []))
    wave(["raw data"], Wave("sig", np.linspace(0, 1, 5), kind="float32", scaling=[(2.0, 0.5)],
                            dim_units=[b"s"], unit=b"A", note=b"raw\rsignal"))
    start(["raw data", "run 1"])
    for index, kind in enumerate(types):
        info = np.iinfo(kind) if kind.startswith(("int", "uint")) else None
        values = np.array([info.min, 0, info.max]) if info else np.array([-1.5, 0.0, 2.25])
        wave(["raw data", "run 1"], Wave(f"t{index} {kind}", values, kind=kind))
    wave(["raw data", "run 1"], Wave("c64", np.array([1 + 2j, -3.5j]), kind="float32", complex_=True))
    wave(["raw data", "run 1"], Wave("c128", np.array([1e300 - 1e-300j]), kind="float64", complex_=True))
    wave(["raw data", "run 1"], Wave("cu32", np.array([4294967295 + 1j]), kind="uint32", complex_=True))
    wave(["raw data", "run 1"], Wave("matrix", np.arange(6.0).reshape((2, 3), order="F"), kind="float64",
                                     scaling=[(0.0, 1.0), (10.0, 5.0)], dim_units=[b"", b"mm"]))
    end()
    end()
    start(["a folder whose name is longer than 31 bytes"], long=True)
    wave(["a folder whose name is longer than 31 bytes"], Wave("labels", text=[b"one", b"two"]))
    end()
    start(["dup"])
    wave(["dup"], Wave("inner", np.array([5.0]), kind="float32"))
    end()
    start(["only variables"])
    records.append(variables(order, [(b"x", 1.0), (b"y", 2.0)], [(b"s", b"t")]))
    end()
    # A kind of record this reader does not know is passed over.
    records.append(record(order, 33, b"\x01\x02\x03\x04"))
    records.append(record(order, 2, b"Make wave0\rDisplay wave0\r"))
    records.append(record(order, 4, b"Window Graph0() : Graph\r\tDisplay wave0\rEndMacro\r"
                                    b"\rWindow Table0() : Table\r\tEdit wave0\rEndMacro\r"
                                    b"\rWindow Graph1() : Graph\r\tDisplay sig\rEndMacro\r"))
    records.append(record(order, 5, b"#pragma rtGlobals=3\r"))
    expected = {
        "littleEndian": order == "<",
        "folders": folders,
        "rest": {"variables": 4, "strings": 2, "windows": {"Graph": 2, "Table": 1},
                 "procedure": True, "history": True, "packedFiles": 0, "other": 1},
        "waves": waves,
    }
    return b"".join(records), expected


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    expected = {}
    for filename, version, order, item in single_waves():
        (OUT / filename).write_bytes(item.write(version, order))
        expected[filename] = item.expected(version, order)
    for filename, order in (("experiment-le.pxp", "<"), ("experiment-be.pxp", ">")):
        data, description = experiment(order)
        (OUT / filename).write_bytes(data)
        expected[filename] = description
    (OUT / "expected.json").write_text(json.dumps(expected, indent=1, ensure_ascii=False) + "\n")
    print(f"Wrote {len(expected)} files to {OUT}")


if __name__ == "__main__":
    main()
