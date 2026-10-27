"""Writes F35's IFC4 from another program (R2c-4b, CAD67): a small building made with
IfcOpenShell's authoring API, the way other software writes walls, slabs, columns, beams,
openings and a door. Run in the verification environment (IfcOpenShell installed with pip):

    python -I scripts/bim-ifc/foreign.py packages/bim-ifc/fixtures/f35-ifcopenshell.ifc

The output is committed: the import test reads it without IfcOpenShell.
"""

import sys

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import numpy


def main(out: str) -> None:
    run = ifcopenshell.api.run
    f = ifcopenshell.file(schema="IFC4")
    project = run("root.create_entity", f, ifc_class="IfcProject", name="IfcOpenShell house")
    run("unit.assign_unit", f)  # millimetres, square and cubic metres, degrees
    model = run("context.add_context", f, context_type="Model")
    body = run("context.add_context", f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=model)
    site = run("root.create_entity", f, ifc_class="IfcSite", name="Site")
    building = run("root.create_entity", f, ifc_class="IfcBuilding", name="House")
    storey = run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="Ground")
    upper = run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="Upper")
    run("aggregate.assign_object", f, relating_object=project, products=[site])
    run("aggregate.assign_object", f, relating_object=site, products=[building])
    run("aggregate.assign_object", f, relating_object=building, products=[storey, upper])
    for s, z in ((storey, 0.0), (upper, 3000.0)):
        m = numpy.eye(4)
        m[2][3] = z
        run("geometry.edit_object_placement", f, product=s, matrix=m, is_si=False)
        s.Elevation = z

    concrete = run("material.add_material", f, name="Concrete", category="concrete")
    layer_set = run("material.add_material_set", f, name="Wall 200", set_type="IfcMaterialLayerSet")
    layer = run("material.add_layer", f, layer_set=layer_set, material=concrete)
    layer.LayerThickness = 200.0
    wall_type = run("root.create_entity", f, ifc_class="IfcWallType", name="Wall 200")
    run("material.assign_material", f, products=[wall_type], material=layer_set)

    def place(product, x, y, z, angle=0.0, relative=None):
        m = numpy.eye(4)
        c, s = numpy.cos(angle), numpy.sin(angle)
        m[0][0], m[0][1], m[1][0], m[1][1] = c, -s, s, c
        m[0][3], m[1][3], m[2][3] = x, y, z
        run("geometry.edit_object_placement", f, product=product, matrix=m, is_si=False)

    walls = []
    for name, x, y, angle, length in (("South", 0, 0, 0.0, 6000), ("East", 6000, 0, numpy.pi / 2, 4000)):
        w = run("root.create_entity", f, ifc_class="IfcWall", name=name)
        run("type.assign_type", f, related_objects=[w], relating_type=wall_type)
        place(w, x, y, 0)
        rep = run("geometry.add_wall_representation", f, context=body, length=length / 1000, height=2.7, thickness=0.2)
        run("geometry.assign_representation", f, product=w, representation=rep)
        run("spatial.assign_container", f, relating_structure=storey, products=[w])
        m = numpy.eye(4)
        m[0][0], m[0][1], m[1][0], m[1][1] = numpy.cos(angle), -numpy.sin(angle), numpy.sin(angle), numpy.cos(angle)
        m[0][3], m[1][3] = x, y
        run("geometry.edit_object_placement", f, product=w, matrix=m, is_si=False)
        walls.append(w)

    # An opening in the south wall: a box through it.
    opening = run("root.create_entity", f, ifc_class="IfcOpeningElement", name="Window hole")
    rep = run("geometry.add_wall_representation", f, context=body, length=1.2, height=1.0, thickness=0.4)
    run("geometry.assign_representation", f, product=opening, representation=rep)
    m = numpy.eye(4)
    m[0][3], m[1][3], m[2][3] = 2000, -100, 900
    run("geometry.edit_object_placement", f, product=opening, matrix=m, is_si=False)
    run("feature.add_feature", f, feature=opening, element=walls[0])

    slab = run("root.create_entity", f, ifc_class="IfcSlab", name="Floor")
    rep = run(
        "geometry.add_slab_representation",
        f,
        context=body,
        depth=0.2,
        polyline=[(0.0, 0.0), (6.0, 0.0), (6.0, 4.0), (0.0, 4.0)],
    )
    run("geometry.assign_representation", f, product=slab, representation=rep)
    m = numpy.eye(4)
    m[2][3] = 3000 - 200
    run("geometry.edit_object_placement", f, product=slab, matrix=m, is_si=False)
    run("spatial.assign_container", f, relating_structure=upper, products=[slab])

    steel = run("material.add_material", f, name="Steel", category="steel")
    profile = f.create_entity("IfcRectangleProfileDef", ProfileType="AREA", ProfileName="300x300", XDim=300.0, YDim=300.0)
    column = run("root.create_entity", f, ifc_class="IfcColumn", name="C1")
    rep = run("geometry.add_profile_representation", f, context=body, profile=profile, depth=2.7)
    run("geometry.assign_representation", f, product=column, representation=rep)
    place(column, 3000, 2000, 0)
    run("spatial.assign_container", f, relating_structure=storey, products=[column])
    run("material.assign_material", f, products=[column], material=steel)

    # A door (outside the subset), with the opening it fills.
    door_hole = run("root.create_entity", f, ifc_class="IfcOpeningElement", name="Door hole")
    rep = run("geometry.add_wall_representation", f, context=body, length=0.9, height=2.1, thickness=0.4)
    run("geometry.assign_representation", f, product=door_hole, representation=rep)
    m = numpy.eye(4)
    m[0][0], m[0][1], m[1][0], m[1][1] = 0, -1, 1, 0
    m[0][3], m[1][3] = 6100, 1000
    run("geometry.edit_object_placement", f, product=door_hole, matrix=m, is_si=False)
    run("feature.add_feature", f, feature=door_hole, element=walls[1])
    door = run("root.create_entity", f, ifc_class="IfcDoor", name="D1")
    run("spatial.assign_container", f, relating_structure=storey, products=[door])
    run("feature.add_filling", f, opening=door_hole, element=door)

    furniture = run("root.create_entity", f, ifc_class="IfcFurniture", name="Table")
    run("spatial.assign_container", f, relating_structure=storey, products=[furniture])

    pset = run("pset.add_pset", f, product=walls[0], name="Pset_WallCommon")
    run("pset.edit_pset", f, pset=pset, properties={"IsExternal": True, "LoadBearing": True})
    f.write(out)


if __name__ == "__main__":
    main(sys.argv[1])
