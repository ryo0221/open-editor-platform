#!/usr/bin/env python3
"""Writes F46 (docs/cad/pmi.md, PMI-5): PMI through assembly paths, as the JAMA files write it.

Text edit of F43's `pmi-assembly.step` (the plate placed twice and the block once), so it needs no
OCCT: it appends `COMPONENT_PATH_SHAPE_ASPECT`s on the assembly's shape, each naming one
instance (`NEXT_ASSEMBLY_USAGE_OCCURRENCE`) and a shape aspect whose face is in that instance's
part, and PMI on them:

- flatness 0.03 on the block's top, through the block's only instance;
- flatness 0.04 on the plate's top, through the second plate instance only (never the first);
- a distance of 5 mm from the second plate's top to the block's top (two paths);
- flatness 0.05 on a `COMPOSITE_SHAPE_ASPECT` related to the block's path (the JAMA form);
- a datum `A` on the block's top through its path, and a parallelism 0.02 on the second plate's
  top (its path) referencing the plate part's own datum `A`: letters repeat across parts, so the
  tolerance must take the plate's `A` (copied onto that instance), never the block's.

Run: python3 scripts/cad-kernel/f46-path.py  (writes fixtures/f43/pmi-path.step and path.json)
"""
import json
import os
import re

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "..", "..", "packages", "cad-kernel-occt", "fixtures", "f43")
text = open(os.path.join(out, "pmi-assembly.step"), encoding="latin-1").read()


def entity(pattern):
    m = re.search(pattern, text, re.M)
    assert m, pattern
    return m


# The ids F43's writer gave: the assembly's shape, the instances, the parts' representations,
# the faces and the millimetre unit (checked here, so a change of the base file fails loudly).
asm_shape = "#4"
assert entity(r"^#4 = PRODUCT_DEFINITION_SHAPE\('','',#5\);")
plate_nauo = [m.group(1) for m in re.finditer(
    r"^(#\d+) = NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d','[^']*','',#5,#35,\$\);", text, re.M)]
block_nauo = [m.group(1) for m in re.finditer(
    r"^(#\d+) = NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d','[^']*','',#5,#473,\$\);", text, re.M)]
assert len(plate_nauo) == 2 and len(block_nauo) == 1
second_plate, block = plate_nauo[1], block_nauo[0]
# The plate's top (the face the part-level distance names second) and the block's top.
plate_top = entity(r"^#\d+ = GEOMETRIC_ITEM_SPECIFIC_USAGE\('','',#830,#40,(#\d+)\);").group(1)
block_top = entity(r"^#\d+ = GEOMETRIC_ITEM_SPECIFIC_USAGE\('','',#848,#478,(#\d+)\);").group(1)
mm = "#456"
assert entity(r"^#456 = \( LENGTH_UNIT\(\) NAMED_UNIT\(\*\) SI_UNIT\(\.MILLI\.,\.METRE\.\) \);")

n = max(int(m) for m in re.findall(r"^#(\d+)\s*=", text, re.M))
lines = []


def add(body):
    global n
    n += 1
    lines.append(f"#{n} = {body};")
    return f"#{n}"


def path(nauo, rep, face):
    aspect = add(f"SHAPE_ASPECT('','',{asm_shape},.T.)")
    add(f"GEOMETRIC_ITEM_SPECIFIC_USAGE('','',{aspect},{rep},{face})")
    return add(f"COMPONENT_PATH_SHAPE_ASPECT('','',{asm_shape},.F.,{nauo},{aspect})")


def flatness(value, on):
    measure = add(f"LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE({value}),{mm})")
    return add(f"FLATNESS_TOLERANCE('','',{measure},{on})")


