import {
  bimMaterialCategories,
  bimSchemaVersion,
  cross,
  deriveBim,
  dot,
  left,
  loopEdges,
  pointInLoop,
  sub,
  unit,
  validateBim,
  type BimCommonProperties,
  type BimDiagnostic,
  type BimDocument,
  type BimElement,
  type BimGridAxis,
  type BimLayer,
  type BimLevel,
  type BimLevelHeight,
  type BimLoop,
  type BimLoopVertex,
  type BimMaterial,
  type BimPoint,
  type BimProfile,
  type BimPropertySetDef,
  type BimPropertyValue,
  type BimPropertyValues,
  type BimTop,
  type BimType,
  type BimView,
  type BimSlab,
  type BimWall,
  type BimWallJoin,
  type Vec2,
  type Vec3,
} from '@editor-platform/bim-core';
import {
  P21ReadError,
  readP21,
  type P21File,
  type P21Instance,
  type P21Value,
} from '@editor-platform/geometry-core';
import { bimIfcKinds, writeIfcShapes } from './export';

/**
 * IFC4 import of a `bim` document (docs/cad/r2c-architecture.md, 取り込み; R2c-U5). A file this
 * product wrote comes back from its `EP_*` data and is checked against its own shapes; other
 * IFC4 files give the supported subset (extruded walls, slabs, columns, beams, flat roofs and
 * spaces, openings, types, storeys and grids) without follow relations, and list the rest.
 */

export const bimIfcImportLimits = Object.freeze({
  bytes: 16 * 1024 * 1024,
  entities: 2_000_000,
  depth: 32,
});

export interface BimIfcPartSource {
  artifactId: string;
  versionId: string;
  contentHash: string;
}
export interface BimIfcImportOptions {
  /** Whether a CAD part version resolves through the R2b version reference. */
  resolvePart?: (source: BimIfcPartSource) => boolean;
  /** The user saw the loss report and confirmed: import the supported part. */
  acceptLoss?: boolean;
}

/** Something not imported: an entity, or a part of one (a property set). */
export interface BimIfcLoss {
  entity: string;
  reason: string;
  globalId?: string;
  name?: string;
}
export interface BimIfcImportReport {
  /** Elements restored with their follow relations (`EP_Constraints`). */
  restored: number;
  /**
   * Elements imported at fixed heights and coordinates, without level, grid or join follow
   * ("追従関係なし").
   */
  withoutFollow: number;
  losses: BimIfcLoss[];
  /** Losses by entity type and reason, with counts, in order of first appearance. */
  summary: { entity: string; reason: string; count: number }[];
}
export type BimIfcImportResult =
  | { status: 'imported'; document: BimDocument; report: BimIfcImportReport }
  /** Content would be lost: nothing is imported until the user confirms (`acceptLoss`). */
  | { status: 'needs-confirmation'; report: BimIfcImportReport };

export type BimIfcImportCode =
  | 'ifc-unreadable'
  | 'ifc-too-large'
  | 'ifc-too-many-entities'
  | 'ifc-too-deep'
  | 'ifc-schema-unsupported'
  | 'ifc-unit-unsupported'
  | 'ifc-no-project'
  | 'constraint-mismatch'
  | 'invalid-document';

export class BimIfcImportError extends Error {
  constructor(
    readonly code: BimIfcImportCode,
    /** The entities the problem is about, or a detail. */
    readonly ids: string[] = [],
  ) {
    super(ids.length ? `${code}: ${ids.join(', ')}` : code);
  }
}

// ---------------------------------------------------------------------------------------------
// Values and the instance graph.

const plain = (v: P21Value | undefined): P21Value | undefined =>
  v?.t === 'typed' ? plain(v.v) : v;
const num = (v: P21Value | undefined): number | undefined => {
  const p = plain(v);
  return p?.t === 'real' || p?.t === 'int' ? p.v : undefined;
};
const text = (v: P21Value | undefined): string | undefined => {
  const p = plain(v);
  return p?.t === 'str' ? p.v : undefined;
};
const flag = (v: P21Value | undefined): boolean | undefined => {
  const p = plain(v);
  return p?.t === 'enum' && (p.v === 'T' || p.v === 'F')
    ? p.v === 'T'
    : p?.t === 'bool'
      ? p.v
      : undefined;
};
const enumValue = (v: P21Value | undefined) => (v?.t === 'enum' ? v.v : undefined);
const items = (v: P21Value | undefined): P21Value[] => (v?.t === 'list' ? v.v : []);
const typeName = (v: P21Value | undefined) => (v?.t === 'typed' ? v.name : undefined);

/** Entity names of elements, by the kind they import as. */
const elementEntities: Record<string, BimElement['kind']> = {
  IFCWALL: 'wall',
  IFCWALLSTANDARDCASE: 'wall',
  IFCSLAB: 'slab',
  IFCSLABSTANDARDCASE: 'slab',
  IFCCOLUMN: 'column',
  IFCCOLUMNSTANDARDCASE: 'column',
  IFCBEAM: 'beam',
  IFCBEAMSTANDARDCASE: 'beam',
  IFCROOF: 'roof',
  IFCSPACE: 'space',
  IFCBUILDINGELEMENTPROXY: 'part',
  IFCOPENINGELEMENT: 'opening',
  IFCOPENINGSTANDARDCASE: 'opening',
  IFCDOOR: 'door',
  IFCDOORSTANDARDCASE: 'door',
  IFCWINDOW: 'window',
  IFCWINDOWSTANDARDCASE: 'window',
};
const typeEntities: Record<string, BimType['kind']> = Object.fromEntries(
  Object.entries(bimIfcKinds)
    .filter(([, k]) => k.type)
    .map(([kind, k]) => [k.type, kind as BimType['kind']]),
);
/** Root entities read as structure, relations or definitions; any other root is listed as lost. */
const structural = new Set([
  'IFCPROJECT',
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCGRID',
  'IFCRELAGGREGATES',
  'IFCRELCONTAINEDINSPATIALSTRUCTURE',
  'IFCRELDEFINESBYPROPERTIES',
  'IFCRELDEFINESBYTYPE',
  'IFCRELDEFINESBYTEMPLATE',
  'IFCRELASSOCIATESMATERIAL',
  'IFCRELVOIDSELEMENT',
  'IFCRELFILLSELEMENT',
  'IFCRELCONNECTSPATHELEMENTS',
  'IFCRELDECLARES',
  'IFCPROPERTYSET',
  'IFCELEMENTQUANTITY',
  'IFCPROPERTYSETTEMPLATE',
  'IFCSIMPLEPROPERTYTEMPLATE',
]);

class Graph {
  readonly byType = new Map<string, P21Instance[]>();
  /** Property sets by the object they describe (relations and a type's own sets). */
  readonly sets = new Map<number, P21Instance[]>();
  readonly typeOf = new Map<number, number>();
  readonly materialOf = new Map<number, number>();
  readonly container = new Map<number, number>();
  readonly parent = new Map<number, number>();
  readonly hostOf = new Map<number, number>();
  readonly openingOf = new Map<number, number>();
  readonly templateOf = new Map<number, number>();
  readonly materialProps = new Map<number, P21Instance>();

  constructor(readonly file: P21File) {
    for (const e of file.entities.values()) {
      const list = this.byType.get(e.type) ?? [];
      list.push(e);
      this.byType.set(e.type, list);
    }
    const each = (type: string, f: (e: P21Instance) => void) => this.all(type).forEach(f);
    each('IFCRELDEFINESBYPROPERTIES', (r) => {
      const set = this.get(r.args[5]);
      if (set) for (const o of items(r.args[4])) this.push(this.sets, o, set);
    });
    for (const t of this.file.entities.values())
      if (typeEntities[t.type] || t.type.endsWith('TYPE'))
        for (const s of items(t.args[5])) {
          const set = this.get(s);
          if (set) this.push(this.sets, { t: 'ref', id: t.id }, set);
        }
    each('IFCRELDEFINESBYTYPE', (r) =>
      items(r.args[4]).forEach((o) => this.link(this.typeOf, o, r.args[5])),
    );
    each('IFCRELASSOCIATESMATERIAL', (r) =>
      items(r.args[4]).forEach((o) => this.link(this.materialOf, o, r.args[5])),
    );
    each('IFCRELCONTAINEDINSPATIALSTRUCTURE', (r) =>
      items(r.args[4]).forEach((o) => this.link(this.container, o, r.args[5])),
    );
    each('IFCRELAGGREGATES', (r) =>
      items(r.args[5]).forEach((o) => this.link(this.parent, o, r.args[4])),
    );
    each('IFCRELVOIDSELEMENT', (r) => this.link(this.hostOf, r.args[5], r.args[4]));
    each('IFCRELFILLSELEMENT', (r) => this.link(this.openingOf, r.args[5], r.args[4]));
    each('IFCRELDEFINESBYTEMPLATE', (r) =>
      items(r.args[4]).forEach((o) => this.link(this.templateOf, o, r.args[5])),
    );
    each('IFCMATERIALPROPERTIES', (p) => {
      const m = p.args[3];
      if (m?.t === 'ref' && text(p.args[0]) === 'EP_Constraints') this.materialProps.set(m.id, p);
    });
  }
  private push(map: Map<number, P21Instance[]>, key: P21Value, v: P21Instance) {
    if (key.t !== 'ref') return;
    map.set(key.id, [...(map.get(key.id) ?? []), v]);
  }
  private link(map: Map<number, number>, from: P21Value | undefined, to: P21Value | undefined) {
    if (from?.t === 'ref' && to?.t === 'ref' && !map.has(from.id)) map.set(from.id, to.id);
  }
  get(v: P21Value | number | undefined): P21Instance | undefined {
    if (typeof v === 'number') return this.file.entities.get(v);
    return v?.t === 'ref' ? this.file.entities.get(v.id) : undefined;
  }
  all(type: string) {
    return this.byType.get(type) ?? [];
  }
  /** Single and list values of an object's property sets named `name`, the first set winning. */
  props(id: number, name: string): Map<string, P21Value> | undefined {
    const sets = (this.sets.get(id) ?? []).filter(
      (s) => s.type === 'IFCPROPERTYSET' && text(s.args[2]) === name,
    );
    if (!sets.length) return undefined;
    return this.properties(sets[0].args[4]);
  }
  properties(list: P21Value | undefined) {
    const out = new Map<string, P21Value>();
    for (const p of items(list).map((r) => this.get(r))) {
      if (!p) continue;
      const n = text(p.args[0]);
      if (n === undefined || out.has(n)) continue;
      if (p.type === 'IFCPROPERTYSINGLEVALUE') out.set(n, p.args[2]);
      else if (p.type === 'IFCPROPERTYLISTVALUE') out.set(n, p.args[2]);
      else if (p.type === 'IFCCOMPLEXPROPERTY') out.set(n, { t: 'ref', id: p.id });
    }
    return out;
  }
  /** Whether a property list holds an entity `properties` does not read (enumerated, bounded…). */
  unread(list: P21Value | undefined) {
    return items(list).some((r) => {
      const p = this.get(r);
      return !!p && !readProperties.has(p.type);
    });
  }
}
const readProperties = new Set([
  'IFCPROPERTYSINGLEVALUE',
  'IFCPROPERTYLISTVALUE',
  'IFCCOMPLEXPROPERTY',
]);

// ---------------------------------------------------------------------------------------------
// Placements.

