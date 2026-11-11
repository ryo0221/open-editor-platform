"""Writes F56 (LS7, docs/cad/bim-lean-stairs.md): stairs as another program might export them,
with no EP_* data and no IfcOpenShell. Lengths in metres. Run with any Python 3:

    python3 -I scripts/bim-ifc/f56-stairs.py packages/bim-ifc/fixtures/f56-foreign-stairs.ifc

The output is committed: the import test reads it.

- Stair A: an IfcStair with no shape of its own, made of one IfcStairFlight whose body is a
  faceted B-rep (polygons), turned 30 degrees: 18 risers from Ground to First (3 m), tread
  280 mm, waist 180 mm, 1,100 mm wide.
- Stair B: an IfcStair with its own faceted B-rep: a straight run with a landing halfway (9
  risers, a 1,200 mm landing, 8 more): not one straight flight, so it is lost.
- Flight C: an IfcStairFlight on its own on First, a triangulated face set: 10 risers of
  180 mm, tread 300 mm, waist 200 mm, 1,000 mm wide, facing -y.
"""

import math
import sys


def profile(risers, riser, tread, waist):
    """The LS6 side profile (bimStairProfile), in mm: (u along the flight, z up)."""
    slope = riser / tread
    drop = waist * math.hypot(1, slope)
    run = (risers - 1) * tread
    foot = (drop - riser) / slope
    out = [(0.0, 0.0)]
    if foot > 1e-6:
        out.append((foot, 0.0))
    end = risers * riser - drop
    if end < (risers - 1) * riser - 1e-6:
        out.append((run, end))
    for k in range(risers - 1, 0, -1):
        out += [(k * tread, k * riser), ((k - 1) * tread, k * riser)]
    return out


def landing_profile(riser, tread, waist, first, landing, second):
    """A run of `first` risers, a level landing `landing` deep, then `second` more risers."""
    pts = []
    u = 0.0
    z = 0.0
    top = []
    for k in range(first):
        top += [(u, z), (u, z + riser)]
        z += riser
        u += tread if k < first - 1 else landing
    for k in range(second):
        top += [(u, z), (u, z + riser)]
        z += riser
        u += tread
    top.append((u - tread, z))
    # Underside: a level slab under the landing, waist thick, sloped elsewhere (roughly).
    pts = top + [(u - tread, z - waist * 2), (0.0, 0.0)]
    seen = []
    for p in pts:
        if not seen or abs(seen[-1][0] - p[0]) > 1e-9 or abs(seen[-1][1] - p[1]) > 1e-9:
            seen.append(p)
    # Clockwise from the foot over the steps; reverse to run like the LS6 profile.
    return list(reversed(seen[:-1]))


def area(poly):
    return sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(poly, poly[1:] + poly[:1])) / 2


def ears(poly):
    """Triangles of a simple polygon (counter-clockwise), by ear clipping."""
    idx = list(range(len(poly)))
    out = []

    def inside(p, a, b, c):
        def s(p1, p2, p3):
            return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
        d1, d2, d3 = s(p, a, b), s(p, b, c), s(p, c, a)
        return d1 >= -1e-9 and d2 >= -1e-9 and d3 >= -1e-9

    while len(idx) > 3:
        for k in range(len(idx)):
            i, j, l = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = poly[i], poly[j], poly[l]
            if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 1e-9:
                continue
            if any(inside(poly[m], a, b, c) for m in idx if m not in (i, j, l)):
                continue
            out.append((i, j, l))
            idx.pop(k)
            break
        else:
            raise RuntimeError("no ear")
    out.append(tuple(idx))
    return out


class Writer:
    def __init__(self):
        self.lines = []
        self.n = 1000

    def add(self, text):
        self.n += 1
        self.lines.append(f"#{self.n}={text};")
        return f"#{self.n}"


def f(x):
    s = repr(round(x, 9))
    return s if "." in s or "e" in s else s + "."


def solid(w, prof, width):
    """3D corners of the prism (metres): side -w/2 then +w/2, in the flight's frame."""
    pts = []
    for k in (-1, 1):
        for u, z in prof:
            pts.append((u / 1000, k * width / 2000, z / 1000))
    return pts


