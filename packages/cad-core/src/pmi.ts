import { rotateVector } from './assembly';
import { parameterValues, resolvePosition } from './graph';
import { cadLimits, type CadDocument, type Quaternion, type Vec3 } from './model';

/**
 * PMI-2 (docs/cad/pmi.md): the semantic PMI an import kept, as the `pmi` asset of the document
 * that holds the imported body. Targets are the body's faces, edges and vertices by their
 * 1-based index in `TopExp::MapShapes` of its normalized BRep (the same bytes give the same
 * indices). Values are in mm and degrees. PMI-3a adds the presentation the file draws an item with,
 * PMI-3b the saved views that show it.
 */

/** A target sub-shape of the imported body. */
export interface CadPmiTarget {
  shape: 'face' | 'edge' | 'vertex';
  /** 1-based index in `TopExp::MapShapes(body, kind)`. */
  index: number;
  /**
   * PMI-5 (`assembly-pmi` only): the component whose part has the sub-shape. The item is that
   * instance's alone; another instance of the same part never carries it.
   */
  component?: string;
}
/**
 * PMI-3a: the lines a file presents an item with (its tessellated callouts), in the body's model
 * space in mm, the frame its targets are in. Drawn as they are: nothing is made from the meaning.
 */
export interface CadPmiPresentation {
  /** Line segments: x0, y0, z0, x1, y1, z1 for each. */
  segments: number[];
  /** The annotation plane of the first callout that has one: origin, normal and x direction. */
  plane?: {
    origin: [number, number, number];
    z: [number, number, number];
    x: [number, number, number];
  };
  /**
   * PMI-3b: the segments callout by callout, each with the saved views that list it: `end`
   * is where its values end in `segments` (increasing, the last at `segments.length`). A view
   * draws only the ranges that name it; present when the item has `views`.
   */
  ranges?: { end: number; views: string[] }[];
}
/**
 * PMI-3b: a saved view's parallel camera (ISO 10303-46 `CAMERA_MODEL_D3`) in the body's model
 * space: it stands at `eye`, looks along `direction` with `up` upwards and shows `width` ×
 * `height` mm. Views that clip or project centrally are not kept.
 */
export interface CadPmiCamera {
  eye: [number, number, number];
  direction: [number, number, number];
  up: [number, number, number];
  width: number;
  height: number;
}
/** PMI-3b: a saved view of the file. */
export interface CadPmiView {
  /** Unique in the asset: `view-<n>`. */
  id: string;
  name: string;
  camera: CadPmiCamera;
}
interface CadPmiItemBase {
  /** Unique in the asset: `pmi-<n>`. */
  id: string;
  targets: CadPmiTarget[];
  presentation?: CadPmiPresentation;
  /** PMI-3b: the saved views of this asset that show the item. */
  views?: string[];
}
export interface CadPmiDimension extends CadPmiItemBase {
  kind: 'dimension';
  /** `XCAFDimTolObjects_DimensionType` by name (`pmiDimensionTypes`), e.g. `Size_Diameter`. */
  type: string;
  /** Nominal value, or the values of a range, in mm or degrees. */
  values: number[];
  /** A ± tolerance: signed deviations from the nominal (lower ≤ 0 ≤ upper is not required). */
  deviation?: { lower: number; upper: number };
  qualifier?: 'min' | 'max' | 'avg';
  /** A location dimension's second end. */
  targets2?: CadPmiTarget[];
}
export interface CadPmiDatumReference {
  /** The datum items of one compartment (a common datum has several). */
  datums: string[];
  /** Simple modifiers of the compartment (`pmiDatumModifiers` names). */
  modifiers: string[];
}
export interface CadPmiTolerance extends CadPmiItemBase {
  kind: 'geometric-tolerance';
  /** `XCAFDimTolObjects_GeomToleranceType` by name (`pmiToleranceTypes`), e.g. `Position`. */
  type: string;
  /** Tolerance value in mm. */
  value: number;
  /** `pmiToleranceModifiers` names, and a material requirement. */
  modifiers: string[];
  /** Zone form: a diameter or spherical diameter. */
  zone?: 'D' | 'SD';
  /** A maximum tolerance in mm. */
  maxValue?: number;
  /** Datum references in compartment order. */
  references: CadPmiDatumReference[];
}
export interface CadPmiDatum extends CadPmiItemBase {
  kind: 'datum';
  /** The datum letter. */
  name: string;
}
export interface CadPmiDatumTarget extends CadPmiItemBase {
  kind: 'datum-target';
  /** The datum letter the target belongs to. */
  datum: string;
  number: number;
  type: 'point' | 'line' | 'rectangle' | 'circle' | 'area';
}
export type CadPmiItem = CadPmiDimension | CadPmiTolerance | CadPmiDatum | CadPmiDatumTarget;
export type CadPmiKind = CadPmiItem['kind'];

