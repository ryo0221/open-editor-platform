#!/usr/bin/env python3
"""Writes the F43 PMI fixture (docs/cad/pmi.md) with a native OCCT outside the Wasm build.

Run with cadquery-ocp 8.0.1.1 on the path (pip install --target <dir> cadquery-ocp==8.0.1.1):
  PYTHONPATH=<dir> python3 scripts/cad-kernel/f43-pmi.py packages/cad-kernel-occt/fixtures/f43
The F07 plate (80 x 50 x 5 mm, a 10 mm hole through it) as AP242 with semantic PMI written by
the XDE writer: 2 dimensions, 2 datums, 3 geometric tolerances (2 with datum references). The
writer of OCCT does not write saved views, so this file has none (views: PMI-3).
The expected values are in expected.json beside the file, written from the same tables.
"""
import json
import os
import re
import sys

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_ExtendedString, TCollection_HAsciiString
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.OCP.collections import Sequence_TDF_Label
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.XCAFDimTolObjects import (
    XCAFDimTolObjects_DatumObject,
    XCAFDimTolObjects_DimensionObject,
    XCAFDimTolObjects_DimensionType_Location_LinearDistance,
    XCAFDimTolObjects_DimensionType_Size_Diameter,
    XCAFDimTolObjects_GeomToleranceObject,
    XCAFDimTolObjects_GeomToleranceType_Flatness,
    XCAFDimTolObjects_GeomToleranceType_Parallelism,
    XCAFDimTolObjects_GeomToleranceType_Position,
    XCAFDimTolObjects_GeomToleranceTypeValue_Diameter,
    XCAFDimTolObjects_GeomToleranceTypeValue_None,
)
from OCP.XCAFDoc import (
    XCAFDoc_Datum,
    XCAFDoc_Dimension,
    XCAFDoc_DocumentTool,
    XCAFDoc_GeomTolerance,
)
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def plate():
    box = BRepPrimAPI_MakeBox(80, 50, 5).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40, 25, -1), gp_Dir(0, 0, 1)), 5, 7).Shape()
    return BRepAlgoAPI_Cut(box, hole).Shape()


shape = plate()
faces = []
ex = TopExp_Explorer(shape, TopAbs_FACE)
while ex.More():
    faces.append(TopoDS.Face(ex.Current()))
    ex.Next()


def face(kind, test):
    """The one face of the plate of a surface kind whose adaptor passes `test`."""
    found = []
    for f in faces:
        s = BRepAdaptor_Surface(f)
        if s.GetType() == kind and test(s):
            found.append(f)
    assert len(found) == 1, (kind, len(found))
    return found[0]


def plane_at(axis, value, normal_sign):
    def test(s):
        p = s.Plane()
        loc = [p.Location().X(), p.Location().Y(), p.Location().Z()][axis]
        n = [p.Axis().Direction().X(), p.Axis().Direction().Y(), p.Axis().Direction().Z()][axis]
        return abs(abs(n) - 1) < 1e-9 and abs(loc - value) < 1e-9
    return face(GeomAbs_Plane, test)


bottom = plane_at(2, 0, -1)
top = plane_at(2, 5, 1)
side = plane_at(0, 0, -1)
hole = face(GeomAbs_Cylinder, lambda s: True)

doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
dimtol = XCAFDoc_DocumentTool.DimTolTool_s(doc.Main())
part = shapes.AddShape(shape, False)
label = {name: shapes.AddSubShape(part, f) for name, f in
         [("bottom", bottom), ("top", top), ("side", side), ("hole", hole)]}

datums = {}
for name, target, position in [("A", "bottom", 1), ("B", "side", 2)]:
    d = dimtol.AddDatum()
    seq = Sequence_TDF_Label()
    seq.Append(label[target])
    dimtol.SetDatum(seq, d)
    obj = XCAFDimTolObjects_DatumObject()
    obj.SetName(TCollection_HAsciiString(name))
    obj.SetPosition(position)
    XCAFDoc_Datum.Set_s(d).SetObject(obj)
    datums[name] = d

expected = {"dimensions": [], "tolerances": [], "datums": [
    {"name": "A", "target": "bottom"}, {"name": "B", "target": "side"}]}


def enum_name(value):
    """An enumerator's name without its type's prefix, as the kernel's tables name it."""
    return re.sub(r"^XCAFDimTolObjects_(DimensionType|GeomToleranceType)_", "", value.name)


def dimension(kind, first, second, value, lower=None, upper=None):
    d = dimtol.AddDimension()
    if second:
        dimtol.SetDimension(label[first], label[second], d)
    else:
        dimtol.SetDimension(label[first], d)
    obj = XCAFDimTolObjects_DimensionObject()
    obj.SetType(kind)
    obj.SetValue(value)
    if lower is not None:
        obj.SetLowerTolValue(lower)
        obj.SetUpperTolValue(upper)
    XCAFDoc_Dimension.Set_s(d).SetObject(obj)
    expected["dimensions"].append({"type": enum_name(kind), "value": value, "lower": lower,
                                   "upper": upper, "targets": [t for t in (first, second) if t]})