def faces(prof):
    """The sides and the quads along the profile's edges, each run so its normal is outward."""
    m = len(prof)
    pts = [(u, -1.0, z) for u, z in prof] + [(u, 1.0, z) for u, z in prof]
    ccw = 1 if area(prof) > 0 else -1

    def newell(loop):
        n = [0.0, 0.0, 0.0]
        for k, a in enumerate(loop):
            p, q = pts[a], pts[loop[(k + 1) % len(loop)]]
            n[0] += (p[1] - q[1]) * (p[2] + q[2])
            n[1] += (p[2] - q[2]) * (p[0] + q[0])
            n[2] += (p[0] - q[0]) * (p[1] + q[1])
        return n

    def out(loop, normal):
        n = newell(loop)
        return loop if sum(a * b for a, b in zip(n, normal)) > 0 else list(reversed(loop))

    side0 = out(list(range(m)), (0, -1, 0))
    side1 = out([i + m for i in range(m)], (0, 1, 0))
    quads = []
    for i in range(m):
        j = (i + 1) % m
        du, dz = prof[j][0] - prof[i][0], prof[j][1] - prof[i][1]
        # Right of the edge for a counter-clockwise profile (u, z), left for a clockwise one.
        quads.append(out([i, j, j + m, i + m], (ccw * dz, 0, -ccw * du)))
    return side0, side1, quads


def brep(w, prof, width):
    pts = solid(w, prof, width)
    refs = [w.add(f"IFCCARTESIANPOINT(({f(p[0])},{f(p[1])},{f(p[2])}))") for p in pts]
    side0, side1, quads = faces(prof)
    out = []
    for loop in [side0, side1] + quads:
        poly = w.add(f"IFCPOLYLOOP(({','.join(refs[i] for i in loop)}))")
        bound = w.add(f"IFCFACEOUTERBOUND({poly},.T.)")
        out.append(w.add(f"IFCFACE(({bound}))"))
    shell = w.add(f"IFCCLOSEDSHELL(({','.join(out)}))")
    return w.add(f"IFCFACETEDBREP({shell})")


def tessellated(w, prof, width):
    pts = solid(w, prof, width)
    side0, side1, quads = faces(prof)
    tris = []
    for side in (side0, side1):
        # Ear clipping wants the loop counter-clockwise in (u, z): a side running the other way
        # is clipped reversed and its triangles turned back.
        flat = [prof[i % len(prof)] for i in side]
        turn = area(flat) < 0
        loop = list(reversed(side)) if turn else side
        for a, b, c in ears([prof[i % len(prof)] for i in loop]):
            t = (loop[a], loop[b], loop[c])
            tris.append(tuple(reversed(t)) if turn else t)
    for q in quads:
        tris += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
    coords = ",".join(f"({f(p[0])},{f(p[1])},{f(p[2])})" for p in pts)
    lst = w.add(f"IFCCARTESIANPOINTLIST3D(({coords}),$)")
    idx = ",".join(f"({a + 1},{b + 1},{c + 1})" for a, b, c in tris)
    return w.add(f"IFCTRIANGULATEDFACESET({lst},$,.T.,({idx}),$)")


def placement(w, rel, x, y, z, angle):
    o = w.add(f"IFCCARTESIANPOINT(({f(x)},{f(y)},{f(z)}))")
    ax = w.add("IFCDIRECTION((0.,0.,1.))")
    rd = w.add(f"IFCDIRECTION(({f(math.cos(angle))},{f(math.sin(angle))},0.))")
    a = w.add(f"IFCAXIS2PLACEMENT3D({o},{ax},{rd})")
    return w.add(f"IFCLOCALPLACEMENT({rel},{a})")


def shape(w, item):
    rep = w.add(f"IFCSHAPEREPRESENTATION(#14,'Body','Brep',({item}))")
    return w.add(f"IFCPRODUCTDEFINITIONSHAPE($,$,({rep}))")


