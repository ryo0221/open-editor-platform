import type { P21File, P21Instance, P21Value } from '@editor-platform/geometry-core';
import { cadLimits, cadPmiLimits } from '@editor-platform/cad-core';
import { familyOf } from './step-pmi';

/**
 * PMI-3 (docs/cad/pmi.md): the presentation of a STEP file's PMI and its saved views, read
 * from the file's text with the own P21 reader. OCCT 7.6's XDE reader reads a presentation only
 * through a `DRAUGHTING_MODEL_ITEM_ASSOCIATION` named 'PMI representation to presentation link'
 * and only the first curve set of each annotation, and it does not know AP242 ed3's
 * `DRAUGHTING_MODEL_ITEM_ASSOCIATION_WITH_PLACEHOLDER` (how the JAMA files link theirs), so
 * the presentation is read here. Nothing is drawn from the meaning (PMI-U2): only the lines the
 * file holds.
 *
 * Read: each `DRAUGHTING_CALLOUT`'s `TESSELLATED_ANNOTATION_OCCURRENCE`s (tessellated curve
 * sets and triangulated surface sets as their edges, placed by `REPOSITIONED_TESSELLATED_ITEM`),
 * its annotation plane, and the PMI items it presents (the definitions of the associations that
 * name it; a datum feature presents its datum). An `ANNOTATION_PLACEHOLDER_OCCURRENCE` marks
 * where a receiving system may write the text again: it has no lines and is skipped. Any other
 * occurrence or item makes the callout unsupported, so it is not shown in part.
 * Each `CAMERA_MODEL_D3` is a saved view with the callouts of its `DRAUGHTING_MODEL`.
 */

export type Vec3 = [number, number, number];
/** An annotation plane: origin, normal and x direction, in mm. */
export interface PmiPlane {
  origin: Vec3;
  z: Vec3;
  x: Vec3;
}
export interface PmiFileCallout {
  /** The `DRAUGHTING_CALLOUT`'s entity. */
  id: number;
  /** Line segments in the file's model space, mm: x0, y0, z0, x1, y1, z1 for each. */
  segments: number[];
  plane?: PmiPlane;
  /** The PMI items the callout presents (dimension, tolerance, datum or datum target entities). */
  presents: number[];
  /** Why the callout cannot be drawn whole: the first type it cannot read. */
  unsupported?: string;
  /**
   * The products whose frame the callout is listed in: for each of its draughting models, the
   * `PRODUCT_DEFINITION` whose shape is in the model's representation context (a context of
   * no or several products names none). Files list a part's callout in its part's model and
   * again in the models of the assemblies above it; the lines are taken to be in the part's
   * frame when it is one of these (`linkedCallouts`), and in no known frame otherwise.
   */
  frames: number[];
  /**
   * Its annotation occurrences: placeholders included, and occurrences that only override the
   * style of one of its own (`OVER_RIDING_STYLED_ITEM`, no lines of their own; colours and line
   * styles are not kept: the viewer draws every line in its own colour), by entity: two
   * callouts can share one.
   */
  occurrences: number[];
}
/**
 * A saved view's camera (ISO 10303-46, as OCCT reads it): the camera stands at `eye` and looks
 * along `direction` with `up` upwards. A parallel view shows `width` × `height` mm.
 */