def tolerance(kind, target, value, refs, value_type=XCAFDimTolObjects_GeomToleranceTypeValue_None):
    t = dimtol.AddGeomTolerance()
    dimtol.SetGeomTolerance(label[target], t)
    obj = XCAFDimTolObjects_GeomToleranceObject()
    obj.SetType(kind)
    obj.SetTypeOfValue(value_type)
    obj.SetValue(value)
    XCAFDoc_GeomTolerance.Set_s(t).SetObject(obj)
    for r in refs:
        dimtol.SetDatumToGeomTol(datums[r], t)
    expected["tolerances"].append({"type": enum_name(kind), "value": value, "target": target,
                                   "datums": refs})


dimension(XCAFDimTolObjects_DimensionType_Location_LinearDistance, "bottom", "top", 5.0)
dimension(XCAFDimTolObjects_DimensionType_Size_Diameter, "hole", None, 10.0, -0.05, 0.05)
tolerance(XCAFDimTolObjects_GeomToleranceType_Flatness, "top", 0.02, [])
tolerance(XCAFDimTolObjects_GeomToleranceType_Parallelism, "top", 0.05, ["A"])
tolerance(XCAFDimTolObjects_GeomToleranceType_Position, "hole", 0.1, ["A", "B"],
          XCAFDimTolObjects_GeomToleranceTypeValue_Diameter)

# The writer's constructor initialises the XDE controller, which resets the parameters.
w = STEPCAFControl_Writer()
Interface_Static.SetCVal_s("write.step.schema", "AP242DIS")
Interface_Static.SetCVal_s("write.step.unit", "MM")
w.SetDimTolMode(True)
assert w.Transfer(doc), "transfer"
path = os.path.join(out, "pmi-plate.step")
assert w.Write(path) == IFSelect_RetDone, "write"
text = open(path, encoding="latin-1").read()
# The OCCT 8 writer writes the lower deviation's magnitude (0.05 for -0.05); a TOLERANCE_VALUE's
# lower bound is signed (ISO 10303-41), so the fixture writes the sign it means.
lower_ref = re.search(r"^#\d+ = TOLERANCE_VALUE\(#(\d+),#\d+\);", text, re.M).group(1)
signed = re.sub(rf"^(#{lower_ref} = MEASURE_WITH_UNIT\()5\.E-02,", r"\g<1>-5.E-02,", text, flags=re.M)
assert signed != text, "lower deviation"
text = signed
text = re.sub(r"FILE_NAME\('[^']*','[^']*'", "FILE_NAME('pmi-plate.step','2026-11-06T00:00:00'", text)
text = re.sub(r"PERSON\('[^']*','[^']*','[^']*'", "PERSON('corpus','','corpus'", text)
text = re.sub(r"ORGANIZATION\('IP[^']*'", "ORGANIZATION('corpus'", text)
open(path, "w", encoding="latin-1", newline="\n").write(text)
json.dump(expected, open(os.path.join(out, "expected.json"), "w"), indent=2)
open(os.path.join(out, "expected.json"), "a").write("\n")

# F44 (one of three; the others come with PMI-2): F43 plus one reference through an assembly
# path (`COMPONENT_PATH_SHAPE_ASPECT`, AP242 ed2), which OCCT 7.6 does not read. Text edit: the
# entity names the plate's shape and one of its shape aspects, as the JAMA files' do.
last = max(int(n) for n in re.findall(r"^#(\d+)\s*=", text, re.M))
aspect = re.search(r"^#(\d+) = SHAPE_ASPECT\('','',#4,\.T\.\);", text, re.M).group(1)
path_text = text.replace(
    "ENDSEC;\nEND-ISO-10303-21;",
    f"#{last + 1} = COMPONENT_PATH_SHAPE_ASPECT('','',#4,.F.,#4,#{aspect});\n"
    "ENDSEC;\nEND-ISO-10303-21;",
)
assert path_text != text
path_text = path_text.replace("FILE_NAME('pmi-plate.step'", "FILE_NAME('loss-component-path.step'")
open(os.path.join(out, "loss-component-path.step"), "w", encoding="latin-1", newline="\n").write(path_text)

# F43 assembly (PMI-2): the plate as a part placed twice and a block beside it, in one assembly;
# the plate's PMI is on the plate product's faces, and one distance runs from the plate's top
# to the block's top (a dimension across two parts, which a part's `pmi` asset cannot hold).
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Trsf, gp_Vec

