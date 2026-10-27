import {
  arcOf,
  arcPoint,
  BimContext,
  bimPanelMm,
  bimRoofPlanes,
  bimWallAxis,
  bimWallOpeningLoop,
  profileHeight,
  bimJoinThrough,
  cross,
  deriveBim,
  dot,
  left,
  loopExtreme,
  sub,
  unit,
  validateBim,
  type BimDocument,
  type BimElement,
  type BimLoop,
  type BimPoint,
  type BimProfile,
  type BimPropertyValue,
  type BimRoofShape,
  type BimShape,
  type BimTop,
  type BimType,
  type BimWall,
  type Vec2,
  type Vec3,
} from '@editor-platform/bim-core';
import {
  $,
  bool,
  derived,
  enumOf,
  int,
  isIfcGuid,
  list,
  opt,
  P21Writer,
  real,
  reals,
  stableGuid,
  str,
  typed,
  type P21Value,
} from './p21';

/**
 * IFC4 ADD2 TC1 export of a `bim` document (docs/cad/r2c-architecture.md, IFC; ADR 018). Shapes and
 * quantities come from `deriveBim`; this module only maps them to entities. Same input, same bytes.
 */

/** A part's export mesh in its own coordinates (mm), from the CAD version it references. */
export interface BimIfcPartMesh {
  /**
   * `mixed` (solid and sheet bodies together) is refused (`part-mixed-kinds`). A solid's
   * cavities are shells facing inwards; one outside every outer shell is refused (`part-cavity`).
   */
  kind: 'solid' | 'sheet' | 'mixed';
  /** A sheet that bounds a volume without being a solid (`IfcClosedShell`). */
  closed: boolean;
  positions: readonly number[];
  triangles: readonly number[];
  /** Linear deflection of the export mesh, written beside the reference. */
  deflectionMm: number;
  /**
   * OH-U1: the CAD bodies' looks (`#rrggbb`, opacity 0–1), and each triangle's index into them.
   * A shape item takes its first triangle's look; without them the part has no style.
   */
  styles?: readonly BimIfcPartStyle[];
  triangleStyles?: readonly number[];
}
export interface BimIfcPartStyle {
  color: string;
  opacity: number;
}

/**
 * The mesh's triangles (as offsets into `triangles`) grouped into connected bodies: triangles
 * joined across an edge that exactly two triangles share. Bodies touching at a vertex, or
 * along an edge (four triangles), stay apart. Bodies come in order of their first triangle.
 */
function meshBodies(mesh: BimIfcPartMesh): number[][] {
  const key = (v: number) => mesh.positions.slice(v * 3, v * 3 + 3).join(',');
  const edges = new Map<string, number[]>();
  const count = mesh.triangles.length / 3;
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      const [a, b] = [key(mesh.triangles[i * 3 + k]), key(mesh.triangles[i * 3 + ((k + 1) % 3)])];
      const e = a < b ? `${a};${b}` : `${b};${a}`;
      const users = edges.get(e) ?? [];
      users.push(i);
      edges.set(e, users);
    }
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const users of edges.values())
    if (users.length === 2) parent[find(users[1])] = find(users[0]);
  const bodies = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    if (!bodies.has(root)) bodies.set(root, []);
    bodies.get(root)!.push(i * 3);
  }
  return [...bodies.values()];
}

interface SolidBody {
  outer: number[];
  voids: number[][];
}
/**
 * A solid mesh's bodies as outer shells with their cavities. Outward-facing shells enclose a
 * positive volume; a cavity's shell faces into the cavity, so its volume is negative. Each
 * cavity belongs to the smallest outer shell it lies inside (tested with rays); undefined when
 * one lies inside none, or the rays disagree.
 */
function solidBodies(mesh: BimIfcPartMesh): SolidBody[] | undefined {
  const p = (v: number) => mesh.positions.slice(v * 3, v * 3 + 3);
  const measured = meshBodies(mesh).map((tris) => {
    let volume = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) {
      const [a, b, c] = [0, 1, 2].map((k) => p(mesh.triangles[t + k]));
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
      for (const q of [a, b, c])
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], q[k]);
          max[k] = Math.max(max[k], q[k]);
        }
    }
    return { tris, volume, min, max };
  });
  const outers = measured.filter((m) => m.volume > 0);
  const bodies = new Map(outers.map((m) => [m, { outer: m.tris, voids: [] as number[][] }]));
  /**
   * Whether `x` lies inside a closed shell: crossings of rays from `x`, counted in three
   * unrelated directions that must agree (a ray grazing an edge could miscount).
   */
  const inside = (x: number[], tris: number[]): boolean | undefined => {
    const odd = rays.map((d) => tris.filter((t) => rayHits(x, d, t)).length % 2 === 1);
    return odd.every((o) => o === odd[0]) ? odd[0] : undefined;
  };
  const rayHits = (o: number[], d: number[], t: number) => {
    const [a, b, c] = [0, 1, 2].map((k) => p(mesh.triangles[t + k]));
    const e1 = b.map((v, k) => v - a[k]);
    const e2 = c.map((v, k) => v - a[k]);
    const h = cross3(d, e2);
    const det = dot3(e1, h);
    if (Math.abs(det) < 1e-12) return false;
    const s = o.map((v, k) => v - a[k]);
    const u = dot3(s, h) / det;
    if (u < 0 || u > 1) return false;
    const q = cross3(s, e1);
    const v = dot3(d, q) / det;
    return v >= 0 && u + v <= 1 && dot3(e2, q) / det > 0;
  };
  for (const v of measured.filter((m) => m.volume <= 0)) {
    const probe = p(mesh.triangles[v.tris[0]]);
    const around = outers.filter(
      (o) =>
        [0, 1, 2].every((k) => o.min[k] <= v.min[k] && v.max[k] <= o.max[k]) &&
        inside(probe, o.tris) !== false,
    );
    // Only a shell the cavity is surely inside, and not inside any other, is taken.
    const sure = around.filter((o) => inside(probe, o.tris));
    if (sure.length !== around.length || sure.length === 0) return undefined;
    sure.sort((x, y) => x.volume - y.volume);
    bodies.get(sure[0])!.voids.push(v.tris);
  }
  return [...bodies.values()];
}
const lookKey = (look: BimIfcPartStyle) => `${look.color.toLowerCase()} ${look.opacity}`;
const rays = [
  [0.5773, 0.5779, 0.5768],
  [-0.2673, 0.8018, 0.5345],
  [0.8165, -0.4082, 0.4083],
];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export interface BimIfcExportOptions {
  /** The Artifact's ID: with each entity's ID it makes the stable GlobalIds. */
  artifactId: string;
  /** The saved version's time (ISO 8601), the only time in the file. */
  timeStamp: string;
  fileName?: string;
  /**
   * Quantities the kernel measured for elements clipped by a roof (`source: 'kernel'`). Of the
   * analytic values only plan ones (a wall's length, width and footprint, a column's section) are kept.
   */
  kernelQuantities?: ReadonlyMap<string, Readonly<Record<string, number>>>;
  /** Export meshes of parts, by part element ID. */
  parts?: ReadonlyMap<string, BimIfcPartMesh>;
}

export class BimIfcExportError extends Error {
  constructor(
    readonly code: string,
    /** The entities the problem is about. */
    readonly ids: string[] = [],
  ) {
    super(ids.length ? `${code}: ${ids.join(', ')}` : code);
  }
}

export interface BimIfcExport {
  text: string;
  bytes: Uint8Array;
  /** GlobalId by `bim` ID (levels, types and elements). */
  globalIds: Map<string, string>;
  entityCount: number;
}