block_path = path(block, "#478", block_top)
plate_path = path(second_plate, "#40", plate_top)
block_flatness = flatness("0.03", block_path)
plate_flatness = flatness("0.04", plate_path)
value = add(
    "( LENGTH_MEASURE_WITH_UNIT() MEASURE_REPRESENTATION_ITEM() \n"
    f"MEASURE_WITH_UNIT(POSITIVE_LENGTH_MEASURE(5.),{mm}) REPRESENTATION_ITEM('') )"
)
representation = add(f"SHAPE_DIMENSION_REPRESENTATION('',({value}),#455)")
location = add(f"DIMENSIONAL_LOCATION('linear distance',$,{plate_path},{block_path})")
add(f"DIMENSIONAL_CHARACTERISTIC_REPRESENTATION({location},{representation})")
composite = add(f"COMPOSITE_SHAPE_ASPECT('','',{asm_shape},.T.)")
add(f"SHAPE_ASPECT_RELATIONSHIP('',$,{composite},{block_path})")
flatness("0.05", composite)
block_datum = add(f"DATUM('','',{asm_shape},.F.,'A')")
add(f"SHAPE_ASPECT_RELATIONSHIP('',$,{block_path},{block_datum})")
plate_a = "#822"
assert entity(r"^#822 = DATUM\('','',#34,\.F\.,'A'\);")
compartment = add(f"DATUM_REFERENCE_COMPARTMENT('','',{asm_shape},.F.,{plate_a},$)")
system = add(f"DATUM_SYSTEM('','',{asm_shape},.F.,({compartment}))")
measure = add(f"LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.02),{mm})")
add(
    f"( GEOMETRIC_TOLERANCE('','',{measure},{plate_path}) \n"
    f"GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE(({system})) PARALLELISM_TOLERANCE() )"
)

# PMI-5b-2: presentation lines in the assembly's frame (its representation context #27), as the
# JAMA files write a path item's callout: the second plate's flatness (linked with a placeholder,
# AP242 ed3) and the distance (the plain link). The block's flatness has a callout listed only in
# the block part's context (#809): not the item's frame, so it is not drawn (never guessed).
asm_context = "#27"
assert entity(r"^#27 = \( GEOMETRIC_REPRESENTATION_CONTEXT\(3\)")
block_context = "#809"
colour = add("DRAUGHTING_PRE_DEFINED_COLOUR('white')")
font = add("DRAUGHTING_PRE_DEFINED_CURVE_FONT('continuous')")
curve_style = add(f"CURVE_STYLE('',{font},POSITIVE_LENGTH_MEASURE(0.1),{colour})")
style = add(f"PRESENTATION_STYLE_ASSIGNMENT(({curve_style}))")
null_style = add("PRESENTATION_STYLE_ASSIGNMENT((NULL_STYLE(.NULL.)))")


def point(p):
    return add("CARTESIAN_POINT('',(" + ",".join(f"{v:.1f}" for v in p) + "))")


def callout(name, segments, origin, extra=()):
    """A callout of line segments (assembly mm) on the plane through `origin` facing -Y."""
    pts = [p for seg in segments for p in seg]
    coords = add(f"COORDINATES_LIST('',{len(pts)},(" + ",".join(
        "(" + ",".join(f"{v:.1f}" for v in p) + ")" for p in pts) + "))")
    curves = add(f"TESSELLATED_CURVE_SET('',{coords},(" + ",".join(
        f"({2 * i + 1},{2 * i + 2})" for i in range(len(segments))) + "))")
    geometry = add(f"TESSELLATED_GEOMETRIC_SET('',({curves}))")
    occurrence = add(f"TESSELLATED_ANNOTATION_OCCURRENCE('',({style}),{geometry})")
    c = add(f"DRAUGHTING_CALLOUT('{name}',(" + ",".join([occurrence, *extra]) + "))")
    z = add("DIRECTION('',(0.,-1.,0.))")
    x = add("DIRECTION('',(1.,0.,0.))")
    axis = add(f"AXIS2_PLACEMENT_3D('',{point(origin)},{z},{x})")
    surface = add(f"PLANE('',{axis})")
    plane = add(f"ANNOTATION_PLANE('',({null_style}),{surface},({c}))")
    return c, plane, segments


flatness_lines = [((40, 85, 5), (40, 85, 15)), ((40, 85, 15), (56, 85, 15)),
                  ((56, 85, 15), (56, 85, 20)), ((56, 85, 20), (40, 85, 20)),
                  ((40, 85, 20), (40, 85, 15)), ((46, 85, 15), (46, 85, 20))]
