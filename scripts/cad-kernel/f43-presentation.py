#!/usr/bin/env python3
"""Writes the F43 PMI presentation fixtures (docs/cad/pmi.md, PMI-3) with a native OCCT.

Run with cadquery-ocp 8.0.1.1 on the path, like f43-pmi.py:
  PYTHONPATH=<dir> python3 scripts/cad-kernel/f43-presentation.py packages/cad-kernel-occt/fixtures/f43
The F07 plate (80 x 50 x 5 mm, a 10 mm hole) with semantic PMI and its tessellated
presentation written by the XDE writer: a distance, a diameter, a flatness without a
presentation, a position tolerance with datums A and B, and datum A's presentation. The
writer of OCCT does not write saved views, so two are added to the text (CAMERA_MODEL_D3 in its
own DRAUGHTING_MODEL): "Hole" from above with the diameter and the position tolerance, and
"Datum A" from the front with datum A.

pmi-presented.step links each presentation to its item with the writer's
DRAUGHTING_MODEL_ITEM_ASSOCIATION. pmi-placeholder.step is the same file with the links of the
diameter and the position tolerance rewritten as AP242 ed3's
DRAUGHTING_MODEL_ITEM_ASSOCIATION_WITH_PLACEHOLDER with an empty name, as the JAMA files link
them; OCCT 7.6 does not read these. presented.json beside them lists what each file presents.
"""
import json
import os
import re
import sys

from OCP.BRep import BRep_Builder
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.OCP.collections import Sequence_TDF_Label
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_ExtendedString, TCollection_HAsciiString
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound
from OCP.XCAFDimTolObjects import (
    XCAFDimTolObjects_DatumObject,
    XCAFDimTolObjects_DimensionObject,
    XCAFDimTolObjects_DimensionType_Location_LinearDistance,
    XCAFDimTolObjects_DimensionType_Size_Diameter,
    XCAFDimTolObjects_GeomToleranceObject,
    XCAFDimTolObjects_GeomToleranceType_Flatness,
    XCAFDimTolObjects_GeomToleranceType_Position,
    XCAFDimTolObjects_GeomToleranceTypeValue_Diameter,
    XCAFDimTolObjects_GeomToleranceTypeValue_None,
)
from OCP.XCAFDoc import XCAFDoc_Datum, XCAFDoc_Dimension, XCAFDoc_DocumentTool, XCAFDoc_GeomTolerance
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

box = BRepPrimAPI_MakeBox(80, 50, 5).Shape()
cylinder = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40, 25, -1), gp_Dir(0, 0, 1)), 5, 7).Shape()
shape = BRepAlgoAPI_Cut(box, cylinder).Shape()
faces = []
ex = TopExp_Explorer(shape, TopAbs_FACE)
while ex.More():
    faces.append(TopoDS.Face(ex.Current()))
    ex.Next()


def face(kind, test):
    found = [f for f in faces if BRepAdaptor_Surface(f).GetType() == kind and test(BRepAdaptor_Surface(f))]
    assert len(found) == 1, (kind, len(found))
    return found[0]


def plane_at(axis, value):
    def test(s):
        p = s.Plane()
        loc = [p.Location().X(), p.Location().Y(), p.Location().Z()][axis]
        n = [p.Axis().Direction().X(), p.Axis().Direction().Y(), p.Axis().Direction().Z()][axis]
        return abs(abs(n) - 1) < 1e-9 and abs(loc - value) < 1e-9
    return face(GeomAbs_Plane, test)


doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
dimtol = XCAFDoc_DocumentTool.DimTolTool_s(doc.Main())
part = shapes.AddShape(shape, False)
label = {name: shapes.AddSubShape(part, f) for name, f in [
    ("bottom", plane_at(2, 0)), ("top", plane_at(2, 5)), ("side", plane_at(0, 0)),
    ("hole", face(GeomAbs_Cylinder, lambda s: True))]}


def polylines(lines):
    """A compound of straight edges, one per segment of each polyline. The writer writes each
    edge as one curve of a TESSELLATED_CURVE_SET."""
    b = BRep_Builder()
    c = TopoDS_Compound()
    b.MakeCompound(c)
    for line in lines:
        for a, z in zip(line, line[1:]):
            b.Add(c, BRepBuilderAPI_MakeEdge(gp_Pnt(*a), gp_Pnt(*z)).Edge())
    return c


def rectangle(x0, y0, x1, y1, z):
    return [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), (x0, y0, z)]