export interface PmiCamera {
  eye: Vec3;
  direction: Vec3;
  up: Vec3;
  projection: 'parallel' | 'central';
  width: number;
  height: number;
  /** The view clips by planes, which this viewer does not apply. */
  clipping: boolean;
}
export interface PmiFileView {
  /** The `CAMERA_MODEL_D3`'s entity. */
  id: number;
  name: string;
  camera?: PmiCamera;
  /** Why the camera cannot be read. */
  unsupported?: string;
  /** The callouts of the view's draughting model. */
  callouts: number[];
  /** The products whose frame its camera is listed in, as `PmiFileCallout.frames`. */
  frames: number[];
}
export interface PmiFilePresentation {
  callouts: PmiFileCallout[];
  views: PmiFileView[];
  /** Placeholder occurrences skipped (they hold no lines). */
  placeholders: number;
  /** `DRAUGHTING_CALLOUT_RELATIONSHIP`s: the two callouts each relates (both are drawn). */
  relationships: [number, number][];
  /**
   * The product each presented PMI item is on (the `PRODUCT_DEFINITION` its shape aspects
   * belong to), when that is one product. A callout's lines are an item's only when the two
   * agree: a body is kept in its own product's frame.
   */
  itemFrame: Map<number, number>;
}

type Part = { type: string; args: P21Value[] };
const partsOf = (e: P21Instance): Part[] => e.parts ?? [e];
const num = (v: P21Value | undefined): number =>
  v?.t === 'real' || v?.t === 'int' ? v.v : v?.t === 'typed' ? num(v.v) : NaN;
const list = (v: P21Value | undefined): P21Value[] | undefined =>
  v?.t === 'list' ? v.v : undefined;
const refs = (v: P21Value | undefined): number[] =>
  v?.t === 'ref' ? [v.id] : v?.t === 'list' ? v.v.flatMap(refs) : v?.t === 'typed' ? refs(v.v) : [];
/**
 * Each value visited inside a value, one at a time: a reference as its entity, any other value
 * as -1, so a caller can count every value it reads and stop before a long list ends.
 */
function* valuesOf(v: P21Value | undefined): Generator<number> {
  if (v?.t === 'ref') yield v.id;
  else {
    yield -1;
    if (v?.t === 'list') for (const x of v.v) yield* valuesOf(x);
    else if (v?.t === 'typed') yield* valuesOf(v.v);
  }
}
const str = (v: P21Value | undefined) => (v?.t === 'str' ? v.v : '');
const part = (e: P21Instance | undefined, type: string | RegExp) =>
  e && partsOf(e).find((p) => (typeof type === 'string' ? p.type === type : type.test(p.type)));
const typeOf = (e: P21Instance) => (e.parts ? `(${e.parts.map((p) => p.type).join(' ')})` : e.type);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// `+ 0` turns −0 (which files write) into 0.
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s + 0, a[1] * s + 0, a[2] * s + 0];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 | undefined => {
  const n = Math.hypot(...a);
  return n > 1e-12 && Number.isFinite(n) ? scale(a, 1 / n) : undefined;
};

/** A placement: origin (mm) and orthonormal axes. */
interface Frame {
  o: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}
