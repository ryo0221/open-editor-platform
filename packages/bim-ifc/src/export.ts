import {
  arcOf,
  arcPoint,
  BimContext,
  bimPanelMm,
  bimRoofPlanes,
  bimSlabPlanes,
  bimWallAxis,
  bimWallOpeningLoop,
  bimWallOpeningRise,
  bimSectionAxes,
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
  /** #663: the finish (0–1 each), written as the rendering's specular roughness and method. */
  roughness?: number;
  metalness?: number;
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
const lookKey = (look: BimIfcPartStyle) =>
  `${look.color.toLowerCase()} ${look.opacity} ${look.roughness ?? ''} ${look.metalness ?? ''}`;
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
  /** #663: what the file does not carry (texture maps), for the user. */
  losses: string[];
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
  member: {
    entity: 'IFCMEMBER',
    type: 'IFCMEMBERTYPE',
    pset: 'Pset_MemberCommon',
    qto: 'Qto_MemberBaseQuantities',
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
  // LR3: a spiral ramp. Its type is a slab type, which IfcRamp may not be typed by: the type
  // goes in EP_Constraints, the layers as the slab's. IFC4 has no quantity set for a ramp.
  ramp: { entity: 'IFCRAMP', type: '', pset: 'Pset_RampCommon', qto: '' },
  // LS5: a railing along a ramp's edge. Its type is a wall type (the band's layers), which
  // IfcRailing may not be typed by: the type goes in EP_Constraints, as a ramp's.
  // LS6: a straight flight. Its type is a slab type (the waist), which IfcStair may not be
  // typed by: the type goes in EP_Constraints, as a ramp's. IFC4 has no quantity set for it.
  stair: { entity: 'IFCSTAIR', type: '', pset: 'Pset_StairCommon', qto: '' },
  railing: {
    entity: 'IFCRAILING',
    type: '',
    pset: 'Pset_RailingCommon',
    qto: 'Qto_RailingBaseQuantities',
  },
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
  member: {
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
  railing: { length: ['Length', 'L'] },
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

/**
 * LR3b: a ramp's tessellation, `n` steps round and `m` rings across. Radial lines every step
 * keep the arcs within 0.1 mm of their circles; the rings keep each twisted cell within 0.5 mm
 * of its two triangles.
 */
function rampGrid(s: Extract<BimShape, { kind: 'ramp' | 'railing' }>): [number, number] {
  const { innerRadius: r, outerRadius: R, sweep } = s;
  const step = 2 * Math.acos(1 - Math.min(0.1 / R, 1));
  const n = Math.max(8, Math.ceil(Math.abs(sweep) / step));
  const dTheta = Math.abs(sweep) / n;
  const pitch = Math.abs(s.zEnd - s.zStart) / Math.abs(sweep);
  const m = Math.max(1, Math.ceil(((R - r) * dTheta * pitch) / (2 * Math.hypot(r, pitch))));
  return [n, m];
}
/** The most points one ramp's face set may have (about 2.4 MB of IFC per 100,000). */
export const bimIfcRampPointBudget = 500_000;

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
  // A ramp whose tessellation would exceed the budget is refused before anything is allocated.
  const dense = doc.elements.filter((e) => {
    const s = e.kind === 'ramp' || e.kind === 'railing' ? shapeOf(e.id) : undefined;
    if (s?.kind !== 'ramp' && s?.kind !== 'railing') return false;
    const [n, m] = rampGrid(s);
    return (n + 1) * (m + 1) * 2 > bimIfcRampPointBudget;
  });
  if (dense.length)
    throw new BimIfcExportError(
      'ramp-too-detailed',
      dense.map((e) => e.id),
    );

  const w = new P21Writer();
  const add = (name: string, ...args: P21Value[]) => w.add(name, args);
  const losses = new Set<string>();
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
  const placement3 = (o: Vec3, x?: Vec2 | Vec3, z?: Vec3) => {
    const isOrigin = o[0] === 0 && o[1] === 0 && o[2] === 0;
    const plainX = !x || (x[0] === 1 && x[1] === 0 && !x[2]);
    const x3 = x && dir3([x[0], x[1], x[2] ?? 0]);
    return add(
      'IFCAXIS2PLACEMENT3D',
      isOrigin ? origin3 : pt3(o),
      z ? dir3(z) : plainX ? $ : zUp,
      z ? x3! : plainX ? $ : x3!,
    );
  };
  const worldPlacement = add('IFCAXIS2PLACEMENT3D', origin3, $, $);
  /**
   * One surface style per look (OH-U1), seen from both sides as a sheet is. #663: an
   * `IfcSurfaceStyleRendering` (a shading, for readers that know no more): the colour and
   * transparency, and a finish as the specular roughness and a metal or plastic reflectance,
   * the specular colour being the surface colour for a metal and a 4% grey otherwise.
   */
  const surfaceStyles = new Map<string, P21Value>();
  const surfaceStyle = (look: BimIfcPartStyle, name = look.color.toLowerCase()) => {
    const k = `${lookKey(look)} ${name}`;
    let style = surfaceStyles.get(k);
    if (!style) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(look.color.slice(i, i + 2), 16) / 255);
      const finish = look.roughness !== undefined || look.metalness !== undefined;
      const metal = (look.metalness ?? 0) >= 0.5;
      style = add(
        'IFCSURFACESTYLE',
        str(name),
        enumOf('BOTH'),
        list([
          add(
            'IFCSURFACESTYLERENDERING',
            add('IFCCOLOURRGB', $, real(r!), real(g!), real(b!)),
            real(1 - Math.min(1, Math.max(0, look.opacity))),
            $,
            $,
            $,
            $,
            finish
              ? metal
                ? typed('IFCNORMALISEDRATIOMEASURE', real(1))
                : add('IFCCOLOURRGB', $, real(0.04), real(0.04), real(0.04))
              : $,
            finish
              ? typed(
                  'IFCSPECULARROUGHNESS',
                  real(Math.min(1, Math.max(0, look.roughness ?? 0.55))),
                )
              : $,
            enumOf(finish ? (metal ? 'METAL' : 'PLASTIC') : 'NOTDEFINED'),
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
    // LS6: properties of the common set the element's shape gives (a stair's steps), in the
    // same set as its common ones: a set's name is unique on an object (Codex).
    shaped: P21Value[] = [],
  ) => {
    const out: P21Value[] = [];
    const c = d.common;
    if ((c || shaped.length) && commonName) {
      const props: P21Value[] = [...shaped];
      if (c?.reference !== undefined)
        props.push(single('Reference', typed('IFCIDENTIFIER', str(c.reference))));
      if (c?.isExternal !== undefined)
        props.push(single('IsExternal', typed('IFCBOOLEAN', bool(c.isExternal))));
      if (c?.loadBearing !== undefined)
        props.push(single('LoadBearing', typed('IFCBOOLEAN', bool(c.loadBearing))));
      if (c?.fireRating !== undefined)
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
    const ref = profileDef(p, label(ctx.types.get(typeId)!.name));
    profiles.set(typeId, ref);
    return ref;
  };
  /** A profile's parameterized definition, centred on its origin. */
  const profileDef = (p: BimProfile, name: P21Value) => {
    const ref =
      p.shape === 'rect'
        ? add('IFCRECTANGLEPROFILEDEF', enumOf('AREA'), name, $, real(p.widthMm), real(p.depthMm))
        : p.shape === 'circle'
          ? add('IFCCIRCLEPROFILEDEF', enumOf('AREA'), name, $, real(p.diameterMm / 2))
          : p.shape === 'pipe'
            ? add(
                'IFCCIRCLEHOLLOWPROFILEDEF',
                enumOf('AREA'),
                name,
                $,
                real(p.diameterMm / 2),
                real(p.wallMm),
              )
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
    return ref;
  };
  const extrude = (profile: P21Value, depth: number, position?: P21Value) =>
    add('IFCEXTRUDEDAREASOLID', profile, position ?? $, zUp, real(depth));
  /**
   * LR2b: a leaning wall's body in its local frame (`base` and `top` its footprints there, `h`
   * its height). A top that is the base moved is a slanted `IfcExtrudedAreaSolid`; an arc wall
   * whose ends point at its centre (a cone) the section revolved about the centre's vertical
   * (`IfcRevolvedAreaSolid`); any other an `IfcTriangulatedFaceSet` of the ruled faces. FU3b:
   * an opening's cut through a leaning wall too, its sweep from `from`.
   */
  const leanBody = (
    base: BimLoop,
    top: BimLoop,
    h: number,
    center: Vec2 | undefined,
    sweep: number,
    from: Vec2 = [0, 0],
  ): { item: P21Value; type: string } => {
    const d: Vec2 = [top[0]![0] - base[0]![0], top[0]![1] - base[0]![1]];
    const moved = base.every(
      (v, i) =>
        Math.abs(top[i]![0] - v[0] - d[0]) <= 1e-6 &&
        Math.abs(top[i]![1] - v[1] - d[1]) <= 1e-6 &&
        Math.abs((top[i]![2] ?? 0) - (v[2] ?? 0)) <= 1e-12,
    );
    if (moved) {
      const len = Math.hypot(d[0], d[1], h);
      return {
        item: add(
          'IFCEXTRUDEDAREASOLID',
          loopProfile(base),
          $,
          dir3([d[0] / len, d[1] / len, h / len]),
          real(len),
        ),
        type: 'SweptSolid',
      };
    }
    // A cone: every straight edge on a ray from the centre, at base and top.
    const radial = (l: BimLoop) =>
      l.every((v, i) => {
        if (v[2]) return true;
        const w = l[(i + 1) % l.length]!;
        const [p, q] = [sub([v[0], v[1]], center!), sub([w[0], w[1]], center!)];
        return Math.abs(cross(p, q)) <= 1e-9 * Math.hypot(...p) * Math.hypot(...q) && dot(p, q) > 0;
      });
    // LS2: and the same angles at base and top (an upright arc wall whose ends follow a leaning
    // wall's face turns them, and is written as triangles).
    const sameAngles = (center: Vec2) =>
      base.every((v, i) => {
        const w = top[i]!;
        const a = Math.atan2(v[1] - center[1], v[0] - center[0]);
        const b = Math.atan2(w[1] - center[1], w[0] - center[0]);
        return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= 1e-9;
      });
    if (center && radial(base) && radial(top) && sameAngles(center)) {
      const radii = (l: BimLoop) => {
        const r = l.map((v) => Math.hypot(v[0] - center[0], v[1] - center[1]));
        return [Math.min(...r), Math.max(...r)];
      };
      const [b0, b1] = radii(base);
      const [t0, t1] = radii(top);
      // From the axis's start (the frame's origin, or `from`) round the sweep, counter-clockwise.
      const start = Math.atan2(from[1] - center[1], from[0] - center[0]) + Math.min(0, sweep);
      const [c, s] = [Math.cos(start), Math.sin(start)];
      return {
        item: add(
          'IFCREVOLVEDAREASOLID',
          loopProfile([
            [b0!, 0],
            [b1!, 0],
            [t1!, h],
            [t0!, h],
          ]),
          add(
            'IFCAXIS2PLACEMENT3D',
            pt3([center[0], center[1], 0]),
            dir3([s, -c, 0]),
            dir3([c, s, 0]),
          ),
          add('IFCAXIS1PLACEMENT', origin3, dir3([0, 1, 0])),
          real(Math.abs(sweep)),
        ),
        type: 'SweptSolid',
      };
    }
    // The ruled faces as triangles: arcs sampled alike at base and top, a twisted side quad
    // split into an 8 × 8 grid of its bilinear surface. LS2: an arc's sweep may differ between
    // base and top (an upright arc wall whose end follows a leaning face), so each pair of edges
    // takes the larger count (Codex).
    const arcAt = (l: BimLoop, i: number) => {
      const [v, w] = [l[i]!, l[(i + 1) % l.length]!];
      return v[2] ? arcOf([v[0], v[1]], [w[0], w[1]], v[2]) : undefined;
    };
    const counts = base.map((_, i) =>
      Math.max(
        1,
        ...[arcAt(base, i), arcAt(top, i)].map((a) =>
          a ? Math.ceil(Math.abs(a.sweep) / 0.01) : 1,
        ),
      ),
    );
    const sample = (l: BimLoop) =>
      l.flatMap((v, i): Vec2[] => {
        const arc = arcAt(l, i);
        const n = counts[i]!;
        if (!arc) {
          const w = l[(i + 1) % l.length]!;
          // A straight edge whose other is an arc: points along it, as many.
          return Array.from(
            { length: n },
            (_, k): Vec2 => [v[0] + ((w[0] - v[0]) * k) / n, v[1] + ((w[1] - v[1]) * k) / n],
          );
        }
        return Array.from({ length: n }, (_, k) => arcPoint(arc, k / n));
      });
    const [pb, pt] = [sample(base), sample(top)];
    const coords: P21Value[] = [];
    const index = new Map<string, number>();
    const at = (p: Vec3) => {
      const q = p.map((c) => Math.round(c * 1000) / 1000);
      const key = q.join();
      let k = index.get(key);
      if (k === undefined) {
        coords.push(reals(q));
        index.set(key, (k = coords.length));
      }
      return k;
    };
    const triangles: P21Value[] = [];
    const tri = (a: Vec3, b: Vec3, c: Vec3) => triangles.push(list([at(a), at(b), at(c)].map(int)));
    const cap = (pts: Vec2[], z: number, up: boolean) => {
      for (const [a, b, c] of earClip(pts)) {
        const [p, q, r] = [a, b, c].map((v) => [v[0], v[1], z] as Vec3);
        if (up) tri(p!, q!, r!);
        else tri(p!, r!, q!);
      }
    };
    cap(pb, 0, false);
    cap(pt, h, true);
    const n = pb.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const corner = (u: number, v: number): Vec3 => {
        const lo = [
          pb[i]![0] + (pb[j]![0] - pb[i]![0]) * u,
          pb[i]![1] + (pb[j]![1] - pb[i]![1]) * u,
        ];
        const hi = [
          pt[i]![0] + (pt[j]![0] - pt[i]![0]) * u,
          pt[i]![1] + (pt[j]![1] - pt[i]![1]) * u,
        ];
        return [lo[0]! + (hi[0]! - lo[0]!) * v, lo[1]! + (hi[1]! - lo[1]!) * v, h * v];
      };
      const twist = cross(sub(pb[j]!, pb[i]!), sub(pt[j]!, pt[i]!));
      const m = Math.abs(twist) > 1e-9 * Math.hypot(...sub(pb[j]!, pb[i]!)) ** 2 ? 8 : 1;
      for (let a = 0; a < m; a++)
        for (let b = 0; b < m; b++) {
          const [p00, p10, p01, p11] = [
            corner(a / m, b / m),
            corner((a + 1) / m, b / m),
            corner(a / m, (b + 1) / m),
            corner((a + 1) / m, (b + 1) / m),
          ];
          tri(p00, p10, p11);
          tri(p00, p11, p01);
        }
    }
    return {
      item: add(
        'IFCTRIANGULATEDFACESET',
        add('IFCCARTESIANPOINTLIST3D', list(coords)),
        $,
        bool(true),
        list(triangles),
        $,
      ),
      type: 'Tessellation',
    };
  };
  /**
   * LR3: a spiral ramp as one closed `IfcTriangulatedFaceSet`, about its centre (x, y) at its
   * own heights (z). Radial lines every step keep the arcs within 0.1 mm of their circles (so
   * the volume within 1e-5), and enough rings across that each twisted cell of the helicoid
   * lies within 0.5 mm of its two triangles. Top and underside are the same triangles 1
   * thickness apart, so the volume is the faceted plan area × the thickness.
   */
  const rampBody = (s: Extract<BimShape, { kind: 'ramp' | 'railing' }>) => {
    const { innerRadius: r, outerRadius: R, sweep, thickness: t } = s;
    const [n, m] = rampGrid(s);
    const coords: P21Value[] = [];
    const pts: Vec3[] = [];
    // Index (1-based) of the point at step i, ring j, top (0) or underside (1).
    const at = (i: number, j: number, k: 0 | 1) => 1 + ((i * (m + 1) + j) * 2 + k);
    for (let i = 0; i <= n; i++) {
      const a = s.startAngle + (sweep * i) / n;
      const z = s.zStart + ((s.zEnd - s.zStart) * i) / n;
      for (let j = 0; j <= m; j++) {
        const rho = r + ((R - r) * j) / m;
        for (const k of [0, 1] as const) {
          const p: Vec3 = [rho * Math.cos(a), rho * Math.sin(a), z - k * t];
          pts.push(p);
          coords.push(reals(p.map((c) => Math.round(c * 1000) / 1000)));
        }
      }
    }
    const tris: [number, number, number][] = [];
    const quad = (a: number, b: number, c: number, d: number) => tris.push([a, b, c], [a, c, d]);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < m; j++) {
        quad(at(i, j, 0), at(i, j + 1, 0), at(i + 1, j + 1, 0), at(i + 1, j, 0));
        quad(at(i, j, 1), at(i + 1, j, 1), at(i + 1, j + 1, 1), at(i, j + 1, 1));
      }
    for (let i = 0; i < n; i++) {
      quad(at(i, m, 0), at(i, m, 1), at(i + 1, m, 1), at(i + 1, m, 0));
      quad(at(i, 0, 0), at(i + 1, 0, 0), at(i + 1, 0, 1), at(i, 0, 1));
    }
    for (let j = 0; j < m; j++) {
      quad(at(0, j, 0), at(0, j, 1), at(0, j + 1, 1), at(0, j + 1, 0));
      quad(at(n, j, 0), at(n, j + 1, 0), at(n, j + 1, 1), at(n, j, 1));
    }
    // Outward for a counter-clockwise ramp; a clockwise one is its mirror image.
    let v = 0;
    for (const [a, b, c] of tris) {
      const [p, q, w] = [pts[a - 1]!, pts[b - 1]!, pts[c - 1]!];
      v +=
        p[0] * (q[1] * w[2] - q[2] * w[1]) -
        p[1] * (q[0] * w[2] - q[2] * w[0]) +
        p[2] * (q[0] * w[1] - q[1] * w[0]);
    }
    const flip = v < 0;
    return add(
      'IFCTRIANGULATEDFACESET',
      add('IFCCARTESIANPOINTLIST3D', list(coords)),
      $,
      bool(true),
      list(tris.map(([a, b, c]) => list((flip ? [a, c, b] : [a, b, c]).map(int)))),
      $,
    );
  };
  /**
   * TW5: a tapered extrusion. Its end is the same kind of profile with every size scaled (walls
   * too), centred on the same origin: one of the two ends IFC4 allows (`VaryingProfileShape`),
   * and the one IfcOpenShell 0.9 builds for a circle (it fails on a derived, scaled circle).
   */
  const taper = (
    profile: P21Value,
    p: BimProfile,
    depth: number,
    scale: number,
    position?: P21Value,
  ) => {
    const end = Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, typeof v === 'number' ? v * scale : v]),
    ) as BimProfile;
    return add(
      'IFCEXTRUDEDAREASOLIDTAPERED',
      profile,
      position ?? $,
      zUp,
      real(depth),
      profileDef(end, $),
    );
  };
  const shapeRep = (ctxRef: P21Value, id: string, type: string, items: P21Value[]) =>
    add('IFCSHAPEREPRESENTATION', ctxRef, label(id), label(type), list(items));
  const productShape = (reps: P21Value[]) => add('IFCPRODUCTDEFINITIONSHAPE', $, $, list(reps));
  /** Removes the half-space on the side `normal` points to (material on the other side). */
  /**
   * LS1: a clipping result's first operand must be swept (or clipped); a leaning wall written as
   * triangles is cut by a plain Boolean difference (`csg`).
   */
  const clipAbove = (operand: P21Value, frame: Frame, plane: Plane, csg = false) => {
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
      csg ? 'IFCBOOLEANRESULT' : 'IFCBOOLEANCLIPPINGRESULT',
      enumOf('DIFFERENCE'),
      operand,
      add('IFCHALFSPACESOLID', surface, bool(false)),
    );
  };
  const flip = (pl: Plane): Plane => ({ p: pl.p, n: [-pl.n[0], -pl.n[1], -pl.n[2]] });
  /**
   * A slab's body: its extrusion, or (TW5, sloped) an extrusion over the slope's whole rise cut
   * above by its top plane and below by its bottom plane.
   */
  const slabBody = (s: Extract<BimShape, { kind: 'slab' }>, frame: Frame, holes: BimLoop[]) => {
    const t = s.zTop - s.zBottom;
    if (!s.slope)
      return shapeRep(body, 'Body', 'SweptSolid', [extrude(loopProfile(s.boundary, holes), t)]);
    const { top, bottom, zLow, zHigh } = bimSlabPlanes(s);
    const z0 = zLow - t - 10 - s.zBottom;
    const prism = extrude(
      loopProfile(s.boundary, holes),
      zHigh + 10 - s.zBottom - z0,
      placement3([0, 0, z0]),
    );
    return shapeRep(body, 'Body', 'Clipping', [
      clipAbove(clipAbove(prism, frame, top), frame, flip(bottom)),
    ]);
  };
  const facePlanes = bimRoofPlanes;
  /** Cuts what lies above a roof's underside: above each of its planes in turn. */
  const clipByRoof = (solid: P21Value, frame: Frame, roofId: string, csg = false) => {
    const s = shapeOf(roofId) as Extract<BimShape, { kind: 'roof' }>;
    return s.faces.reduce((acc, f) => clipAbove(acc, frame, facePlanes(s, f).under, csg), solid);
  };

  // Materials.
  const materials = new Map(
    doc.materials.map((m) => {
      const ref = add('IFCMATERIAL', label(m.name), $, label(m.category));
      const look = m.appearance;
      add(
        'IFCMATERIALPROPERTIES',
        label('EP_Constraints'),
        $,
        list([
          single('BimId', ident(m.id)),
          // #663: the exact metalness, which the reflectance method only rounds.
          ...(look
            ? [single('Metalness', typed('IFCNORMALISEDRATIOMEASURE', real(look.metalness)))]
            : []),
          ...(look?.preset ? [single('Preset', ident(look.preset))] : []),
        ]),
        ref,
      );
      // #663: the material's look, as viewers colour what it makes.
      if (look) {
        if (look.textures)
          losses.add(
            `The texture maps of ${m.name} are not written: IFC keeps its colour and finish.`,
          );
        add(
          'IFCMATERIALDEFINITIONREPRESENTATION',
          $,
          $,
          list([
            add(
              'IFCSTYLEDREPRESENTATION',
              body,
              label('Style'),
              label('Material'),
              list([add('IFCSTYLEDITEM', $, list([surfaceStyle(look, m.name)]), $)]),
            ),
          ]),
          ref,
        );
      }
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
                        : t.kind === 'member'
                          ? 'BRACE'
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
  /** LS6: an element's common properties its shape gives, written with its common set. */
  const shapedCommon = new Map<string, P21Value[]>();
  const spaces = new Map<string, P21Value[]>();
  const levelOf = (e: BimElement): string | undefined => {
    switch (e.kind) {
      case 'slab':
      case 'beam':
        return e.top.level;
      case 'member':
        return e.start.height.level;
      case 'opening':
      case 'door':
      case 'window':
      case 'railing':
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
  /**
   * The cut an opening of a wall makes, in the wall's frame, and how high above the frame its
   * own placement stands: a prism from the sill up; FU3b, in a leaning wall, the plan region at
   * the sill swept to the head's along the lean (a slanted extrusion, or on a cone the section
   * revolved about the centre's vertical).
   */
  const wallOpeningCut = (
    wall: BimWall,
    frame: Frame,
    alongMm: number,
    widthMm: number,
    sillMm: number,
    heightMm: number,
  ): { solid: P21Value; z: number } => {
    if (!wall.lean)
      return {
        solid: extrude(
          loopProfile(loopToLocal(frame, wallOpeningLoop(wall, alongMm, widthMm))),
          heightMm,
          placement3([0, 0, sillMm]),
        ),
        z: 0,
      };
    const [z0, z1] = bimWallOpeningRise(wall, sillMm, heightMm);
    const at = (rise: number) =>
      loopToLocal(frame, bimWallOpeningLoop(ctx, wall, alongMm, widthMm, rise));
    const a = wallAxis(wall);
    const cut = leanBody(
      at(z0),
      at(z1),
      z1 - z0,
      a.arc && toLocal(frame, a.arc.center),
      a.arc ? (Math.sign(a.arc.sweep) * widthMm) / a.arc.radius : 0,
      toLocal(frame, a.at(alongMm)[0]),
    );
    return { solid: cut.item, z: z0 };
  };
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
        // LR2b: a leaning wall's body by its shape.
        const lean = s.footprintTop
          ? leanBody(
              loopToLocal(frame, s.footprint),
              loopToLocal(frame, s.footprintTop),
              s.zTop - s.zBase,
              a.arc && toLocal(frame, a.arc.center),
              a.arc?.sweep ?? 0,
            )
          : undefined;
        let solid =
          lean?.item ?? extrude(loopProfile(loopToLocal(frame, s.footprint)), s.zTop - s.zBase);
        // LS1: a roof cuts a leaning wall too; triangles by a Boolean difference.
        const csg = lean !== undefined && lean.type !== 'SweptSolid';
        if (e.clipBy) solid = clipByRoof(solid, frame, e.clipBy, csg);
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
              shapeRep(
                body,
                'Body',
                e.clipBy ? (csg ? 'CSG' : 'Clipping') : (lean?.type ?? 'SweptSolid'),
                [solid],
              ),
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
        if (e.lean) constraints.push(['Lean', typed('IFCPLANEANGLEMEASURE', real(e.lean))]);
        break;
      }
      case 'slab': {
        const s = shape as Extract<BimShape, { kind: 'slab' }>;
        const frame: Frame = { o: [0, 0, s.zBottom], x: [1, 0] };
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.slab.entity,
          ...elementHead(e, placement, productShape([slabBody(s, frame, e.holes)])),
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
          ...(e.slope
            ? [
                ['SlopeEdge', typed('IFCINTEGER', int(e.slope.edge))] as [string, P21Value],
                ...heightRefs('SlopeEndTop', e.slope.endTop),
              ]
            : []),
        );
        break;
      }
      case 'column': {
        const s = shape as Extract<BimShape, { kind: 'column' }>;
        const x: Vec2 = [Math.cos(s.rotationRad), Math.sin(s.rotationRad)];
        const frame: Frame = { o: [s.at[0], s.at[1], s.zBase], x };
        // TW5: a tapered column's end is its profile scaled about the axis.
        const sweep = (depth: number, position?: P21Value) =>
          s.topScale !== undefined
            ? taper(parametricProfile(e.typeId, s.profile), s.profile, depth, s.topScale, position)
            : extrude(parametricProfile(e.typeId, s.profile), depth, position);
        // TW2: a leaning column extrudes along its axis, given in the level frame of its base.
        const local = (v: Vec3): Vec3 => [
          v[0] * x[0] + v[1] * x[1],
          -v[0] * x[1] + v[1] * x[0],
          v[2],
        ];
        const a = s.topAt ? bimSectionAxes(s) : undefined;
        let solid = a
          ? sweep(a.length, placement3([0, 0, 0], local(a.x), local(a.z)))
          : sweep(s.zTop - s.zBase);
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
            productShape([
              shapeRep(
                body,
                'Body',
                e.clipBy
                  ? 'Clipping'
                  : s.topScale !== undefined
                    ? 'AdvancedSweptSolid'
                    : 'SweptSolid',
                [solid],
              ),
            ]),
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
        if (e.topAt) constraints.push(...pointRefs('TopAt', e.topAt));
        if (e.topScale !== undefined)
          constraints.push(['TopScale', typed('IFCREAL', real(e.topScale))]);
        break;
      }
      case 'beam': {
        const s = shape as Extract<BimShape, { kind: 'beam' }>;
        // TW2: along the axis, which rises for a sloping beam; x stays level.
        const a = bimSectionAxes(s);
        const placement = add(
          'IFCLOCALPLACEMENT',
          storeys.get(levelId)!.placement,
          placement3([a.origin[0], a.origin[1], a.origin[2] - storeyZ], a.x, a.z),
        );
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.beam.entity,
          ...elementHead(
            e,
            placement,
            productShape([
              shapeRep(body, 'Body', 'SweptSolid', [
                extrude(parametricProfile(e.typeId, s.profile), a.length),
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
        if (e.endTop) constraints.push(...heightRefs('EndTop', e.endTop));
        break;
      }
      case 'ramp': {
        const s = shape as Extract<BimShape, { kind: 'ramp' }>;
        const frame: Frame = { o: [s.center[0], s.center[1], 0], x: [1, 0] };
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.ramp.entity,
          ...elementHead(
            e,
            placement,
            productShape([shapeRep(body, 'Body', 'Tessellation', [rampBody(s)])]),
          ),
          $,
          enumOf('SPIRAL_RAMP'),
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
          ['Type', ident(globalIds.get(e.typeId)!)],
          ...pointRefs('Center', e.center),
          ['InnerRadius', length(e.innerRadiusMm)],
          ['OuterRadius', length(e.outerRadiusMm)],
          ['StartAngle', angle(e.startAngleRad)],
          ['Sweep', angle(e.sweepRad)],
          ...heightRefs('Base', e.base),
          ...heightRefs('Top', e.top),
        );
        break;
      }
      case 'stair': {
        // LS6: placed at its start, turned up its flight; its side (in the upright plane along
        // the flight) extruded across its width.
        const s = shape as Extract<BimShape, { kind: 'stair' }>;
        const frame: Frame = {
          o: [s.at[0], s.at[1], s.zBase],
          x: [Math.cos(s.directionRad), Math.sin(s.directionRad)],
        };
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        const side = loopProfile(s.profile);
        ref = add(
          bimIfcKinds.stair.entity,
          ...elementHead(
            e,
            placement,
            productShape([
              shapeRep(body, 'Body', 'SweptSolid', [
                extrude(side, s.width, placement3([0, s.width / 2, 0], [1, 0, 0], [0, -1, 0])),
              ]),
            ]),
          ),
          $,
          enumOf('STRAIGHT_RUN_STAIR'),
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
        shapedCommon.set(e.id, [
          single('NumberOfRiser', typed('IFCCOUNTMEASURE', int(s.risers))),
          single('NumberOfTreads', typed('IFCCOUNTMEASURE', int(s.risers - 1))),
          single('RiserHeight', typed('IFCPOSITIVELENGTHMEASURE', real(s.riser))),
          single('TreadLength', typed('IFCPOSITIVELENGTHMEASURE', real(s.tread))),
        ]);
        constraints.push(
          ['Type', ident(globalIds.get(e.typeId)!)],
          ...pointRefs('Start', e.start),
          ['Direction', angle(e.directionRad)],
          ['Width', length(e.widthMm)],
          ['Risers', typed('IFCINTEGER', int(e.risers))],
          ['Tread', length(e.treadMm)],
          ...heightRefs('Base', e.base),
          ...heightRefs('Top', e.top),
        );
        break;
      }
      case 'railing': {
        // LS5: as its ramp, a band of triangles about the ramp's centre at its own heights.
        const s = shape as Extract<BimShape, { kind: 'railing' }>;
        const placement = localPlacement(levelId, { o: [s.center[0], s.center[1], 0], x: [1, 0] });
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.railing.entity,
          ...elementHead(
            e,
            placement,
            productShape([shapeRep(body, 'Body', 'Tessellation', [rampBody(s)])]),
          ),
          $,
          enumOf('GUARDRAIL'),
        );
        const u = usage.get(`${e.typeId}\u0000railing`) ?? {
          set: add(
            'IFCMATERIALLAYERSETUSAGE',
            materialSets.get(e.typeId)!,
            enumOf('AXIS2'),
            enumOf('POSITIVE'),
            real(0),
            $,
          ),
          objects: [],
        };
        u.objects.push(ref);
        usage.set(`${e.typeId}\u0000railing`, u);
        constraints.push(
          ['Type', ident(globalIds.get(e.typeId)!)],
          ['Host', ident(e.hostId)],
          ['Side', typed('IFCLABEL', str(e.side))],
          ['Height', length(e.heightMm)],
        );
        break;
      }
      case 'member': {
        const s = shape as Extract<BimShape, { kind: 'member' }>;
        // TW2: placed at its start, with its axes: the section extrudes along the member.
        const a = bimSectionAxes(s);
        const placement = add(
          'IFCLOCALPLACEMENT',
          storeys.get(levelId)!.placement,
          placement3([a.origin[0], a.origin[1], a.origin[2] - storeyZ], a.x, a.z),
        );
        placements.set(e.id, placement);
        ref = add(
          bimIfcKinds.member.entity,
          ...elementHead(
            e,
            placement,
            productShape([
              shapeRep(body, 'Body', 'SweptSolid', [
                extrude(parametricProfile(e.typeId, s.profile), a.length),
              ]),
            ]),
          ),
          $,
          enumOf('BRACE'),
        );
        const u = usage.get(`${e.typeId}\u0000`) ?? {
          set: add('IFCMATERIALPROFILESETUSAGE', materialSets.get(e.typeId)!, int(5), $),
          objects: [],
        };
        u.objects.push(ref);
        usage.set(`${e.typeId}\u0000`, u);
        constraints.push(
          ...pointRefs('Start', e.start.at),
          ...heightRefs('StartHeight', e.start.height),
          ...pointRefs('End', e.end.at),
          ...heightRefs('EndHeight', e.end.height),
          ['Rotation', angle(e.rotationRad)],
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
              // TW1: holes as IfcArbitraryProfileDefWithVoids.
              extrude(loopProfile(s.boundary, s.holes), s.zTop - s.zBase),
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
          ...(e.holes ?? []).flatMap((h, i) => loopRefs(`Hole${i + 1}`, h)),
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
        // Written only for the shells that use them (TW0a: a face set lists its own points).
        const written: P21Value[] = [];
        const point = (v: number) => (written[v] ??= pt3(mesh.positions.slice(3 * v, 3 * v + 3)));
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
                          (inward ? [0, 2, 1] : [0, 1, 2]).map((k) =>
                            point(mesh.triangles[i + k]!),
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
        /**
         * TW0a (SK-U1): a solid body as one `IfcTriangulatedFaceSet` — each point written once,
         * at 0.001 mm (the mesh deflection is at least 0.5 mm), the triangles by index.
         */
        const faceSet = (body: number[]) => {
          const index = new Map<number, number>();
          const coords: P21Value[] = [];
          const triangles: P21Value[] = [];
          for (const t of body) {
            const corner: P21Value[] = [];
            for (let k = 0; k < 3; k++) {
              const v = mesh.triangles[t + k]!;
              let n = index.get(v);
              if (n === undefined) {
                n = coords.length + 1;
                index.set(v, n);
                coords.push(
                  reals([0, 1, 2].map((c) => Math.round(mesh.positions[3 * v + c]! * 1000) / 1000)),
                );
              }
              corner.push(int(n));
            }
            triangles.push(list(corner));
          }
          return add(
            'IFCTRIANGULATEDFACESET',
            add('IFCCARTESIANPOINTLIST3D', list(coords)),
            $,
            bool(true),
            list(triangles),
            $,
          );
        };
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
              ? bodies.map((b) => styled(faceSet(b.outer), b.outer[0]))
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
                mesh.kind !== 'solid' ? 'SurfaceModel' : csg ? 'CSG' : 'Tessellation',
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
        let rise = 0;
        if ('wall' in e) {
          const hs = shapeOf(host.id) as Extract<BimShape, { kind: 'wall' }>;
          const a = wallAxis(host as BimWall);
          const frame: Frame = { o: [a.s[0], a.s[1], hs.zBase], x: a.x };
          const cut = wallOpeningCut(
            host as BimWall,
            frame,
            e.wall.alongMm,
            e.wall.widthMm,
            e.wall.sillMm,
            e.wall.heightMm,
          );
          solid = cut.solid;
          rise = cut.z;
        } else if (host.kind === 'ramp') {
          // LS4: in the ramp's frame (its centre, heights as they are), upright through its rise.
          const hs = shapeOf(host.id) as Extract<BimShape, { kind: 'ramp' }>;
          const z0 = Math.min(hs.zStart, hs.zEnd) - hs.thickness;
          const z1 = Math.max(hs.zStart, hs.zEnd);
          const local = e.slab.boundary.map((v) => {
            const p: Vec2 = [v[0] - hs.center[0], v[1] - hs.center[1]];
            return v[2] ? ([...p, v[2]] as BimLoop[number]) : p;
          });
          solid = extrude(loopProfile(local), z1 - z0 + 20, placement3([0, 0, z0 - 10]));
        } else {
          const hs = shapeOf(host.id) as Extract<BimShape, { kind: 'slab' }>;
          // Through the whole thickness; a sloped slab's (TW5) over its whole rise.
          const t = hs.zTop - hs.zBottom;
          const [z0, z1] = hs.slope
            ? (({ zLow, zHigh }) => [zLow - t - hs.zBottom, zHigh - hs.zBottom])(bimSlabPlanes(hs))
            : [0, t];
          solid = extrude(loopProfile(e.slab.boundary), z1 - z0 + 20, placement3([0, 0, z0 - 10]));
        }
        const placement = add(
          'IFCLOCALPLACEMENT',
          placements.get(host.id)!,
          placement3([0, 0, rise]),
        );
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
        const cut = wallOpeningCut(host, hostFrame, e.alongMm, t.widthMm, sill, t.heightMm);
        // The opening the door or window fills.
        const opening = add(
          bimIfcKinds.opening.entity,
          auxGid(`opening\u0000${e.id}`),
          $,
          // IfcLabel holds 255 characters; the host's name is shortened to fit the suffix.
          label(`${[...(e.name ?? e.id)].slice(0, 255 - ' opening'.length).join('')} opening`),
          $,
          $,
          add('IFCLOCALPLACEMENT', placements.get(host.id)!, placement3([0, 0, cut.z])),
          productShape([shapeRep(body, 'Body', 'SweptSolid', [cut.solid])]),
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
        // FU3b: in a leaning wall it leans with the wall about the tangent, its sill measured up
        // the face from the middle of the wall at the base (as the kernel places it).
        const lean = host.lean ?? 0;
        const mid = (a.leftOff + a.rightOff) / 2 / Math.cos(lean);
        const n = left(tangent);
        const up: Vec3 = [-Math.sin(lean) * n[0], -Math.sin(lean) * n[1], Math.cos(lean)];
        const o: Vec3 = [
          origin[0] + n[0] * mid + up[0] * sill,
          origin[1] + n[1] * mid + up[1] * sill,
          hs.zBase + up[2] * sill,
        ];
        // FU3b: on a cone (a leaning arc wall) the band about the wall's middle between the
        // opening's angles, ruled from the sill to the head like the cut (as the kernel builds it).
        const arc = lean ? a.arc : undefined;
        const [z0, z1] = bimWallOpeningRise(host, sill, t.heightMm);
        const frame: Frame = arc ? { o: [...arc.center, hs.zBase + z0], x: [1, 0] } : { o, x };
        const placement = localPlacement(levelId, frame);
        placements.set(e.id, placement);
        const band = (rise: number) =>
          loopToLocal(
            frame,
            bimWallOpeningLoop(ctx, host, e.alongMm, t.widthMm, rise, panelMm / 2),
          );
        // FU3b: the type's panel in a level wall; in a leaning one its own body, a level section
        // (50 mm square to the face) swept up the face, so its ends are level with the cut's and it
        // fits inside it, as the kernel builds it (Codex).
        const side = e.flipFacing ? -1 : 1;
        const cone =
          arc &&
          leanBody(
            band(z0),
            band(z1),
            z1 - z0,
            [0, 0],
            (Math.sign(arc.sweep) * t.widthMm) / arc.radius,
            toLocal(frame, a.at(e.alongMm)[0]),
          );
        const item = cone
          ? cone.item
          : lean
            ? add(
                'IFCEXTRUDEDAREASOLID',
                add(
                  'IFCRECTANGLEPROFILEDEF',
                  enumOf('AREA'),
                  $,
                  add(
                    'IFCAXIS2PLACEMENT2D',
                    add('IFCCARTESIANPOINT', reals([t.widthMm / 2, 0])),
                    $,
                  ),
                  real(t.widthMm),
                  real(panelMm / Math.cos(lean)),
                ),
                $,
                dir3([0, -side * Math.sin(lean), Math.cos(lean)]),
                real(t.heightMm),
              )
            : add(
                'IFCMAPPEDITEM',
                typeMaps.get(e.typeId)!,
                add('IFCCARTESIANTRANSFORMATIONOPERATOR3D', $, $, origin3, $, $),
              );
        const head = elementHead(
          e,
          placement,
          productShape([
            shapeRep(body, 'Body', cone?.type ?? (lean ? 'SweptSolid' : 'MappedRepresentation'), [
              item,
            ]),
          ]),
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
    if ('typeId' in e && typeRefs.has(e.typeId) && !['ramp', 'railing', 'stair'].includes(e.kind)) {
      const list = byType.get(e.typeId) ?? [];
      list.push(ref);
      byType.set(e.typeId, list);
    }
    describedSets(e.id, bimIfcKinds[e.kind].pset, e, shapedCommon.get(e.id)).forEach((set, i) =>
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
          // TW0e: IfcGridAxis has no bubble position; written only when not both ends.
          ...(a.bubbles === undefined
            ? []
            : [['Bubbles', typed('IFCLABEL', str(a.bubbles))] as [string, P21Value]]),
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
  return {
    text,
    bytes: new TextEncoder().encode(text),
    globalIds,
    entityCount: w.count,
    losses: [...losses],
  };
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

/**
 * LR2b: triangles of a simple polygon (either orientation) by ear clipping, each in the
 * polygon's own turning order. Small polygons only (a wall's footprint).
 */
function earClip(pts: Vec2[]): [Vec2, Vec2, Vec2][] {
  const area = pts.reduce((n, p, i) => n + cross(p, pts[(i + 1) % pts.length]!), 0) / 2;
  const sign = Math.sign(area) || 1;
  const rest = pts.map((_, i) => i);
  const out: [Vec2, Vec2, Vec2][] = [];
  const inside = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) =>
    [
      [a, b],
      [b, c],
      [c, a],
    ].every(([u, v]) => sign * cross(sub(v!, u!), sub(p, u!)) >= 0);
  while (rest.length > 3) {
    let cut = false;
    for (let k = 0; k < rest.length; k++) {
      const [ia, ib, ic] = [
        rest[(k + rest.length - 1) % rest.length]!,
        rest[k]!,
        rest[(k + 1) % rest.length]!,
      ];
      const [a, b, c] = [pts[ia]!, pts[ib]!, pts[ic]!];
      if (sign * cross(sub(b, a), sub(c, b)) <= 0) continue;
      if (rest.some((i) => i !== ia && i !== ib && i !== ic && inside(pts[i]!, a, b, c))) continue;
      out.push([a, b, c]);
      rest.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (rest.length === 3) out.push([pts[rest[0]!]!, pts[rest[1]!]!, pts[rest[2]!]!]);
  return out;
}