adoc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
ashapes = XCAFDoc_DocumentTool.ShapeTool_s(adoc.Main())
adimtol = XCAFDoc_DocumentTool.DimTolTool_s(adoc.Main())
aplate = ashapes.AddShape(shape, False)
block_shape = BRepPrimAPI_MakeBox(gp_Pnt(100, 0, 0), 20, 20, 10).Shape()
ablock = ashapes.AddShape(block_shape, False)
asm = ashapes.NewShape()


def placed(x, y, z):
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(x, y, z))
    return TopLoc_Location(t)


ashapes.AddComponent(asm, aplate, placed(0, 0, 0))
ashapes.AddComponent(asm, aplate, placed(0, 60, 0))
ashapes.AddComponent(asm, ablock, placed(0, 0, 0))
ashapes.UpdateAssemblies()
alabel = {name: ashapes.AddSubShape(aplate, f) for name, f in
          [("bottom", bottom), ("top", top), ("side", side), ("hole", hole)]}
bex = TopExp_Explorer(block_shape, TopAbs_FACE)
block_top = None
while bex.More():
    f = TopoDS.Face(bex.Current())
    s = BRepAdaptor_Surface(f)
    if s.GetType() == GeomAbs_Plane and abs(s.Plane().Location().Z() - 10) < 1e-9:
        block_top = f
    bex.Next()
assert block_top is not None
alabel["block-top"] = ashapes.AddSubShape(ablock, block_top)
adatums = {}
for name, target, position in [("A", "bottom", 1), ("B", "side", 2)]:
    d = adimtol.AddDatum()
    seq = Sequence_TDF_Label()
    seq.Append(alabel[target])
    adimtol.SetDatum(seq, d)
    obj = XCAFDimTolObjects_DatumObject()
    obj.SetName(TCollection_HAsciiString(name))
    obj.SetPosition(position)
    XCAFDoc_Datum.Set_s(d).SetObject(obj)
    adatums[name] = d


def adimension(kind, first, second, value, lower=None, upper=None):
    d = adimtol.AddDimension()
    if second:
        adimtol.SetDimension(alabel[first], alabel[second], d)
    else:
        adimtol.SetDimension(alabel[first], d)
    obj = XCAFDimTolObjects_DimensionObject()
    obj.SetType(kind)
    obj.SetValue(value)
    if lower is not None:
        obj.SetLowerTolValue(lower)
        obj.SetUpperTolValue(upper)
    XCAFDoc_Dimension.Set_s(d).SetObject(obj)


adimension(XCAFDimTolObjects_DimensionType_Location_LinearDistance, "bottom", "top", 5.0)
adimension(XCAFDimTolObjects_DimensionType_Size_Diameter, "hole", None, 10.0, -0.05, 0.05)
adimension(XCAFDimTolObjects_DimensionType_Location_LinearDistance, "top", "block-top", 5.0)
t = adimtol.AddGeomTolerance()
adimtol.SetGeomTolerance(alabel["hole"], t)
obj = XCAFDimTolObjects_GeomToleranceObject()
obj.SetType(XCAFDimTolObjects_GeomToleranceType_Position)
obj.SetTypeOfValue(XCAFDimTolObjects_GeomToleranceTypeValue_Diameter)
obj.SetValue(0.1)
XCAFDoc_GeomTolerance.Set_s(t).SetObject(obj)
for r in ["A", "B"]:
    adimtol.SetDatumToGeomTol(adatums[r], t)
w = STEPCAFControl_Writer()
Interface_Static.SetCVal_s("write.step.schema", "AP242DIS")
Interface_Static.SetCVal_s("write.step.unit", "MM")
w.SetDimTolMode(True)
assert w.Transfer(adoc), "assembly transfer"
apath = os.path.join(out, "pmi-assembly.step")
assert w.Write(apath) == IFSelect_RetDone, "assembly write"
atext = open(apath, encoding="latin-1").read()
lower_ref = re.search(r"^#\d+ = TOLERANCE_VALUE\(#(\d+),#\d+\);", atext, re.M).group(1)
signed = re.sub(rf"^(#{lower_ref} = MEASURE_WITH_UNIT\()5\.E-02,", r"\g<1>-5.E-02,", atext, flags=re.M)
assert signed != atext, "assembly lower deviation"
atext = signed
atext = re.sub(r"FILE_NAME\('[^']*','[^']*'", "FILE_NAME('pmi-assembly.step','2026-11-07T00:00:00'", atext)
atext = re.sub(r"PERSON\('[^']*','[^']*','[^']*'", "PERSON('corpus','','corpus'", atext)
atext = re.sub(r"ORGANIZATION\('IP[^']*'", "ORGANIZATION('corpus'", atext)
open(apath, "w", encoding="latin-1", newline="\n").write(atext)