def main(out):
    w = Writer()
    head = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('f56-foreign-stairs.ifc','2026-11-09T12:00:00',('F56'),(''),'scripts/bim-ifc/f56-stairs.py','another program','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
/* Written for F56 (LS7, docs/cad/bim-lean-stairs.md) by scripts/bim-ifc/f56-stairs.py:
   stairs as another program might export them, with no EP_* data. Lengths in metres. */
#1=IFCPROJECT('0project______________',$,'Foreign stairs',$,$,$,$,(#10),#2);
#2=IFCUNITASSIGNMENT((#3,#4,#5,#6));
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#5=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#6=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#11,#12);
#11=IFCAXIS2PLACEMENT3D(#13,$,$);
#12=IFCDIRECTION((0.,1.));
#13=IFCCARTESIANPOINT((0.,0.,0.));
#14=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCSITE('0site_________________',$,'Site',$,$,#21,$,$,.ELEMENT.,$,$,$,$,$);
#21=IFCLOCALPLACEMENT($,#11);
#22=IFCBUILDING('0building_____________',$,'Stair house',$,$,#23,$,$,.ELEMENT.,$,$,$);
#23=IFCLOCALPLACEMENT(#21,#11);
#24=IFCBUILDINGSTOREY('0ground_______________',$,'Ground',$,$,#25,$,$,.ELEMENT.,0.);
#25=IFCLOCALPLACEMENT(#23,#11);
#26=IFCBUILDINGSTOREY('0first________________',$,'First',$,$,#27,$,$,.ELEMENT.,3.);
#27=IFCLOCALPLACEMENT(#23,#28);
#28=IFCAXIS2PLACEMENT3D(#29,$,$);
#29=IFCCARTESIANPOINT((0.,0.,3.));
#30=IFCRELAGGREGATES('0agg1_________________',$,$,$,#1,(#20));
#31=IFCRELAGGREGATES('0agg2_________________',$,$,$,#20,(#22));
#32=IFCRELAGGREGATES('0agg3_________________',$,$,$,#22,(#24,#26));"""
    # Stair A: a whole with one flight.
    w.lines.append("/* Stair A: an IfcStair made of one straight flight (a faceted B-rep). */")
    pa = placement(w, "#25", 2.0, 1.0, 0.0, math.pi / 6)
    w.lines.append(f"#100=IFCSTAIR('0stairA_______________',$,'Stair A',$,$,{pa},$,$,.STRAIGHT_RUN_STAIR.);")
    pf = placement(w, pa, 0.0, 0.0, 0.0, 0.0)
    item = brep(w, profile(18, 3000 / 18, 280, 180), 1100)
    sa = shape(w, item)
    w.lines.append(f"#110=IFCSTAIRFLIGHT('0flightA______________',$,'Flight A',$,$,{pf},{sa},$,18,17,{f(3 / 18)},0.28,.STRAIGHT.);")
    w.lines.append("#104=IFCRELAGGREGATES('0agg4_________________',$,$,$,#100,(#110));")
    # Stair B: a landing halfway.
    w.lines.append("/* Stair B: a straight run with a landing halfway, one faceted B-rep: lost. */")
    pb = placement(w, "#25", 8.0, 0.0, 0.0, 0.0)
    item = brep(w, landing_profile(3000 / 17, 260, 150, 9, 1200, 8), 1200)
    sb = shape(w, item)
    w.lines.append(f"#200=IFCSTAIR('0stairB_______________',$,'Stair B',$,$,{pb},{sb},$,.STRAIGHT_RUN_STAIR.);")
    # Flight C: on its own, triangulated.
    w.lines.append("/* Flight C: an IfcStairFlight on its own on First, a triangulated face set. */")
    pc = placement(w, "#27", 0.0, 10.0, 0.0, -math.pi / 2)
    item = tessellated(w, profile(10, 180, 300, 200), 1000)
    sc = shape(w, item)
    w.lines.append(f"#300=IFCSTAIRFLIGHT('0flightC______________',$,'Flight C',$,$,{pc},{sc},$,10,9,0.18,0.3,.STRAIGHT.);")
    w.lines.append("#400=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont1________________',$,$,$,(#100,#200),#24);")
    w.lines.append("#401=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont2________________',$,$,$,(#300),#26);")
    body = "\n".join(w.lines)
    with open(out, "w") as fh:
        fh.write(head + "\n" + body + "\nENDSEC;\nEND-ISO-10303-21;\n")


if __name__ == "__main__":
    main(sys.argv[1])