export const bimIfcKinds = {
  wall: {
    entity: 'IFCWALL',
    type: 'IFCWALLTYPE',
    pset: 'Pset_WallCommon',
    qto: 'Qto_WallBaseQuantities',
  },
  slab: {
    entity: 'IFCSLAB',
    type: 'IFCSLABTYPE',
    pset: 'Pset_SlabCommon',
    qto: 'Qto_SlabBaseQuantities',
  },
  column: {
    entity: 'IFCCOLUMN',
    type: 'IFCCOLUMNTYPE',
    pset: 'Pset_ColumnCommon',
    qto: 'Qto_ColumnBaseQuantities',
  },
  beam: {
    entity: 'IFCBEAM',
    type: 'IFCBEAMTYPE',
    pset: 'Pset_BeamCommon',
    qto: 'Qto_BeamBaseQuantities',
  },
  door: { entity: 'IFCDOOR', type: 'IFCDOORTYPE', pset: 'Pset_DoorCommon', qto: '' },
  window: { entity: 'IFCWINDOW', type: 'IFCWINDOWTYPE', pset: 'Pset_WindowCommon', qto: '' },
  roof: {
    entity: 'IFCROOF',
    type: 'IFCROOFTYPE',
    pset: 'Pset_RoofCommon',
    qto: 'Qto_RoofBaseQuantities',
  },
  space: { entity: 'IFCSPACE', type: '', pset: 'Pset_SpaceCommon', qto: 'Qto_SpaceBaseQuantities' },
  part: {
    entity: 'IFCBUILDINGELEMENTPROXY',
    type: 'IFCBUILDINGELEMENTPROXYTYPE',
    pset: 'Pset_BuildingElementProxyCommon',
    qto: '',
  },
  opening: { entity: 'IFCOPENINGELEMENT', type: '', pset: 'Pset_OpeningElementCommon', qto: '' },
} as const;

/** `bim-core` quantity keys → `Qto_*BaseQuantities` names, with their kind. */
export const bimQtoNames: Record<string, Record<string, [string, 'L' | 'A' | 'V']>> = {
  wall: {
    length: ['Length', 'L'],
    width: ['Width', 'L'],
    height: ['Height', 'L'],
    footprintArea: ['GrossFootprintArea', 'A'],
    grossSideArea: ['GrossSideArea', 'A'],
    netSideArea: ['NetSideArea', 'A'],
    grossVolume: ['GrossVolume', 'V'],
    netVolume: ['NetVolume', 'V'],
  },
  slab: {
    depth: ['Width', 'L'],
    perimeter: ['Perimeter', 'L'],
    grossArea: ['GrossArea', 'A'],
    netArea: ['NetArea', 'A'],
    grossVolume: ['GrossVolume', 'V'],
    netVolume: ['NetVolume', 'V'],
  },
  column: {
    length: ['Length', 'L'],
    crossSectionArea: ['CrossSectionArea', 'A'],
    grossVolume: ['GrossVolume', 'V'],
    netVolume: ['NetVolume', 'V'],
  },
  beam: {
    length: ['Length', 'L'],
    crossSectionArea: ['CrossSectionArea', 'A'],
    netVolume: ['NetVolume', 'V'],
  },
  roof: { projectedArea: ['ProjectedArea', 'A'], grossArea: ['GrossArea', 'A'] },
  space: {
    height: ['Height', 'L'],
    netFloorArea: ['NetFloorArea', 'A'],
    netPerimeter: ['NetPerimeter', 'L'],
    netVolume: ['NetVolume', 'V'],
  },
};
/** Quantities a roof's clip leaves unchanged; other quantities of clipped elements come from the kernel. */
/** IfcRoof's PredefinedType for each roof form. */
const roofTypes: Record<BimRoofShape['form'], string> = {
  flat: 'FLAT_ROOF',
  mono: 'SHED_ROOF',
  gable: 'GABLE_ROOF',
  hip: 'HIP_ROOF',
};
const planQuantities: Record<string, string[]> = {
  wall: ['length', 'width', 'footprintArea'],
  column: ['crossSectionArea'],
};
/** Areas and volumes are written in m² and m³ (the file's units); lengths stay in mm. */
export const bimQtoScale = { L: 1, A: 1e-6, V: 1e-9 } as const;

/** A horizontal frame: origin and the direction of local +X in plan. */
interface Frame {
  o: Vec3;
  x: Vec2;
}
const toLocal = (f: Frame, p: Vec2): Vec2 => {
  const d = sub(p, [f.o[0], f.o[1]]);
  return [dot(d, f.x), dot(d, left(f.x))];
};
const loopToLocal = (f: Frame, loop: BimLoop): BimLoop =>
  loop.map((v) => {
    const p = toLocal(f, [v[0], v[1]]);
    return v.length === 3 ? [p[0], p[1], v[2]] : p;
  });
/** A plane in world coordinates: a point and its normal. */
interface Plane {
  p: Vec3;
  n: Vec3;
}