/** The `pmi` asset's JSON. */
export interface CadPmiAsset {
  version: 1;
  items: CadPmiItem[];
  /** PMI-3b: the saved views that show at least one of the items. */
  views?: CadPmiView[];
}

/** Proposed limits (docs/cad/pmi.md, 上限). */
export const cadPmiLimits = Object.freeze({
  items: 5000,
  targets: 1024,
  /** Saved views of one asset. */
  views: 256,
  /** Characters of a saved view's name. */
  viewName: 256,
  /** Vertices of the presentation lines of one asset (two per segment). */
  vertices: 2_000_000,
  bytes: 8 * 1024 * 1024,
});

/** How many sub-shapes of each kind the body has, to check target indices. */
export interface CadPmiShapeCounts {
  faces: number;
  edges: number;
  vertices: number;
}

const kinds = new Set(['dimension', 'geometric-tolerance', 'datum', 'datum-target']);
const targetTypes = new Set(['point', 'line', 'rectangle', 'circle', 'area']);
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const names = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 64 && v.every((s) => typeof s === 'string' && s.length <= 64);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).every((k) => keys.includes(k));
/** A coordinate the viewport can draw: finite and in the model's range. */
const coordinate = (v: unknown): v is number => finite(v) && Math.abs(v) <= cadLimits.coordinateMm;
const vec = (v: unknown, unitLength = false) =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every(coordinate) &&
  (!unitLength || Math.abs(Math.hypot(...(v as number[])) - 1) < 1e-6);
const dot3 = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/**
 * Checks a `pmi` asset's JSON (PMI-2, CAD82): its shape, value ranges, that every target is a
 * sub-shape of the body (`counts`) and that every datum reference names a datum of the same
 * asset. Returns the path of the first problem, or undefined when the asset is valid. The
 * caller refuses with `pmi-invalid`.
 */
export function pmiAssetProblem(value: unknown, counts: CadPmiShapeCounts): string | undefined {
  return assetProblem(value, { counts: () => counts, assembly: false });
}
/**
 * PMI-5: checks an assembly's `assembly-pmi` asset as `pmiAssetProblem` does, with every target
 * naming a component (`counts` of its part, undefined when the document has no such
 * component). A datum may have no targets: JAMA's assembly datums stand on features that name
 * no geometry.
 */