const identity: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const apply = (f: Frame, p: Vec3): Vec3 => [
  f.o[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.z[0] * p[2],
  f.o[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.z[1] * p[2],
  f.o[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.z[2] * p[2],
];
/** `inner` placed in `outer`. */
const compose = (outer: Frame, inner: Frame): Frame => ({
  o: apply(outer, inner.o),
  x: sub(apply(outer, inner.x), outer.o),
  y: sub(apply(outer, inner.y), outer.o),
  z: sub(apply(outer, inner.z), outer.o),
});

/** Adds `value` to the list of `key`, in place (copying the list each time is quadratic). */
/** A point the viewport can draw: in the model's coordinate range (float32 past it). */
const inRange = (p: readonly number[]) => p.every((v) => Math.abs(v) <= cadLimits.coordinateMm);

const append = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/** Entities the presentation reader visits in one file at most (see `visits`). */
export const presentationVisits = 1_000_000;
/**
 * Work the reader does in one file at most beyond reading each entity once: links from an
 * occurrence many callouts share to each of them (associations and style overrides naming
 * it) and the callouts of saved views. Past it nothing of the file's presentation is read
 * (`overPresentation`): every callout and view is `presentation-budget`.
 */
export const presentationExpansion = 1_000_000;
class PresentationOver extends Error {}
const budget = 'presentation-budget';

export function pmiPresentation(file: P21File, mm: number): PmiFilePresentation {
  let derived = 0;
  const charge = (n: number) => {
    derived += n;
    if (derived > presentationExpansion) throw new PresentationOver();
  };
  try {
    return readPresentation(file, mm, charge);
  } catch (e) {
    if (e instanceof PresentationOver) return overPresentation(file);
    throw e;
  }
}

/**
 * The presentation of a file past `presentationExpansion`: its callouts, with the occurrences
 * they list, and its views, all unread. Linear in the file.
 */
function overPresentation(file: P21File): PmiFilePresentation {
  const callouts: PmiFileCallout[] = [];
  const views: PmiFileView[] = [];
  for (const e of file.entities.values()) {
    const c = part(e, 'DRAUGHTING_CALLOUT');
    if (c && c.args.length >= 2)
      callouts.push({
        id: e.id,
        segments: [],
        presents: [],
        occurrences: [...new Set(refs(c.args[1]))],
        frames: [],
        unsupported: budget,
      });
    const v = part(e, /^CAMERA_MODEL_D3/);
    if (v && v.args.length >= 3)
      views.push({ id: e.id, name: str(v.args[0]), callouts: [], frames: [], unsupported: budget });
  }
  return { callouts, views, placeholders: 0, relationships: [], itemFrame: new Map() };
}
/** Vertices the presentation reader makes in one file at most, kept or not (see `work`). */
export const presentationWork = 2 * cadPmiLimits.vertices;

function readPresentation(
  file: P21File,
  mm: number,
  charge: (n: number) => void,
): PmiFilePresentation {
  const get = (id: number) => file.entities.get(id);
  /** Three numbers, or undefined: the count is checked before any is read. */
  const triple = (v: P21Value | undefined) => {
    const l = list(v);
    return l && l.length === 3 ? (l.map(num) as Vec3) : undefined;
  };
  const point = (id: number | undefined): Vec3 | undefined => {
    const p = part(id === undefined ? undefined : get(id), 'CARTESIAN_POINT');
    const c = triple(p?.args[1]);
    return c && c.every(Number.isFinite) ? scale(c, mm) : undefined;
  };
  const direction = (id: number | undefined): Vec3 | undefined => {
    const p = part(id === undefined ? undefined : get(id), 'DIRECTION');
    const c = triple(p?.args[1]);
    return c && unit(c);
  };
  /** Each placement, read once: many callouts and cameras can share one. */
  const frames = new Map<number | undefined, Frame | undefined>();
  const frame = (id: number | undefined): Frame | undefined => {
    if (!frames.has(id)) frames.set(id, readFrame(id));
    return frames.get(id);
  };
  /** `AXIS2_PLACEMENT_3D(name, location, axis, ref_direction)`, axes defaulting to z and x. */
  const readFrame = (id: number | undefined): Frame | undefined => {
    const p = part(id === undefined ? undefined : get(id), 'AXIS2_PLACEMENT_3D');
    if (!p) return undefined;
    const [, location, axis, ref] = p.args;
    const o = point(refs(location)[0]);
    const z = axis?.t === 'ref' ? direction(axis.id) : [0, 0, 1];
    const r = ref?.t === 'ref' ? direction(ref.id) : [1, 0, 0];
    if (!o || !z || !r) return undefined;
    const x = unit(sub(r as Vec3, scale(z as Vec3, dot(r as Vec3, z as Vec3))));
    return x && { o, x, y: scale(cross(z as Vec3, x), 1), z: z as Vec3 };
  };

  // Datum features present their datum (`SHAPE_ASPECT_RELATIONSHIP(name, desc, feature, datum)`).
  const datumOf = new Map<number, number>();
  // The callouts each annotation occurrence belongs to, and the plane of each callout.
  const calloutsOf = new Map<number, number[]>();
  const planeOf = new Map<number, PmiPlane>();
  const definitions = new Map<number, number[]>();
  const callouts: P21Instance[] = [];
  const cameras: P21Instance[] = [];
  /** Each draughting model: its items and its representation context. */
  const models: { items: number[]; context?: number }[] = [];
  /** The items of each draughting model, by its entity. */
  const modelItems = new Map<number, Set<number>>();
  /** Shape representations by context, and the product shape each shape representation is. */
  const shapesIn = new Map<number, number[]>();
  const shapeOf = new Map<number, number>();
  const productOfShape = new Map<number, number>();
  const relationships: [number, number][] = [];
  // Style overrides of annotation occurrences: the override and the occurrence it restyles.
  const overrides: [number, number][] = [];
  for (const e of file.entities.values())
    for (const p of partsOf(e)) {
      if (p.type === 'DRAUGHTING_CALLOUT' && p.args.length >= 2) {
        callouts.push(e);
        for (const o of new Set(refs(p.args[1]))) append(calloutsOf, o, e.id);
      } else if (p.type === 'DRAUGHTING_CALLOUT_RELATIONSHIP' && p.args.length >= 4) {
        const [a, b] = [refs(p.args[2])[0], refs(p.args[3])[0]];
        if (a !== undefined && b !== undefined) relationships.push([a, b]);
      } else if (
        p.type === 'OVER_RIDING_STYLED_ITEM' &&
        e.parts?.some((q) => /ANNOTATION_\w*OCCURRENCE/.test(q.type))
      ) {
        const restyled = refs(p.args[p.args.length - 1])[0];
        if (restyled !== undefined) overrides.push([e.id, restyled]);
      } else if (/^CAMERA_MODEL_D3/.test(p.type) && p.args.length >= 3) cameras.push(e);
      else if (p.type === 'DRAUGHTING_MODEL') {
        // A simple instance, or a complex one whose REPRESENTATION part holds the arguments.
        const r = p.args.length >= 3 ? p : part(e, 'REPRESENTATION');
        if (r && r.args.length >= 3) {
          models.push({ items: refs(r.args[1]), context: refs(r.args[2])[0] });
          modelItems.set(e.id, new Set(refs(r.args[1])));
        }
      } else if (/SHAPE_REPRESENTATION$/.test(p.type) && p.args.length >= 3) {
        const context = refs(p.args[2])[0];
        if (context !== undefined) append(shapesIn, context, e.id);
      } else if (p.type === 'SHAPE_DEFINITION_REPRESENTATION' && p.args.length >= 2) {
        const [definition, used] = [refs(p.args[0])[0], refs(p.args[1])[0]];
        if (definition !== undefined && used !== undefined) shapeOf.set(used, definition);
      } else if (p.type === 'PRODUCT_DEFINITION_SHAPE' && p.args.length >= 3) {
        const definition = refs(p.args[2])[0];
        if (definition !== undefined) productOfShape.set(e.id, definition);
      } else if (p.type === 'SHAPE_ASPECT_RELATIONSHIP') {
        const [, , feature, datum] = p.args;
        const d = datum?.t === 'ref' ? get(datum.id) : undefined;
        if (feature?.t === 'ref' && d && part(d, /^(?:DATUM|COMMON_DATUM)$/))
          datumOf.set(feature.id, d.id);
      }
    }
  for (const e of file.entities.values())
    for (const p of partsOf(e)) {
      if (/^DRAUGHTING_MODEL_ITEM_ASSOCIATION/.test(p.type) && p.args.length >= 5) {
        const definition = refs(p.args[2])[0];
        if (definition === undefined) continue;
        // An occurrence shared by callouts: the ones in the association's draughting model,
        // or all of them when the model lists none.
        const listed = modelItems.get(refs(p.args[3])[0] ?? -1);
        for (const item of refs(p.args[4])) {
          const all =
            get(item) && part(get(item), 'DRAUGHTING_CALLOUT')
              ? [item]
              : (calloutsOf.get(item) ?? []);
          // An occurrence many callouts share multiplies: charged (`presentationExpansion`).
          charge(all.length);
          const inModel = all.filter((c) => listed?.has(c));
          for (const callout of inModel.length ? inModel : all)
            append(definitions, callout, definition);
        }
      } else if (p.type === 'ANNOTATION_PLANE' && p.args.length >= 4) {
        const plane = part(get(refs(p.args[2])[0] ?? -1), 'PLANE');
        const f = plane && frame(refs(plane.args[1])[0]);
        if (f) for (const c of refs(p.args[3])) planeOf.set(c, { origin: f.o, z: f.z, x: f.x });
      }
    }
  /** The PMI item a definition is, or undefined for a shape aspect or another entity. */
  const item = (id: number): number | undefined => {
    const e = get(id);
    if (!e) return undefined;
    const families = new Set(partsOf(e).map((p) => familyOf(p.type)));
    if (
      families.has('dimension') ||
      families.has('geometric-tolerance') ||
      families.has('datum-target') ||
      families.has('datum')
    )
      return id;
    return datumOf.get(id);
  };

  /** The one product a context's shapes are, or undefined. */
  // Resolved once per context (many callouts and cameras share a model and its context).
  const frameOfContext = new Map<number | undefined, number | undefined>();
  const contextFrame = (context: number | undefined) => {
    if (frameOfContext.has(context)) return frameOfContext.get(context);
    const products = new Set(
      (context === undefined ? [] : (shapesIn.get(context) ?? [])).flatMap((r) => {
        const pd = productOfShape.get(shapeOf.get(r) ?? -1);
        return pd === undefined ? [] : [pd];
      }),
    );
    const frame = products.size === 1 ? [...products][0] : undefined;
    frameOfContext.set(context, frame);
    return frame;
  };
  /** The draughting models that list each item. */
  const modelsOf = new Map<number, (typeof models)[number][]>();
  for (const m of models) for (const i of new Set(m.items)) append(modelsOf, i, m);
  /** The products of the contexts of the draughting models that list `id`. */
  const modelFrames = (id: number) => [
    ...new Set(
      (modelsOf.get(id) ?? []).flatMap((m) => {
        const f = contextFrame(m.context);
        return f === undefined ? [] : [f];
      }),
    ),
  ];
  /**
   * The products an item's shape aspects belong to: following its references to each
   * `PRODUCT_DEFINITION_SHAPE` (not further), at most `limit` entities. Undefined when the
   * search stops at a limit with references left unread: a product found so far is not known
   * to be the only one.
   */
  const itemProducts = (id: number, limit = 256): Set<number> | undefined => {
    const found = new Set<number>();
    const seen = new Set([id]);
    const queue = [id];
    // Values read, references or not, seen or not: a shared list (a datum system's
    // compartments) is not read whole for each item. At most 16 × `limit` per item, charged
    // to the file's budget.
    let scanned = 0;
    let cut = false;
    const most = 16 * limit;
    while (queue.length && seen.size <= limit && scanned < most) {
      const e = get(queue.shift()!);
      if (!e) continue;
      const pds = part(e, 'PRODUCT_DEFINITION_SHAPE');
      if (pds) {
        const pd = productOfShape.get(e.id);
        if (pd !== undefined) found.add(pd);
        continue;
      }
      walk: for (const q of partsOf(e))
        for (const a of q.args)
          for (const r of valuesOf(a)) {
            if (++scanned > most) {
              cut = true;
              break walk;
            }
            if (r >= 0 && !seen.has(r)) {
              seen.add(r);
              queue.push(r);
            }
          }
    }
    charge(scanned);
    return cut || queue.length > 0 ? undefined : found;
  };

  /**
   * Each tessellated leaf's lines once, however many occurrences place it: its points (mm, in
   * the leaf's own frame) and its edges as pairs of point indices, or why it cannot be read.
   * Decoding is work in the size of the file, not of how often a leaf is referenced.
   */
  const pointsOf = new Map<number, Vec3[] | undefined>();
  const coordinates = (id: number | undefined): Vec3[] | undefined => {
    if (id === undefined) return undefined;
    if (pointsOf.has(id)) return pointsOf.get(id);
    const c = part(get(id), 'COORDINATES_LIST');
    const raw = list(c?.args[2])?.map((p) => list(p)?.map(num));
    const points =
      !raw || raw.some((p) => !p || p.length !== 3 || !p.every(Number.isFinite))
        ? undefined
        : raw.map((p) => scale(p as Vec3, mm));
    pointsOf.set(id, points);
    return points;
  };
  const leaves = new Map<number, { points: Vec3[]; edges: number[] } | string>();
  const leafOf = (e: P21Instance): { points: Vec3[]; edges: number[] } | string => {
    const known = leaves.get(e.id);
    if (known !== undefined) return known;
    const result = readLeaf(e);
    leaves.set(e.id, result);
    return result;
  };
  /** Indices from 1 into a list of `n` points as 0-based edge pairs; false when one is outside. */
  const polyline = (edges: number[], n: number, indices: number[], closed = false) => {
    const ok = (i: number | undefined) => Number.isInteger(i) && i! >= 1 && i! <= n;
    if (!indices.every(ok)) return false;
    for (let i = 1; i < indices.length; i++) edges.push(indices[i - 1]! - 1, indices[i]! - 1);
    if (closed && indices.length > 2) edges.push(indices[indices.length - 1]! - 1, indices[0]! - 1);
    return true;
  };
  const readLeaf = (e: P21Instance): { points: Vec3[]; edges: number[] } | string => {
    const curves = part(e, 'TESSELLATED_CURVE_SET');
    if (curves && curves.args.length >= 2) {
      const n = curves.args.length;
      const points = coordinates(refs(curves.args[n - 2])[0]);
      const strips = list(curves.args[n - 1])?.map((s) => list(s)?.map(num));
      const edges: number[] = [];
      if (!points || !strips || strips.some((s) => !s || !polyline(edges, points.length, s)))
        return 'TESSELLATED_CURVE_SET';
      return { points, edges };
    }
    // Triangles as their edges: simple instances only (name, coordinates, pnmax, normals,
    // pnindex, …), the point of a triangle index through `pnindex` when it is not empty.
    const complexSet = !e.parts && e.type === 'COMPLEX_TRIANGULATED_SURFACE_SET';
    const triangleSet = !e.parts && e.type === 'TRIANGULATED_SURFACE_SET';
    if (complexSet || triangleSet) {
      const all = coordinates(refs(e.args[1])[0]);
      const pnindex = list(e.args[4])?.map(num) ?? [];
      if (!all) return e.type;
      // The shared, already checked list itself, or this leaf's own picks from it (checked
      // here, in the size of `pnindex`): a shared list is not scanned again for each leaf.
      const points = pnindex.length ? pnindex.map((i) => all[i - 1]) : all;
      if (pnindex.length && points.some((v) => !v)) return e.type;
      const groups = (v: P21Value | undefined) => list(v)?.map((s) => list(s)?.map(num));
      const edges: number[] = [];
      const triangle = (a: number, b: number, c: number) =>
        polyline(edges, points.length, [a, b, c], true);
      if (triangleSet) {
        const t = groups(e.args[5]);
        if (!t || t.some((x) => !x || x.length !== 3)) return e.type;
        for (const x of t as number[][]) if (!triangle(x[0]!, x[1]!, x[2]!)) return e.type;
      } else {
        const strips = groups(e.args[5]);
        const fans = groups(e.args[6]);
        if (!strips || !fans || [...strips, ...fans].some((s) => !s)) return e.type;
        for (const s of strips as number[][])
          for (let i = 2; i < s.length; i++)
            if (!triangle(s[i - 2]!, s[i - 1]!, s[i]!)) return e.type;
        for (const f of fans as number[][])
          for (let i = 2; i < f.length; i++) if (!triangle(f[0]!, f[i - 1]!, f[i]!)) return e.type;
      }
      return { points: points as Vec3[], edges };
    }
    return typeOf(e);
  };

  let placeholders = 0;
  /**
   * Vertices drawn so far in the whole file. Shared tessellated geometry can be referenced
   * many times, so the lines are bounded while they are made, not only in the asset: past
   * `cadPmiLimits.vertices` (one asset's limit) a callout is not drawn (`presentation-budget`).
   */
  let vertices = 0;
  /**
   * Entities visited while drawing, in the whole file: nested sets can share children that
   * draw nothing, so the walk is bounded as well as what it draws.
   */
  let visits = 0;
  /**
   * Vertices made in the whole file, including those of callouts later discarded: a shared
   * curve in many callouts that each fail would otherwise be made again and again.
   */
  let work = 0;
  let over = false;
  const read = (callout: P21Instance): PmiFileCallout => {
    const out: PmiFileCallout = {
      id: callout.id,
      segments: [],
      ...(planeOf.has(callout.id) ? { plane: planeOf.get(callout.id) } : {}),
      presents: [...new Set((definitions.get(callout.id) ?? []).flatMap((d) => item(d) ?? []))],
      occurrences: [],
      frames: modelFrames(callout.id),
    };
    const fail = (why: string) => {
      out.unsupported ??= why;
    };
    // An annotation plane placed past the coordinate range: nothing of the callout is drawn.
    if (out.plane && !inRange(out.plane.origin)) fail('coordinate-range');
    const segment = (a: Vec3 | undefined, b: Vec3 | undefined) => {
      if (!a || !b) return false;
      if (!inRange(a) || !inRange(b)) {
        fail('coordinate-range');
        return false;
      }
      if (vertices + 2 > cadPmiLimits.vertices || work + 2 > presentationWork) {
        over = true;
        fail(budget);
        return false;
      }
      vertices += 2;
      work += 2;
      out.segments.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      return true;
    };
    const tessellated = (id: number, outer: Frame, depth: number): void => {
      if (over || ++visits > presentationVisits) {
        over = true;
        return fail(budget);
      }
      const e = get(id);
      if (!e || depth > 8) return fail(`#${id}`);
      const moved = part(e, 'REPOSITIONED_TESSELLATED_ITEM');
      const placed = moved ? frame(refs(moved.args[0])[0]) : identity;
      if (!placed) return fail('REPOSITIONED_TESSELLATED_ITEM');
      const at = compose(outer, placed);
      const set = part(e, 'TESSELLATED_GEOMETRIC_SET');
      if (set) {
        for (const child of refs(set.args[set.args.length - 1])) tessellated(child, at, depth + 1);
        return;
      }
      // The anchor of a repositioned set, no lines.
      if (part(e, 'AXIS2_PLACEMENT_3D') && !e.parts) return;
      const lines = leafOf(e);
      if (typeof lines === 'string') return fail(lines);
      // Only the points the edges use are placed: what the vertex budget counts.
      const { points, edges } = lines;
      for (let i = 0; i < edges.length; i += 2)
        if (!segment(apply(at, points[edges[i]!]!), apply(at, points[edges[i + 1]!]!))) return;
    };
    const contents = part(callout, 'DRAUGHTING_CALLOUT')!;
    for (const id of refs(contents.args[1])) {
      const o = get(id);
      if (o) out.occurrences.push(id);
      if (!o) {
        fail(`#${id}`);
        continue;
      }
      if (part(o, /^ANNOTATION_PLACEHOLDER_OCCURRENCE/)) {
        placeholders++;
        continue;
      }
      const occurrence = part(o, 'TESSELLATED_ANNOTATION_OCCURRENCE');
      if (!occurrence) {
        fail(typeOf(o));
        continue;
      }
      const geometry = refs(occurrence.args[occurrence.args.length - 1])[0];
      if (geometry === undefined) fail('TESSELLATED_ANNOTATION_OCCURRENCE');
      else tessellated(geometry, identity, 0);
    }
    if (!out.segments.length) fail('no lines');
    if (out.unsupported) {
      vertices -= out.segments.length / 3;
      out.segments = [];
    }
    return out;
  };

  /** The callouts each draughting model lists, found once per model (cameras share models). */
  const modelCallouts = new Map<(typeof models)[number], number[]>();
  const calloutsInModel = (m: (typeof models)[number]) => {
    let found = modelCallouts.get(m);
    if (!found) {
      found = [...new Set(m.items)].filter((id) => !!part(get(id), 'DRAUGHTING_CALLOUT'));
      modelCallouts.set(m, found);
    }
    return found;
  };
  /**
   * The callouts of a camera's models: one model's list, or the union of several, made once
   * for each set of models and shared by the cameras in it (charged, `presentationExpansion`).
   */
  const unions = new Map<string, number[]>();
  const index = new Map(models.map((m, i) => [m, i]));
  const membersOf = (inModel: (typeof models)[number][]) => {
    if (inModel.length === 1) return calloutsInModel(inModel[0]!);
    const key = inModel.map((m) => index.get(m)).join();
    let union = unions.get(key);
    if (!union) {
      const lists = inModel.map(calloutsInModel);
      charge(lists.reduce((n, l) => n + l.length, 0));
      union = [...new Set(lists.flat())];
      unions.set(key, union);
    }
    return union;
  };
  const views: PmiFileView[] = cameras.map((e) => {
    const p = part(e, /^CAMERA_MODEL_D3/)!;
    const inModel = modelsOf.get(e.id) ?? [];
    const members = membersOf(inModel);
    const view: PmiFileView = {
      id: e.id,
      name: str(p.args[0]),
      callouts: members,
      frames: modelFrames(e.id),
    };
    const f = frame(refs(p.args[1])[0]);
    const volume = part(get(refs(p.args[2])[0] ?? -1), 'VIEW_VOLUME');
    const window = part(get(refs(volume?.args[8])[0] ?? -1), 'PLANAR_BOX');
    const projection = volume?.args[0]?.t === 'enum' ? volume.args[0].v : '';
    const width = num(window?.args[1]) * mm;
    const height = num(window?.args[2]) * mm;
    const flag = (v: P21Value | undefined) => v?.t === 'enum' && v.v === 'T';
    if (!f) view.unsupported = 'view reference system';
    else if (!volume || !window || !(width > 0) || !(height > 0)) view.unsupported = 'view volume';
    else if (projection !== 'PARALLEL' && projection !== 'CENTRAL') view.unsupported = projection;
    else if (!inRange(f.o) || !inRange([width, height])) view.unsupported = 'coordinate-range';
    else
      view.camera = {
        eye: f.o,
        direction: f.z,
        up: f.y,
        projection: projection === 'PARALLEL' ? 'parallel' : 'central',
        width,
        height,
        clipping:
          flag(volume.args[4]) ||
          flag(volume.args[6]) ||
          flag(volume.args[7]) ||
          /MULTI_CLIPPING/.test(p.type),
      };
    return view;
  });
  const results = callouts.map(read);
  const byId = new Map(results.map((c) => [c.id, c]));
  for (const [override, restyled] of overrides) {
    const shared = calloutsOf.get(restyled) ?? [];
    charge(shared.length);
    for (const id of shared) byId.get(id)?.occurrences.push(override);
  }
  const itemFrame = new Map<number, number>();
  for (const id of new Set(results.flatMap((c) => c.presents))) {
    const products = itemProducts(id);
    if (products?.size === 1) itemFrame.set(id, [...products][0]);
  }
  return { callouts: results, views, placeholders, relationships, itemFrame };
}