export function writeIfc(doc: BimDocument, options: BimIfcExportOptions): BimIfcExport {
  const problems = validateBim(doc).filter((d) => d.severity === 'error');
  if (problems.length)
    throw new BimIfcExportError(
      'invalid-document',
      problems.map((d) => d.id ?? d.path),
    );
  const ctx = new BimContext(doc);
  const derivedBim = deriveBim(doc);
  const shapeOf = (id: string) => derivedBim.shapes.get(id)!;

  // Refusals before writing anything.
  const needKernel = doc.elements.filter(
    (e) =>
      derivedBim.quantities.get(e.id)?.source === 'kernel' && !options.kernelQuantities?.has(e.id),
  );
  if (needKernel.length)
    throw new BimIfcExportError(
      'evaluation-required',
      needKernel.map((e) => e.id),
    );
  const parts = doc.elements.filter((e) => e.kind === 'part');
  const noMesh = parts.filter((e) => !options.parts?.has(e.id));
  if (noMesh.length)
    throw new BimIfcExportError(
      'evaluation-required',
      noMesh.map((e) => e.id),
    );
  const mixed = parts.filter((e) => options.parts!.get(e.id)!.kind === 'mixed');
  if (mixed.length)
    throw new BimIfcExportError(
      'part-mixed-kinds',
      mixed.map((e) => e.id),
    );
  const solids = new Map<string, SolidBody[]>();
  const loose: string[] = [];
  for (const e of parts) {
    const mesh = options.parts!.get(e.id)!;
    if (mesh.kind !== 'solid') continue;
    const bodies = solidBodies(mesh);
    if (bodies) solids.set(e.id, bodies);
    else loose.push(e.id);
  }
  if (loose.length) throw new BimIfcExportError('part-cavity', loose);

  const w = new P21Writer();
  const add = (name: string, ...args: P21Value[]) => w.add(name, args);
  /** Document entities and auxiliary entities hash in separate namespaces (IDs hold no NUL). */
  const guidKey = (ns: 'entity' | 'aux', key: string) =>
    stableGuid(`${options.artifactId}\u0000${ns}\u0000${key}`);
  const globalIds = new Map<string, string>();
  /** Every root's GlobalId once: a GlobalId kept from an import may repeat or meet a new one. */
  const emitted = new Set<string>();
  const unique = (g: string, id: string) => {
    if (emitted.has(g)) throw new BimIfcExportError('global-id-duplicate', [id]);
    emitted.add(g);
    return str(g);
  };
  const gid = (id: string, keep?: string) => {
    const g = keep && isIfcGuid(keep) ? keep : guidKey('entity', id);
    globalIds.set(id, g);
    return unique(g, id);
  };
  const auxGid = (key: string) => unique(guidKey('aux', key), key);
  const label = (s: string) => str(s);
  /** IfcLabel and IfcIdentifier hold 255 characters; longer user texts are IfcText. */
  const textValue = (type: string, v: string) =>
    typed([...v].length > 255 ? 'IFCTEXT' : type, str(v));

  // Shared geometry.
  const pt3 = (p: readonly number[]) => add('IFCCARTESIANPOINT', reals(p));
  const dir3 = (d: readonly number[]) => add('IFCDIRECTION', reals(d));
  const origin3 = pt3([0, 0, 0]);
  const zUp = dir3([0, 0, 1]);
  const placement3 = (o: Vec3, x?: Vec2, z?: Vec3) => {
    const isOrigin = o[0] === 0 && o[1] === 0 && o[2] === 0;
    const plainX = !x || (x[0] === 1 && x[1] === 0);
    return add(
      'IFCAXIS2PLACEMENT3D',
      isOrigin ? origin3 : pt3(o),
      z ? dir3(z) : plainX ? $ : zUp,
      z ? dir3([x![0], x![1], 0]) : plainX ? $ : dir3([x![0], x![1], 0]),
    );
  };
  const worldPlacement = add('IFCAXIS2PLACEMENT3D', origin3, $, $);
  /** One surface style per look (OH-U1), seen from both sides as a sheet is. */
  const surfaceStyles = new Map<string, P21Value>();
  const surfaceStyle = (look: BimIfcPartStyle) => {
    const k = lookKey(look);
    let style = surfaceStyles.get(k);
    if (!style) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(look.color.slice(i, i + 2), 16) / 255);
      style = add(
        'IFCSURFACESTYLE',
        str(look.color.toLowerCase()),
        enumOf('BOTH'),
        list([
          add(
            'IFCSURFACESTYLESHADING',
            add('IFCCOLOURRGB', $, real(r!), real(g!), real(b!)),
            real(1 - Math.min(1, Math.max(0, look.opacity))),
          ),
        ]),
      );
      surfaceStyles.set(k, style);
    }
    return style;
  };

  // Units and contexts.
  const units = add(
    'IFCUNITASSIGNMENT',
    list([
      add('IFCSIUNIT', derived, enumOf('LENGTHUNIT'), enumOf('MILLI'), enumOf('METRE')),
      add('IFCSIUNIT', derived, enumOf('AREAUNIT'), $, enumOf('SQUARE_METRE')),
      add('IFCSIUNIT', derived, enumOf('VOLUMEUNIT'), $, enumOf('CUBIC_METRE')),
      add('IFCSIUNIT', derived, enumOf('PLANEANGLEUNIT'), $, enumOf('RADIAN')),
    ]),
  );
  const north = doc.project.trueNorthRad;
  const context = add(
    'IFCGEOMETRICREPRESENTATIONCONTEXT',
    $,
    label('Model'),
    int(3),
    real(1e-5),
    worldPlacement,
    north === 0 ? $ : add('IFCDIRECTION', reals([-Math.sin(north), Math.cos(north)])),
  );
  const subContext = (id: string, view: string) =>
    add(
      'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
      label(id),
      label('Model'),
      derived,
      derived,
      derived,
      derived,
      context,
      $,
      enumOf(view),
      $,
    );
  const body = subContext('Body', 'MODEL_VIEW');
  const axisContext = subContext('Axis', 'GRAPH_VIEW');

  // Spatial structure.
  const project = add(
    'IFCPROJECT',
    auxGid('project'),
    $,
    label(doc.project.name),
    $,
    $,
    $,
    $,
    list([context]),
    units,
  );
  const sitePlacement = add('IFCLOCALPLACEMENT', $, worldPlacement);
  const site = add(
    'IFCSITE',
    auxGid('site'),
    $,
    label('Site'),
    $,
    $,
    sitePlacement,
    $,
    $,
    enumOf('ELEMENT'),
    $,
    $,
    real(doc.project.siteElevationMm),
    $,
    $,
  );
  const buildingPlacement = add('IFCLOCALPLACEMENT', sitePlacement, worldPlacement);
  const building = add(
    'IFCBUILDING',
    auxGid('building'),
    $,
    label(doc.project.name),
    $,
    $,
    buildingPlacement,
    $,
    $,
    enumOf('ELEMENT'),
    $,
    $,
    $,
  );
  add('IFCRELAGGREGATES', auxGid('agg:project'), $, $, $, project, list([site]));
  add('IFCRELAGGREGATES', auxGid('agg:site'), $, $, $, site, list([building]));
  const storeys = new Map<string, { ref: P21Value; placement: P21Value; z: number }>();
  for (const l of ctx.sortedLevels) {
    const placement = add(
      'IFCLOCALPLACEMENT',
      buildingPlacement,
      placement3([0, 0, l.elevationMm]),
    );
    const ref = add(
      'IFCBUILDINGSTOREY',
      gid(l.id),
      $,
      label(l.name),
      $,
      $,
      placement,
      $,
      $,
      enumOf('ELEMENT'),
      real(l.elevationMm),
    );
    storeys.set(l.id, { ref, placement, z: l.elevationMm });
  }
  if (storeys.size)
    add(
      'IFCRELAGGREGATES',
      auxGid('agg:building'),
      $,
      $,
      $,
      building,
      list([...storeys.values()].map((s) => s.ref)),
    );

  // Property sets.
  const propertyValue = (type: string, v: BimPropertyValue): P21Value =>
    type === 'boolean'
      ? typed('IFCBOOLEAN', bool(v as boolean))
      : type === 'number'
        ? typed('IFCREAL', real(v as number))
        : type === 'length'
          ? typed('IFCLENGTHMEASURE', real(v as number))
          : textValue('IFCLABEL', v as string);
  const single = (name: string, value: P21Value) =>
    add('IFCPROPERTYSINGLEVALUE', label(name), $, value, $);
  /** A constraint value that is a list: a marker the constraint set turns into a list property. */
  const listValue = (values: P21Value[]): P21Value => ({ t: 'list', v: values });
  /** `tag` tells sets apart in the GlobalId: the fixed name, or the user set's definition ID. */
  const propertySet = (key: string, name: string, props: P21Value[], tag = name) =>
    add('IFCPROPERTYSET', auxGid(`pset\u0000${key}\u0000${tag}`), $, label(name), $, list(props));
  const setDefs = new Map(doc.propertySets.map((s) => [s.id, s]));
  /** Instances of each user property set, tied to its template at the end. */
  const setUses = new Map<string, P21Value[]>();
  const measureOf = {
    string: 'IfcLabel',
    number: 'IfcReal',
    boolean: 'IfcBoolean',
    length: 'IfcLengthMeasure',
  };
  // A user set's definition is a template; its ID is the template's Description.
  const templates = new Map(
    doc.propertySets.map((def) => [
      def.id,
      add(
        'IFCPROPERTYSETTEMPLATE',
        auxGid(`pst\u0000${def.id}`),
        $,
        label(def.name),
        str(def.id),
        enumOf('NOTDEFINED'),
        $,
        list(
          def.properties.map((p) =>
            add(
              'IFCSIMPLEPROPERTYTEMPLATE',
              auxGid(`pst\u0000${def.id}\u0000${p.name}`),
              $,
              label(p.name),
              $,
              enumOf('P_SINGLEVALUE'),
              label(measureOf[p.type]),
              $,
              $,
              $,
              $,
              $,
              $,
            ),
          ),
        ),
      ),
    ]),
  );
  if (templates.size)
    add('IFCRELDECLARES', auxGid('declares'), $, $, $, project, list([...templates.values()]));
  /** Common and user property sets of a type or element. */
  const describedSets = (
    key: string,
    commonName: string,
    d: { common?: BimType['common']; properties?: BimType['properties'] },
  ) => {
    const out: P21Value[] = [];
    const c = d.common;
    if (c && commonName) {
      const props: P21Value[] = [];
      if (c.reference !== undefined)
        props.push(single('Reference', typed('IFCIDENTIFIER', str(c.reference))));
      if (c.isExternal !== undefined)
        props.push(single('IsExternal', typed('IFCBOOLEAN', bool(c.isExternal))));
      if (c.loadBearing !== undefined)
        props.push(single('LoadBearing', typed('IFCBOOLEAN', bool(c.loadBearing))));
      if (c.fireRating !== undefined)
        props.push(single('FireRating', typed('IFCLABEL', str(c.fireRating))));
      if (props.length) out.push(propertySet(key, commonName, props));
    }
    for (const [setId, values] of Object.entries(d.properties ?? {})) {
      const def = setDefs.get(setId)!;
      const props = def.properties
        .filter((p) => values[p.name] !== undefined)
        .map((p) => single(p.name, propertyValue(p.type, values[p.name])));
      // User set names need not be unique; the NUL keeps the tag apart from fixed names.
      const set = propertySet(key, def.name, props, `user\u0000${setId}`);
      setUses.set(setId, [...(setUses.get(setId) ?? []), set]);
      out.push(set);
    }
    return out;
  };
  const property = ([n, v]: [string, P21Value]) =>
    v.t === 'list' ? add('IFCPROPERTYLISTVALUE', label(n), $, v, $) : single(n, v);
  const constraintSet = (key: string, props: [string, P21Value][], name = 'EP_Constraints') =>
    propertySet(key, name, props.map(property));
  const ident = (s: string) => typed('IFCIDENTIFIER', str(s));
  const length = (v: number) => typed('IFCLENGTHMEASURE', real(v));
  const pointRefs = (name: string, p: BimPoint): [string, P21Value][] =>
    // One property per axis: IDs may hold any character, so a joined list could be ambiguous.
    'grid' in p
      ? [
          [`${name}GridA`, ident(p.grid[0])],
          [`${name}GridB`, ident(p.grid[1])],
        ]
      : [
          [`${name}X`, length(p.xy[0])],
          [`${name}Y`, length(p.xy[1])],
        ];
  /**
   * A loop as written in the document: the profile curve is normalized (orientation, arc mid
   * points), so the exact vertices and bulges go beside it.
   */
  const loopRefs = (name: string, loop: BimLoop): [string, P21Value][] => [
    [name, listValue(loop.flatMap((v) => [length(v[0]), length(v[1])]))],
    [`${name}Bulge`, listValue(loop.map((v) => typed('IFCREAL', real(v[2] ?? 0))))],
  ];
  const angle = (v: number) => typed('IFCPLANEANGLEMEASURE', real(v));
  const heightRefs = (
    name: string,
    h: { level: string; offsetMm: number },
  ): [string, P21Value][] => [
    [`${name}Level`, ident(globalIds.get(h.level)!)],
    [`${name}Offset`, length(h.offsetMm)],
  ];
  const topRefs = (t: BimTop | undefined): [string, P21Value][] =>
    !t ? [] : 'heightMm' in t ? [['TopHeight', length(t.heightMm)]] : heightRefs('Top', t);
  const partReference = (
    key: string,
    source: Extract<BimType, { kind: 'part' }>['source'],
    deflectionMm?: number,
  ) =>
    propertySet(key, 'EP_PartReference', [
      single('ArtifactId', ident(source.artifactId)),
      single('VersionId', ident(source.versionId)),
      single('ContentHash', ident(source.contentHash)),
      ...(deflectionMm === undefined ? [] : [single('MeshDeflection', length(deflectionMm))]),
    ]);
  const relDefines = (key: string, objects: P21Value[], set: P21Value) =>
    add('IFCRELDEFINESBYPROPERTIES', auxGid(`rdp\u0000${key}`), $, $, $, list(objects), set);

  // Profiles.
  const indexedCurve = (loop: BimLoop, closed = true) => {
    const points: Vec2[] = [];
    const segments: P21Value[] = [];
    const index = (p: Vec2) => points.push(p);
    loop.forEach((v) => index([v[0], v[1]]));
    const n = loop.length;
    (closed ? loop : loop.slice(0, -1)).forEach((v, i) => {
      const a = i + 1;
      const b = ((i + 1) % n) + 1;
      if (v[2]) {
        const next = loop[(i + 1) % n];
        const mid = arcPoint(arcOf([v[0], v[1]], [next[0], next[1]], v[2]), 0.5);
        index(mid);
        segments.push(typed('IFCARCINDEX', list([int(a), int(points.length), int(b)])));
      } else segments.push(typed('IFCLINEINDEX', list([int(a), int(b)])));
    });
    return add(
      'IFCINDEXEDPOLYCURVE',
      add('IFCCARTESIANPOINTLIST2D', list(points.map((p) => reals(p)))),
      list(segments),
      bool(false),
    );
  };
  const loopProfile = (outer: BimLoop, holes: BimLoop[] = []) =>
    holes.length
      ? add(
          'IFCARBITRARYPROFILEDEFWITHVOIDS',
          enumOf('AREA'),
          $,
          indexedCurve(outer),
          list(holes.map((h) => indexedCurve(h))),
        )
      : add('IFCARBITRARYCLOSEDPROFILEDEF', enumOf('AREA'), $, indexedCurve(outer));
  const profiles = new Map<string, P21Value>();
  const parametricProfile = (typeId: string, p: BimProfile) => {
    const known = profiles.get(typeId);
    if (known) return known;
    const name = label(ctx.types.get(typeId)!.name);
    const ref =
      p.shape === 'rect'
        ? add('IFCRECTANGLEPROFILEDEF', enumOf('AREA'), name, $, real(p.widthMm), real(p.depthMm))
        : p.shape === 'circle'
          ? add('IFCCIRCLEPROFILEDEF', enumOf('AREA'), name, $, real(p.diameterMm / 2))
          : p.shape === 'h'
            ? add(
                'IFCISHAPEPROFILEDEF',
                enumOf('AREA'),
                name,
                $,
                real(p.widthMm),
                real(p.depthMm),
                real(p.webMm),
                real(p.flangeMm),
                $,
                $,
                $,
              )
            : p.shape === 'l'
              ? add(
                  'IFCLSHAPEPROFILEDEF',
                  enumOf('AREA'),
                  name,
                  $,
                  real(p.depthMm),
                  real(p.widthMm),
                  real(p.thicknessMm),
                  $,
                  $,
                  $,
                )
              : p.shape === 'channel'
                ? add(
                    'IFCUSHAPEPROFILEDEF',
                    enumOf('AREA'),
                    name,
                    $,
                    real(p.depthMm),
                    real(p.widthMm),
                    real(p.webMm),
                    real(p.flangeMm),
                    $,
                    $,
                    $,
                  )
                : add(
                    'IFCRECTANGLEHOLLOWPROFILEDEF',
                    enumOf('AREA'),
                    name,
                    $,
                    real(p.widthMm),
                    real(p.depthMm),
                    real(p.wallMm),
                    $,
                    $,
                  );
    profiles.set(typeId, ref);
    return ref;
  };
  const extrude = (profile: P21Value, depth: number, position?: P21Value) =>
    add('IFCEXTRUDEDAREASOLID', profile, position ?? $, zUp, real(depth));
  const shapeRep = (ctxRef: P21Value, id: string, type: string, items: P21Value[]) =>
    add('IFCSHAPEREPRESENTATION', ctxRef, label(id), label(type), list(items));
  const productShape = (reps: P21Value[]) => add('IFCPRODUCTDEFINITIONSHAPE', $, $, list(reps));
  /** Removes the half-space on the side `normal` points to (material on the other side). */
  const clipAbove = (operand: P21Value, frame: Frame, plane: Plane) => {
    const p = toLocal(frame, [plane.p[0], plane.p[1]]);
    const nx = toLocal({ o: [0, 0, 0], x: frame.x }, [plane.n[0], plane.n[1]]);
    const n: Vec3 = [nx[0], nx[1], plane.n[2]];
    const ref: Vec2 = Math.hypot(n[0], n[1]) < 1e-12 ? [1, 0] : unit([-n[1], n[0]]);
    const surface = add(
      'IFCPLANE',
      add(
        'IFCAXIS2PLACEMENT3D',
        pt3([p[0], p[1], plane.p[2] - frame.o[2]]),
        dir3(n),
        dir3([ref[0], ref[1], 0]),
      ),
    );
    return add(
      'IFCBOOLEANCLIPPINGRESULT',
      enumOf('DIFFERENCE'),
      operand,
      add('IFCHALFSPACESOLID', surface, bool(false)),
    );
  };
  const flip = (pl: Plane): Plane => ({ p: pl.p, n: [-pl.n[0], -pl.n[1], -pl.n[2]] });
  const facePlanes = bimRoofPlanes;
  /** Cuts what lies above a roof's underside: above each of its planes in turn. */
  const clipByRoof = (solid: P21Value, frame: Frame, roofId: string) => {
    const s = shapeOf(roofId) as Extract<BimShape, { kind: 'roof' }>;
    return s.faces.reduce((acc, f) => clipAbove(acc, frame, facePlanes(s, f).under), solid);
  };

  // Materials.
  const materials = new Map(
    doc.materials.map((m) => {
      const ref = add('IFCMATERIAL', label(m.name), $, label(m.category));
      add(
        'IFCMATERIALPROPERTIES',
        label('EP_Constraints'),
        $,
        list([single('BimId', ident(m.id))]),
        ref,
      );
      return [m.id, ref];
    }),
  );
  const materialSets = new Map<string, P21Value>();
  for (const t of doc.types) {
    if ('layers' in t) {
      const layers = t.layers.map((l) =>
        add('IFCMATERIALLAYER', materials.get(l.materialId)!, real(l.thicknessMm), $, $, $, $, $),
      );
      materialSets.set(t.id, add('IFCMATERIALLAYERSET', list(layers), label(t.name), $));
    } else if ('profile' in t) {
      const mp = add(
        'IFCMATERIALPROFILE',
        $,
        $,
        materials.get(t.materialId)!,
        parametricProfile(t.id, t.profile),
        $,
        $,
      );
      materialSets.set(t.id, add('IFCMATERIALPROFILESET', label(t.name), $, list([mp]), $));
    }
  }

  // Types, with shared door and window bodies.
  const typeRefs = new Map<string, P21Value>();
  const typeMaps = new Map<string, P21Value>();
  const panelMm = bimPanelMm;
  for (const t of doc.types) {
    const k = bimIfcKinds[t.kind];
    if (!k.type) continue;
    const sets = describedSets(`type\u0000${t.id}`, k.pset, t);
    const typeConstraints: [string, P21Value][] = [['BimId', ident(t.id)]];
    if (t.kind === 'part') {
      // The reference and the bounds the Host reported, for a type no element places.
      (['Min', 'Max'] as const).forEach((m) =>
        t.hintBounds[m === 'Min' ? 'min' : 'max'].forEach((v, k) =>
          typeConstraints.push([`Hint${m}${'XYZ'[k]}`, length(v)]),
        ),
      );
      sets.push(partReference(`type\u0000${t.id}`, t.source));
    }
    sets.push(constraintSet(`type\u0000${t.id}`, typeConstraints));
    let maps: P21Value = $;
    if (t.kind === 'door' || t.kind === 'window') {
      const panel = add(
        'IFCRECTANGLEPROFILEDEF',
        enumOf('AREA'),
        $,
        add('IFCAXIS2PLACEMENT2D', add('IFCCARTESIANPOINT', reals([t.widthMm / 2, 0])), $),
        real(t.widthMm),
        real(panelMm),
      );
      const map = add(
        'IFCREPRESENTATIONMAP',
        worldPlacement,
        shapeRep(body, 'Body', 'SweptSolid', [extrude(panel, t.heightMm)]),
      );
      typeMaps.set(t.id, map);
      maps = list([map]);
    }
    const head = [gid(t.id), $, label(t.name), $, $, list(sets), maps, $, $];
    const ref =
      t.kind === 'door'
        ? add(k.type, ...head, enumOf('DOOR'), enumOf('NOTDEFINED'), $, $)
        : t.kind === 'window'
          ? add(k.type, ...head, enumOf('WINDOW'), enumOf('NOTDEFINED'), $, $)
          : add(
              k.type,
              ...head,
              enumOf(
                t.kind === 'wall'
                  ? 'STANDARD'
                  : t.kind === 'slab'
                    ? 'FLOOR'
                    : t.kind === 'roof'
                      ? 'NOTDEFINED'
                      : t.kind === 'part'
                        ? 'NOTDEFINED'
                        : t.kind.toUpperCase(),
              ),
            );
    typeRefs.set(t.id, ref);
    const set = materialSets.get(t.id);
    if (set)
      add(
        'IFCRELASSOCIATESMATERIAL',
        auxGid(`mat\u0000type\u0000${t.id}`),
        $,
        $,
        $,
        list([ref]),
        set,
      );
  }

  // Grid: axes parallel to the first one (U) and all others (V). One direction only: no IfcGrid.
  const gridAxes = new Map<string, P21Value>();
  const lowest = ctx.sortedLevels[0];
  const contained = new Map<string, P21Value[]>();
  const contain = (levelId: string, ref: P21Value) => {
    const list = contained.get(levelId) ?? [];
    list.push(ref);
    contained.set(levelId, list);
  };
  if (doc.grids.length && lowest) {
    const d0 = unit(sub(doc.grids[0].end, doc.grids[0].start));
    const groups: [typeof doc.grids, typeof doc.grids] = [[], []];
    for (const a of doc.grids)
      groups[Math.abs(cross(unit(sub(a.end, a.start)), d0)) <= 1e-9 ? 0 : 1].push(a);
    if (groups[1].length) {
      const axisRefs = groups.map((g) =>
        g.map((a) => {
          const ref = add(
            'IFCGRIDAXIS',
            label(a.label),
            add('IFCPOLYLINE', list([pt2(a.start), pt2(a.end)])),
            bool(true),
          );
          gridAxes.set(a.id, ref);
          return ref;
        }),
      );
      const gridPlacement = add(
        'IFCLOCALPLACEMENT',
        storeys.get(lowest.id)!.placement,
        worldPlacement,
      );
      const grid = add(
        'IFCGRID',
        auxGid('grid'),
        $,
        label('Grid'),
        $,
        $,
        gridPlacement,
        $,
        list(axisRefs[0]),
        list(axisRefs[1]),
        $,
        enumOf('RECTANGULAR'),
      );
      contain(lowest.id, grid);
    }
  }
  function pt2(p: Vec2) {
    return add('IFCCARTESIANPOINT', reals(p));
  }

  // Elements.
  const elementRefs = new Map<string, P21Value>();
  const placements = new Map<string, P21Value>();
  const byType = new Map<string, P21Value[]>();
  const usage = new Map<string, { set: P21Value; objects: P21Value[] }>();
  const quantitySets: [string, P21Value, P21Value][] = [];
  const spaces = new Map<string, P21Value[]>();
  const levelOf = (e: BimElement): string | undefined => {
    switch (e.kind) {
      case 'slab':
      case 'beam':
        return e.top.level;
      case 'opening':
      case 'door':
      case 'window':
        return levelOf(ctx.elements.get(e.hostId)!);
      default:
        return e.base.level;
    }
  };
  const localPlacement = (levelId: string, f: Frame) =>
    add(
      'IFCLOCALPLACEMENT',
      storeys.get(levelId)!.placement,
      placement3([f.o[0], f.o[1], f.o[2] - storeys.get(levelId)!.z], f.x),
    );
  const quantities = (e: BimElement) => {
    const names = bimQtoNames[e.kind];
    if (!names) return;
    const q = derivedBim.quantities.get(e.id)!;
    // A clipped element keeps only the analytic values the clip cannot change.
    const values =
      q.source === 'kernel'
        ? {
            ...Object.fromEntries(
              Object.entries(q.values).filter(([k]) => planQuantities[e.kind]?.includes(k)),
            ),
            ...options.kernelQuantities!.get(e.id),
          }
        : q.values;
    const items = Object.entries(names)
      .filter(([key]) => values[key] !== undefined)
      .map(([key, [name, kind]]) =>
        add(
          kind === 'L'
            ? 'IFCQUANTITYLENGTH'
            : kind === 'A'
              ? 'IFCQUANTITYAREA'
              : 'IFCQUANTITYVOLUME',
          label(name),
          $,
          $,
          real(values[key] * bimQtoScale[kind]),
          $,
        ),
      );
    return add(
      'IFCELEMENTQUANTITY',
      auxGid(`qto\u0000${e.id}`),
      $,
      label(bimIfcKinds[e.kind].qto),
      $,
      label(q.source === 'kernel' ? 'kernel' : 'analytic'),
      list(items),
    );
  };

  const wallAxis = (wall: BimWall) => bimWallAxis(ctx, wall);
  const wallOpeningLoop = (wall: BimWall, alongMm: number, widthMm: number) =>
    bimWallOpeningLoop(ctx, wall, alongMm, widthMm);
  const elementHead = (e: BimElement, placement: P21Value, shape: P21Value) => [
    gid(e.id, e.ifcGlobalId),
    $,
    label(e.name ?? e.id),
    $,
    $,
    placement,
    shape,
  ];

  // Hosts before what they host: openings need their host's entity and placement.
  const hosted = (e: BimElement) =>
    e.kind === 'opening' || e.kind === 'door' || e.kind === 'window';
  for (const e of [...doc.elements.filter((x) => !hosted(x)), ...doc.elements.filter(hosted)]) {
    const shape = shapeOf(e.id);
    const levelId = levelOf(e)!;
    const storeyZ = storeys.get(levelId)!.z;
    let ref: P21Value;
    const constraints: [string, P21Value][] = [['BimId', ident(e.id)]];
    // Name falls back to the ID (a proxy needs one); this keeps a name equal to the ID apart.
    if (e.name === undefined && e.kind !== 'space')
      constraints.push(['Unnamed', typed('IFCBOOLEAN', bool(true))]);
    switch (e.kind) {
      case 'wall': {
        const s = shape as Extract<BimShape, { kind: 'wall' }>;
        const a = wallAxis(e);
        const frame: Frame = { o: [a.s[0], a.s[1], s.zBase], x: a.x };
        let solid = extrude(loopProfile(loopToLocal(frame, s.footprint)), s.zTop - s.zBase);
        if (e.clipBy) solid = clipByRoof(solid, frame, e.clipBy);
        const axisCurve = a.arc
          ? indexedCurve([[...toLocal(frame, a.s), e.bulge!], toLocal(frame, a.e)], false)
          : add('IFCPOLYLINE', list([pt2([0, 0]), pt2(toLocal(frame, a.e))]));
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.wall.entity,
          ...elementHead(
            e,
            placement,
            productShape([
              shapeRep(axisContext, 'Axis', 'Curve2D', [axisCurve]),
              shapeRep(body, 'Body', e.clipBy ? 'Clipping' : 'SweptSolid', [solid]),
            ]),
          ),
          $,
          enumOf('STANDARD'),
        );
        const key = `${e.typeId}\u0000${a.rightOff}`;
        const u = usage.get(key) ?? {
          set: add(
            'IFCMATERIALLAYERSETUSAGE',
            materialSets.get(e.typeId)!,
            enumOf('AXIS2'),
            enumOf('POSITIVE'),
            real(a.rightOff),
            $,
          ),
          objects: [],
        };
        u.objects.push(ref);
        usage.set(key, u);
        constraints.push(
          ['Location', typed('IFCLABEL', str(e.location))],
          ...pointRefs('Start', e.start),
          ...pointRefs('End', e.end),
          ...heightRefs('Base', e.base),
          ...topRefs(e.top),
        );
        if (e.bulge) constraints.push(['Bulge', typed('IFCREAL', real(e.bulge))]);
        break;
      }
      case 'slab': {
        const s = shape as Extract<BimShape, { kind: 'slab' }>;
        const frame: Frame = { o: [0, 0, s.zBottom], x: [1, 0] };
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.slab.entity,
          ...elementHead(
            e,
            placement,
            productShape([
              shapeRep(body, 'Body', 'SweptSolid', [
                extrude(loopProfile(s.boundary, e.holes), s.zTop - s.zBottom),
              ]),
            ]),
          ),
          $,
          enumOf('FLOOR'),
        );
        const u = usage.get(`${e.typeId}\u0000`) ?? {
          set: add(
            'IFCMATERIALLAYERSETUSAGE',
            materialSets.get(e.typeId)!,
            enumOf('AXIS3'),
            enumOf('POSITIVE'),
            real(0),
            $,
          ),
          objects: [],
        };
        u.objects.push(ref);
        usage.set(`${e.typeId}\u0000`, u);
        constraints.push(
          ...heightRefs('Top', e.top),
          ...loopRefs('Boundary', e.boundary),
          ...e.holes.flatMap((h, i) => loopRefs(`Hole${i + 1}`, h)),
        );
        break;
      }
      case 'column': {
        const s = shape as Extract<BimShape, { kind: 'column' }>;
        const x: Vec2 = [Math.cos(s.rotationRad), Math.sin(s.rotationRad)];
        const frame: Frame = { o: [s.at[0], s.at[1], s.zBase], x };
        let solid = extrude(parametricProfile(e.typeId, s.profile), s.zTop - s.zBase);
        if (e.clipBy) solid = clipByRoof(solid, frame, e.clipBy);
        // IfcGridPlacement would be the standard form, but IFC4 readers do not agree on it
        // (IfcOpenShell 0.9 cannot place it); the grid intersection is kept in EP_Constraints.
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.column.entity,
          ...elementHead(
            e,
            placement,
            productShape([shapeRep(body, 'Body', e.clipBy ? 'Clipping' : 'SweptSolid', [solid])]),
          ),
          $,
          enumOf('COLUMN'),
        );
        const u = usage.get(`${e.typeId}\u0000`) ?? {
          set: add('IFCMATERIALPROFILESETUSAGE', materialSets.get(e.typeId)!, int(5), $),
          objects: [],
        };
        u.objects.push(ref);
        usage.set(`${e.typeId}\u0000`, u);
        constraints.push(
          ...pointRefs('At', e.at),
          ['Rotation', angle(e.rotationRad)],
          ...heightRefs('Base', e.base),
          ...topRefs(e.top),
        );
        if (e.clipBy) constraints.push(['ClipBy', ident(e.clipBy)]);
        break;
      }
      case 'beam': {
        const s = shape as Extract<BimShape, { kind: 'beam' }>;
        const d = unit(sub(s.end, s.start));
        const n = left(d);
        const zAxis = s.zTop - profileHeight(s.profile) / 2;
        const placement = add(
          'IFCLOCALPLACEMENT',
          storeys.get(levelId)!.placement,
          placement3([s.start[0], s.start[1], zAxis - storeyZ], n, [d[0], d[1], 0]),
        );
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.beam.entity,
          ...elementHead(
            e,
            placement,
            productShape([
              shapeRep(body, 'Body', 'SweptSolid', [
                extrude(parametricProfile(e.typeId, s.profile), Math.hypot(...sub(s.end, s.start))),
              ]),
            ]),
          ),
          $,
          enumOf('BEAM'),
        );
        const u = usage.get(`${e.typeId}\u0000`) ?? {
          set: add('IFCMATERIALPROFILESETUSAGE', materialSets.get(e.typeId)!, int(5), $),
          objects: [],
        };
        u.objects.push(ref);
        usage.set(`${e.typeId}\u0000`, u);
        constraints.push(
          ...pointRefs('Start', e.start),
          ...pointRefs('End', e.end),
          ...heightRefs('Top', e.top),
        );
        break;
      }
      case 'roof': {
        const s = shape as Extract<BimShape, { kind: 'roof' }>;
        const frame: Frame = { o: [0, 0, s.zBase], x: [1, 0] };
        const solids: P21Value[] = [];
        let type = 'SweptSolid';
        if (s.faces[0].slope === 0) solids.push(extrude(loopProfile(s.boundary), s.thicknessMm));
        else {
          // Each plane over its part of the plan (the whole boundary for a mono-pitch roof): a
          // prism cut above by its top and below by its underside.
          for (const f of s.faces) {
            const { under, top } = facePlanes(s, f);
            const area: BimLoop = f.region ?? s.boundary;
            // How far the part reaches up the slope, exact on arcs.
            const highest = loopExtreme(area, [-f.direction[0], -f.direction[1]]);
            const reach = dot(sub(highest, f.origin), f.direction);
            const height = f.slope * reach + s.thicknessMm * Math.sqrt(1 + f.slope * f.slope) + 10;
            const prism = extrude(loopProfile(area), height + 10, placement3([0, 0, -10]));
            solids.push(clipAbove(clipAbove(prism, frame, top), frame, flip(under)));
          }
          type = 'Clipping';
        }
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.roof.entity,
          ...elementHead(e, placement, productShape([shapeRep(body, 'Body', type, solids)])),
          $,
          enumOf(roofTypes[s.form]),
        );
        const u = usage.get(`${e.typeId}\u0000`) ?? {
          set: add(
            'IFCMATERIALLAYERSETUSAGE',
            materialSets.get(e.typeId)!,
            enumOf('AXIS3'),
            enumOf('POSITIVE'),
            real(0),
            $,
          ),
          objects: [],
        };
        u.objects.push(ref);
        usage.set(`${e.typeId}\u0000`, u);
        constraints.push(...heightRefs('Base', e.base), ...loopRefs('Boundary', e.boundary), [
          'Form',
          typed('IFCLABEL', str(e.shape.form)),
        ]);
        if (e.shape.form !== 'flat') constraints.push(['Slope', angle(e.shape.slopeRad)]);
        if (e.shape.form === 'mono') constraints.push(['Direction', angle(e.shape.directionRad)]);
        if (e.shape.form === 'gable') constraints.push(['Ridge', angle(e.shape.ridgeRad)]);
        break;
      }
      case 'space': {
        const s = shape as Extract<BimShape, { kind: 'space' }>;
        const frame: Frame = { o: [0, 0, s.zBase], x: [1, 0] };
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.space.entity,
          gid(e.id, e.ifcGlobalId),
          $,
          label(e.number),
          $,
          $,
          placement,
          productShape([
            shapeRep(body, 'Body', 'SweptSolid', [
              extrude(loopProfile(s.boundary), s.zTop - s.zBase),
            ]),
          ]),
          opt(e.name, label),
          enumOf('ELEMENT'),
          enumOf('NOTDEFINED'),
          $,
        );
        constraints.push(
          ...heightRefs('Base', e.base),
          ...topRefs(e.top),
          ...loopRefs('Boundary', e.boundary),
        );
        const list = spaces.get(levelId) ?? [];
        list.push(ref);
        spaces.set(levelId, list);
        break;
      }
      case 'part': {
        const s = shape as Extract<BimShape, { kind: 'part' }>;
        const mesh = options.parts!.get(e.id)!;
        const frame: Frame = {
          o: [s.at[0], s.at[1], s.zBase],
          x: [Math.cos(s.rotationRad), Math.sin(s.rotationRad)],
        };
        const points: P21Value[] = [];
        for (let i = 0; i < mesh.positions.length; i += 3)
          points.push(pt3(mesh.positions.slice(i, i + 3)));
        // A shell must be connected: each body of the mesh becomes its own shell.
        const shell = (body: number[], inward = false) =>
          add(
            mesh.kind === 'solid' || mesh.closed ? 'IFCCLOSEDSHELL' : 'IFCOPENSHELL',
            list(
              body.map((i) =>
                add(
                  'IFCFACE',
                  list([
                    add(
                      'IFCFACEOUTERBOUND',
                      add(
                        'IFCPOLYLOOP',
                        list(
                          (inward ? [0, 2, 1] : [0, 1, 2]).map(
                            (k) => points[mesh.triangles[i + k]],
                          ),
                        ),
                      ),
                      bool(true),
                    ),
                  ]),
                ),
              ),
            ),
          );
        // A cavity is cut from the body around it (CSG): IfcOpenShell 0.9 cannot build an
        // IfcFacetedBrepWithVoids, so it could not be checked independently. The cavity's
        // shell is turned to face outwards as a solid of its own.
        const bodies = mesh.kind === 'solid' ? solids.get(e.id)! : [];
        const csg = bodies.some((b) => b.voids.length > 0);
        /** The look of a triangle (an offset into `triangles`), when the mesh has looks. */
        const lookOf = (t: number) => {
          const i = mesh.triangleStyles?.[t / 3];
          const look = i === undefined ? undefined : mesh.styles?.[i];
          return look && /^#[0-9a-f]{6}$/i.test(look.color) ? look : undefined;
        };
        const styled = (item: P21Value, t: number) => {
          const look = lookOf(t);
          if (look) add('IFCSTYLEDITEM', item, list([surfaceStyle(look)]), $);
          return item;
        };
        // A sheet's shells are grouped by look, one surface model each.
        const sheets = new Map<string, { first: number; shells: number[][] }>();
        if (mesh.kind !== 'solid')
          for (const b of meshBodies(mesh)) {
            const look = lookOf(b[0]);
            const k = look ? lookKey(look) : '';
            const group = sheets.get(k) ?? { first: b[0], shells: [] };
            group.shells.push(b);
            sheets.set(k, group);
          }
        const items =
          mesh.kind !== 'solid'
            ? [...sheets.values()].map((g) =>
                styled(
                  add('IFCSHELLBASEDSURFACEMODEL', list(g.shells.map((b) => shell(b)))),
                  g.first,
                ),
              )
            : !csg
              ? bodies.map((b) => styled(add('IFCFACETEDBREP', shell(b.outer)), b.outer[0]))
              : [
                  bodies
                    .map((b) =>
                      b.voids.reduce(
                        (solid, v) =>
                          add(
                            'IFCBOOLEANRESULT',
                            enumOf('DIFFERENCE'),
                            solid,
                            add('IFCFACETEDBREP', shell(v, true)),
                          ),
                        add('IFCFACETEDBREP', shell(b.outer)),
                      ),
                    )
                    .reduce((all, b) => add('IFCBOOLEANRESULT', enumOf('UNION'), all, b)),
                ].map((item) => styled(item, bodies[0]!.outer[0]!));
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.part.entity,
          ...elementHead(
            e,
            placement,
            productShape([
              shapeRep(
                body,
                'Body',
                mesh.kind !== 'solid' ? 'SurfaceModel' : csg ? 'CSG' : 'Brep',
                items,
              ),
            ]),
          ),
          $,
          enumOf('NOTDEFINED'),
        );
        const t = ctx.types.get(e.typeId) as Extract<BimType, { kind: 'part' }>;
        relDefines(`partref\u0000${e.id}`, [ref], partReference(e.id, t.source, mesh.deflectionMm));
        constraints.push(
          ...pointRefs('At', e.at),
          ['Rotation', angle(e.rotationRad)],
          ...heightRefs('Base', e.base),
        );
        break;
      }
      case 'opening': {
        const host = ctx.elements.get(e.hostId)!;
        let solid: P21Value;
        if ('wall' in e) {
          const hs = shapeOf(host.id) as Extract<BimShape, { kind: 'wall' }>;
          const a = wallAxis(host as BimWall);
          const frame: Frame = { o: [a.s[0], a.s[1], hs.zBase], x: a.x };
          solid = extrude(
            loopProfile(
              loopToLocal(frame, wallOpeningLoop(host as BimWall, e.wall.alongMm, e.wall.widthMm)),
            ),
            e.wall.heightMm,
            placement3([0, 0, e.wall.sillMm]),
          );
        } else {
          const hs = shapeOf(host.id) as Extract<BimShape, { kind: 'slab' }>;
          solid = extrude(
            loopProfile(e.slab.boundary),
            hs.zTop - hs.zBottom + 20,
            placement3([0, 0, -10]),
          );
        }
        const placement = add('IFCLOCALPLACEMENT', placements.get(host.id)!, placement3([0, 0, 0]));
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.opening.entity,
          ...elementHead(
            e,
            placement,
            productShape([shapeRep(body, 'Body', 'SweptSolid', [solid])]),
          ),
          $,
          enumOf('OPENING'),
        );
        add(
          'IFCRELVOIDSELEMENT',
          auxGid(`void\u0000${e.id}`),
          $,
          $,
          $,
          elementRefs.get(host.id)!,
          ref,
        );
        constraints.push(
          ...('wall' in e
            ? ([
                ['Along', length(e.wall.alongMm)],
                ['Sill', length(e.wall.sillMm)],
                ['Width', length(e.wall.widthMm)],
                ['Height', length(e.wall.heightMm)],
              ] as [string, P21Value][])
            : loopRefs('Boundary', e.slab.boundary)),
        );
        break;
      }
      case 'door':
      case 'window': {
        const host = ctx.elements.get(e.hostId) as BimWall;
        const hs = shapeOf(host.id) as Extract<BimShape, { kind: 'wall' }>;
        const t = ctx.types.get(e.typeId) as Extract<BimType, { kind: 'door' | 'window' }>;
        const sill = e.kind === 'window' ? e.sillMm : 0;
        const a = wallAxis(host);
        const hostFrame: Frame = { o: [a.s[0], a.s[1], hs.zBase], x: a.x };
        // The opening the door or window fills.
        const opening = add(
          bimIfcKinds.opening.entity,
          auxGid(`opening\u0000${e.id}`),
          $,
          // IfcLabel holds 255 characters; the host's name is shortened to fit the suffix.
          label(`${[...(e.name ?? e.id)].slice(0, 255 - ' opening'.length).join('')} opening`),
          $,
          $,
          add('IFCLOCALPLACEMENT', placements.get(host.id)!, placement3([0, 0, 0])),
          productShape([
            shapeRep(body, 'Body', 'SweptSolid', [
              extrude(
                loopProfile(loopToLocal(hostFrame, wallOpeningLoop(host, e.alongMm, t.widthMm))),
                t.heightMm,
                placement3([0, 0, sill]),
              ),
            ]),
          ]),
          $,
          enumOf('OPENING'),
        );
        add(
          'IFCRELVOIDSELEMENT',
          auxGid(`void\u0000${e.id}`),
          $,
          $,
          $,
          elementRefs.get(host.id)!,
          opening,
        );
        // The panel stands on the wall's axis, facing along the tangent at the opening's start.
        const [p, tangent] = a.at(e.alongMm);
        const x = e.flipFacing ? ([-tangent[0], -tangent[1]] as Vec2) : tangent;
        const origin: Vec2 = e.flipFacing
          ? [p[0] + tangent[0] * t.widthMm, p[1] + tangent[1] * t.widthMm]
          : p;
        const mid = (a.leftOff + a.rightOff) / 2;
        const n = left(tangent);
        const frame: Frame = {
          o: [origin[0] + n[0] * mid, origin[1] + n[1] * mid, hs.zBase + sill],
          x,
        };
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        const mapped = add(
          'IFCMAPPEDITEM',
          typeMaps.get(e.typeId)!,
          add('IFCCARTESIANTRANSFORMATIONOPERATOR3D', $, $, origin3, $, $),
        );
        const head = elementHead(
          e,
          placement,
          productShape([shapeRep(body, 'Body', 'MappedRepresentation', [mapped])]),
        );
        ref =
          e.kind === 'door'
            ? add(
                bimIfcKinds.door.entity,
                ...head,
                $,
                real(t.heightMm),
                real(t.widthMm),
                enumOf('DOOR'),
                enumOf('NOTDEFINED'),
                $,
              )
            : add(
                bimIfcKinds.window.entity,
                ...head,
                $,
                real(t.heightMm),
                real(t.widthMm),
                enumOf('WINDOW'),
                enumOf('NOTDEFINED'),
                $,
              );
        add('IFCRELFILLSELEMENT', auxGid(`fill\u0000${e.id}`), $, $, $, opening, ref);
        constraints.push(
          ['Along', length(e.alongMm)],
          ['FlipFacing', typed('IFCBOOLEAN', bool(e.flipFacing))],
        );
        if (e.kind === 'door')
          constraints.push(['FlipHand', typed('IFCBOOLEAN', bool(e.flipHand))]);
        else constraints.push(['Sill', length(e.sillMm)]);
        break;
      }
    }
    elementRefs.set(e.id, ref);
    if (e.kind === 'wall' && e.clipBy) constraints.push(['ClipBy', ident(e.clipBy)]);
    if (e.kind !== 'space' && e.kind !== 'opening') contain(levelId, ref);
    if ('typeId' in e && typeRefs.has(e.typeId)) {
      const list = byType.get(e.typeId) ?? [];
      list.push(ref);
      byType.set(e.typeId, list);
    }
    describedSets(e.id, bimIfcKinds[e.kind].pset, e).forEach((set, i) =>
      relDefines(`el\u0000${e.id}\u0000set\u0000${i}`, [ref], set),
    );
    relDefines(`el\u0000${e.id}\u0000constraints`, [ref], constraintSet(e.id, constraints));
    const q = quantities(e);
    if (q) quantitySets.push([e.id, ref, q]);
  }
  for (const [id, ref, q] of quantitySets) relDefines(`qto\u0000${id}`, [ref], q);

  // Joins.
  doc.joins.forEach((j) => {
    const [a, b] = j.walls.map((id) => ctx.elements.get(id) as BimWall);
    const connection = (wall: BimWall, other: BimWall) => {
      const o = wallAxis(other);
      const onOther = (p: Vec2) => {
        const t = dot(sub(p, o.s), o.x);
        const off = Math.abs(dot(sub(p, o.s), left(o.x)));
        return off <= 1 && t >= -1 && t <= o.length + 1;
      };
      const me = wallAxis(wall);
      return onOther(me.s) ? 'ATSTART' : onOther(me.e) ? 'ATEND' : 'ATPATH';
    };
    // Without `through`, the same wall derivation runs through (a T's crossed wall, else the first).
    const through = bimJoinThrough(doc, j);
    const [relating, related] = through === b.id ? [b, a] : [a, b];
    add(
      'IFCRELCONNECTSPATHELEMENTS',
      gid(j.id),
      $,
      label(j.kind),
      label(j.id),
      $,
      elementRefs.get(relating.id)!,
      elementRefs.get(related.id)!,
      list(through ? [int(1)] : []),
      list(through ? [int(0)] : []),
      enumOf(connection(related, relating)),
      enumOf(connection(relating, related)),
    );
  });

  // Document data without an IFC entity: on the project, one complex property per item.
  const complex = (name: string, usage: string, props: [string, P21Value][]) =>
    add('IFCCOMPLEXPROPERTY', label(name), $, label(usage), list(props.map(property)));
  const projectSet = (name: string, props: P21Value[]) =>
    relDefines(
      `project\u0000${name}`,
      [project],
      // NUL keeps the key apart from element IDs, which key element property sets.
      propertySet(`project\u0000`, name, props),
    );
  projectSet('EP_Constraints', [single('TrueNorth', angle(north))]);
  const labelValue = (v: string) => textValue('IFCLABEL', v);
  if (doc.grids.length)
    projectSet(
      'EP_Grids',
      doc.grids.map((a) =>
        complex(a.id, 'GridAxis', [
          ['Label', labelValue(a.label)],
          ['StartX', length(a.start[0])],
          ['StartY', length(a.start[1])],
          ['EndX', length(a.end[0])],
          ['EndY', length(a.end[1])],
        ]),
      ),
    );
  if (doc.joins.length)
    projectSet(
      'EP_Joins',
      doc.joins.map((j) =>
        complex(j.id, 'Join', [
          ['Kind', typed('IFCLABEL', str(j.kind))],
          ['WallA', ident(j.walls[0])],
          ['WallB', ident(j.walls[1])],
          ...(j.through === undefined ? [] : [['Through', ident(j.through)] as [string, P21Value]]),
        ]),
      ),
    );
  if (doc.views.length)
    projectSet(
      'EP_Views',
      doc.views.map((v) =>
        complex(v.id, 'View', [
          ['Kind', typed('IFCLABEL', str(v.kind))],
          ['Name', labelValue(v.name)],
          ...(v.kind === 'plan'
            ? ([
                ['Level', ident(globalIds.get(v.level)!)],
                ['CutHeight', length(v.cutHeightMm)],
              ] as [string, P21Value][])
            : ([
                ['StartX', length(v.line[0][0])],
                ['StartY', length(v.line[0][1])],
                ['EndX', length(v.line[1][0])],
                ['EndY', length(v.line[1][1])],
                ['Direction', typed('IFCLABEL', str(v.direction))],
              ] as [string, P21Value][])),
          ['Depth', length(v.depthMm)],
          ['Scale', typed('IFCINTEGER', int(v.scale))],
        ]),
      ),
    );
  for (const [setId, sets] of setUses)
    add(
      'IFCRELDEFINESBYTEMPLATE',
      auxGid(`template\u0000${setId}`),
      $,
      $,
      $,
      list(sets),
      templates.get(setId)!,
    );

  // Relations.
  for (const [typeId, objects] of byType)
    add(
      'IFCRELDEFINESBYTYPE',
      auxGid(`type\u0000${typeId}`),
      $,
      $,
      $,
      list(objects),
      typeRefs.get(typeId)!,
    );
  [...usage.entries()].forEach(([key, u]) =>
    add('IFCRELASSOCIATESMATERIAL', auxGid(`usage\u0000${key}`), $, $, $, list(u.objects), u.set),
  );
  for (const l of ctx.sortedLevels) {
    const s = storeys.get(l.id)!;
    relDefines(
      `level\u0000${l.id}`,
      [s.ref],
      constraintSet(`level\u0000${l.id}`, [['BimId', ident(l.id)]]),
    );
    const sp = spaces.get(l.id);
    if (sp) add('IFCRELAGGREGATES', auxGid(`agg\u0000${l.id}`), $, $, $, s.ref, list(sp));
    const c = contained.get(l.id);
    if (c)
      add('IFCRELCONTAINEDINSPATIALSTRUCTURE', auxGid(`in\u0000${l.id}`), $, $, $, list(c), s.ref);
  }

  const text = w.text({
    description: ['ViewDefinition [DesignTransferView]'],
    implementationLevel: '2;1',
    name: options.fileName ?? `${doc.project.name}.ifc`,
    timeStamp: options.timeStamp,
    author: [''],
    organization: [''],
    preprocessorVersion: 'EditorPlatform bim-ifc',
    originatingSystem: 'EditorPlatform',
    authorization: '',
    schemas: ['IFC4'],
  });
  return { text, bytes: new TextEncoder().encode(text), globalIds, entityCount: w.count };
}

/**
 * The file's shapes without what only the Host has (kernel quantities, part meshes): for the
 * import's check that restored elements give the shapes their file holds. Part bodies are empty.
 */
export function writeIfcShapes(doc: BimDocument): BimIfcExport {
  const empty: BimIfcPartMesh = {
    kind: 'sheet',
    closed: false,
    positions: [],
    triangles: [],
    deflectionMm: 0,
  };
  return writeIfc(doc, {
    artifactId: 'shapes',
    timeStamp: '',
    kernelQuantities: new Map(doc.elements.map((e) => [e.id, {}])),
    parts: new Map(doc.elements.filter((e) => e.kind === 'part').map((e) => [e.id, empty])),
  });
}