export function assemblyPmiAssetProblem(
  value: unknown,
  counts: (componentId: string) => CadPmiShapeCounts | undefined,
): string | undefined {
  return assetProblem(value, {
    counts: (t) => (typeof t.component === 'string' ? counts(t.component) : undefined),
    assembly: true,
  });
}
function assetProblem(
  value: unknown,
  options: {
    counts: (target: Record<string, unknown>) => CadPmiShapeCounts | undefined;
    assembly: boolean;
  },
): string | undefined {
  if (!record(value) || value.version !== 1 || !onlyKeys(value, ['version', 'items', 'views']))
    return '$';
  const items = value.items;
  if (!Array.isArray(items) || items.length > cadPmiLimits.items) return '$.items';
  const viewIds = new Set<string>();
  if (value.views !== undefined) {
    if (
      !Array.isArray(value.views) ||
      !value.views.length ||
      value.views.length > cadPmiLimits.views
    )
      return '$.views';
    for (const [i, v] of value.views.entries()) {
      const at = `$.views[${i}]`;
      if (!record(v) || !onlyKeys(v, ['id', 'name', 'camera'])) return at;
      if (typeof v.id !== 'string' || !/^view-\d{1,6}$/.test(v.id) || viewIds.has(v.id))
        return `${at}.id`;
      viewIds.add(v.id);
      if (typeof v.name !== 'string' || v.name.length > cadPmiLimits.viewName) return `${at}.name`;
      const c = v.camera;
      if (
        !record(c) ||
        !onlyKeys(c, ['eye', 'direction', 'up', 'width', 'height']) ||
        !vec(c.eye) ||
        !vec(c.direction, true) ||
        !vec(c.up, true) ||
        Math.abs(dot3(c.direction as number[], c.up as number[])) > 1e-6 ||
        !coordinate(c.width) ||
        !coordinate(c.height) ||
        !(c.width > 0) ||
        !(c.height > 0)
      )
        return `${at}.camera`;
    }
  }
  const ids = new Set<string>();
  const datums = new Set<string>();
  for (const item of items)
    if (record(item) && item.kind === 'datum' && typeof item.id === 'string') datums.add(item.id);
  const targetsProblem = (v: unknown, at: string, empty = false) => {
    if (!Array.isArray(v) || (!empty && !v.length) || v.length > cadPmiLimits.targets) return at;
    for (const [j, t] of v.entries()) {
      if (
        !record(t) ||
        !onlyKeys(t, options.assembly ? ['component', 'shape', 'index'] : ['shape', 'index'])
      )
        return `${at}[${j}]`;
      const counts = options.counts(t);
      if (!counts) return `${at}[${j}].component`;
      const max =
        t.shape === 'face'
          ? counts.faces
          : t.shape === 'edge'
            ? counts.edges
            : t.shape === 'vertex'
              ? counts.vertices
              : 0;
      if (!Number.isInteger(t.index) || (t.index as number) < 1 || (t.index as number) > max)
        return `${at}[${j}].index`;
    }
    return undefined;
  };
  let vertices = 0;
  const presentationProblem = (v: unknown, at: string, itemViews: Set<unknown>) => {
    if (!record(v) || !onlyKeys(v, ['segments', 'plane', 'ranges'])) return at;
    const { segments, plane, ranges } = v;
    if (!Array.isArray(segments) || !segments.length || segments.length % 6)
      return `${at}.segments`;
    vertices += segments.length / 3;
    if (vertices > cadPmiLimits.vertices || !segments.every(coordinate)) return `${at}.segments`;
    if (
      plane !== undefined &&
      (!record(plane) ||
        !onlyKeys(plane, ['origin', 'z', 'x']) ||
        !vec(plane.origin) ||
        !vec(plane.z, true) ||
        !vec(plane.x, true))
    )
      return `${at}.plane`;
    if (ranges !== undefined) {
      // Increasing whole segments ending at the last, each naming views of the item.
      if (!Array.isArray(ranges) || !ranges.length || !itemViews.size) return `${at}.ranges`;
      let end = 0;
      for (const range of ranges) {
        if (
          !record(range) ||
          !onlyKeys(range, ['end', 'views']) ||
          !Number.isInteger(range.end) ||
          (range.end as number) <= end ||
          (range.end as number) % 6 ||
          !Array.isArray(range.views) ||
          new Set(range.views).size !== range.views.length ||
          !range.views.every((id) => itemViews.has(id))
        )
          return `${at}.ranges`;
        end = range.end as number;
      }
      if (end !== segments.length) return `${at}.ranges`;
    }
    return undefined;
  };
  for (const [i, item] of items.entries()) {
    const at = `$.items[${i}]`;
    if (!record(item) || !kinds.has(item.kind as string)) return at;
    if (typeof item.id !== 'string' || !/^pmi-\d{1,6}$/.test(item.id) || ids.has(item.id))
      return `${at}.id`;
    ids.add(item.id);
    const bad = targetsProblem(
      item.targets,
      `${at}.targets`,
      options.assembly && item.kind === 'datum',
    );
    if (bad) return bad;
    if (
      item.views !== undefined &&
      (!Array.isArray(item.views) ||
        !item.views.length ||
        item.views.length > cadPmiLimits.views ||
        new Set(item.views).size !== item.views.length ||
        !item.views.every((v) => typeof v === 'string' && viewIds.has(v)))
    )
      return `${at}.views`;
    if (item.presentation !== undefined) {
      const badPresentation = presentationProblem(
        item.presentation,
        `${at}.presentation`,
        new Set(Array.isArray(item.views) ? item.views : []),
      );
      if (badPresentation) return badPresentation;
    }
    switch (item.kind) {
      case 'dimension': {
        if (
          !onlyKeys(item, [
            'id',
            'kind',
            'type',
            'values',
            'deviation',
            'qualifier',
            'targets',
            'targets2',
            'presentation',
            'views',
          ])
        )
          return at;
        if (typeof item.type !== 'string' || item.type.length > 64) return `${at}.type`;
        if (!Array.isArray(item.values) || !item.values.length || item.values.length > 2)
          return `${at}.values`;
        if (!item.values.every(finite)) return `${at}.values`;
        if (item.deviation !== undefined) {
          const d = item.deviation;
          if (
            !record(d) ||
            !onlyKeys(d, ['lower', 'upper']) ||
            !finite(d.lower) ||
            !finite(d.upper)
          )
            return `${at}.deviation`;
        }
        if (
          item.qualifier !== undefined &&
          !['min', 'max', 'avg'].includes(item.qualifier as string)
        )
          return `${at}.qualifier`;
        if (item.targets2 !== undefined) {
          const bad2 = targetsProblem(item.targets2, `${at}.targets2`, true);
          if (bad2) return bad2;
        }
        break;
      }
      case 'geometric-tolerance': {
        if (
          !onlyKeys(item, [
            'id',
            'kind',
            'type',
            'value',
            'modifiers',
            'zone',
            'maxValue',
            'references',
            'targets',
            'presentation',
            'views',
          ])
        )
          return at;
        if (typeof item.type !== 'string' || item.type.length > 64) return `${at}.type`;
        if (!finite(item.value) || item.value < 0) return `${at}.value`;
        if (!names(item.modifiers)) return `${at}.modifiers`;
        if (item.zone !== undefined && item.zone !== 'D' && item.zone !== 'SD') return `${at}.zone`;
        if (item.maxValue !== undefined && (!finite(item.maxValue) || item.maxValue <= 0))
          return `${at}.maxValue`;
        if (!Array.isArray(item.references) || item.references.length > 3)
          return `${at}.references`;
        for (const [j, r] of item.references.entries()) {
          const rp = `${at}.references[${j}]`;
          if (!record(r) || !onlyKeys(r, ['datums', 'modifiers']) || !names(r.modifiers)) return rp;
          if (!Array.isArray(r.datums) || !r.datums.length || r.datums.length > 8)
            return `${rp}.datums`;
          if (!r.datums.every((d) => typeof d === 'string' && datums.has(d))) return `${rp}.datums`;
        }
        break;
      }
      case 'datum':
        if (!onlyKeys(item, ['id', 'kind', 'name', 'targets', 'presentation', 'views'])) return at;
        if (typeof item.name !== 'string' || !item.name || item.name.length > 16)
          return `${at}.name`;
        break;
      case 'datum-target':
        if (
          !onlyKeys(item, [
            'id',
            'kind',
            'datum',
            'number',
            'type',
            'targets',
            'presentation',
            'views',
          ])
        )
          return at;
        if (typeof item.datum !== 'string' || item.datum.length > 16) return `${at}.datum`;
        if (!Number.isInteger(item.number) || (item.number as number) < 0) return `${at}.number`;
        if (!targetTypes.has(item.type as string)) return `${at}.type`;
        break;
    }
  }
  return undefined;
}

