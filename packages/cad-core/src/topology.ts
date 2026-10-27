/**
 * Persistent topology names and references (docs/cad/r1-modeling.md, 永続topology参照).
 *
 * A face name is a list of segments, outermost prefix first (`['tool:cyl-a', 'side']`), so an ID
 * that contains `/` or `:` never makes two names equal. Edges are named by their two faces and
 * vertices by the faces around them (three at a box's corner), each list sorted, so a name never
 * carries a kernel enumeration index.
 */
import type { CadFeature } from './model';
import type { CadSketch } from './sketch';

export type CadFaceName = readonly string[];
/** One face name for a face, two for an edge, three for a vertex, sorted by `faceNameKey`. */
export type CadTopoName = readonly CadFaceName[];
/** Vertices are referenced by connectors only (R2b-2c): no feature reads one. */
export type CadTopologyKind = 'face' | 'edge' | 'vertex';

export interface CadTopologyRef {
  kind: CadTopologyKind;
  /** An input feature of the feature that uses the reference; resolved on its output only. */
  featureId: string;
  name: CadTopoName;
  /** Written by a command when names alone do not pick one element (分かれた要素の選び直し). */
  select?: { adjacent: CadTopoName[] };
  /** Geometry when the reference was made: orders candidates, never resolves a reference. */
  hint: { centroid: [number, number, number]; normal?: [number, number, number]; size: number };
}

/**
 * One stored reference that did not resolve, as evaluation reports it (解決): where it is in its
 * feature's args, and for an ambiguous one its candidates nearest the hint first. Each candidate
 * carries the reference that would pick it (`select` from `selectFor`), or none when names do not
 * tell it apart. A candidate is only a proposal: the rebound content is evaluated again.
 */
export interface CadReferenceProblem {
  featureId: string;
  /** Path inside the feature's `args`, e.g. `['edges', 2]`. */
  path: (string | number)[];
  status: 'ambiguous' | 'missing';
  candidates: {
    ref?: CadTopologyRef;
    hint: CadTopologyRef['hint'];
  }[];
}
/** Candidates one problem lists at most. */
export const cadReferenceCandidates = 16;

export const cadTopologyLimits = Object.freeze({
  nameSegments: 64,
  nameChars: 1024,
  refsPerFeature: 256,
  refsPerDocument: 4096,
});

/**
 * The pick table of one shape: its faces, edges and vertices in the kernel's map order. Indices
 * are evaluation-scoped and never stored; names are. Edges list their faces (1 or 2) and end
 * vertices by index, which is all adjacency needs; a vertex is named by the faces of its edges.
 */
export interface CadTopologyTable {
  faces: { name: CadFaceName | null; centroid: [number, number, number]; area: number }[];
  edges: {
    faces: number[];
    vertices: number[];
    centroid: [number, number, number];
    length: number;
    /**
     * A sheet's free edge (on one face, not a seam) where its feature names the boundary
     * (docs/cad/r2a-freeform.md, 命名): the edge is named by its face and this name.
     */
    boundary?: CadFaceName;
  }[];
  /** The kernel's points (mm, the body's coordinates), in the order edges index them. */
  vertices: { centroid: [number, number, number] }[];
}

export const faceNameKey = (name: CadFaceName) => JSON.stringify(name);
export const topoNameKey = (name: CadTopoName) => JSON.stringify(name);
/**
 * The segments that hold a list of names as JSON (`blend:[…]`, `shared:[…]`, R2a-2c's
 * `boundary:[…]` and `side:[…]` for a referenced edge, and R2a-3's `cut:[…]` for a trim's cut
 * along a sheet's face).
 */
