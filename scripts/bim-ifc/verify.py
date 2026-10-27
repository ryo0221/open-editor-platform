"""Independent check of IFC files written by `bim-ifc` (R2c-4a, CAD66).

Reads each `<name>.ifc` with IfcOpenShell (installed only in the verification
environment with pip, never shipped) next to `<name>.expected.json`, which the
`bim-ifc` test writes when `BIM_IFC_OUT` is set:

    BIM_IFC_OUT=work/bim-ifc npx vitest run packages/bim-ifc
    python -I scripts/bim-ifc/verify.py work/bim-ifc

Checks: the schema and EXPRESS rules (`ifcopenshell.validate`), the spatial
structure, entity counts, `Qto_*` values, and each element's volume and bounds
from IfcOpenShell's own geometry against `bim-core`'s analytic values.
"""

import json
import sys
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.validate


def mesh_volume_bounds(shape):
    v = shape.geometry.verts
    f = shape.geometry.faces
    pts = [(v[i], v[i + 1], v[i + 2]) for i in range(0, len(v), 3)]
    vol = 0.0
    for i in range(0, len(f), 3):
        a, b, c = pts[f[i]], pts[f[i + 1]], pts[f[i + 2]]
        vol += (
            a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])
        ) / 6.0
    lo = [min(p[k] for p in pts) for k in range(3)]
    hi = [max(p[k] for p in pts) for k in range(3)]
    return vol, lo, hi


def check(path: Path, expected: dict) -> list[str]:
    errors: list[str] = []
    f = ifcopenshell.open(str(path))
    if f.schema_identifier != "IFC4":
        errors.append(f"schema {f.schema_identifier}")
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(f, logger, express_rules=True)
    for s in logger.statements:
        errors.append("validate: " + str(s.get("message", s)).replace("\n", " ")[:300])

    # Spatial structure: storeys under the building, spaces aggregated, the rest contained.
    storeys = f.by_type("IfcBuildingStorey")
    if len(storeys) != expected["storeys"]:
        errors.append(f"storeys {len(storeys)} != {expected['storeys']}")
    contained = {e.id() for r in f.by_type("IfcRelContainedInSpatialStructure") for e in r.RelatedElements}
    for sp in f.by_type("IfcSpace"):
        parent = ifcopenshell.util.element.get_aggregate(sp)
        if not parent or not parent.is_a("IfcBuildingStorey"):
            errors.append(f"space {sp.GlobalId} not aggregated under a storey")
        if sp.id() in contained:
            errors.append(f"space {sp.GlobalId} contained (WR31)")
    for el in f.by_type("IfcElement"):
        if el.is_a("IfcOpeningElement"):
            continue
        if el.id() not in contained:
            errors.append(f"{el.is_a()} {el.GlobalId} not contained")

    counts = {k: len(f.by_type(k, include_subtypes=False)) for k in expected["counts"]}
    for k, n in expected["counts"].items():
        if counts[k] != n:
            errors.append(f"count {k} {counts[k]} != {n}")

    # Quantities.
    for gid, exp in expected["elements"].items():
        el = f.by_guid(gid)
        qtos = ifcopenshell.util.element.get_psets(el, qtos_only=True)
        for name, value in exp.get("qto", {}).items():
            qset, q = name.split(".")
            got = qtos.get(qset, {}).get(q)
            if got is None or abs(got - value) > 1e-9 * max(1.0, abs(value)):
                errors.append(f"qto {gid} {name} {got} != {value}")

    # Part colours (OH-U1): the surface styles on the items of each part's body.
    styled: dict[int, list] = {}
    for si in f.by_type("IfcStyledItem"):
        if si.Item is not None:
            styled.setdefault(si.Item.id(), []).append(si)
    for gid, exp in expected["elements"].items():
        if "styles" not in exp:
            continue
        el = f.by_guid(gid)
        got = []
        for rep in el.Representation.Representations:
            for item in rep.Items:
                for si in styled.get(item.id(), []):
                    for style in si.Styles:
                        for shading in style.Styles:
                            if shading.is_a("IfcSurfaceStyleShading"):
                                c = shading.SurfaceColour
                                got.append([c.Red, c.Green, c.Blue, shading.Transparency or 0.0])
        if len(got) != len(exp["styles"]) or any(
            abs(a - b) > 1e-9 for g, w in zip(got, exp["styles"]) for a, b in zip(g, w)
        ):
            errors.append(f"styles {gid} {got} != {exp['styles']}")

    # Geometry from IfcOpenShell's own kernel.
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    # Fine enough that the faceted arcs stay within the curved tolerance below.
    settings.set("mesher-linear-deflection", 0.0001)
    settings.set("mesher-angular-deflection", 0.005)
    it = ifcopenshell.geom.iterator(settings, f, include=[f.by_guid(g) for g in expected["elements"]])
    seen = set()
    if it.initialize():
        while True:
            shape = it.get()
            gid = shape.guid
            seen.add(gid)
            exp = expected["elements"][gid]
            vol, lo, hi = mesh_volume_bounds(shape)
            # Coordinates come back in metres.
            vol_mm3 = vol * 1e9
            # Faceted arcs lose a little volume; plane faces must agree to the last digits.
            rel = 1e-4 if exp.get("curved") else 1e-6
            if "volume" in exp and abs(vol_mm3 - exp["volume"]) > rel * exp["volume"] + 1.0:
                errors.append(f"volume {gid} {exp['kind']} {vol_mm3:.3f} != {exp['volume']:.3f}")
            if "bounds" in exp:
                for k in range(3):
                    for got, want in ((lo[k] * 1e3, exp["bounds"][0][k]), (hi[k] * 1e3, exp["bounds"][1][k])):
                        if abs(got - want) > 0.01:
                            errors.append(f"bounds {gid} {exp['kind']} axis {k} {got:.3f} != {want:.3f}")
            if not it.next():
                break
    for gid in expected["elements"]:
        if gid not in seen:
            errors.append(f"no geometry for {gid}")
    return errors


def main() -> int:
    root = Path(sys.argv[1])
    found = sorted(root.glob("*.expected.json")) if root.is_dir() else []
    if not found:
        # Nothing to check means the export step was skipped or pointed elsewhere.
        print(f"FAIL no *.expected.json in {root}")
        return 1
    failed = False
    for exp_path in found:
        name = exp_path.name.removesuffix(".expected.json")
        expected = json.loads(exp_path.read_text())
        errors = check(root / f"{name}.ifc", expected)
        n = len(expected["elements"])
        if errors:
            failed = True
            print(f"FAIL {name}: {len(errors)} problems ({n} elements)")
            for e in errors[:40]:
                print("  " + e)
        else:
            print(f"PASS {name}: {n} elements, {expected['storeys']} storeys, counts {expected['counts']}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