/** Where a body's kept PMI stands (PMI-2; PMI-4a follows it through changes of the shape). */
export type CadBodyPmi =
  | { status: 'none' }
  /** Only rigid placements follow the import: the targets are the body's own faces and edges. */
  | { status: 'current'; featureId: string; assetId: string }
  /**
   * PMI-4a: a feature that changes the shape (a Boolean, a fillet, …) lies between the import
   * and the body. An item stays current only where the evaluation finds each sub-shape it
   * depends on unchanged in the body (`cadPmiItemStates`); the others are stale.
   */
  | { status: 'changed'; featureId: string; assetId: string; changedById: string }
  /** Imports with PMI meet in the body: their PMI is not followed, all of it is stale. */
  | {
      status: 'stale';
      featureId: string;
      assetId: string;
      changedById: string;
      /** PMI-4b: every import with PMI upstream, in input order (the first is `featureId`). */
      imports: { featureId: string; assetId: string }[];
    };

/**
 * The PMI an active or consumed body carries from an import (PMI-2): follows the body's result
 * back through rigid placements (`transform`) to an imported feature with a `pmi` asset. Past a
 * feature that changes the shape, the one import with PMI upstream is followed item by item
 * (PMI-4a); several are stale. The asset itself never changes.
 */
export function cadBodyPmi(doc: CadDocument, bodyId: string): CadBodyPmi {
  const body = doc.bodies.find((b) => b.id === bodyId);
  if (!body) return { status: 'none' };
  const byId = new Map(doc.features.map((f) => [f.id, f]));
  let f = byId.get(body.resultFeatureId);
  const seen = new Set<string>();
  while (f && f.type === 'transform' && f.inputFeatureIds.length === 1) {
    seen.add(f.id);
    f = byId.get(f.inputFeatureIds[0]!);
  }
  if (f?.type === 'imported')
    return f.args.pmiAssetId === undefined
      ? { status: 'none' }
      : { status: 'current', featureId: f.id, assetId: f.args.pmiAssetId };
  if (!f) return { status: 'none' };
  const changedBy = f.id;
  // The imported features with PMI upstream of the change, in input order (a Boolean's target
  // before its tools).
  const found: { id: string; assetId: string }[] = [];
  const stack: CadDocument['features'][number][] = [f];
  while (stack.length) {
    const g = stack.shift()!;
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    if (g.type === 'imported') {
      if (g.args.pmiAssetId !== undefined) found.push({ id: g.id, assetId: g.args.pmiAssetId });
      continue;
    }
    for (const id of g.inputFeatureIds) {
      const input = byId.get(id);
      if (input) stack.push(input);
    }
  }
  if (!found.length) return { status: 'none' };
  const first = { featureId: found[0]!.id, assetId: found[0]!.assetId, changedById: changedBy };
  return found.length === 1
    ? { status: 'changed', ...first }
    : {
        status: 'stale',
        ...first,
        imports: found.map((g) => ({ featureId: g.id, assetId: g.assetId })),
      };
}

