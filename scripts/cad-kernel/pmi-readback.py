#!/usr/bin/env python3
"""Reads the semantic PMI of STEP files with a native OCCT outside the Wasm build (PMI-4b, CAD85).

Run with cadquery-ocp 8.0.1.1 on the path (pip install --target <dir> cadquery-ocp==8.0.1.1):
  PYTHONPATH=<dir> python3 scripts/cad-kernel/pmi-readback.py <file.step>...
Prints one JSON line per file: its dimensions, geometric tolerances and datums by meaning, each
target as its kind and centroid (mm, 4 decimals), and how many presentation edges each item has.
The PMI-4b check compares a part exported by the kernel with the file it was imported from: the
same items with the same values on faces at the same places (docs/verification/cad-pmi).
"""
import json
import sys

from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX
from OCP.TopExp import TopExp_Explorer
from OCP.BRep import BRep_Tool
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import (
    XCAFDoc_Datum,
    XCAFDoc_Dimension,
    XCAFDoc_DocumentTool,
    XCAFDoc_GeomTolerance,
    XCAFDoc_ShapeTool,
)


def centroid(shape):
    kind = shape.ShapeType()
    if kind == TopAbs_VERTEX:
        p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(shape))
        return "vertex", [round(p.X(), 4), round(p.Y(), 4), round(p.Z(), 4)]
    props = GProp_GProps()
    if kind == TopAbs_FACE:
        BRepGProp.SurfaceProperties_s(shape, props)
        name = "face"
    elif kind == TopAbs_EDGE:
        BRepGProp.LinearProperties_s(shape, props)
        name = "edge"
    else:
        return str(kind), None
    c = props.CentreOfMass()
    return name, [round(c.X(), 4) + 0.0, round(c.Y(), 4) + 0.0, round(c.Z(), 4) + 0.0]


def targets(dimtol, label):
    first, second = TDF_LabelSequence(), TDF_LabelSequence()
    dimtol.GetRefShapeLabel_s(label, first, second)
    out = []
    for seq in (first, second):
        out.append(sorted(json.dumps(centroid(XCAFDoc_ShapeTool.GetShape_s(seq.Value(i))))
                          for i in range(1, seq.Length() + 1)))
    return out


def edges(shape):
    if shape is None or shape.IsNull():
        return 0
    n, ex = 0, TopExp_Explorer(shape, TopAbs_EDGE)
    while ex.More():
        n += 1
        ex.Next()
    return n


def read(path):
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetGDTMode(True)
    if reader.ReadFile(path) != IFSelect_RetDone or not reader.Transfer(doc):
        return {"file": path, "error": "read"}
    dimtol = XCAFDoc_DocumentTool.DimTolTool_s(doc.Main())
    out = {"dimensions": [], "tolerances": [], "datums": []}
    seq = TDF_LabelSequence()
    dimtol.GetDimensionLabels(seq)
    for i in range(1, seq.Length() + 1):
        l = seq.Value(i)
        # Set returns the label's attribute (the bindings cannot fill a handle).
        attr = XCAFDoc_Dimension.Set_s(l)
        d = attr.GetObject()
        if d.IsDimWithRange():
            values = [round(d.GetLowerBound(), 6), round(d.GetUpperBound(), 6)]
        else:
            values = [round(d.GetValue(), 6)]
        if d.IsDimWithPlusMinusTolerance():
            values += [round(d.GetLowerTolValue(), 6), round(d.GetUpperTolValue(), 6)]
        out["dimensions"].append({
            "type": str(d.GetType()).split(".")[-1],
            "values": values,
            "plusMinus": bool(d.IsDimWithPlusMinusTolerance()),
            "qualifier": str(d.GetQualifier()).split(".")[-1] if d.HasQualifier() else None,
            "targets": targets(dimtol, l),
            "presentationEdges": edges(d.GetPresentation()),
        })
    seq = TDF_LabelSequence()
    dimtol.GetGeomToleranceLabels(seq)
    for i in range(1, seq.Length() + 1):
        l = seq.Value(i)
        # Set returns the label's attribute (the bindings cannot fill a handle).
        attr = XCAFDoc_GeomTolerance.Set_s(l)
        t = attr.GetObject()
        datums = TDF_LabelSequence()
        dimtol.GetDatumWithObjectOfTolerLabels_s(l, datums)
        refs = []
        for k in range(1, datums.Length() + 1):
            o = XCAFDoc_Datum.Set_s(datums.Value(k)).GetObject()
            if o is not None:
                refs.append([o.GetName().ToCString(), o.GetPosition(),
                             sorted(str(m).split(".")[-1] for m in o.GetModifiers())])
        out["tolerances"].append({
            "type": str(t.GetType()).split(".")[-1],
            "value": round(t.GetValue(), 6),
            "typeOfValue": str(t.GetTypeOfValue()).split(".")[-1],
            "material": str(t.GetMaterialRequirementModifier()).split(".")[-1],
            "modifiers": sorted(str(m).split(".")[-1] for m in t.GetModifiers()),
            "datums": sorted(refs),
            "targets": targets(dimtol, l),
            "presentationEdges": edges(t.GetPresentation()),
        })
    seq = TDF_LabelSequence()
    dimtol.GetDatumLabels(seq)
    seen = set()
    for i in range(1, seq.Length() + 1):
        l = seq.Value(i)
        # Set returns the label's attribute (the bindings cannot fill a handle).
        attr = XCAFDoc_Datum.Set_s(l)
        d = attr.GetObject()
        item = {"name": d.GetName().ToCString(), "targets": targets(dimtol, l),
                "presentationEdges": edges(d.GetPresentation())}
        key = json.dumps(item, sort_keys=True)
        # The reader gives a datum once per tolerance that references it.
        if key not in seen:
            seen.add(key)
            out["datums"].append(item)
    for k in out:
        out[k].sort(key=lambda x: json.dumps(x, sort_keys=True))
    return {"file": path, **out}


for p in sys.argv[1:]:
    print(json.dumps(read(p), sort_keys=True))