const nested = (s: string): [string, CadTopoName] | null => {
  const m = /^(blend|shared|boundary|side|cut):\[/.exec(s);
  if (!m) return null;
  try {
    return [m[1]!, JSON.parse(s.slice(m[1]!.length + 1)) as CadTopoName];
  } catch {
    return null;
  }
};
/**
 * Segments joined by `/`; a blend segment shows the edge it replaces as `blend:(a | b)`, a shared
 * segment the faces it was as `shared:(a | b)`.
 */
export const formatFaceName = (name: CadFaceName): string =>
  name
    .map((s) => {
      const n = nested(s);
      return n ? `${n[0]}:(${formatTopoName(n[1])})` : s;
    })
    .join('/');
export const formatTopoName = (name: CadTopoName) => name.map(formatFaceName).join(' | ');

/** Prefixes `segment` to a name, failing past the name limits (`topology-name-too-long`). */
export function prefixFaceName(segment: string, name: CadFaceName): CadFaceName {
  const next = [segment, ...name];
  if (!faceNameFits(next)) throw new Error('topology-name-too-long');
  return next;
}
export const faceNameFits = (name: CadFaceName) =>
  name.length <= cadTopologyLimits.nameSegments &&
  name.reduce((n, s) => n + s.length, 0) <= cadTopologyLimits.nameChars;

const sorted = (names: CadFaceName[]): CadTopoName =>
  [...names].sort((a, b) => (faceNameKey(a) < faceNameKey(b) ? -1 : 1));
/** The name of the edge between two named faces. */
export const edgeName = (a: CadFaceName, b: CadFaceName): CadTopoName => sorted([a, b]);

/** The name of element `index` of `kind`, or null when one of its faces is unnamed. */
export function elementName(
  table: CadTopologyTable,
  kind: CadTopologyKind,
  index: number,
): CadTopoName | null {
  const edge = kind === 'edge' ? table.edges[index]! : undefined;
  const faces = edge ? edge.faces : kind === 'vertex' ? vertexFaces(table, index) : [index];
  const names = faces.map((f) => table.faces[f]!.name);
  if (kind === 'vertex')
    return names.length && names.every((n) => n !== null) ? sorted(names as CadFaceName[]) : null;
  if (names.some((n) => n === null)) return null;
  // A seam edge borders one face twice; it is named by that face twice, like any edge. A free
  // edge of a sheet is named by its face and its boundary when the feature names one.
  return sorted(
    (names.length === 1 && edge ? [names[0], edge.boundary ?? names[0]] : names) as CadFaceName[],
  );
}

/** The faces of a vertex's edges, each once, in table order. */
function vertexFaces(table: CadTopologyTable, index: number): number[] {
  const out = new Set<number>();
  for (const e of table.edges) if (e.vertices.includes(index)) for (const f of e.faces) out.add(f);
  return [...out].sort((a, b) => a - b);
}
/** An element's position and size (area, length, or 0 for a point), for hints and ordering. */
export function elementGeometry(table: CadTopologyTable, kind: CadTopologyKind, index: number) {
  if (kind === 'vertex') return { centroid: table.vertices[index]!.centroid, size: 0 };
  const element = kind === 'face' ? table.faces[index]! : table.edges[index]!;
  return { centroid: element.centroid, size: 'area' in element ? element.area : element.length };
}
const elementCount = (table: CadTopologyTable, kind: CadTopologyKind) =>
  kind === 'face'
    ? table.faces.length
    : kind === 'edge'
      ? table.edges.length
      : table.vertices.length;

/**
 * Elements adjacent to element `index`: faces sharing an edge, edges sharing a vertex, or
 * vertices sharing an edge.
 */
function neighbours(table: CadTopologyTable, kind: CadTopologyKind, index: number): number[] {
  const out = new Set<number>();
  if (kind === 'vertex') {
    for (const e of table.edges)
      if (e.vertices.includes(index)) for (const v of e.vertices) if (v !== index) out.add(v);
  } else if (kind === 'face') {
    for (const e of table.edges)
      if (e.faces.includes(index)) for (const f of e.faces) if (f !== index) out.add(f);
  } else {
    const ends = table.edges[index]!.vertices;
    table.edges.forEach((e, i) => {
      if (i !== index && e.vertices.some((v) => ends.includes(v))) out.add(i);
    });
  }
  return [...out];
}
const adjacentNames = (table: CadTopologyTable, kind: CadTopologyKind, index: number) => {
  const names = new Map<string, CadTopoName>();
  for (const n of neighbours(table, kind, index)) {
    const name = elementName(table, kind, n);
    if (name) names.set(topoNameKey(name), name);
  }
  return names;
};
const satisfies = (
  table: CadTopologyTable,
  kind: CadTopologyKind,
  index: number,
  adjacent: readonly CadTopoName[],
) => {
  const names = adjacentNames(table, kind, index);
  return adjacent.every((a) => names.has(topoNameKey(a)));
};

/** Elements that carry `name`, in table order. */
export function candidatesOf(
  table: CadTopologyTable,
  kind: CadTopologyKind,
  name: CadTopoName,
): number[] {
  const key = topoNameKey(name);
  const count = elementCount(table, kind);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const n = elementName(table, kind, i);
    if (n && topoNameKey(n) === key) out.push(i);
  }
  return out;
}