/** A rigid placement: `rotation · p + translation` (mm). */
export interface CadPmiPlacement {
  rotation: Quaternion;
  translation: Vec3;
}
/**
 * PMI-3a: the rigid placements (`transform` features) between a body's imported feature and
 * the body, from the import outwards, to draw the presentation where the body is. Empty when
 * the body is the import itself. PMI-4a: past features that change the shape in place, along
 * the one path back to the import; a pattern's copies of it have no one placement. Undefined
 * when its PMI is neither current nor changed, the path is not one, or a translation does not
 * evaluate.
 */
export function cadBodyPmiPlacements(
  doc: CadDocument,
  bodyId: string,
): CadPmiPlacement[] | undefined {
  const state = cadBodyPmi(doc, bodyId);
  if (state.status !== 'current' && state.status !== 'changed') return undefined;
  const body = doc.bodies.find((b) => b.id === bodyId)!;
  const byId = new Map(doc.features.map((f) => [f.id, f]));
  /** Whether a feature's result comes, through its inputs, from the import. */
  const reaches = new Map<string, boolean>();
  const from = (id: string): boolean => {
    const known = reaches.get(id);
    if (known !== undefined) return known;
    reaches.set(id, false);
    const g = byId.get(id);
    const r = id === state.featureId || (!!g && g.inputFeatureIds.some(from));
    reaches.set(id, r);
    return r;
  };
  const out: CadPmiPlacement[] = [];
  try {
    const params = parameterValues(doc);
    let f = byId.get(body.resultFeatureId);
    for (let steps = 0; f && f.id !== state.featureId; steps++) {
      if (steps > doc.features.length) return undefined;
      if (f.type === 'transform') {
        out.unshift({
          rotation: f.args.rotation,
          translation: resolvePosition(f.args.translation, params),
        });
        f = byId.get(f.inputFeatureIds[0]);
        continue;
      }
      const inputs = f.inputFeatureIds.filter(from);
      // A pattern copies its tool: the import has as many placements as copies.
      if (inputs.length !== 1 || (f.type === 'pattern' && inputs[0] !== f.inputFeatureIds[0]))
        return undefined;
      f = byId.get(inputs[0]!);
    }
    if (!f) return undefined;
  } catch {
    return undefined;
  }
  return out;
}

