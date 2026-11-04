"""Explicit R1-a golden generation; never invoked by npm test.

Independent Fraction arithmetic on represented binary64 values. No production
code or BigInt/dyadic decomposition is imported or translated here.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import platform
import random
import struct

PYTHON_VERSION = "3.12.14"
SEED = 0x596A
ROOT = Path(__file__).resolve().parent


def bits(value: float) -> str:
    return struct.pack(">d", value).hex()


def number(value: str) -> float:
    return struct.unpack(">d", bytes.fromhex(value))[0]


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def sign(value):
    return (value > 0) - (value < 0)


def point_relation(p, a, b):
    if p == a or p == b:
        return "endpoint"
    if cross(sub(p, a), sub(b, a)) == 0 and dot(sub(p, a), sub(p, b)) <= 0:
        return "interior"
    return "outside"


def segment_relation(a, b, c, d):
    r, s, q = sub(b, a), sub(d, c), sub(c, a)
    rr, ss = dot(r, r), dot(s, s)
    if rr == 0:
        return "touch" if point_relation(a, c, d) != "outside" else "disjoint"
    if ss == 0:
        return "touch" if point_relation(c, a, b) != "outside" else "disjoint"
    determinant = cross(r, s)
    if determinant != 0:
        t, u = cross(q, s) / determinant, cross(q, r) / determinant
        if 0 <= t <= 1 and 0 <= u <= 1:
            return "cross" if 0 < t < 1 and 0 < u < 1 else "touch"
        return "disjoint"
    if cross(q, r) != 0:
        return "disjoint"
    t0, t1 = dot(q, r) / rr, dot(sub(d, a), r) / rr
    start, end = max(Fraction(0), min(t0, t1)), min(Fraction(1), max(t0, t1))
    return "disjoint" if start > end else "touch" if start == end else "overlap"


def expected(encoded):
    points = [tuple(Fraction.from_float(number(x)) for x in p) for p in encoded]
    a, b, c, d = points
    area = sum(cross(p, q) for p, q in zip(points, points[1:] + points[:1]))
    return {
        "orientation": sign(cross(sub(b, a), sub(c, a))),
        "pointRelation": point_relation(a, b, c),
        "segmentRelation": segment_relation(a, b, c, d),
        "areaSign": sign(area),
    }


def generate():
    cases = []

    def add(name, points):
        encoded = [[bits(float(x)), bits(float(y))] for x, y in points]
        cases.append({"id": name, "points": encoded, **expected(encoded)})

    m = float.fromhex("0x1.fffffffffffffp+1023")
    tiny = float.fromhex("0x0.0000000000001p-1022")
    u = 2.0 ** -52
    named = [
        ("triangle", [(0, 0), (4, 0), (0, 3), (0, 0)]),
        ("rectangle", [(0, 0), (4, 0), (4, 3), (0, 3)]),
        ("bow-tie-algebraic-zero", [(0, 0), (2, 2), (0, 2), (2, 0)]),
        ("proper-cross", [(0, 0), (4, 4), (0, 4), (4, 0)]),
        ("shared-endpoint", [(0, 0), (1, 0), (1, 0), (2, 0)]),
        ("t-junction", [(0, 0), (2, 0), (1, 0), (1, 2)]),
        ("collinear-overlap", [(0, 0), (2, 0), (1, 0), (3, 0)]),
        ("reversed-same-segment", [(0, 0), (2, 0), (2, 0), (0, 0)]),
        ("vertical-overlap", [(2, -3), (2, 3), (2, -1), (2, 4)]),
        ("near-gap", [(0, 0), (1, 0), (1 + 2.0 ** -40, 0), (2, 0)]),
        ("near-touch", [(0, 0), (2, 0), (1, 2.0 ** -42), (1, 2)]),
        ("point-interior", [(1, 0), (0, 0), (2, 0), (2, 1)]),
        ("point-endpoint", [(0, 0), (0, 0), (2, 0), (2, 1)]),
        ("point-outside-collinear", [(3, 0), (0, 0), (2, 0), (2, 1)]),
        ("point-degenerate-equal", [(2, 3), (2, 3), (2, 3), (2, 3)]),
        ("point-degenerate-unequal", [(2, 3), (4, 3), (4, 3), (2, 3)]),
        ("two-points-same-y", [(0, 1), (0, 1), (2, 1), (2, 1)]),
        ("two-points-same-x", [(1, 0), (1, 0), (1, 2), (1, 2)]),
        ("point-on-segment", [(1, 0), (1, 0), (0, 0), (2, 0)]),
        ("signed-zero", [(0, -0.0), (-0.0, 0), (0, 0), (-0.0, -0.0)]),
        ("all-zero", [(0, 0)] * 4),
        ("subnormal-area", [(0, 0), (tiny, 0), (0, tiny), (0, 0)]),
        ("underflow-area", [(0, 0), (2.0 ** -600, 0), (0, 2.0 ** -600), (0, 0)]),
        ("overflow-differences", [(-m, -m), (m, -m), (0, m), (-m, -m)]),
        ("mixed-subnormal-and-max", [(0, tiny), (m, 0), (-m, 0), (0, -tiny)]),
        ("negative-subnormal", [(0, 0), (-tiny, 0), (0, tiny), (0, 0)]),
        ("near-collinear", [(0, 0), (1, 1), (2, 2 + 2.0 ** -50), (0, 0)]),
        ("product-cancellation", [(0, 0), (1, 1 + u), (1 - u, 1), (0, 0)]),
        ("origin-ulp", [(1e20, 1e20), (1e20 + 16384, 1e20), (1e20, 1e20 + 16384), (1e20, 1e20)]),
        ("origin-lost-increment", [(1e20, 1e20), (1e20 + 1, 1e20), (1e20, 1e20 + 1), (1e20, 1e20)]),
        ("geo-boundary-triangle", [(0, 0), (120, 0), (240, 100), (0, 0)]),
        ("geo-boundary-tiny-square", [(0, 0), (1e-6, 0), (1e-6, 1e-6), (0, 1e-6)]),
    ]
    for name, points in named:
        add(name, points)
    rng = random.Random(SEED)
    for i in range(64):
        # Full bit patterns, with a finite exponent chosen independently.
        encoded = []
        for _ in range(4):
            point = []
            for _ in range(2):
                word = (rng.getrandbits(1) << 63) | (rng.randrange(2047) << 52) | rng.getrandbits(52)
                point.append(f"{word:016x}")
            encoded.append(point)
        cases.append({"id": f"finite-bits-{i:02d}", "points": encoded, **expected(encoded)})
    return {
        "schema": 1,
        "python": f"CPython {PYTHON_VERSION}",
        "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "seed": f"0x{SEED:x}",
        "cases": cases,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if platform.python_implementation() != "CPython" or platform.python_version() != PYTHON_VERSION:
        parser.error(f"generation is pinned to CPython {PYTHON_VERSION}; review a pin/golden change explicitly")
    output = ROOT / "planar-oracle.json"
    data = json.dumps(generate(), indent=2, ensure_ascii=True) + "\n"
    if args.write:
        output.write_text(data, encoding="utf-8")
        print(f"Wrote {output.name}: 96 cases")
    elif json.loads(output.read_text(encoding="utf-8")) != json.loads(data):
        parser.exit(1, "planar oracle is stale; regenerate and review the golden diff\n")
    else:
        print("planar oracle matches: 96 cases")


if __name__ == "__main__":
    main()