export type CadReferenceResolution =
  | { status: 'resolved'; index: number }
  /** Candidates nearest the hint first (docs/cad/r1-modeling.md, 解決). */
  | { status: 'ambiguous'; candidates: number[] }
  | { status: 'missing' };

/** Classifies a reference on a table. Never picks the nearest element by geometry. */
export function resolveTopologyRef(
  table: CadTopologyTable,
  ref: Pick<CadTopologyRef, 'kind' | 'name' | 'select' | 'hint'>,
): CadReferenceResolution {
  const hits = candidatesOf(table, ref.kind, ref.name).filter(
    (i) => !ref.select || satisfies(table, ref.kind, i, ref.select.adjacent),
  );
  if (hits.length === 1) return { status: 'resolved', index: hits[0]! };
  if (!hits.length) return { status: 'missing' };
  const at = (i: number) => elementGeometry(table, ref.kind, i).centroid;
  const d = (i: number) => Math.hypot(...at(i).map((c, k) => c - ref.hint.centroid[k]!));
  // Ties keep table order, so the list is deterministic for one evaluation.
  return { status: 'ambiguous', candidates: [...hits].sort((a, b) => d(a) - d(b)) };
}

/** Subsets `selectFor` tries before it stops looking for the smallest one. */
const selectSearchLimit = 50_000;

/**
 * The `select` that picks element `index` among the elements of its name: the smallest set of
 * its neighbours' names that no other candidate has all of (ties broken by name order), or
 * undefined when names alone pick it. Past `selectSearchLimit` subsets it returns a set none of
 * whose names can be dropped instead. Throws `reference-not-selectable` when even all of its
 * neighbours' names do not tell it apart (a symmetric candidate).
 */