/**
 * PMI-4a: the imported faces, edges and vertices a body still has exactly once and unchanged,
 * from its evaluation: pairs of the 1-based index in the import's BRep (`CadPmiTarget.index`)
 * and the index in the body's topology table, in increasing import order. What is not listed is
 * gone, changed, or copied.
 */
export interface CadPmiTracking {
  /** The imported feature. */
  featureId: string;
  faces: number[];
  edges: number[];
  vertices: number[];
}
const trackedMaps = new WeakMap<
  CadPmiTracking,
  Record<CadPmiTarget['shape'], Map<number, number>>
>();
/** PMI-4a: a target's index in the body's topology table, or undefined when it is not unchanged. */
export function cadPmiTrackedIndex(
  tracking: CadPmiTracking,
  target: CadPmiTarget,
): number | undefined {
  let maps = trackedMaps.get(tracking);
  if (!maps) {
    const pairs = (list: number[]) => {
      const m = new Map<number, number>();
      for (let i = 0; i + 1 < list.length; i += 2) m.set(list[i]!, list[i + 1]!);
      return m;
    };
    maps = {
      face: pairs(tracking.faces),
      edge: pairs(tracking.edges),
      vertex: pairs(tracking.vertices),
    };
    trackedMaps.set(tracking, maps);
  }
  return maps[target.shape].get(target.index);
}

/** PMI-4a: whether an item is current on a body whose shape changed after the import. */
export type CadPmiItemState =
  | { current: true }
  /** `target`: a target is not unchanged; `datum`: a datum it depends on is stale. */
  | { current: false; reason: 'target' | 'datum' };
/**
 * PMI-4a (docs/cad/pmi.md, 加工と失効): each item of an asset on a changed body is current only
 * when every target it has is unchanged (`tracking`) and every datum it depends on is current:
 * a tolerance's referenced datums, a datum's datum targets (a datum with no targets of its own
 * stands on them). An item with nothing to check is stale; without a tracking (no evaluation)
 * all are.
 */