/** A rigid placement: origin and orthonormal axes, in mm. */
interface Xf {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}
const identity: Xf = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  unit: (a: Vec3): Vec3 => v3.scale(a, 1 / Math.hypot(...a)),
};
const dirOf = (xf: Xf, d: Vec3): Vec3 =>
  v3.add(v3.add(v3.scale(xf.x, d[0]), v3.scale(xf.y, d[1])), v3.scale(xf.z, d[2]));
const pointOf = (xf: Xf, p: Vec3): Vec3 => v3.add(xf.o, dirOf(xf, p));
const compose = (a: Xf, b: Xf): Xf => ({
  o: pointOf(a, b.o),
  x: dirOf(a, b.x),
  y: dirOf(a, b.y),
  z: dirOf(a, b.z),
});
const near = (a: number, b: number, tol = 1e-6) =>
  Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const parallel = (a: Vec3, b: Vec3) => near(v3.dot(v3.unit(a), v3.unit(b)), 1, 1e-9);

/** Something the importer cannot map, with the reason it gives in the loss report. */
class Unsupported extends Error {}
const unsupported = (reason: string): never => {
  throw new Unsupported(reason);
};

// ---------------------------------------------------------------------------------------------

export function readIfc(bytes: Uint8Array, options: BimIfcImportOptions = {}): BimIfcImportResult {
  let file: P21File;
  try {
    file = readP21(bytes, bimIfcImportLimits);
  } catch (e) {
    if (!(e instanceof P21ReadError)) throw e;
    const code =
      e.code === 'p21-too-large'
        ? 'ifc-too-large'
        : e.code === 'p21-too-many-entities'
          ? 'ifc-too-many-entities'
          : e.code === 'p21-too-deep'
            ? 'ifc-too-deep'
            : 'ifc-unreadable';
    throw new BimIfcImportError(code, [e.detail || e.code]);
  }
  const schema = file.header.find((h) => h.type === 'FILE_SCHEMA');
  const schemas = items(schema?.args[0]).map((v) => text(v)?.trim().toUpperCase());
  if (schemas.length !== 1 || schemas[0] !== 'IFC4')
    throw new BimIfcImportError('ifc-schema-unsupported', [schemas.join(',') || 'none']);
  const g = new Graph(file);
  const [projectEntity, ...extraProjects] = g.all('IFCPROJECT');
  if (!projectEntity || extraProjects.length) throw new BimIfcImportError('ifc-no-project');
  return new Importer(g, projectEntity, options).run();
}

class Importer {
  readonly losses: BimIfcLoss[] = [];
  /** Root instances read (or deliberately skipped); the others are listed as lost. */
  readonly seen = new Set<number>();
  /** Length unit in mm and plane angle unit in radians. */
  readonly mm: number;
  readonly rad: number;
  /** The file is this product's (mm, radians): its `EP_*` data may be trusted. */
  readonly own: boolean;
  /** The project carries `EP_Constraints`: written by this product. */
  ownProject = false;
  readonly doc: BimDocument;
  /** `bim` ID by instance, for every imported level, type, material and element. */
  readonly idOf = new Map<number, string>();
  /** Element instances imported from `EP_Constraints` (checked against their shapes). */
  readonly restored = new Set<number>();
  readonly foreign = new Set<number>();
  /** Joins read from IfcRelConnectsPathElements (dropped when the rules refuse them). */
  readonly foreignJoins = new Set<string>();
  /** Foreign walls cut by a horizontal plane: its height, matched with a roof in `settle`. */
  readonly clipPlanes = new Map<BimElement, number>();
  private joinInst = new Map<string, P21Instance>();
  private usedIds = new Set<string>();
  private worldCache = new Map<number, Xf>();

  constructor(
    readonly g: Graph,
    readonly project: P21Instance,
    readonly options: BimIfcImportOptions,
  ) {
    const units = this.units();
    this.mm = units.mm;
    this.rad = units.rad;
    this.own = this.mm === 1 && this.rad === 1;
    this.doc = {
      schemaVersion: bimSchemaVersion as 1,
      units: 'mm',
      axes: 'right-handed-z-up',
      project: { name: text(project.args[2]) ?? 'Imported', trueNorthRad: 0, siteElevationMm: 0 },
      levels: [],
      grids: [],
      materials: [],
      types: [],
      elements: [],
      joins: [],
      views: [],
      propertySets: [],
    };
  }

  lose(e: P21Instance | undefined, reason: string, entity?: string) {
    this.losses.push({
      entity: entity ?? (e ? e.type : 'unknown'),
      reason,
      ...(e && text(e.args[0]) !== undefined && e.type !== '' ? { globalId: text(e.args[0]) } : {}),
      ...(e && text(e.args[2]) !== undefined ? { name: text(e.args[2]) } : {}),
    });
  }

  /**
   * A unique `bim` ID: the preferred one when free (a native ID stays as written), else with a
   * counter, shortened only as far as the 128 code points the suffix needs.
   */
  newId(preferred: string) {
    const cut = (s: string, n: number) => [...s].slice(0, n).join('').trim() || 'ifc';
    let id = cut(preferred, 128);
    if (this.usedIds.has(id)) {
      let n = 2;
      const next = () => `${cut(id, 128 - `-${n}`.length)}-${n}`;
      while (this.usedIds.has(next())) n++;
      id = next();
    }
    this.usedIds.add(id);
    return id;
  }

  // -------------------------------------------------------------------------------------------
  // Units and placements.