# Each presentation: polylines on an annotation plane (origin, normal, x direction).
presented = {
    # Above the top face: a leader from the hole's rim to a text frame.
    "diameter": ([[(45, 25, 5), (55, 35, 5), (70, 35, 5)], rectangle(55, 35, 70, 40, 5)],
                 ((55, 35, 5), (0, 0, 1), (1, 0, 0))),
    # Beside the diameter: a feature control frame of three compartments.
    "position": ([rectangle(55, 42, 75, 47, 5), [(62, 42, 5), (62, 47, 5)],
                  [(69, 42, 5), (69, 47, 5)], [(45, 25, 5), (55, 44.5, 5)]],
                 ((55, 42, 5), (0, 0, 1), (1, 0, 0))),
    # In front of the front face (y = 0): datum A's triangle on the bottom edge and its frame.
    "datum A": ([[(15, 0, 0), (20, 0, 0), (17.5, 0, -3), (15, 0, 0)], [(17.5, 0, -3), (17.5, 0, -8)],
                 rectangle(15, -13, 20, -8, 0)],
                ((15, 0, -13), (0, -1, 0), (1, 0, 0))),
    "distance": ([[(82, 0, 0), (90, 0, 0)], [(82, 0, 5), (90, 0, 5)], [(88, 0, 0), (88, 0, 5)]],
                 ((88, 0, 0), (0, -1, 0), (1, 0, 0))),
}
# The rectangle of the datum's frame lies in the plane y = 0, so its points are (x, 0, z).
presented["datum A"][0][2] = [(15, 0, -13), (20, 0, -13), (20, 0, -8), (15, 0, -8), (15, 0, -13)]


def present(obj, name):
    lines, (origin, normal, xdir) = presented[name]
    obj.SetPresentation(polylines(lines), TCollection_HAsciiString(name))
    obj.SetPlane(gp_Ax2(gp_Pnt(*origin), gp_Dir(*normal), gp_Dir(*xdir)))
    obj.SetPointTextAttach(gp_Pnt(*origin))


datums = {}
for name, target, position in [("A", "bottom", 1), ("B", "side", 2)]:
    d = dimtol.AddDatum()
    seq = Sequence_TDF_Label()
    seq.Append(label[target])
    dimtol.SetDatum(seq, d)
    obj = XCAFDimTolObjects_DatumObject()
    obj.SetName(TCollection_HAsciiString(name))
    obj.SetPosition(position)
    if name == "A":
        present(obj, "datum A")
    XCAFDoc_Datum.Set_s(d).SetObject(obj)
    datums[name] = d

for kind, first, second, value, name in [
        (XCAFDimTolObjects_DimensionType_Location_LinearDistance, "bottom", "top", 5.0, "distance"),
        (XCAFDimTolObjects_DimensionType_Size_Diameter, "hole", None, 10.0, "diameter")]:
    d = dimtol.AddDimension()
    if second:
        dimtol.SetDimension(label[first], label[second], d)
    else:
        dimtol.SetDimension(label[first], d)
    obj = XCAFDimTolObjects_DimensionObject()
    obj.SetType(kind)
    obj.SetValue(value)
    present(obj, name)
    XCAFDoc_Dimension.Set_s(d).SetObject(obj)

for kind, target, value, refs, value_type, name in [
        (XCAFDimTolObjects_GeomToleranceType_Flatness, "top", 0.02, [],
         XCAFDimTolObjects_GeomToleranceTypeValue_None, None),
        (XCAFDimTolObjects_GeomToleranceType_Position, "hole", 0.1, ["A", "B"],
         XCAFDimTolObjects_GeomToleranceTypeValue_Diameter, "position")]:
    t = dimtol.AddGeomTolerance()
    dimtol.SetGeomTolerance(label[target], t)
    obj = XCAFDimTolObjects_GeomToleranceObject()
    obj.SetType(kind)
    obj.SetTypeOfValue(value_type)
    obj.SetValue(value)
    if name:
        present(obj, name)
    XCAFDoc_GeomTolerance.Set_s(t).SetObject(obj)
    for r in refs:
        dimtol.SetDatumToGeomTol(datums[r], t)

# The writer's constructor initialises the XDE controller, which resets the parameters.
w = STEPCAFControl_Writer()
Interface_Static.SetCVal_s("write.step.schema", "AP242DIS")
Interface_Static.SetCVal_s("write.step.unit", "MM")
w.SetDimTolMode(True)
assert w.Transfer(doc), "transfer"
path = os.path.join(out, "pmi-presented.step")
assert w.Write(path) == IFSelect_RetDone, "write"

text = open(path, encoding="latin-1").read()
text = re.sub(r"FILE_NAME\('[^']*','[^']*'", "FILE_NAME('pmi-presented.step','2026-11-07T00:00:00'", text)
text = re.sub(r"PERSON\('[^']*','[^']*','[^']*'", "PERSON('corpus','','corpus'", text)
text = re.sub(r"ORGANIZATION\('IP[^']*'", "ORGANIZATION('corpus'", text)

callouts = {m.group(2): m.group(1) for m in re.finditer(r"^#(\d+) = DRAUGHTING_CALLOUT\('([^']*)'", text, re.M)}
assert sorted(callouts) == sorted(presented), callouts
context = re.search(r"^#\d+ = DRAUGHTING_MODEL\('',\([^)]*\),\s*#(\d+)\);", text, re.M).group(1)
last = max(int(n) for n in re.findall(r"^#(\d+)\s*=", text, re.M))

