#!/usr/bin/env python3
"""Writes the F07 STEP corpus (docs/cad/verification-plan.md) with a native OCCT outside the Wasm build.

Run with cadquery-ocp 8.0.1.1 on the path (pip install --target <dir> cadquery-ocp==8.0.1.1):
  PYTHONPATH=<dir> python3 scripts/cad-kernel/f07-corpus.py packages/cad-kernel-occt/fixtures/f07
The reader and writer are a different OCCT version and build than the kernel, as another CAD
would be. A few files are the plate with one entity added by text, to test what the scan refuses
or reports; they say so in the README.
"""
import os
import re
import sys

from OCP.BRep import BRep_Builder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCone,
    BRepPrimAPI_MakeCylinder,
    BRepPrimAPI_MakeSphere,
    BRepPrimAPI_MakeTorus,
)
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shell
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def static(key, value):
    Interface_Static.SetCVal_s(key, value)


def write(name, shapes, unit="MM", schema="AP214IS", assembly=2):
    static("write.step.schema", schema)
    static("write.step.unit", unit)
    # 2 (auto) writes a compound as an assembly of its solids; 0 keeps one product.
    Interface_Static.SetIVal_s("write.step.assembly", assembly)
    w = STEPControl_Writer()
    for s in shapes:
        assert w.Transfer(s, STEPControl_AsIs) == IFSelect_RetDone, name
    path = os.path.join(out, name)
    assert w.Write(path) == IFSelect_RetDone, name
    return stable(path, name)


def stable(path, name):
    """Fixes the timestamp and file name, and drops the login and address AP203 writes."""
    text = open(path, encoding="latin-1").read()
    text = re.sub(r"FILE_NAME\('[^']*','[^']*'", f"FILE_NAME('{name}','2026-10-23T00:00:00'", text)
    text = re.sub(r"PERSON\('[^']*','[^']*','[^']*'", "PERSON('corpus','','corpus'", text)
    text = re.sub(r"ORGANIZATION\('IP[^']*'", "ORGANIZATION('corpus'", text)
    open(path, "w", encoding="latin-1", newline="\n").write(text)
    return text


def moved(shape, x, y, z):
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(x, y, z))
    return BRepBuilderAPI_Transform(shape, t, True).Shape()


def plate():
    box = BRepPrimAPI_MakeBox(80, 50, 5).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40, 25, -1), gp_Dir(0, 0, 1)), 5, 7).Shape()
    return BRepAlgoAPI_Cut(box, hole).Shape()


plate_text = write("normal-mm-plate.step", [plate()])
# Geometry in mm; the writer converts to the declared unit, the reader converts back.
write("normal-inch-block.step", [BRepPrimAPI_MakeBox(50.8, 25.4, 12.7).Shape()], unit="INCH")
write(
    "normal-m-cone.step",
    [BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 200, 50, 300).Shape()],
    unit="M",
)
torus = BRepPrimAPI_MakeTorus(30, 10).Shape()
sphere = BRepPrimAPI_MakeSphere(gp_Pnt(30, 0, 0), 12).Shape()
write("normal-analytic.step", [BRepAlgoAPI_Fuse(torus, sphere).Shape()])
write("normal-ap203.step", [plate()], schema="AP203")
write("reject-ap242.step", [plate()], schema="AP242DIS")
write("reject-unit-mile.step", [BRepPrimAPI_MakeBox(10, 10, 10).Shape()], unit="MI")

def faces_of(shape):
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    faces = []
    while ex.More():
        faces.append(TopoDS.Face(ex.Current()))
        ex.Next()
    return faces


two = TopoDS_Compound()
b = BRep_Builder()
b.MakeCompound(two)
b.Add(two, BRepPrimAPI_MakeBox(10, 10, 10).Shape())
b.Add(two, moved(BRepPrimAPI_MakeBox(10, 10, 10).Shape(), 20, 0, 0))
write("reject-two-solids.step", [two], assembly=0)

# A box without its top face: an open shell, no solid. Imported as a sheet (R2a-1).
shell = TopoDS_Shell()
b.MakeShell(shell)
for f in faces_of(BRepPrimAPI_MakeBox(10, 10, 10).Shape())[:-1]:
    b.Add(shell, f)
write("sheet-open-box.step", [shell])