  units() {
    let mm: number | undefined;
    let rad = 1;
    const assignment = this.g.get(this.project.args[8]);
    for (const u of items(assignment?.args[0]).map((r) => this.g.get(r))) {
      if (!u) continue;
      const kind = enumValue(u.args[1]);
      if (kind !== 'LENGTHUNIT' && kind !== 'PLANEANGLEUNIT') continue;
      const factor = this.unitFactor(u, 0);
      if (factor === undefined) throw new BimIfcImportError('ifc-unit-unsupported', [kind, u.type]);
      if (kind === 'LENGTHUNIT') mm = factor * 1000;
      else rad = factor;
    }
    if (mm === undefined) throw new BimIfcImportError('ifc-unit-unsupported', ['LENGTHUNIT']);
    return { mm, rad };
  }
  /** The unit in metres or radians. */
  unitFactor(u: P21Instance, depth: number): number | undefined {
    if (depth > 4) return undefined;
    if (u.type === 'IFCSIUNIT') {
      const name = enumValue(u.args[3]);
      if (name !== 'METRE' && name !== 'RADIAN') return undefined;
      const prefix = enumValue(u.args[2]);
      const p: Record<string, number> = { MILLI: 1e-3, CENTI: 1e-2, DECI: 1e-1, KILO: 1e3 };
      return prefix === undefined ? 1 : p[prefix];
    }
    if (u.type === 'IFCCONVERSIONBASEDUNIT' || u.type === 'IFCCONVERSIONBASEDUNITWITHOFFSET') {
      const m = this.g.get(u.args[3]);
      const value = num(m?.args[0]);
      const base = this.g.get(m?.args[1]);
      const f = base && this.unitFactor(base, depth + 1);
      return value !== undefined && f !== undefined ? value * f : undefined;
    }
    return undefined;
  }
  point(v: P21Value | undefined): Vec3 {
    const p = this.g.get(v);
    if (p?.type !== 'IFCCARTESIANPOINT') return unsupported('point');
    const c = items(p.args[0]).map((x) => (num(x) ?? NaN) * this.mm);
    if (c.length < 2 || c.some((x) => !Number.isFinite(x))) return unsupported('point');
    return [c[0], c[1], c[2] ?? 0];
  }
  direction(v: P21Value | undefined, fallback: Vec3): Vec3 {
    const d = this.g.get(v);
    if (!d) return fallback;
    if (d.type !== 'IFCDIRECTION') return unsupported('direction');
    const c = items(d.args[0]).map((x) => num(x) ?? NaN);
    const r: Vec3 = [c[0], c[1], c[2] ?? 0];
    if (r.some((x) => !Number.isFinite(x)) || Math.hypot(...r) === 0)
      return unsupported('direction');
    return v3.unit(r);
  }
  axis2(v: P21Value | undefined): Xf {
    const a = this.g.get(v);
    if (!a) return identity;
    if (a.type === 'IFCAXIS2PLACEMENT2D') {
      const o = this.point(a.args[0]);
      const x = this.direction(a.args[1], [1, 0, 0]);
      const xh = v3.unit([x[0], x[1], 0]);
      return { o: [o[0], o[1], 0], x: xh, y: [-xh[1], xh[0], 0], z: [0, 0, 1] };
    }
    if (a.type !== 'IFCAXIS2PLACEMENT3D') return unsupported('placement');
    const o = this.point(a.args[0]);
    const z = this.direction(a.args[1], [0, 0, 1]);
    let x = this.direction(a.args[2], Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    x = v3.unit(v3.add(x, v3.scale(z, -v3.dot(x, z))));
    return { o, x, y: v3.cross(z, x), z };
  }
  /** World placement of an object placement. */
  world(v: P21Value | undefined, depth = 0): Xf {
    const p = this.g.get(v);
    if (!p) return identity;
    const cached = this.worldCache.get(p.id);
    if (cached) return cached;
    if (depth > 64) return unsupported('placement');
    let xf: Xf;
    if (p.type === 'IFCLOCALPLACEMENT')
      xf = compose(this.world(p.args[0], depth + 1), this.axis2(p.args[1]));
    else if (p.type === 'IFCGRIDPLACEMENT') xf = this.gridPlacement(p).xf;
    else return unsupported('placement');
    this.worldCache.set(p.id, xf);
    return xf;
  }

  // -------------------------------------------------------------------------------------------

  run(): BimIfcImportResult {
    try {
      return this.read();
    } catch (e) {
      // Document-level content (storeys, units, the project) that cannot be read.
      if (e instanceof BimIfcImportError) throw e;
      throw new BimIfcImportError('ifc-unreadable', [reasonOf(e)]);
    }
  }
  read(): BimIfcImportResult {
    const doc = this.doc;
    const g = this.g;
    this.seen.add(this.project.id);
    const ownProject = this.own ? g.props(this.project.id, 'EP_Constraints') : undefined;
    this.ownProject = ownProject !== undefined;
    const site = g.all('IFCSITE')[0];
    doc.project.siteElevationMm = (num(site?.args[11]) ?? 0) * this.mm;
    if (ownProject) doc.project.trueNorthRad = num(ownProject.get('TrueNorth')) ?? 0;
    else {
      const context = g.get(items(this.project.args[7])[0]);
      const north = this.g.get(context?.args[5]);
      if (north) {
        const d = this.direction(context!.args[5], [0, 1, 0]);
        doc.project.trueNorthRad = Math.atan2(-d[0], d[1]) || 0;
      }
    }
    this.readLevels();
    this.readMaterials();
    this.readPropertySets();
    this.readGrids(ownProject !== undefined);
    this.readTypes();
    this.readElements();
    this.readJoins(ownProject !== undefined);
    if (ownProject) this.readViews();
    this.sweep();
    this.settle();
    this.check();
    const summary: BimIfcImportReport['summary'] = [];
    for (const l of this.losses) {
      const s = summary.find((x) => x.entity === l.entity && x.reason === l.reason);
      if (s) s.count++;
      else summary.push({ entity: l.entity, reason: l.reason, count: 1 });
    }
    const report: BimIfcImportReport = {
      restored: this.restored.size,
      withoutFollow: this.foreign.size,
      losses: this.losses,
      summary,
    };
    if (this.losses.length && !this.options.acceptLoss)
      return { status: 'needs-confirmation', report };
    return { status: 'imported', document: doc, report };
  }

  // -------------------------------------------------------------------------------------------
  // Levels, materials, property sets, grids.

  readLevels() {
    const storeys = this.g.all('IFCBUILDINGSTOREY');
    for (const s of storeys) {
      this.seen.add(s.id);
      const ep = this.own ? this.g.props(s.id, 'EP_Constraints') : undefined;
      const xf = this.world(s.args[5]);
      const level: BimLevel = {
        id: this.newId(text(ep?.get('BimId')) ?? `ifc-${text(s.args[0]) ?? s.id}`),
        name: text(s.args[2]) ?? text(s.args[7]) ?? `Level ${this.doc.levels.length + 1}`,
        // The placement places the storey; Elevation is informative and may be relative.
        elevationMm: ep ? (num(s.args[9]) ?? xf.o[2]) : snap(xf.o[2]),
      };
      this.idOf.set(s.id, level.id);
      this.doc.levels.push(level);
    }
    for (const t of ['IFCSITE', 'IFCBUILDING']) for (const e of this.g.all(t)) this.seen.add(e.id);
  }
  levelByGlobalId(gid: string | undefined) {
    const s = this.g.all('IFCBUILDINGSTOREY').find((x) => text(x.args[0]) === gid);
    return s && this.idOf.get(s.id);
  }

  readMaterials() {
    for (const m of this.g.all('IFCMATERIAL')) {
      const ep = this.own ? this.g.properties(this.g.materialProps.get(m.id)?.args[2]) : undefined;
      const category = text(m.args[2])?.toLowerCase();
      const mat: BimMaterial = {
        id: this.newId(text(ep?.get('BimId')) ?? `ifc-material-${m.id}`),
        name: text(m.args[0]) || 'Material',
        category: (bimMaterialCategories as readonly string[]).includes(category ?? '')
          ? (category as BimMaterial['category'])
          : 'other',
      };
      this.idOf.set(m.id, mat.id);
      this.doc.materials.push(mat);
    }
  }
  /** A material for content without one. */
  fallbackMaterial() {
    const existing = this.doc.materials.find((m) => m.id === 'ifc-material-unknown');
    if (existing) return existing.id;
    const id = this.newId('ifc-material-unknown');
    this.doc.materials.push({ id, name: 'Unknown', category: 'other' });
    return id;
  }

  readPropertySets() {
    const kinds: Record<string, BimPropertySetDef['properties'][number]['type']> = {
      IFCLABEL: 'string',
      IFCTEXT: 'string',
      IFCREAL: 'number',
      IFCBOOLEAN: 'boolean',
      IFCLENGTHMEASURE: 'length',
    };
    for (const t of this.g.all('IFCPROPERTYSETTEMPLATE')) {
      this.seen.add(t.id);
      const id = text(t.args[3]);
      const props = items(t.args[6]).map((r) => this.g.get(r));
      props.forEach((p) => p && this.seen.add(p.id));
      // Only this product's templates carry the definition's ID (its files have the project's
      // EP_Constraints; units alone do not tell).
      if (!this.ownProject || !id) {
        this.lose(t, 'property-template');
        continue;
      }
      const def: BimPropertySetDef = {
        id: this.newId(id),
        name: text(t.args[2]) ?? id,
        properties: props.map((p) => ({
          name: text(p?.args[2]) ?? '',
          type: kinds[(text(p?.args[5]) ?? '').toUpperCase()] ?? 'string',
        })),
      };
      this.idOf.set(t.id, def.id);
      this.doc.propertySets.push(def);
    }
  }

  readGrids(own: boolean) {
    const grids = this.g.all('IFCGRID');
    grids.forEach((gr) => this.seen.add(gr.id));
    if (own) {
      const set = this.g.props(this.project.id, 'EP_Grids');
      for (const [id, ref] of set ?? []) {
        const c = this.complex(ref);
        this.doc.grids.push({
          id: this.newId(id),
          label: text(c.get('Label')) ?? id,
          start: [num(c.get('StartX')) ?? NaN, num(c.get('StartY')) ?? NaN],
          end: [num(c.get('EndX')) ?? NaN, num(c.get('EndY')) ?? NaN],
        });
      }
      return;
    }
    for (const gr of grids) {
      try {
        const xf = this.world(gr.args[5]);
        // U, V and W axes alike: a `bim` grid axis is any straight line.
        for (const a of [...items(gr.args[7]), ...items(gr.args[8]), ...items(gr.args[9])].map(
          (r) => this.g.get(r),
        )) {
          if (!a) continue;
          const pts = this.polyline(a.args[1]);
          if (pts.length !== 2) {
            this.lose(gr, 'grid-axis-curve', 'IFCGRIDAXIS');
            continue;
          }
          const [s, e] = pts.map((p) => pointOf(xf, [p[0], p[1], 0]));
          const axis: BimGridAxis = {
            id: this.newId(`ifc-grid-${text(a.args[0]) ?? a.id}`),
            label: text(a.args[0]) ?? `${this.doc.grids.length + 1}`,
            start: [snap(s[0]), snap(s[1])],
            end: [snap(e[0]), snap(e[1])],
          };
          this.idOf.set(a.id, axis.id);
          this.doc.grids.push(axis);
        }
      } catch (e) {
        this.lose(gr, reasonOf(e));
      }
    }
  }
  complex(ref: P21Value | undefined) {
    const c = this.g.get(ref);
    return c?.type === 'IFCCOMPLEXPROPERTY'
      ? this.g.properties(c.args[3])
      : new Map<string, P21Value>();
  }
  /** Points of a 2D or 3D polyline or point list, in mm. */
  polyline(v: P21Value | undefined): Vec2[] {
    const c = this.g.get(v);
    if (c?.type === 'IFCPOLYLINE')
      return items(c.args[0])
        .map((p) => this.point(p))
        .map((p) => [p[0], p[1]]);
    if (c?.type === 'IFCINDEXEDPOLYCURVE' && !items(c.args[1]).length)
      return this.pointList(c.args[0]);
    return [];
  }
  pointList(v: P21Value | undefined): Vec2[] {
    const l = this.g.get(v);
    if (l?.type !== 'IFCCARTESIANPOINTLIST2D' && l?.type !== 'IFCCARTESIANPOINTLIST3D')
      return unsupported('curve');
    return items(l.args[0]).map((p) => {
      const c = items(p).map((x) => (num(x) ?? NaN) * this.mm);
      if (c.length < 2 || c.some((x) => !Number.isFinite(x))) unsupported('curve');
      return [c[0], c[1]];
    });
  }

  // -------------------------------------------------------------------------------------------
  // Property sets of types and elements.

  described(id: number, kind: BimType['kind'] | BimElement['kind']) {
    const out: { common?: BimCommonProperties; properties?: BimPropertyValues } = {};
    const commonName = bimIfcKinds[kind].pset;
    for (const set of this.g.sets.get(id) ?? []) {
      if (set.type !== 'IFCPROPERTYSET') continue;
      const name = text(set.args[2]) ?? '';
      if (name.startsWith('EP_') || name.startsWith('Qto_')) continue;
      const props = this.g.properties(set.args[4]);
      // A property kind the reader drops (enumerated, bounded, table, reference) is a loss.
      const unread = this.g.unread(set.args[4]);
      const template = this.g.templateOf.get(set.id);
      const setId = template === undefined ? undefined : this.idOf.get(template);
      if (name === commonName) {
        const c: BimCommonProperties = {};
        let dropped = unread;
        for (const [n, v] of props) {
          if (n === 'Reference' && text(v) !== undefined) c.reference = text(v);
          else if (n === 'IsExternal' && flag(v) !== undefined) c.isExternal = flag(v);
          else if (n === 'LoadBearing' && flag(v) !== undefined) c.loadBearing = flag(v);
          else if (n === 'FireRating' && text(v) !== undefined) c.fireRating = text(v);
          else dropped = true;
        }
        if (Object.keys(c).length) out.common = c;
        if (dropped) this.lose(set, 'properties-partly-kept', 'IFCPROPERTYSET');
      } else if (setId !== undefined) {
        const def = this.doc.propertySets.find((d) => d.id === setId)!;
        const values: Record<string, BimPropertyValue> = {};
        for (const p of def.properties) {
          const v = props.get(p.name);
          if (v === undefined) continue;
          const value = p.type === 'boolean' ? flag(v) : p.type === 'string' ? text(v) : num(v);
          if (value !== undefined) values[p.name] = value;
        }
        if (Object.keys(values).length) (out.properties ??= {})[setId] = values;
        if (unread) this.lose(set, 'properties-partly-kept', 'IFCPROPERTYSET');
      } else this.lose(set, 'property-set-not-kept', 'IFCPROPERTYSET');
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Types.

  readTypes() {
    for (const t of this.g.file.entities.values()) {
      const kind = typeEntities[t.type];
      if (!kind) continue;
      this.seen.add(t.id);
      const ep = this.own ? this.g.props(t.id, 'EP_Constraints') : undefined;
      const bimId = text(ep?.get('BimId'));
      // A foreign type becomes a `bim` type when an element uses it (its layers or profile).
      if (!bimId) continue;
      try {
        const type = this.ownType(t, kind, bimId, ep!);
        this.idOf.set(t.id, type.id);
        this.doc.types.push(type);
      } catch (e) {
        this.lose(t, reasonOf(e));
      }
    }
  }
  ownType(
    t: P21Instance,
    kind: BimType['kind'],
    bimId: string,
    ep: Map<string, P21Value>,
  ): BimType {
    const base = {
      id: this.newId(bimId),
      name: text(t.args[2]) ?? bimId,
      ...this.described(t.id, kind),
    };
    const material = this.g.get(this.g.materialOf.get(t.id));
    switch (kind) {
      case 'wall':
      case 'slab':
      case 'roof':
        return { ...base, kind, layers: this.layers(material) };
      case 'column':
      case 'beam': {
        const mp = this.g.get(items(material?.args[2])[0]);
        if (material?.type !== 'IFCMATERIALPROFILESET' || !mp) return unsupported('type-profile');
        const materialId = this.idOf.get(this.g.get(mp.args[2])?.id ?? -1);
        if (!materialId) return unsupported('type-material');
        return { ...base, kind, profile: this.profile(this.g.get(mp.args[3])).profile, materialId };
      }
      case 'door':
      case 'window': {
        // The panel of the shared representation: its width and its extrusion's height.
        const map = this.g.get(items(t.args[6])[0]);
        const rep = this.g.get(map?.args[1]);
        const solid = this.g.get(items(rep?.args[3])[0]);
        const panel = this.g.get(solid?.args[0]);
        const widthMm = num(panel?.args[3]);
        const heightMm = num(solid?.args[3]);
        if (
          solid?.type !== 'IFCEXTRUDEDAREASOLID' ||
          widthMm === undefined ||
          heightMm === undefined
        )
          return unsupported('type-shape');
        return { ...base, kind, widthMm, heightMm };
      }
      case 'part': {
        const ref = this.g.props(t.id, 'EP_PartReference');
        const source = this.partSource(ref);
        if (!source) return unsupported('part-reference');
        const v = (n: string) => num(ep.get(n)) ?? NaN;
        return {
          ...base,
          kind,
          source,
          hintBounds: {
            min: [v('HintMinX'), v('HintMinY'), v('HintMinZ')],
            max: [v('HintMaxX'), v('HintMaxY'), v('HintMaxZ')],
          },
        };
      }
    }
  }
  partSource(ref: Map<string, P21Value> | undefined): BimIfcPartSource | undefined {
    const [artifactId, versionId, contentHash] = ['ArtifactId', 'VersionId', 'ContentHash'].map(
      (n) => text(ref?.get(n)),
    );
    return artifactId && versionId && contentHash
      ? { artifactId, versionId, contentHash }
      : undefined;
  }
  layers(set: P21Instance | undefined): BimLayer[] {
    const ls = set?.type === 'IFCMATERIALLAYERSETUSAGE' ? this.g.get(set.args[0]) : set;
    if (ls?.type !== 'IFCMATERIALLAYERSET') return unsupported('type-layers');
    return items(ls.args[0]).map((r) => {
      const l = this.g.get(r);
      const m = this.g.get(l?.args[0]);
      const thicknessMm = snap((num(l?.args[1]) ?? NaN) * this.mm);
      return { materialId: (m && this.idOf.get(m.id)) ?? this.fallbackMaterial(), thicknessMm };
    });
  }
  /** A parametric profile: its `bim` form, centre placement (mm) and height across. */
  profile(p: P21Instance | undefined): { profile: BimProfile; position: Xf; symmetric: boolean } {
    if (!p) return unsupported('profile');
    const n = (k: number) => {
      const v = num(p.args[k]);
      return v === undefined ? NaN : snap(v * this.mm);
    };
    const zero = (...ks: number[]) => ks.every((k) => !num(p.args[k]));
    const position = this.axis2(p.args[2]);
    let profile: BimProfile;
    let symmetric = true;
    switch (p.type) {
      case 'IFCRECTANGLEPROFILEDEF':
        profile = { shape: 'rect', widthMm: n(3), depthMm: n(4) };
        break;
      case 'IFCCIRCLEPROFILEDEF':
        profile = { shape: 'circle', diameterMm: n(3) * 2 };
        break;
      case 'IFCISHAPEPROFILEDEF':
        if (!zero(7, 8, 9)) return unsupported('profile-fillet');
        profile = { shape: 'h', widthMm: n(3), depthMm: n(4), webMm: n(5), flangeMm: n(6) };
        break;
      case 'IFCLSHAPEPROFILEDEF':
        if (!zero(6, 7, 8)) return unsupported('profile-fillet');
        profile = {
          shape: 'l',
          depthMm: n(3),
          widthMm: num(p.args[4]) === undefined ? n(3) : n(4),
          thicknessMm: n(5),
        };
        symmetric = false;
        break;
      case 'IFCUSHAPEPROFILEDEF':
        if (!zero(7, 8, 9)) return unsupported('profile-fillet');
        profile = { shape: 'channel', depthMm: n(3), widthMm: n(4), webMm: n(5), flangeMm: n(6) };
        symmetric = false;
        break;
      case 'IFCRECTANGLEHOLLOWPROFILEDEF':
        if (!zero(6, 7)) return unsupported('profile-fillet');
        profile = { shape: 'box', widthMm: n(3), depthMm: n(4), wallMm: n(5) };
        break;
      default:
        return unsupported('profile');
    }
    return { profile, position, symmetric };
  }

  // -------------------------------------------------------------------------------------------
  // Elements.

  readElements() {
    const g = this.g;
    // Openings filled by a door or window this import keeps belong to it.
    const products = [...g.file.entities.values()].filter((e) => elementEntities[e.type]);
    const hostedLast = [
      ...products.filter((e) => !['opening', 'door', 'window'].includes(elementEntities[e.type])),
      ...products.filter((e) => elementEntities[e.type] === 'opening'),
      ...products.filter((e) => ['door', 'window'].includes(elementEntities[e.type])),
    ];
    const kept = new Map<number, BimElement>();
    const filled = new Set(g.openingOf.values());
    const fills = new Set<number>();
    for (const e of hostedLast) {
      this.seen.add(e.id);
      const kind = elementEntities[e.type];
      const ep = this.own ? g.props(e.id, 'EP_Constraints') : undefined;
      try {
        if (ep && text(ep.get('BimId'))) {
          const el = this.ownElement(e, kind, ep);
          kept.set(e.id, el);
          this.restored.add(e.id);
        } else {
          if (kind === 'opening' && filled.has(e.id)) {
            // Decided below, once the doors and windows are read.
            continue;
          }
          const el = snapElement(this.foreignElement(e, kind));
          kept.set(e.id, el);
          this.foreign.add(e.id);
        }
      } catch (err) {
        this.lose(e, reasonOf(err));
      }
    }
    // Openings a kept door or window fills are part of it; others become plain openings.
    for (const [fill, opening] of g.openingOf) {
      const el = kept.get(fill);
      if (el && (el.kind === 'door' || el.kind === 'window')) fills.add(opening);
    }
    for (const e of hostedLast) {
      if (elementEntities[e.type] !== 'opening' || kept.has(e.id) || fills.has(e.id)) continue;
      if (!filled.has(e.id)) continue;
      try {
        const el = snapElement(this.foreignElement(e, 'opening'));
        kept.set(e.id, el);
        this.foreign.add(e.id);
      } catch (err) {
        this.lose(e, reasonOf(err));
      }
    }
    // File order: this product writes hosts before what they host, in document order.
    for (const e of products) {
      const el = kept.get(e.id);
      if (el) {
        this.idOf.set(e.id, el.id);
        this.doc.elements.push(el);
      }
    }
    // Hosts may come after their openings were assigned IDs: resolve them now.
    for (const el of this.doc.elements)
      if ('hostId' in el && el.hostId.startsWith('#')) {
        const host = this.idOf.get(Number(el.hostId.slice(1)));
        if (host) el.hostId = host;
      }
  }

  /** Identity, name and properties common to every element. */
  head(e: P21Instance, kind: BimElement['kind'], id: string, unnamed: boolean) {
    const globalId = text(e.args[0]);
    const name = kind === 'space' ? text(e.args[7]) : unnamed ? undefined : text(e.args[2]);
    return clean({
      id: this.newId(id),
      ...(name !== undefined ? { name } : {}),
      ...(globalId !== undefined ? { ifcGlobalId: globalId } : {}),
      ...this.described(e.id, kind),
    });
  }
  typeIdOf(e: P21Instance) {
    const t = this.g.typeOf.get(e.id);
    const id = t === undefined ? undefined : this.idOf.get(t);
    return id;
  }

  ownElement(e: P21Instance, kind: BimElement['kind'], ep: Map<string, P21Value>): BimElement {
    const bimId = text(ep.get('BimId'))!;
    const head = this.head(e, kind, bimId, flag(ep.get('Unnamed')) === true);
    const len = (n: string) => {
      const v = num(ep.get(n));
      return v === undefined ? unsupported('constraint-missing') : v;
    };
    const ident = (n: string) => text(ep.get(n));
    const height = (prefix: string): BimLevelHeight => {
      const level = this.levelByGlobalId(ident(`${prefix}Level`));
      if (!level) return unsupported('constraint-level');
      return { level, offsetMm: len(`${prefix}Offset`) };
    };
    const top = (): BimTop =>
      ep.has('TopHeight') ? { heightMm: len('TopHeight') } : height('Top');
    const point = (prefix: string): BimPoint => {
      const a = ident(`${prefix}GridA`);
      const b = ident(`${prefix}GridB`);
      return a !== undefined && b !== undefined
        ? { grid: [a, b] }
        : { xy: [len(`${prefix}X`), len(`${prefix}Y`)] };
    };
    const loop = (name: string): BimLoop => {
      const xy = items(ep.get(name)).map((v) => num(v) ?? NaN);
      const bulge = items(ep.get(`${name}Bulge`)).map((v) => num(v) ?? NaN);
      if (!xy.length || xy.length !== bulge.length * 2) return unsupported('constraint-loop');
      return bulge.map(
        (b, i): BimLoopVertex => (b ? [xy[2 * i], xy[2 * i + 1], b] : [xy[2 * i], xy[2 * i + 1]]),
      );
    };
    const typeId = () => this.typeIdOf(e) ?? unsupported('type-missing');
    const host = () => {
      const opening = kind === 'door' || kind === 'window' ? this.g.openingOf.get(e.id) : e.id;
      const h = opening === undefined ? undefined : this.g.hostOf.get(opening);
      if (h === undefined) return unsupported('host-missing');
      return `#${h}`;
    };
    const clipBy = ident('ClipBy');
    switch (kind) {
      case 'wall': {
        const bulge = num(ep.get('Bulge'));
        return clean({
          ...head,
          kind,
          typeId: typeId(),
          start: point('Start'),
          end: point('End'),
          ...(bulge !== undefined ? { bulge } : {}),
          location: (ident('Location') ?? 'center') as BimWall['location'],
          base: height('Base'),
          top: top(),
          ...(clipBy !== undefined ? { clipBy } : {}),
        });
      }
      case 'slab': {
        const holes: BimLoop[] = [];
        for (let i = 1; ep.has(`Hole${i}`); i++) holes.push(loop(`Hole${i}`));
        return {
          ...head,
          kind,
          typeId: typeId(),
          top: height('Top'),
          boundary: loop('Boundary'),
          holes,
        };
      }
      case 'column':
        return clean({
          ...head,
          kind,
          typeId: typeId(),
          at: point('At'),
          rotationRad: len('Rotation'),
          base: height('Base'),
          top: top(),
          ...(clipBy !== undefined ? { clipBy } : {}),
        });
      case 'beam':
        return {
          ...head,
          kind,
          typeId: typeId(),
          start: point('Start'),
          end: point('End'),
          top: height('Top'),
        };
      case 'roof': {
        const form = ident('Form');
        return {
          ...head,
          kind,
          typeId: typeId(),
          base: height('Base'),
          boundary: loop('Boundary'),
          shape:
            form === 'mono'
              ? { form, slopeRad: len('Slope'), directionRad: len('Direction') }
              : form === 'gable'
                ? { form, slopeRad: len('Slope'), ridgeRad: len('Ridge') }
                : form === 'hip'
                  ? { form, slopeRad: len('Slope') }
                  : form === 'flat'
                    ? { form }
                    : unsupported('constraint-roof'),
        };
      }
      case 'space':
        return clean({
          ...head,
          kind,
          number: text(e.args[2]) ?? '',
          base: height('Base'),
          ...(ep.has('TopHeight') || ep.has('TopLevel') ? { top: top() } : {}),
          boundary: loop('Boundary'),
        });
      case 'part': {
        const t = this.doc.types.find((x) => x.id === this.typeIdOf(e));
        if (t?.kind !== 'part') return unsupported('type-missing');
        // Shape-only parts are not kept (R2c-U5): the version must resolve.
        if (!this.options.resolvePart?.(t.source)) return unsupported('part-unresolved');
        return {
          ...head,
          kind,
          typeId: t.id,
          at: point('At'),
          base: height('Base'),
          rotationRad: len('Rotation'),
        };
      }
      case 'opening':
        return ep.has('Boundary')
          ? { ...head, kind, hostId: host(), slab: { boundary: loop('Boundary') } }
          : {
              ...head,
              kind,
              hostId: host(),
              wall: {
                alongMm: len('Along'),
                sillMm: len('Sill'),
                widthMm: len('Width'),
                heightMm: len('Height'),
              },
            };
      case 'door':
        return {
          ...head,
          kind,
          typeId: typeId(),
          hostId: host(),
          alongMm: len('Along'),
          flipFacing: flag(ep.get('FlipFacing')) ?? false,
          flipHand: flag(ep.get('FlipHand')) ?? false,
        };
      case 'window':
        return {
          ...head,
          kind,
          typeId: typeId(),
          hostId: host(),
          alongMm: len('Along'),
          sillMm: len('Sill'),
          flipFacing: flag(ep.get('FlipFacing')) ?? false,
        };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Elements of other software: shapes at fixed heights and coordinates.

  /** The element's only `Body` item, unwrapping nothing. */
  body(e: P21Instance): P21Instance {
    const shape = this.g.get(e.args[6]);
    const reps = items(shape?.args[2]).map((r) => this.g.get(r));
    const body =
      reps.find((r) => text(r?.args[1]) === 'Body') ?? (reps.length === 1 ? reps[0] : undefined);
    const its = items(body?.args[3]).map((r) => this.g.get(r));
    if (!body || its.length !== 1 || !its[0]) return unsupported('shape-unsupported');
    return its[0];
  }
  /** A vertical extrusion of a profile in world plan coordinates. */
  extrusion(solid: P21Instance, placement: Xf) {
    if (solid.type !== 'IFCEXTRUDEDAREASOLID') return unsupported('shape-unsupported');
    const xf = compose(placement, this.axis2(solid.args[1]));
    const d = dirOf(xf, this.direction(solid.args[2], [0, 0, 1]));
    const depth = (num(solid.args[3]) ?? NaN) * this.mm;
    if (!(depth > 0)) return unsupported('shape-unsupported');
    return { xf, d, depth, profile: this.g.get(solid.args[0]) };
  }
  /** Outer and inner loops of an area profile, in world plan coordinates. */
  areaLoops(profile: P21Instance | undefined, xf: Xf): { outer: BimLoop; holes: BimLoop[] } {
    if (!parallel(xf.z, [0, 0, 1]) && !parallel(xf.z, [0, 0, -1]))
      return unsupported('shape-not-vertical');
    const toWorld =
      (pos: Xf) =>
      (loop: BimLoop): BimLoop => {
        const flipped = xf.z[2] < 0 !== pos.z[2] < 0;
        const out = loop.map((v): BimLoopVertex => {
          const w = pointOf(compose(xf, pos), [v[0], v[1], 0]);
          return v[2] ? [w[0], w[1], flipped ? -v[2] : v[2]] : [w[0], w[1]];
        });
        return out;
      };
    if (
      profile?.type === 'IFCARBITRARYCLOSEDPROFILEDEF' ||
      profile?.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS'
    ) {
      const w = toWorld(identity);
      return {
        outer: w(this.curveLoop(profile.args[2])),
        holes:
          profile.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS'
            ? items(profile.args[3]).map((c) => w(this.curveLoop(c)))
            : [],
      };
    }
    if (profile?.type === 'IFCRECTANGLEPROFILEDEF') {
      const pos = this.axis2(profile.args[2]);
      const [x, y] = [
        ((num(profile.args[3]) ?? NaN) * this.mm) / 2,
        ((num(profile.args[4]) ?? NaN) * this.mm) / 2,
      ];
      return {
        outer: toWorld(pos)([
          [-x, -y],
          [x, -y],
          [x, y],
          [-x, y],
        ]),
        holes: [],
      };
    }
    return unsupported('profile');
  }
  /** A closed curve as a loop: a polyline, or an indexed poly curve of lines and arcs. */
  curveLoop(v: P21Value | undefined): BimLoop {
    const c = this.g.get(v);
    const close = (pts: Vec2[]) => {
      const last = pts[pts.length - 1];
      if (pts.length > 1 && near(last[0], pts[0][0], 1e-9) && near(last[1], pts[0][1], 1e-9))
        pts = pts.slice(0, -1);
      return pts.map((p): BimLoopVertex => [p[0], p[1]]);
    };
    if (c?.type === 'IFCPOLYLINE') return close(this.polyline(v));
    if (c?.type !== 'IFCINDEXEDPOLYCURVE') return unsupported('curve');
    const pts = this.pointList(c.args[0]);
    const segments = items(c.args[1]);
    if (!segments.length) return close(pts);
    const loop: BimLoopVertex[] = [];
    let first: number | undefined;
    let last: number | undefined;
    for (const s of segments) {
      const idx = items(plain(s)).map((x) => (num(x) ?? NaN) - 1);
      if (idx.some((k) => !(k >= 0 && k < pts.length)) || (last !== undefined && idx[0] !== last))
        return unsupported('curve');
      first ??= idx[0];
      const name = typeName(s);
      if (name === 'IFCLINEINDEX') {
        for (const k of idx.slice(0, -1)) loop.push([pts[k][0], pts[k][1]]);
      } else if (name === 'IFCARCINDEX' && idx.length === 3) {
        const [a, m, b] = idx.map((k) => pts[k]);
        loop.push([a[0], a[1], bulgeThrough(a, m, b)]);
      } else return unsupported('curve');
      last = idx[idx.length - 1];
    }
    if (last !== first) return unsupported('curve-open');
    return loop;
  }

  /** The storey an element is in, else the highest storey at or below `z`. */
  levelFor(e: P21Instance, z: number): BimLevel {
    let c = this.g.container.get(e.id);
    for (let i = 0; c !== undefined && i < 8; i++) {
      const id = this.idOf.get(c);
      const level = id && this.doc.levels.find((l) => l.id === id);
      if (level) return level;
      c = this.g.parent.get(c);
    }
    const below = this.doc.levels.filter((l) => l.elevationMm <= z + 1e-6);
    const pool = below.length ? below : this.doc.levels;
    if (!pool.length) return unsupported('no-storey');
    return pool.reduce((a, b) =>
      (below.length ? b.elevationMm > a.elevationMm : b.elevationMm < a.elevationMm) ? b : a,
    );
  }

  foreignElement(e: P21Instance, kind: BimElement['kind']): BimElement {
    const head = this.head(e, kind, `ifc-${text(e.args[0]) ?? e.id}`, false);
    const placement = this.world(e.args[5]);
    switch (kind) {
      case 'wall':
        return this.foreignWall(e, head, placement);
      case 'slab': {
        const x = this.extrusion(this.body(e), placement);
        if (!parallel(x.d, [0, 0, 1]) && !parallel(x.d, [0, 0, -1]))
          return unsupported('shape-not-vertical');
        const { outer, holes } = this.areaLoops(x.profile, x.xf);
        const zTop = Math.max(x.xf.o[2], x.xf.o[2] + x.d[2] * x.depth);
        const level = this.levelFor(e, zTop);
        const typeId = this.layeredType(e, 'slab', x.depth);
        return {
          ...head,
          kind,
          typeId,
          top: { level: level.id, offsetMm: zTop - level.elevationMm },
          boundary: outer,
          holes,
        };
      }
      case 'roof': {
        const x = this.extrusion(this.body(e), placement);
        if (!parallel(x.d, [0, 0, 1])) return unsupported('shape-not-vertical');
        const { outer, holes } = this.areaLoops(x.profile, x.xf);
        if (holes.length) return unsupported('roof-holes');
        const z = x.xf.o[2];
        const level = this.levelFor(e, z);
        const typeId = this.layeredType(e, 'roof', x.depth);
        return {
          ...head,
          kind,
          typeId,
          base: { level: level.id, offsetMm: z - level.elevationMm },
          boundary: outer,
          shape: { form: 'flat' },
        };
      }
      case 'space': {
        const x = this.extrusion(this.body(e), placement);
        if (!parallel(x.d, [0, 0, 1])) return unsupported('shape-not-vertical');
        const { outer, holes } = this.areaLoops(x.profile, x.xf);
        if (holes.length) return unsupported('space-holes');
        const z = x.xf.o[2];
        const level = this.levelFor(e, z);
        return clean({
          ...head,
          kind,
          number: text(e.args[2]) ?? head.id,
          base: { level: level.id, offsetMm: z - level.elevationMm },
          top: { heightMm: x.depth },
          boundary: outer,
        });
      }
      case 'column': {
        const x = this.extrusion(this.body(e), placement);
        if (!parallel(x.d, [0, 0, 1]) || !parallel(x.xf.z, [0, 0, 1]))
          return unsupported('shape-not-vertical');
        const { profile, position } = this.profile(x.profile);
        const centre = compose(x.xf, position);
        const level = this.levelFor(e, centre.o[2]);
        // A grid point only where the column's centre is the intersection itself.
        const gp =
          this.g.get(e.args[5])?.type === 'IFCGRIDPLACEMENT'
            ? this.gridPlacement(this.g.get(e.args[5])!)
            : undefined;
        const grid =
          gp?.grid && near(gp.xf.o[0], centre.o[0]) && near(gp.xf.o[1], centre.o[1])
            ? gp.grid
            : undefined;
        return {
          ...head,
          kind,
          typeId: this.profiledType(e, 'column', profile),
          at: grid ?? { xy: [centre.o[0], centre.o[1]] },
          rotationRad: Math.atan2(centre.x[1], centre.x[0]) || 0,
          base: { level: level.id, offsetMm: centre.o[2] - level.elevationMm },
          top: { heightMm: x.depth },
        };
      }
      case 'beam': {
        const x = this.extrusion(this.body(e), placement);
        const { profile, position, symmetric } = this.profile(x.profile);
        const frame = compose(x.xf, position);
        // Horizontal, the profile's Y up, its X to the left of the run (as `bim-core` places it).
        // Swept along the profile's normal: an oblique sweep is not a `bim` beam.
        if (
          Math.abs(x.d[2]) > 1e-9 ||
          !parallel(frame.y, [0, 0, 1]) ||
          !(parallel(x.d, frame.z) || parallel(x.d, v3.scale(frame.z, -1)))
        )
          return unsupported('beam-orientation');
        const run = v3.scale(x.d, x.depth);
        const dir = unit([run[0], run[1]]);
        if (!symmetric && !parallel(frame.x, [...left(dir), 0] as Vec3))
          return unsupported('beam-orientation');
        const h = profile.shape === 'circle' ? profile.diameterMm : profile.depthMm;
        const zTop = frame.o[2] + h / 2;
        const level = this.levelFor(e, frame.o[2]);
        return {
          ...head,
          kind,
          typeId: this.profiledType(e, 'beam', profile),
          start: { xy: [frame.o[0], frame.o[1]] },
          end: { xy: [frame.o[0] + run[0], frame.o[1] + run[1]] },
          top: { level: level.id, offsetMm: zTop - level.elevationMm },
        };
      }
      case 'opening':
        return this.foreignOpening(e, head, placement);
      case 'part':
        return unsupported(
          this.g.props(e.id, 'EP_PartReference') ? 'part-unresolved' : 'shape-only',
        );
      default:
        return unsupported('not-in-subset');
    }
  }

  foreignWall(e: P21Instance, head: ReturnType<Importer['head']>, placement: Xf): BimWall {
    let item = this.body(e);
    let clipZ: number | undefined;
    if (item.type === 'IFCBOOLEANCLIPPINGRESULT') {
      clipZ = this.clipPlane(this.g.get(item.args[2]), placement);
      if (clipZ === undefined || enumValue(item.args[0]) !== 'DIFFERENCE')
        return unsupported('clip-not-roof');
      item = this.g.get(item.args[1]) ?? unsupported('shape-unsupported');
    }
    const x = this.extrusion(item, placement);
    if (!parallel(x.d, [0, 0, 1]) || !parallel(x.xf.z, [0, 0, 1]))
      return unsupported('shape-not-vertical');
    const { outer, holes } = this.areaLoops(x.profile, x.xf);
    if (holes.length || outer.length !== 4 || outer.some((v) => v[2]))
      return unsupported('wall-shape');
    const p = outer.map((v): Vec2 => [v[0], v[1]]);
    const edges = p.map((a, i) => sub(p[(i + 1) % 4], a));
    const lens = edges.map((d) => Math.hypot(...d));
    const rect =
      edges.every(
        (d, i) => Math.abs(dot(d, edges[(i + 1) % 4])) <= 1e-9 * lens[i] * lens[(i + 1) % 4],
      ) &&
      near(lens[0], lens[2], 1e-9) &&
      near(lens[1], lens[3], 1e-9);
    if (!rect) return unsupported('wall-shape');
    // The axis runs through the middle along the sides the Axis representation follows, else
    // across the sides as thick as the layers, else along the long sides.
    const axis = this.axisOf(e, placement);
    let k: number;
    if (axis) {
      const d = unit(sub(axis[1], axis[0]));
      const along = [0, 1].filter((i) => Math.abs(cross(edges[i], d)) <= 1e-9 * lens[i]);
      if (along.length !== 1) return unsupported('wall-shape');
      k = along[0];
    } else {
      const totals = this.layerTotals(e);
      const across = [0, 1].filter((i) => totals.some((t) => near(t, lens[i], 1e-6)));
      k = across.length === 1 ? 1 - across[0] : lens[0] >= lens[1] ? 0 : 1;
    }
    const thickness = lens[k + 1];
    const half = edges[k + 1].map((c) => c / 2) as Vec2;
    let s: Vec2 = [p[k][0] + half[0], p[k][1] + half[1]];
    let end: Vec2 = [s[0] + edges[k][0], s[1] + edges[k][1]];
    // Keep the Axis representation's direction when there is one.
    if (axis && dot(sub(axis[1], axis[0]), sub(end, s)) < 0) [s, end] = [end, s];
    const zBase = x.xf.o[2];
    const level = this.levelFor(e, zBase);
    const wall = clean({
      ...head,
      kind: 'wall',
      typeId: this.layeredType(e, 'wall', thickness),
      start: { xy: s },
      end: { xy: end },
      location: 'center',
      base: { level: level.id, offsetMm: zBase - level.elevationMm },
      top: { heightMm: x.depth },
    }) as BimWall;
    if (clipZ !== undefined) this.clipPlanes.set(wall, clipZ);
    return wall;
  }
  axisOf(e: P21Instance, placement: Xf): [Vec2, Vec2] | undefined {
    const shape = this.g.get(e.args[6]);
    const rep = items(shape?.args[2])
      .map((r) => this.g.get(r))
      .find((r) => text(r?.args[1]) === 'Axis');
    const pts = this.polyline(items(rep?.args[3])[0]);
    if (pts.length !== 2) return undefined;
    return pts.map((q) => {
      const w = pointOf(placement, [q[0], q[1], 0]);
      return [w[0], w[1]] as Vec2;
    }) as [Vec2, Vec2];
  }
  /**
   * A horizontal half-space removing what lies above: the height of its plane, to be matched
   * with a flat roof's underside once the roofs are read (`clipPlanes`).
   */
  clipPlane(half: P21Instance | undefined, placement: Xf): number | undefined {
    if (half?.type !== 'IFCHALFSPACESOLID') return undefined;
    const plane = this.g.get(half.args[0]);
    if (plane?.type !== 'IFCPLANE') return undefined;
    const pos = compose(placement, this.axis2(plane.args[0]));
    if (!parallel(pos.z, [0, 0, 1]) && !parallel(pos.z, [0, 0, -1])) return undefined;
    // AgreementFlag false: the half-space lies on the normal's side, which DIFFERENCE removes.
    const removedUp = pos.z[2] > 0 === (flag(half.args[1]) === false);
    return removedUp ? pos.o[2] : undefined;
  }
  foreignOpening(e: P21Instance, head: ReturnType<Importer['head']>, placement: Xf): BimElement {
    const hostInst = this.g.hostOf.get(e.id);
    if (hostInst === undefined) return unsupported('host-missing');
    const hostRef = `#${hostInst}`;
    const hostKind = elementEntities[this.g.get(hostInst)?.type ?? ''];
    const x = this.extrusion(this.body(e), placement);
    if (hostKind === 'slab') {
      if (!parallel(x.d, [0, 0, 1]) && !parallel(x.d, [0, 0, -1]))
        return unsupported('opening-shape');
      const { outer, holes } = this.areaLoops(x.profile, x.xf);
      if (holes.length) return unsupported('opening-shape');
      const zs = [x.xf.o[2], x.xf.o[2] + x.d[2] * x.depth];
      // Checked against the host's thickness in `settle`.
      const z = [Math.min(...zs), Math.max(...zs)];
      return {
        ...head,
        kind: 'opening',
        hostId: hostRef,
        slab: { boundary: outer, z } as { boundary: BimLoop },
      };
    }
    if (hostKind !== 'wall') return unsupported('opening-host');
    // A box: a rectangle swept straight. Its corners, measured along the host wall later.
    const profile = x.profile;
    let corners: Vec3[];
    if (profile?.type === 'IFCRECTANGLEPROFILEDEF') {
      const pos = this.axis2(profile.args[2]);
      const [hx, hy] = [
        ((num(profile.args[3]) ?? NaN) * this.mm) / 2,
        ((num(profile.args[4]) ?? NaN) * this.mm) / 2,
      ];
      corners = [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy],
        [-hx, hy],
      ].map((c) => pointOf(compose(x.xf, pos), [c[0], c[1], 0]));
    } else if (profile?.type === 'IFCARBITRARYCLOSEDPROFILEDEF') {
      const loop = this.curveLoop(profile.args[2]);
      if (loop.length !== 4 || loop.some((v) => v[2])) return unsupported('opening-shape');
      corners = loop.map((v) => pointOf(x.xf, [v[0], v[1], 0]));
    } else return unsupported('opening-shape');
    const run = v3.scale(x.d, x.depth);
    const box = [...corners, ...corners.map((c) => v3.add(c, run))];
    return {
      ...head,
      kind: 'opening',
      hostId: hostRef,
      // Resolved against the host's axis in `settle`.
      wall: { box } as unknown as {
        alongMm: number;
        sillMm: number;
        widthMm: number;
        heightMm: number;
      },
    };
  }

  /** A wall, slab or roof type with layers totalling `thickness`: the element's own, else made. */
  /** The thicknesses of the layer sets the element or its type is given. */
  layerTotals(e: P21Instance): number[] {
    const typeInst = this.g.typeOf.get(e.id);
    const totals: number[] = [];
    for (const c of [
      this.g.materialOf.get(e.id),
      typeInst === undefined ? undefined : this.g.materialOf.get(typeInst),
    ]) {
      const m = this.g.get(c);
      if (m?.type !== 'IFCMATERIALLAYERSETUSAGE' && m?.type !== 'IFCMATERIALLAYERSET') continue;
      try {
        totals.push(this.layers(m).reduce((n, l) => n + l.thicknessMm, 0));
      } catch {
        continue;
      }
    }
    return totals;
  }
  layeredType(e: P21Instance, kind: 'wall' | 'slab' | 'roof', thickness: number): string {
    const typeInst = this.g.typeOf.get(e.id);
    const candidates = [
      this.g.materialOf.get(e.id),
      typeInst === undefined ? undefined : this.g.materialOf.get(typeInst),
    ];
    for (const c of candidates) {
      const m = this.g.get(c);
      if (m?.type !== 'IFCMATERIALLAYERSETUSAGE' && m?.type !== 'IFCMATERIALLAYERSET') continue;
      let layers: BimLayer[];
      try {
        layers = this.layers(m);
      } catch {
        continue;
      }
      const total = layers.reduce((s, l) => s + l.thicknessMm, 0);
      if (near(total, thickness, 1e-6))
        return this.typeFor(kind, typeInst, `layers:${JSON.stringify(layers)}`, { layers });
    }
    const single = this.g.get(candidates.find((c) => this.g.get(c)?.type === 'IFCMATERIAL'));
    const materialId = (single && this.idOf.get(single.id)) ?? this.fallbackMaterial();
    return this.typeFor(kind, typeInst, `${materialId}:${thickness}`, {
      layers: [{ materialId, thicknessMm: thickness }],
    });
  }
  profiledType(e: P21Instance, kind: 'column' | 'beam', profile: BimProfile): string {
    const typeInst = this.g.typeOf.get(e.id);
    let materialId: string | undefined;
    for (const c of [
      this.g.materialOf.get(e.id),
      typeInst === undefined ? undefined : this.g.materialOf.get(typeInst),
    ]) {
      let m = this.g.get(c);
      if (m?.type === 'IFCMATERIALPROFILESETUSAGE') m = this.g.get(m.args[0]);
      if (m?.type === 'IFCMATERIALPROFILESET')
        m = this.g.get(this.g.get(items(m.args[2])[0])?.args[2]);
      if (m?.type === 'IFCMATERIAL') {
        materialId = this.idOf.get(m.id);
        break;
      }
    }
    materialId ??= this.fallbackMaterial();
    return this.typeFor(kind, typeInst, `${materialId}:${JSON.stringify(profile)}`, {
      profile,
      materialId,
    });
  }
  private madeTypes = new Map<string, string>();
  typeFor(kind: BimType['kind'], typeInst: number | undefined, key: string, body: object): string {
    const k = `${kind}\u0000${typeInst ?? ''}\u0000${key}`;
    const known = this.madeTypes.get(k);
    if (known) return known;
    const t = typeInst === undefined ? undefined : this.g.get(typeInst);
    const name =
      text(t?.args[2]) ?? `${kind[0].toUpperCase()}${kind.slice(1)} ${this.doc.types.length + 1}`;
    const id = this.newId(`ifc-${text(t?.args[0]) ?? `${kind}-type`}`);
    const type = { id, kind, name, ...(t ? this.described(t.id, kind) : {}), ...body } as BimType;
    this.doc.types.push(type);
    this.madeTypes.set(k, id);
    return id;
  }

  /** IfcGridPlacement: the intersection of two grid axes, as a grid point when offsets are zero. */
  gridPlacement(p: P21Instance): { xf: Xf; grid?: BimPoint } {
    const at = this.gridIntersection(this.g.get(p.args[0]));
    // Without a reference direction, X runs along the first axis.
    let x: Vec3 = [at.along[0], at.along[1], 0];
    const ref = this.g.get(p.args[1]);
    if (ref?.type === 'IFCDIRECTION') x = this.direction(p.args[1], [1, 0, 0]);
    else if (ref?.type === 'IFCVIRTUALGRIDINTERSECTION') {
      const to = this.gridIntersection(ref).o;
      x = [to[0] - at.o[0], to[1] - at.o[1], 0];
      if (Math.hypot(x[0], x[1]) < 1e-9) return unsupported('placement');
    } else if (ref) return unsupported('placement');
    const xh = v3.unit([x[0], x[1], 0]);
    return { xf: { o: at.o, x: xh, y: [-xh[1], xh[0], 0], z: [0, 0, 1] }, grid: at.grid };
  }
  /**
   * IfcVirtualGridIntersection: where the two axes meet, each first moved by its offset along
   * its normal (then up by the third offset), and the first axis's direction.
   */
  gridIntersection(vgi: P21Instance | undefined): { o: Vec3; along: Vec2; grid?: BimPoint } {
    if (vgi?.type !== 'IFCVIRTUALGRIDINTERSECTION') return unsupported('placement');
    const axes = items(vgi.args[0]).map((r) => this.g.get(r));
    const offsets = items(vgi.args[1]).map((v) => (num(v) ?? 0) * this.mm);
    const lines = axes.map((a, i) => {
      const grid = this.g
        .all('IFCGRID')
        .find((gr) =>
          [...items(gr.args[7]), ...items(gr.args[8]), ...items(gr.args[9])].some(
            (r) => r.t === 'ref' && r.id === a?.id,
          ),
        );
      const pts = a ? this.polyline(a.args[1]) : [];
      if (!grid || pts.length !== 2) return unsupported('placement');
      const xf = this.world(grid.args[5]);
      const [p0, p1] = pts.map((q) => pointOf(xf, [q[0], q[1], 0]));
      // SameSense false: the axis runs against its curve, and its offsets with it.
      const sense = flag(a!.args[2]) === false ? -1 : 1;
      const d = unit([(p1[0] - p0[0]) * sense, (p1[1] - p0[1]) * sense]);
      const n = left(d);
      const off = offsets[i] ?? 0;
      const from: Vec2 = [p0[0] + n[0] * off, p0[1] + n[1] * off];
      return { from, d, z: xf.o[2], axis: a! };
    });
    if (lines.length !== 2) return unsupported('placement');
    const [l1, l2] = lines;
    const den = cross(l1.d, l2.d);
    if (Math.abs(den) < 1e-12) return unsupported('placement');
    const t = cross(sub(l2.from, l1.from), l2.d) / den;
    const o: Vec3 = [l1.from[0] + l1.d[0] * t, l1.from[1] + l1.d[1] * t, l1.z + (offsets[2] ?? 0)];
    const ids = [this.idOf.get(l1.axis.id), this.idOf.get(l2.axis.id)];
    const grid =
      !offsets[0] && !offsets[1] && ids[0] && ids[1]
        ? ({ grid: [ids[0], ids[1]] } as BimPoint)
        : undefined;
    return { o, along: l1.d, grid };
  }

  // -------------------------------------------------------------------------------------------
  // Joins and views.

  readJoins(own: boolean) {
    const rels = this.g.all('IFCRELCONNECTSPATHELEMENTS');
    rels.forEach((r) => this.seen.add(r.id));
    if (own) {
      for (const [id, ref] of this.g.props(this.project.id, 'EP_Joins') ?? []) {
        const c = this.complex(ref);
        const through = text(c.get('Through'));
        this.doc.joins.push(
          clean({
            id: this.newId(id),
            walls: [text(c.get('WallA')) ?? '', text(c.get('WallB')) ?? ''] as [string, string],
            kind: (text(c.get('Kind')) ?? 'butt') as BimWallJoin['kind'],
            ...(through !== undefined ? { through } : {}),
          }),
        );
      }
      return;
    }
    for (const r of rels) {
      const a = this.g.get(r.args[5]);
      const b = this.g.get(r.args[6]);
      const ids = [a, b].map((x) => x && this.idOf.get(x.id));
      const walls = [a, b].map(
        (x) => x && this.doc.elements.find((el) => el.id === this.idOf.get(x.id)),
      );
      if (!ids[0] || !ids[1] || walls.some((w) => w?.kind !== 'wall')) {
        this.lose(r, 'join-walls-missing');
        continue;
      }
      const kind = text(r.args[2]) === 'miter' ? 'miter' : 'butt';
      const relating = items(r.args[7]).length > 0;
      const id = this.newId(`ifc-${text(r.args[0]) ?? r.id}`);
      this.foreignJoins.add(id);
      this.joinInst.set(id, r);
      this.doc.joins.push({
        id,
        walls: [ids[0], ids[1]],
        kind,
        ...(kind === 'butt' && relating ? { through: ids[0] } : {}),
      });
    }
  }
  readViews() {
    for (const [id, ref] of this.g.props(this.project.id, 'EP_Views') ?? []) {
      const c = this.complex(ref);
      const n = (k: string) => num(c.get(k)) ?? NaN;
      const common = {
        id: this.newId(id),
        name: text(c.get('Name')) ?? id,
        depthMm: n('Depth'),
        scale: n('Scale') as BimView['scale'],
      };
      const view: BimView =
        text(c.get('Kind')) === 'plan'
          ? {
              ...common,
              kind: 'plan',
              level: this.levelByGlobalId(text(c.get('Level'))) ?? '',
              cutHeightMm: n('CutHeight'),
            }
          : {
              ...common,
              kind: 'section',
              line: [
                [n('StartX'), n('StartY')],
                [n('EndX'), n('EndY')],
              ],
              direction: text(c.get('Direction')) === 'right' ? 'right' : 'left',
            };
      // Key order as the model writes it.
      this.doc.views.push(view);
    }
  }

  // -------------------------------------------------------------------------------------------

  /** Lists every root the import did not read. */
  sweep() {
    for (const e of this.g.file.entities.values()) {
      if (this.seen.has(e.id) || structural.has(e.type)) continue;
      // Roots carry a GlobalId first; property definitions and resources are not listed.
      const gid = text(e.args[0]);
      if (
        gid === undefined ||
        gid.length !== 22 ||
        e.type.endsWith('TYPE') ||
        e.type.endsWith('STYLE')
      )
        continue;
      this.lose(e, 'not-in-subset');
    }
    // Foreign types no element used are information, not content: not listed.
  }

  /**
   * Resolves what waited for the hosts (opening boxes, clipping roofs), then drops foreign
   * content the document rules refuse, until the rest validates.
   */
  settle() {
    const doc = this.doc;
    const refused: [string, string][] = [];
    for (const el of doc.elements) {
      const z = el.kind === 'wall' ? this.clipPlanes.get(el) : undefined;
      if (el.kind === 'wall' && z !== undefined) {
        // A flat roof whose underside is the clipping plane and whose outline holds the wall.
        const at: Vec2 | undefined =
          'xy' in el.start && 'xy' in el.end
            ? [(el.start.xy[0] + el.end.xy[0]) / 2, (el.start.xy[1] + el.end.xy[1]) / 2]
            : undefined;
        const roof = doc.elements.find(
          (r) =>
            r.kind === 'roof' &&
            r.shape.form === 'flat' &&
            near(this.levelZ(r.base), z) &&
            at !== undefined &&
            pointInLoop(at, loopEdges(r.boundary)),
        );
        if (roof) el.clipBy = roof.id;
        else refused.push([el.id, 'clip-not-roof']);
      }
      if (el.kind === 'opening' && 'slab' in el && 'z' in el.slab) {
        // Through the whole slab: `bim-core` cuts every slab opening through its thickness.
        const { z, ...slab } = el.slab as { boundary: BimLoop; z: number[] };
        el.slab = slab;
        const host = doc.elements.find((h) => h.id === el.hostId);
        const top = host?.kind === 'slab' ? this.levelZ(host.top) : NaN;
        const bottom = host?.kind === 'slab' ? top - this.thickness(host) : NaN;
        if (!(z[0] <= bottom + 1e-6 && z[1] >= top - 1e-6)) refused.push([el.id, 'opening-shape']);
        continue;
      }
      if (el.kind !== 'opening' || !('wall' in el) || !('box' in (el.wall as object))) continue;
      const box = (el.wall as unknown as { box: Vec3[] }).box;
      const host = doc.elements.find((h) => h.id === el.hostId);
      if (host?.kind !== 'wall' || host.bulge || !('xy' in host.start) || !('xy' in host.end)) {
        refused.push([el.id, 'opening-shape']);
        continue;
      }
      const s = host.start.xy;
      const d = unit(sub(host.end.xy, s));
      const n = left(d);
      const along = box.map((c) => dot(sub([c[0], c[1]], s), d));
      const across = box.map((c) => dot(sub([c[0], c[1]], s), n));
      const zs = box.map((c) => c[2]);
      // Every corner on one of two values along each of the wall's directions: a box aligned
      // with the wall, reaching through it.
      const two = (v: number[]) => new Set(v.map((x) => Math.round(x * 1e6) / 1e6)).size === 2;
      const t = this.thickness(host);
      if (
        !two(along) ||
        !two(across) ||
        !two(zs) ||
        Math.min(...across) > -t / 2 + 1e-6 ||
        Math.max(...across) < t / 2 - 1e-6
      ) {
        refused.push([el.id, 'opening-shape']);
        continue;
      }
      el.wall = {
        alongMm: snap(Math.min(...along)),
        sillMm: snap(Math.min(...zs) - this.levelZ(host.base)),
        widthMm: snap(Math.max(...along) - Math.min(...along)),
        heightMm: snap(Math.max(...zs) - Math.min(...zs)),
      };
    }
    for (const [id, reason] of refused) this.drop(id, reason);
    this.keepJoins();
    // Drop foreign elements, joins and types the rules refuse; the restored ones must hold.
    for (let round = 0; round < 8; round++) {
      const problems = validateBim(doc).filter((d) => d.severity === 'error');
      if (!problems.length) return;
      const foreignIds = new Set(
        [...this.foreign].map((i) => this.idOf.get(i)).filter((x): x is string => x !== undefined),
      );
      const joinIds = this.foreignJoins;
      const culprits = new Map<string, string>();
      const badTypes = new Set<string>();
      const made = new Set(this.madeTypes.values());
      for (const p of problems) {
        const typeId = this.typeAt(p);
        // A type made for foreign elements goes with the elements using it.
        const users = typeId
          ? doc.elements.filter((e) => 'typeId' in e && e.typeId === typeId).map((e) => e.id)
          : [];
        const ids = typeId ? users : [p.id ?? this.idAt(p)];
        // Restored content and the document itself must hold as written.
        if (
          (typeId && !made.has(typeId)) ||
          !ids.every((id) => id && (foreignIds.has(id) || joinIds.has(id)))
        )
          throw new BimIfcImportError('invalid-document', problems.map(describe));
        if (typeId) badTypes.add(typeId);
        for (const id of ids) if (!culprits.has(id!)) culprits.set(id!, p.code);
      }
      for (const [id, code] of culprits) this.drop(id, code);
      doc.types = doc.types.filter((t) => !badTypes.has(t.id));
    }
    throw new BimIfcImportError('invalid-document', ['unsettled']);
  }
  /**
   * A foreign join must give the walls the file draws: the joined ends move to where the axes
   * meet, and the walls with their joins must then cover what the bodies did. `bim-core` reshapes
   * joined ends, so a join that would change a body is listed instead.
   */
  keepJoins() {
    const doc = this.doc;
    const foreign = doc.joins.filter((x) => this.foreignJoins.has(x.id));
    if (!foreign.length) return;
    const ids = [...new Set(foreign.flatMap((j) => j.walls))];
    const wallsNow = () => ids.map((id) => doc.elements.find((e) => e.id === id) as BimWall);
    const footprints = (walls: BimWall[], joins: BimWallJoin[]) => {
      const elements = walls.map((w) => ({ ...w, clipBy: undefined }) as BimElement);
      const { shapes } = deriveBim({ ...doc, elements, joins });
      return walls.map((w) => (shapes.get(w.id) as { footprint?: BimLoop } | undefined)?.footprint);
    };
    const same = (a: (BimLoop | undefined)[], b: (BimLoop | undefined)[]) =>
      a.every(
        (l, i) =>
          l &&
          b[i] &&
          l.length === b[i]!.length &&
          l.every((v, k) => v.every((c, m) => close(c ?? 0, b[i]![k][m] ?? 0))),
      );
    // The bodies as read: each wall alone.
    const bodies = footprints(wallsNow(), []);
    const kept: BimWallJoin[] = [];
    for (const j of foreign) {
      const pair = j.walls.map((id) => wallsNow().find((w) => w.id === id)!);
      const meet = axesMeet(pair[0], pair[1]);
      const moved =
        meet &&
        pair.map((w) => {
          const s = (w.start as { xy: Vec2 }).xy;
          const e = (w.end as { xy: Vec2 }).xy;
          const atStart = Math.hypot(...sub(s, meet)) <= Math.hypot(...sub(e, meet));
          return { ...w, [atStart ? 'start' : 'end']: { xy: meet } } as BimWall;
        });
      const tries: BimWallJoin[] =
        j.kind === 'butt'
          ? [j, ...j.walls.filter((w) => w !== j.through).map((w) => ({ ...j, through: w }))]
          : [j];
      const fits = moved
        ? tries.find((t) => {
            const walls = wallsNow().map((w) => moved.find((m) => m.id === w.id) ?? w);
            try {
              return same(footprints(walls, [...kept, t]), bodies);
            } catch {
              return false;
            }
          })
        : undefined;
      if (!fits || !moved) {
        this.drop(j.id, 'join-reshapes');
        continue;
      }
      kept.push(fits);
      Object.assign(j, fits);
      for (const m of moved) {
        const w = doc.elements.find((e) => e.id === m.id) as BimWall;
        // Hosted openings keep their place as the start moves.
        const shift = dot(
          sub((w.start as { xy: Vec2 }).xy, (m.start as { xy: Vec2 }).xy),
          unit(sub((m.end as { xy: Vec2 }).xy, (m.start as { xy: Vec2 }).xy)),
        );
        for (const h of doc.elements)
          if (h.kind === 'opening' && h.hostId === w.id && 'wall' in h)
            h.wall = { ...h.wall, alongMm: snap(h.wall.alongMm + shift) };
        w.start = m.start;
        w.end = m.end;
      }
    }
  }
  /** The type a diagnostic points into, by ID or by path. */
  typeAt(d: BimDiagnostic): string | undefined {
    if (d.id !== undefined && this.doc.types.some((t) => t.id === d.id)) return d.id;
    const m = /^\$\.types\[(\d+)\]/.exec(d.path);
    return m ? this.doc.types[Number(m[1])]?.id : undefined;
  }
  /** The element or join a diagnostic's path points into. */
  idAt(d: BimDiagnostic): string | undefined {
    const m = /^\$\.(elements|joins)\[(\d+)\]/.exec(d.path);
    if (!m) return undefined;
    return m[1] === 'elements'
      ? this.doc.elements[Number(m[2])]?.id
      : this.doc.joins[Number(m[2])]?.id;
  }
  drop(id: string, reason: string) {
    const doc = this.doc;
    const el = doc.elements.find((e) => e.id === id);
    if (el) {
      const inst = [...this.idOf].find(([, v]) => v === id)?.[0];
      this.lose(inst === undefined ? undefined : this.g.get(inst), reason);
      doc.elements = doc.elements.filter((e) => e.id !== id);
      if (inst !== undefined) this.foreign.delete(inst);
      // What it hosts goes with it; joins on it too.
      for (const h of doc.elements.filter((e) => 'hostId' in e && e.hostId === id))
        this.drop(h.id, 'host-not-kept');
      for (const j of doc.joins.filter((j) => j.walls.includes(id)))
        this.drop(j.id, 'join-walls-missing');
      // A wall it cut would lose its cut: it goes too, rather than change shape.
      for (const w of doc.elements.filter((x) => x.kind === 'wall' && x.clipBy === id))
        this.drop(w.id, 'clip-not-roof');
      return;
    }
    const j = doc.joins.find((x) => x.id === id);
    if (j) {
      const inst = this.joinInst.get(id);
      this.lose(inst, reason, 'IFCRELCONNECTSPATHELEMENTS');
      doc.joins = doc.joins.filter((x) => x.id !== id);
    }
  }
  levelZ(h: BimLevelHeight) {
    return this.doc.levels.find((l) => l.id === h.level)!.elevationMm + h.offsetMm;
  }
  thickness(el: BimWall | BimSlab) {
    const t = this.doc.types.find((x) => x.id === el.typeId);
    return t && 'layers' in t ? t.layers.reduce((s, l) => s + l.thicknessMm, 0) : 0;
  }

  /**
   * Restored elements must give the shapes the file holds: the document is written again and
   * each restored element's placement and body compared with the file's.
   */
  check() {
    if (!this.restored.size) return;
    let again: P21File;
    try {
      const out = writeIfcShapes(this.doc);
      again = readP21(out.bytes, { bytes: Infinity, entities: Infinity, depth: 64 });
    } catch (e) {
      throw new BimIfcImportError('constraint-mismatch', [String((e as Error).message)]);
    }
    const ag = new Graph(again);
    const byGid = (gr: Graph) => {
      const m = new Map<string, P21Instance>();
      for (const e of gr.file.entities.values())
        if (elementEntities[e.type]) m.set(text(e.args[0]) ?? '', e);
      return m;
    };
    const mine = byGid(ag);
    const mismatched: string[] = [];
    const theirs = new Importer(ag, ag.all('IFCPROJECT')[0], {});
    for (const inst of this.restored) {
      const e = this.g.get(inst)!;
      const gid = text(e.args[0])!;
      const other = mine.get(gid);
      const id = this.idOf.get(inst) ?? gid;
      if (!other || other.type !== e.type) {
        mismatched.push(id);
        continue;
      }
      const a = this.world(e.args[5]);
      const b = theirs.world(other.args[5]);
      const sameXf = sameXfOf(a, b);
      const isPart = elementEntities[e.type] === 'part';
      if (!sameXf || (!isPart && !sameTree(this.g, e.args[6], ag, other.args[6]))) {
        mismatched.push(id);
        continue;
      }
      // A door or window also gives the opening it fills (IfcRelFillsElement).
      const oa = this.g.get(this.g.openingOf.get(e.id));
      const ob = ag.get(ag.openingOf.get(other.id));
      if (
        !oa !== !ob ||
        (oa &&
          ob &&
          (!sameXfOf(this.world(oa.args[5]), theirs.world(ob.args[5])) ||
            !sameTree(this.g, oa.args[6], ag, ob.args[6])))
      )
        mismatched.push(id);
    }
    if (mismatched.length) throw new BimIfcImportError('constraint-mismatch', mismatched);
  }
}

/**
 * Why an entity was not imported. Anything but a known refusal is a malformed entity: the file
 * is untrusted, and one bad entity should not stop the rest.
 */
function reasonOf(err: unknown): string {
  if (err instanceof BimIfcImportError) throw err;
  return err instanceof Unsupported ? err.message : 'malformed';
}

/** Where two straight walls' axes, extended, cross. */
function axesMeet(a: BimWall, b: BimWall): Vec2 | undefined {
  if (a.bulge || b.bulge || !('xy' in a.start && 'xy' in a.end && 'xy' in b.start && 'xy' in b.end))
    return undefined;
  const da = sub(a.end.xy, a.start.xy);
  const db = sub(b.end.xy, b.start.xy);
  const den = cross(da, db);
  if (Math.abs(den) < 1e-12) return undefined;
  const t = cross(sub(b.start.xy, a.start.xy), db) / den;
  return [snap(a.start.xy[0] + da[0] * t), snap(a.start.xy[1] + da[1] * t)];
}
const sameXfOf = (a: Xf, b: Xf) =>
  (['o', 'x', 'y', 'z'] as const).every((k) => a[k].every((c, i) => close(c, b[k][i])));
const close = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-6 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
/** Two values with their referenced instances, compared by content (numbers within `close`). */
function sameTree(
  ga: Graph,
  a: P21Value | undefined,
  gb: Graph,
  b: P21Value | undefined,
  depth = 0,
): boolean {
  if (depth > 64) return false;
  if (!a || !b) return a === b;
  if (a.t === 'ref' && b.t === 'ref') {
    const x = ga.get(a);
    const y = gb.get(b);
    if (!x || !y || x.type !== y.type || x.args.length !== y.args.length) return false;
    // A representation's context is the file's own; compared by identity of role only.
    if (x.type === 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT')
      return text(x.args[0]) === text(y.args[0]);
    return x.args.every((v, i) => sameTree(ga, v, gb, y.args[i], depth + 1));
  }
  if ((a.t === 'real' || a.t === 'int') && (b.t === 'real' || b.t === 'int'))
    return close(a.v, b.v);
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'list':
      return (
        a.v.length === (b as typeof a).v.length &&
        a.v.every((v, i) => sameTree(ga, v, gb, (b as typeof a).v[i], depth + 1))
      );
    case 'typed':
      return a.name === (b as typeof a).name && sameTree(ga, a.v, gb, (b as typeof a).v, depth + 1);
    case 'enum':
    case 'str':
    case 'binary':
      return a.v === (b as typeof a).v;
    default:
      return true;
  }
}

/** Bulge of the arc from `a` through `m` to `b`: tan of a quarter of its signed sweep. */
function bulgeThrough(a: Vec2, m: Vec2, b: Vec2): number {
  // The inscribed angle at `m` is π − θ/2; the arc turns counter-clockwise when `m` lies to the
  // right of the chord.
  const u = sub(a, m);
  const v = sub(b, m);
  const inscribed = Math.atan2(Math.abs(cross(u, v)), dot(u, v));
  const sweep = 2 * Math.PI - 2 * inscribed;
  const sign = cross(sub(b, a), sub(m, a)) < 0 ? 1 : -1;
  return sign * Math.tan(sweep / 4);
}

const describe = (d: BimDiagnostic) => `${d.code} ${d.path}`;
/** Drops keys whose value is undefined. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Lengths of other programs' content, rounded to 1e-6 mm: placement turns leave noise such as
 * 1.2e-14 where the file meant zero. Far below `bimTolerance`.
 */
const snap = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
const snapLoop = (l: BimLoop): BimLoop =>
  l.map(
    (v): BimLoopVertex =>
      v.length === 3 ? [snap(v[0]), snap(v[1]), v[2]] : [snap(v[0]), snap(v[1])],
  );
function snapElement(el: BimElement): BimElement {
  const o = el as unknown as Record<string, unknown>;
  for (const k of ['start', 'end', 'at']) {
    const p = o[k] as BimPoint | undefined;
    if (p && 'xy' in p) o[k] = { xy: [snap(p.xy[0]), snap(p.xy[1])] };
  }
  for (const k of ['base', 'top']) {
    const h = o[k] as Record<string, number> | undefined;
    if (h)
      for (const f of ['offsetMm', 'heightMm']) if (typeof h[f] === 'number') h[f] = snap(h[f]);
  }
  if (Array.isArray(o.boundary)) o.boundary = snapLoop(o.boundary as BimLoop);
  if (Array.isArray(o.holes)) o.holes = (o.holes as BimLoop[]).map(snapLoop);
  if (el.kind === 'opening' && 'slab' in el) el.slab.boundary = snapLoop(el.slab.boundary);
  return el;
}