# Two saved views. A camera looks along the z axis of its view reference system from its
# location, with the y axis up (ISO 10303-46; OCCT reads the same). The window is the visible
# width and height in mm.
views = [
    ("Hole", (60, 36, 100), (0, 0, -1), (-1, 0, 0), (50, 30), ["diameter", "position"]),
    ("Datum A", (40, -100, -4), (0, 1, 0), (-1, 0, 0), (100, 50), ["datum A"]),
]
def real(c):
    """A real as STEP writes it: 60. for 60."""
    s = repr(float(c))
    return s[:-1] if s.endswith(".0") else s


def f(v):
    return "(" + ",".join(real(c) for c in v) + ")"


added = []
n = last
for name, location, z, x, (width, height), members in views:
    ids = {}
    for key in ["loc", "z", "x", "axis", "origin", "pz", "px", "paxis", "window", "volume", "camera", "model"]:
        n += 1
        ids[key] = n
    added += [
        f"#{ids['loc']} = CARTESIAN_POINT('',{f(location)});",
        f"#{ids['z']} = DIRECTION('',{f(z)});",
        f"#{ids['x']} = DIRECTION('',{f(x)});",
        f"#{ids['axis']} = AXIS2_PLACEMENT_3D('',#{ids['loc']},#{ids['z']},#{ids['x']});",
        f"#{ids['origin']} = CARTESIAN_POINT('',(0.,0.,0.));",
        f"#{ids['pz']} = DIRECTION('',(0.,0.,1.));",
        f"#{ids['px']} = DIRECTION('',(1.,0.,0.));",
        f"#{ids['paxis']} = AXIS2_PLACEMENT_3D('',#{ids['origin']},#{ids['pz']},#{ids['px']});",
        f"#{ids['window']} = PLANAR_BOX('',{real(width)},{real(height)},#{ids['paxis']});",
        f"#{ids['volume']} = VIEW_VOLUME(.PARALLEL.,#{ids['origin']},{real(width / 2)},0.,.F.,0.,.F.,.F.,#{ids['window']});",
        f"#{ids['camera']} = CAMERA_MODEL_D3('{name}',#{ids['axis']},#{ids['volume']});",
        f"#{ids['model']} = DRAUGHTING_MODEL('{name}',(#{ids['camera']},"
        + ",".join(f"#{callouts[m]}" for m in members) + f"),#{context});",
    ]
text = text.replace("ENDSEC;\nEND-ISO-10303-21;", "\n".join(added) + "\nENDSEC;\nEND-ISO-10303-21;")
assert "CAMERA_MODEL_D3" in text
open(path, "w", encoding="latin-1", newline="\n").write(text)

# The placeholder variant: the diameter's and the position's links as JAMA writes them.
links = {}
for m in re.finditer(r"^#(\d+) = DRAUGHTING_MODEL_ITEM_ASSOCIATION\(\s*'PMI representation to presentation link','',#(\d+),#(\d+),#(\d+)\);", text, re.M):
    links[m.group(4)] = m
held = text.replace("FILE_NAME('pmi-presented.step'", "FILE_NAME('pmi-placeholder.step'")
n = max(int(k) for k in re.findall(r"^#(\d+)\s*=", held, re.M))
extra = []
for name in ["diameter", "position"]:
    m = links[callouts[name]]
    n += 1
    point, axis, holder = n, n + 1, n + 2
    n += 2
    lines, (origin, _, _) = presented[name]
    extra += [
        f"#{point} = CARTESIAN_POINT('',{f(origin)});",
        f"#{axis} = GEOMETRIC_SET('',(#{point}));",
        f"#{holder} = ANNOTATION_PLACEHOLDER_OCCURRENCE('{name}',(),#{axis},.GPS_DATA.,3.5);",
    ]
    # The callout holds the placeholder beside its tessellated occurrence, as in the JAMA files.
    callout = re.search(rf"^#{callouts[name]} = DRAUGHTING_CALLOUT\('[^']*',\(#\d+", held, re.M).group(0)
    held = held.replace(callout, f"{callout},#{holder}")
    held = held.replace(
        m.group(0),
        f"#{m.group(1)} = DRAUGHTING_MODEL_ITEM_ASSOCIATION_WITH_PLACEHOLDER('','',#{m.group(2)},#{m.group(3)},#{m.group(4)},#{holder});",
    )
assert held.count("_WITH_PLACEHOLDER(") == 2
held = held.replace("ENDSEC;\nEND-ISO-10303-21;", "\n".join(extra) + "\nENDSEC;\nEND-ISO-10303-21;")
open(os.path.join(out, "pmi-placeholder.step"), "w", encoding="latin-1", newline="\n").write(held)

expected = {
    "presentations": {k: {"polylines": [[list(p) for p in line] for line in v[0]],
                          "plane": {"origin": list(v[1][0]), "z": list(v[1][1]), "x": list(v[1][2])}}
                      for k, v in presented.items()},
    "views": [{"name": name, "eye": list(location), "direction": list(z), "up": [
        z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]],
        "width": width, "height": height, "members": members}
        for name, location, z, x, (width, height), members in views],
    "placeholder": ["diameter", "position"],
}
with open(os.path.join(out, "presented.json"), "w", encoding="utf-8", newline="\n") as fh:
    json.dump(expected, fh, indent=1)
    fh.write("\n")