# STEP keeps no per-entity tolerance: a reader derives it from how well the geometry meets. One
# vertex moved 0.005 mm off its edges' lines makes the reader widen that vertex's tolerance.
loose = write("reject-tolerance-gap.step", [BRepPrimAPI_MakeBox(10, 10, 10).Shape()])
points = set(re.findall(r"VERTEX_POINT\('',#(\d+)\)", loose))
vertex = next(
    n for n in points if re.search(rf"^#{n} = CARTESIAN_POINT\('',\(0\.,0\.,10\.\)\);", loose, re.M)
)
loose = re.sub(
    rf"^#{vertex} = CARTESIAN_POINT\('',\(0\.,0\.,10\.\)\);",
    f"#{vertex} = CARTESIAN_POINT('',(5.E-03,0.,10.));",
    loose,
    flags=re.M,
)
open(os.path.join(out, "reject-tolerance-gap.step"), "w", encoding="latin-1", newline="\n").write(loose)


def xcaf(name, build):
    static("write.step.schema", "AP214IS")
    static("write.step.unit", "MM")
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    build(shapes, colors)
    w = STEPCAFControl_Writer()
    assert w.Transfer(doc, STEPControl_AsIs)
    path = os.path.join(out, name)
    assert w.Write(path) == IFSelect_RetDone
    stable(path, name)


def coloured(shapes, colors):
    label = shapes.AddShape(plate(), False)
    colors.SetColor(label, Quantity_Color(0.8, 0.2, 0.1, Quantity_TOC_RGB), XCAFDoc_ColorSurf)


def assembly(shapes, colors):
    part = shapes.AddShape(BRepPrimAPI_MakeBox(10, 10, 10).Shape(), False)
    top = shapes.NewShape()
    for x in (0, 20):
        t = gp_Trsf()
        t.SetTranslation(gp_Vec(x, 0, 0))
        from OCP.TopLoc import TopLoc_Location

        shapes.AddComponent(top, part, TopLoc_Location(t))
    shapes.UpdateAssemblies()


xcaf("normal-colour.step", coloured)
xcaf("reject-assembly.step", assembly)


def with_entity(name, entity):
    """The plate with one more entity before ENDSEC of DATA (a text edit, not a writer's output)."""
    last = max(int(n) for n in re.findall(r"^#(\d+)\s*=", plate_text, re.M))
    data_end = plate_text.rindex("ENDSEC;")
    text = plate_text[:data_end] + f"#{last + 1} = {entity};\n" + plate_text[data_end:]
    text = text.replace("normal-mm-plate.step", name)
    open(os.path.join(out, name), "w", encoding="latin-1", newline="\n").write(text)


with_entity("reject-external-reference.step", "DOCUMENT_FILE('bolt','bolt.step','',$,'','')")
with_entity("reject-pmi-dimension.step", "DIMENSIONAL_SIZE($,'thickness')")
open(os.path.join(out, "reject-truncated.step"), "w", encoding="latin-1", newline="\n").write(
    plate_text[: len(plate_text) // 2]
)
open(os.path.join(out, "reject-not-step.step"), "w", newline="\n").write("solid cube\nendsolid cube\n")

# Written last: the writer numbers its products, so earlier files keep their bytes.
# The box with a loose face beside it: one solid, plus a face the solid does not own.
loose_face = TopoDS_Compound()
b.MakeCompound(loose_face)
b.Add(loose_face, BRepPrimAPI_MakeBox(10, 10, 10).Shape())
b.Add(loose_face, faces_of(moved(BRepPrimAPI_MakeBox(10, 10, 1).Shape(), 20, 0, 0))[0])
write("reject-free-face.step", [loose_face], assembly=0)

# R2a-1 sheets, written after the D2 files so those keep their bytes.
# All six faces of a box as a shell without a solid: a closed sheet, not a solid.
closed = TopoDS_Shell()
b.MakeShell(closed)
for f in faces_of(BRepPrimAPI_MakeBox(10, 10, 10).Shape()):
    b.Add(closed, f)
closed.Closed(True)
write("sheet-closed-box.step", [closed])
# Two open shells apart: not one connected sheet.
apart = TopoDS_Compound()
b.MakeCompound(apart)
for x in (0, 20):
    part = TopoDS_Shell()
    b.MakeShell(part)
    for f in faces_of(moved(BRepPrimAPI_MakeBox(10, 10, 10).Shape(), x, 0, 0))[:-1]:
        b.Add(part, f)
    b.Add(apart, part)
write("reject-two-shells.step", [apart], assembly=0)
print("\n".join(sorted(os.listdir(out))))