export function cadPmiItemStates(
  asset: CadPmiAsset,
  tracking: CadPmiTracking | undefined,
): Map<string, CadPmiItemState> {
  const out = new Map<string, CadPmiItemState>();
  const own = (item: CadPmiItem) => {
    const all = [...item.targets, ...(item.kind === 'dimension' ? (item.targets2 ?? []) : [])];
    return (
      !!tracking &&
      all.length > 0 &&
      all.every((t) => cadPmiTrackedIndex(tracking, t) !== undefined)
    );
  };
  const stale = (reason: 'target' | 'datum'): CadPmiItemState => ({ current: false, reason });
  for (const item of asset.items)
    if (item.kind === 'datum-target')
      out.set(item.id, own(item) ? { current: true } : stale('target'));
  const targetsOf = new Map<string, boolean>();
  for (const item of asset.items)
    if (item.kind === 'datum-target')
      targetsOf.set(item.datum, (targetsOf.get(item.datum) ?? true) && out.get(item.id)!.current);
  // A datum stands on its own targets, or on its datum targets when it has none of its own.
  for (const item of asset.items)
    if (item.kind === 'datum') {
      const byTargets = targetsOf.get(item.name);
      const ownOk = item.targets.length ? own(item) : byTargets !== undefined && !!tracking;
      out.set(
        item.id,
        !ownOk ? stale('target') : byTargets === false ? stale('datum') : { current: true },
      );
    }
  for (const item of asset.items) {
    if (item.kind === 'datum' || item.kind === 'datum-target') continue;
    if (!own(item)) out.set(item.id, stale('target'));
    else if (
      item.kind === 'geometric-tolerance' &&
      item.references.some((r) => r.datums.some((d) => out.get(d)?.current !== true))
    )
      out.set(item.id, stale('datum'));
    else out.set(item.id, { current: true });
  }
  return out;
}
/** A point of the imported body's model space where the body is now. */
export function placePmiPoint(placements: readonly CadPmiPlacement[], p: Vec3): Vec3 {
  let q = p;
  for (const { rotation, translation } of placements) {
    const r = rotateVector(rotation, q);
    q = [r[0] + translation[0], r[1] + translation[1], r[2] + translation[2]];
  }
  return q;
}

/** A direction of the imported body's model space where the body is now. */
export function placePmiDirection(placements: readonly CadPmiPlacement[], v: Vec3): Vec3 {
  let q = v;
  for (const { rotation } of placements) q = rotateVector(rotation, q);
  return q;
}
/**
 * PMI-3b: a saved view as a viewport camera where the body is now. The camera looks at the
 * point of its axis nearest `center` (the body's middle, so that orbiting turns about it, at
 * least 1 mm ahead), orthographic, showing the view's window whole at `aspect` (width / height
 * of the viewport).
 */
export function cadPmiViewCamera(
  placements: readonly CadPmiPlacement[],
  camera: CadPmiCamera,
  center: Vec3,
  aspect: number,
): {
  camera: { position: Vec3; target: Vec3; up: Vec3 };
  projection: { type: 'orthographic'; spanMm: number };
} {
  const eye = placePmiPoint(placements, camera.eye);
  const direction = placePmiDirection(placements, camera.direction);
  const up = placePmiDirection(placements, camera.up);
  const ahead = Math.max(
    1,
    (center[0] - eye[0]) * direction[0] +
      (center[1] - eye[1]) * direction[1] +
      (center[2] - eye[2]) * direction[2],
  );
  const target: Vec3 = [
    eye[0] + direction[0] * ahead,
    eye[1] + direction[1] * ahead,
    eye[2] + direction[2] * ahead,
  ];
  const fit = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  return {
    camera: { position: eye, target, up },
    projection: { type: 'orthographic', spanMm: Math.max(camera.height, camera.width / fit) },
  };
}

/**
 * A stored `pmi` asset's JSON as an asset, or undefined when the bytes are not one (the
 * evaluation refuses such a document with `pmi-invalid`; the list shows it as unreadable).
 */
export function readCadPmiAsset(bytes: Uint8Array): CadPmiAsset | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const any = { faces: Infinity, edges: Infinity, vertices: Infinity };
    return pmiAssetProblem(value, any) === undefined ? (value as CadPmiAsset) : undefined;
  } catch {
    return undefined;
  }
}