distance_lines = [((80, 50, 5), (130, 50, 5)), ((120, 50, 10), (130, 50, 10)),
                  ((128, 50, 5), (128, 50, 10))]
block_lines = [((110, 10, 10), (110, 10, 20)), ((110, 10, 20), (126, 10, 20))]
holder_point = point((48, 85, 17.5))
holder_set = add(f"GEOMETRIC_SET('',({holder_point}))")
holder = add(f"ANNOTATION_PLACEHOLDER_OCCURRENCE('flatness',(),{holder_set},.GPS_DATA.,3.5)")
plate_callout = callout("flatness plate 2", flatness_lines, (40, 85, 15), [holder])
distance_callout = callout("distance", distance_lines, (128, 50, 5))
block_callout = callout("flatness block", block_lines, (110, 10, 20))
asm_model = add(
    "DRAUGHTING_MODEL('',(" + ",".join([*plate_callout[:2], *distance_callout[:2]]) + f"),{asm_context})"
)
block_model = add(f"DRAUGHTING_MODEL('',({block_callout[0]},{block_callout[1]}),{block_context})")
add(f"DRAUGHTING_MODEL_ITEM_ASSOCIATION_WITH_PLACEHOLDER('','',{plate_flatness},{asm_model},"
    f"{plate_callout[0]},{holder})")
add(f"DRAUGHTING_MODEL_ITEM_ASSOCIATION('PMI representation to presentation link','',{location},"
    f"{asm_model},{distance_callout[0]})")
add(f"DRAUGHTING_MODEL_ITEM_ASSOCIATION('PMI representation to presentation link','',"
    f"{block_flatness},{block_model},{block_callout[0]})")

edited = text.replace("ENDSEC;\nEND-ISO-10303-21;", "\n".join(lines) + "\nENDSEC;\nEND-ISO-10303-21;")
assert edited != text
edited = edited.replace("FILE_NAME('pmi-assembly.step'", "FILE_NAME('pmi-path.step'")
open(os.path.join(out, "pmi-path.step"), "w", encoding="latin-1", newline="\n").write(edited)
# What the paths mean: the instance each names (by the file's instance order, 1-based as the
# NEXT_ASSEMBLY_USAGE_OCCURRENCE ids '1'..'3' say) and the face's centroid in its part (mm), from scripts/cad-kernel/pmi-readback.py on the part-level PMI of pmi-assembly.step (OCCT 8.0).
expected = {
    "items": [
        {"kind": "geometric-tolerance", "type": "Flatness", "value": 0.03,
         "targets": [{"instance": 3, "part": "block", "centroid": [110, 10, 10]}]},
        {"kind": "geometric-tolerance", "type": "Flatness", "value": 0.04,
         "targets": [{"instance": 2, "part": "plate", "centroid": [40, 25, 5]}]},
        {"kind": "dimension", "type": "Location_LinearDistance", "values": [5],
         "targets": [{"instance": 2, "part": "plate", "centroid": [40, 25, 5]}],
         "targets2": [{"instance": 3, "part": "block", "centroid": [110, 10, 10]}]},
        {"kind": "geometric-tolerance", "type": "Flatness", "value": 0.05,
         "targets": [{"instance": 3, "part": "block", "centroid": [110, 10, 10]}]},
        {"kind": "geometric-tolerance", "type": "Parallelism", "value": 0.02,
         "targets": [{"instance": 2, "part": "plate", "centroid": [40, 25, 5]}]},
    ],
    # The block's datum A (through its path). The parallelism references the plate part's own A,
    # copied onto instance 2 with the faces the plate's part PMI gives it.
    "datums": [
        {"kind": "datum", "name": "A",
         "targets": [{"instance": 3, "part": "block", "centroid": [110, 10, 10]}]},
    ],
}
# The lines each kept item carries, in the assembly's frame (mm; the block's flatness carries none).
expected["presentation"] = {
    "Flatness 0.04": [v for seg in flatness_lines for p in seg for v in p],
    "Location_LinearDistance 5": [v for seg in distance_lines for p in seg for v in p],
}
json.dump(expected, open(os.path.join(out, "path.json"), "w"), indent=2)
open(os.path.join(out, "path.json"), "a").write("\n")