export function selectFor(
  table: CadTopologyTable,
  kind: CadTopologyKind,
  index: number,
): { adjacent: CadTopoName[] } | undefined {
  const name = elementName(table, kind, index);
  if (!name) throw new Error('reference-unnamed');
  const others = candidatesOf(table, kind, name).filter((i) => i !== index);
  if (!others.length) return undefined;
  const own = [...adjacentNames(table, kind, index).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const around = others.map((o) => adjacentNames(table, kind, o));
  const unique = (keys: number[]) => around.every((n) => !keys.every((k) => n.has(own[k]![0])));
  const all = own.map((_, i) => i);
  if (!unique(all)) throw new Error('reference-not-selectable');
  const named = (keys: number[]) => ({ adjacent: keys.map((k) => own[k]![1]) });
  let budget = selectSearchLimit;
  const search = (size: number, from: number, picked: number[]): number[] | undefined => {
    if (picked.length === size) return budget-- > 0 && unique(picked) ? picked : undefined;
    for (let i = from; i < own.length && budget > 0; i++) {
      const hit = search(size, i + 1, [...picked, i]);
      if (hit) return hit;
    }
    return undefined;
  };
  for (let size = 1; size <= own.length && budget > 0; size++) {
    const hit = search(size, 0, []);
    if (hit) return named(hit);
  }
  // Too many neighbours to search: drop every name the rest still decides without.
  const keep = [...all];
  for (const k of all) {
    const without = keep.filter((x) => x !== k);
    if (unique(without)) keep.splice(keep.indexOf(k), 1);
  }
  return named(keep);
}

/**
 * The reference that picks element `index` of `table`, the output of feature `featureId`: its
 * name, the `select` that tells it apart, and its geometry as the hint. Throws like `selectFor`.
 */
export function topologyRefOf(
  table: CadTopologyTable,
  kind: CadTopologyKind,
  index: number,
  featureId: string,
): CadTopologyRef {
  const select = selectFor(table, kind, index);
  const { centroid, size } = elementGeometry(table, kind, index);
  return {
    kind,
    featureId,
    name: elementName(table, kind, index)!,
    ...(select ? { select } : {}),
    hint: { centroid, size },
  };
}

/** A sketch's stored reference: the face it is attached to, at `['plane', 'face']` in it. */
export function sketchReferences(
  s: Pick<CadSketch, 'plane'>,
): { path: (string | number)[]; ref: CadTopologyRef }[] {
  return 'face' in s.plane ? [{ path: ['plane', 'face'], ref: s.plane.face }] : [];
}
/** Every stored reference of `f`, with its path in the feature's args, in args order. */
export function featureReferences(
  f: CadFeature,
): { path: (string | number)[]; ref: CadTopologyRef }[] {
  const list = (key: string, refs: CadTopologyRef[]) =>
    refs.map((ref, i) => ({ path: [key, i], ref }));
  switch (f.type) {
    case 'fillet':
      return list('edges', f.args.edges);
    case 'chamfer':
      return [
        ...list('edges', f.args.edges),
        ...('face' in f.args ? [{ path: ['face'], ref: f.args.face }] : []),
      ];
    case 'shell':
      return list('openFaces', f.args.openFaces);
    case 'draft':
      return [...list('faces', f.args.faces), { path: ['neutral'], ref: f.args.neutral }];
    case 'mirror':
      return 'face' in f.args.plane ? [{ path: ['plane', 'face'], ref: f.args.plane.face }] : [];
    case 'surfaceLoft':
      return f.args.sections.flatMap((x, i) =>
        'edges' in x ? x.edges.map((ref, j) => ({ path: ['sections', i, 'edges', j], ref })) : [],
      );
    case 'boundarySurface':
      return f.args.curves.flatMap((c, i) =>
        'edge' in c ? [{ path: ['curves', i, 'edge'], ref: c.edge }] : [],
      );
    case 'fill':
      return f.args.boundary.flatMap((b, i) =>
        'edge' in b.curve ? [{ path: ['boundary', i, 'curve', 'edge'], ref: b.curve.edge }] : [],
      );
    default:
      return [];
  }
}

/**
 * Where a surface feature's curve comes from (docs/cad/r2a-freeform.md, 命名), so its boundary
 * edge keeps one name whatever the curves' order or direction: a sketch element is
 * `sketch:<sketch ID>/boundary:e:<element ID>`, a referenced edge
 * `from:<feature ID>/boundary:<the edge's name>`.
 */
export function curveBoundaryName(
  source: { sketchId: string; element: string } | { edge: CadTopologyRef },
): CadFaceName {
  const name =
    'edge' in source
      ? [`from:${source.edge.featureId}`, `boundary:${topoNameKey(source.edge.name)}`]
      : [`sketch:${source.sketchId}`, `boundary:e:${source.element}`];
  if (!faceNameFits(name)) throw new Error('topology-name-too-long');
  return name;
}
/** A loft side face from a referenced edge: `from:<feature ID>/side:<the edge's name>`. */
export function edgeSideName(ref: CadTopologyRef): CadFaceName {
  const name = [`from:${ref.featureId}`, `side:${topoNameKey(ref.name)}`];
  if (!faceNameFits(name)) throw new Error('topology-name-too-long');
  return name;
}

/**
 * Where a trim's cut runs (R2a-3, 命名): along element `e` of a sketch chain
 * `sketch:<sketch ID>/cut:e:<element ID>`, a plane `cut:plane`, a face of another sheet
 * `from:<feature ID>/cut:<the face's name>`. A cut edge is named by its piece and this.
 */
export function cutBoundaryName(
  tool:
    | { sketchId: string; element: string }
    | { plane: true }
    | { featureId: string; face: CadFaceName },
): CadFaceName {
  const name =
    'plane' in tool
      ? ['cut:plane']
      : 'face' in tool
        ? [`from:${tool.featureId}`, `cut:${topoNameKey([tool.face])}`]
        : [`sketch:${tool.sketchId}`, `cut:e:${tool.element}`];
  if (!faceNameFits(name)) throw new Error('topology-name-too-long');
  return name;
}
/** A thicken's side face along a sheet's free edge: `side:<the edge's name>` (R2a-3, 命名). */
export function thickenSideName(edge: CadTopoName): CadFaceName {
  const name = [`side:${topoNameKey(edge)}`];
  if (!faceNameFits(name)) throw new Error('topology-name-too-long');
  return name;
}

/** The face a fillet or chamfer makes in place of an edge: `blend:<the edge's name>` (命名). */
export function blendFaceName(edge: CadTopoName): CadFaceName {
  const name = [`blend:${topoNameKey(edge)}`];
  if (!faceNameFits(name)) throw new Error('topology-name-too-long');
  return name;
}

/**
 * The face several tool faces of one Boolean became (coincident faces): `shared:<their names>`,
 * sorted, so neither the order of the tools nor their IDs choose one of them.
 */
export function sharedFaceName(names: CadFaceName[]): CadFaceName {
  const name = [`shared:${topoNameKey(sorted(names))}`];
  if (!faceNameFits(name)) throw new Error('topology-name-too-long');
  return name;
}

/**
 * A name with the IDs it carries replaced by `idMap` (a duplicated closure's copies): `tool:<id>`,
 * `copy:<id>:<i>`, `mirror:<id>`, `sew:<id>` and `trim:<id>:<side>` segments, polyline sides `side:v:<vertex ID>` (other side
 * names are recipe names, never IDs) and the names inside `blend:` and `shared:` segments.
 */
export function remapTopoName(
  name: CadTopoName,
  idMap: Readonly<Record<string, string>>,
): CadTopoName {
  const segment = (s: string): string => {
    if (s.startsWith('tool:') && Object.hasOwn(idMap, s.slice(5)))
      return `tool:${idMap[s.slice(5)]}`;
    if (s.startsWith('side:v:') && Object.hasOwn(idMap, s.slice(7)))
      return `side:v:${idMap[s.slice(7)]}`;
    if (s.startsWith('mirror:') && Object.hasOwn(idMap, s.slice(7)))
      return `mirror:${idMap[s.slice(7)]}`;
    if (s.startsWith('from:') && Object.hasOwn(idMap, s.slice(5)))
      return `from:${idMap[s.slice(5)]}`;
    if (s.startsWith('sketch:') && Object.hasOwn(idMap, s.slice(7)))
      return `sketch:${idMap[s.slice(7)]}`;
    if (s.startsWith('sew:') && Object.hasOwn(idMap, s.slice(4))) return `sew:${idMap[s.slice(4)]}`;
    // The side is a word, so the ID is everything before the last `:`.
    const trim = /^trim:(.*):(inside|outside|front|back)$/.exec(s);
    if (trim && Object.hasOwn(idMap, trim[1]!)) return `trim:${idMap[trim[1]!]}:${trim[2]}`;
    // The copy index is digits, so the ID is everything before the last `:`.
    const copy = /^copy:(.*):(\d+)$/.exec(s);
    if (copy && Object.hasOwn(idMap, copy[1]!)) return `copy:${idMap[copy[1]!]}:${copy[2]}`;
    const n = nested(s);
    if (!n) return s;
    const inner = remapTopoName(n[1], idMap);
    if (n[0] === 'boundary' || n[0] === 'side' || n[0] === 'cut')
      return `${n[0]}:${topoNameKey(inner)}`;
    return (n[0] === 'blend' ? blendFaceName(inner) : sharedFaceName([...inner]))[0]!;
  };
  return sorted(name.map((face) => face.map(segment)));
}