const dimensionNames: Record<string, string> = {
  Location_LinearDistance: 'Distance',
  Location_CurvedDistance: 'Curved distance',
  Location_LinearDistance_FromCenterToOuter: 'Distance from centre to outer',
  Location_LinearDistance_FromCenterToInner: 'Distance from centre to inner',
  Location_LinearDistance_FromOuterToCenter: 'Distance from outer to centre',
  Location_LinearDistance_FromOuterToOuter: 'Distance from outer to outer',
  Location_LinearDistance_FromOuterToInner: 'Distance from outer to inner',
  Location_LinearDistance_FromInnerToCenter: 'Distance from inner to centre',
  Location_LinearDistance_FromInnerToOuter: 'Distance from inner to outer',
  Location_LinearDistance_FromInnerToInner: 'Distance from inner to inner',
  Location_Angular: 'Angle',
  Location_Oriented: 'Oriented distance',
  Location_WithPath: 'Distance along a path',
  Size_CurveLength: 'Curve length',
  Size_Diameter: 'Diameter',
  Size_SphericalDiameter: 'Spherical diameter',
  Size_Radius: 'Radius',
  Size_SphericalRadius: 'Spherical radius',
  Size_ToroidalMinorDiameter: 'Toroidal minor diameter',
  Size_ToroidalMajorDiameter: 'Toroidal major diameter',
  Size_ToroidalMinorRadius: 'Toroidal minor radius',
  Size_ToroidalMajorRadius: 'Toroidal major radius',
  Size_ToroidalHighMajorDiameter: 'Toroidal high major diameter',
  Size_ToroidalLowMajorDiameter: 'Toroidal low major diameter',
  Size_ToroidalHighMajorRadius: 'Toroidal high major radius',
  Size_ToroidalLowMajorRadius: 'Toroidal low major radius',
  Size_Thickness: 'Thickness',
  Size_Angular: 'Angle',
  Size_WithPath: 'Length along a path',
};
const symbol = (type: string) => (/Diameter/.test(type) ? '⌀' : /Radius/.test(type) ? 'R' : '');
const number = (v: number) => String(Number(v.toPrecision(12)));
const signed = (v: number) => (v < 0 ? `−${number(-v)}` : `+${number(v)}`);
/** A tolerance type in words: `CircularRunout` as `Circular runout`. */
const words = (type: string) =>
  type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ ([A-Z])/g, (m) => m.toLowerCase());

/**
 * One line for a PMI item in the list (PMI-2): its kind, value with unit and tolerance, and the
 * datums a tolerance references by letter. Words only; the presentation is PMI-3.
 */
export function cadPmiItemText(item: CadPmiItem, asset: CadPmiAsset): string {
  switch (item.kind) {
    case 'dimension': {
      const angle = /Angular/.test(item.type);
      const unit = angle ? '°' : ' mm';
      const value = item.values.map(number).join('–');
      const deviation = item.deviation
        ? item.deviation.lower === -item.deviation.upper
          ? ` ±${number(item.deviation.upper)}`
          : ` ${signed(item.deviation.upper)}/${signed(item.deviation.lower)}`
        : '';
      const qualifier = item.qualifier ? ` (${item.qualifier})` : '';
      return `${dimensionNames[item.type] ?? item.type} ${symbol(item.type)}${value}${deviation}${unit}${qualifier}`;
    }
    case 'geometric-tolerance': {
      const zone = item.zone === 'D' ? '⌀' : item.zone === 'SD' ? 'S⌀' : '';
      const name = (id: string) => {
        const d = asset.items.find((i) => i.id === id);
        return d?.kind === 'datum' ? d.name : '?';
      };
      const said = (m: string) => (/_/.test(m) ? m.replace(/_/g, ' ') : words(m)).toLowerCase();
      // A compartment's modifiers follow its datums, as a feature control frame shows them.
      const refs = item.references
        .map(
          (r) =>
            ` | ${r.datums.map(name).join('-')}${r.modifiers.length ? ` (${r.modifiers.map(said).join(', ')})` : ''}`,
        )
        .join('');
      const modifiers = item.modifiers.length ? ` (${item.modifiers.map(said).join(', ')})` : '';
      const max = item.maxValue !== undefined ? `, at most ${number(item.maxValue)} mm` : '';
      return `${words(item.type)} ${zone}${number(item.value)} mm${max}${refs}${modifiers}`;
    }
    case 'datum':
      return `Datum ${item.name}`;
    case 'datum-target':
      return `Datum target ${item.datum}${item.number} (${item.type})`;
  }
}
