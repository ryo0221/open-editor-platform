import type { BimDocument, BimElementKind, BimPlacement } from '@editor-platform/bim-core';
import type { GeometryMesh } from '@editor-platform/geometry-kernel-occt';
import type { ViewMesh, ViewSolid, ViewSolidMesh } from '@editor-platform/geometry-view';
import type { BimEvaluation } from './evaluate';
import { partFaceBodies, type BimPartStatus } from './parts';

/** Display colour and opacity by element kind. */
export const bimKindStyle: Record<BimElementKind, { color: string; opacity: number }> = {
  wall: { color: '#d6d3d1', opacity: 1 },
  slab: { color: '#a8a29e', opacity: 1 },
  column: { color: '#94a3b8', opacity: 1 },
  beam: { color: '#7c8ea3', opacity: 1 },
  opening: { color: '#ffffff', opacity: 0 },
  door: { color: '#b45309', opacity: 1 },
  window: { color: '#38bdf8', opacity: 0.55 },
  roof: { color: '#9f1239', opacity: 1 },
  space: { color: '#22c55e', opacity: 0.18 },
  part: { color: '#a78bfa', opacity: 1 },
};

/** A kernel mesh re-centred on its bounds, so large site coordinates keep float precision. */
const viewMeshes = new WeakMap<GeometryMesh, ViewMesh>();
function viewMesh(mesh: GeometryMesh, bounds: [number[], number[]]): ViewMesh {
  let v = viewMeshes.get(mesh);
  if (v) return v;
  const origin = [0, 1, 2].map((i) => (bounds[0][i]! + bounds[1][i]!) / 2) as [
    number,
    number,
    number,
  ];
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = mesh.positions[i]! - origin[i % 3]!;
  v = { origin, positions, normals: mesh.normals, indices: mesh.indices };
  viewMeshes.set(mesh, v);
  return v;
}

/** Column-major 4×4 of a placement (row-major rotation, translation). */
export function placementMatrix(p: BimPlacement | undefined): number[] {
  if (!p) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const r = p.rotation;
  const t = p.translation;
  return [
    r[0]!,
    r[3]!,
    r[6]!,
    0,
    r[1]!,
    r[4]!,
    r[7]!,
    0,
    r[2]!,
    r[5]!,
    r[8]!,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

export interface BimViewOptions {
  selection: ReadonlySet<string>;
  /** Element kinds left out of the view. */
  hiddenKinds?: ReadonlySet<BimElementKind>;
  /** Part shapes by content hash: a part without its shape is drawn as its type's bounds. */
  parts?: ReadonlyMap<string, BimPartStatus>;
}

/**
 * The building as instanced solids for `geometry-view`: elements that share a solid and a
 * style are one solid with an instance each. Each instance's path is its element ID.
 */
export function bimViewSolids(
  doc: BimDocument,
  evaluation: Extract<BimEvaluation, { status: 'ok' }> | undefined,
  options: BimViewOptions,
): ViewSolid[] {
  if (!evaluation) return [];
  const solids = new Map<string, ViewSolid>();
  for (const el of doc.elements) {
    if (options.hiddenKinds?.has(el.kind)) continue;
    const r = evaluation.elements.get(el.id);
    if (el.kind === 'part' && r?.status === 'error' && r.placement) {
      // Still being read, or unavailable: the bounds the Host reported for the version.
      const type = doc.types.find((t) => t.id === el.typeId);
      if (type?.kind !== 'part') continue;
      const loading = options.parts?.get(type.source.contentHash)?.status === 'loading';
      const key = `${type.id}\u0000box\u0000${loading}`;
      let solid = solids.get(key);
      if (!solid) {
        solid = {
          bounds: [type.hintBounds.min, type.hintBounds.max],
          box: loading ? 'pending' : 'unavailable',
          instances: [],
        };
        solids.set(key, solid);
      }
      solid.instances.push({
        path: [el.id],
        matrix: placementMatrix(r.placement),
        selected: options.selection.has(el.id),
      });
      continue;
    }
    if (r?.status !== 'ok' || !r.mesh.indices.length) continue;
    const style = bimKindStyle[el.kind];
    const key = `${r.solid}\u0000${el.kind}`;
    const status = el.kind === 'part' ? partStatus(doc, el.typeId, options.parts) : undefined;
    let solid = solids.get(key);
    if (!solid) {
      const mesh = viewMesh(r.mesh, r.measure.bounds);
      const bodies = status && partBodyMeshes(r.mesh, mesh, status);
      const sheet = !!status?.kinds.includes('sheet');
      solid = {
        meshes: bodies ?? [{ mesh, color: style.color, opacity: style.opacity, sheet }],
        bounds: r.measure.bounds,
        instances: [],
      };
      solids.set(key, solid);
    }
    solid.instances.push({
      path: [el.id],
      matrix: placementMatrix(r.placement),
      selected: options.selection.has(el.id),
    });
  }
  return [...solids.values()];
}

/** A part type's version shape, when it has been read. */
function partStatus(
  doc: BimDocument,
  typeId: string,
  parts: ReadonlyMap<string, BimPartStatus> | undefined,
) {
  const type = doc.types.find((t) => t.id === typeId);
  const status = type?.kind === 'part' ? parts?.get(type.source.contentHash) : undefined;
  return status?.status === 'available' ? status : undefined;
}

const bodyMeshes = new WeakMap<ViewMesh, Map<string, ViewSolidMesh[] | undefined>>();
/**
 * OH-U1: a part's mesh split by its CAD bodies' looks. A face index counts the BRep's faces in
 * body order, so `faces` (each body's count) maps it to a body. Bodies that look the same (and are
 * both sheets or both solids) share one mesh. Undefined without looks, or when the faces do not
 * add up, so the part keeps its kind colour.
 */
export function partBodyMeshes(
  kernel: GeometryMesh,
  mesh: ViewMesh,
  status: Extract<BimPartStatus, { status: 'available' }>,
): ViewSolidMesh[] | undefined {
  const bodyOf = partFaceBodies(status);
  if (!bodyOf) return undefined;
  const { looks, kinds } = status as Required<typeof status>;
  const key = JSON.stringify([looks, status.faces, kinds]);
  let cached = bodyMeshes.get(mesh);
  if (cached?.has(key)) return cached.get(key);
  const groupOf = looks.map((l, i) => `${l.color.toLowerCase()} ${l.opacity} ${kinds[i]}`);
  const triangles = new Map<string, number[]>();
  let ok = true;
  for (let t = 0; t < kernel.faceIndices.length && ok; t++) {
    const body = bodyOf[kernel.faceIndices[t]!];
    if (body === undefined) ok = false;
    else {
      const g = groupOf[body]!;
      let list = triangles.get(g);
      if (!list) triangles.set(g, (list = []));
      list.push(mesh.indices[3 * t]!, mesh.indices[3 * t + 1]!, mesh.indices[3 * t + 2]!);
    }
  }
  let out: ViewSolidMesh[] | undefined;
  if (ok && triangles.size) {
    out = [...triangles].map(([g, indices]) => {
      const body = groupOf.indexOf(g);
      return {
        mesh: triangles.size === 1 ? mesh : { ...mesh, indices: new Uint32Array(indices) },
        color: looks[body]!.color,
        opacity: looks[body]!.opacity,
        sheet: kinds[body] === 'sheet',
      };
    });
  }
  if (!cached) bodyMeshes.set(mesh, (cached = new Map()));
  cached.set(key, out);
  return out;
}

/** World bounds of every evaluated element and part box, for framing the camera. */
export function bimViewBounds(
  evaluation: Extract<BimEvaluation, { status: 'ok' }> | undefined,
  doc?: BimDocument,
): [[number, number, number], [number, number, number]] | undefined {
  if (!evaluation) return undefined;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const [id, r] of evaluation.elements) {
    let bounds: [number[], number[]] | undefined;
    if (r.status === 'ok') bounds = r.measure.bounds;
    // A part drawn as its type's bounds (its shape is not read) is framed as that box.
    else if (r.placement && doc) {
      const el = doc.elements.find((e) => e.id === id);
      const type = el?.kind === 'part' ? doc.types.find((t) => t.id === el.typeId) : undefined;
      if (type?.kind === 'part') bounds = [type.hintBounds.min, type.hintBounds.max];
    }
    if (!bounds) continue;
    const m = placementMatrix(r.placement);
    const [a, b] = bounds;
    for (let c = 0; c < 8; c++) {
      const p = [c & 1 ? b[0] : a[0], c & 2 ? b[1] : a[1], c & 4 ? b[2] : a[2]];
      for (let i = 0; i < 3; i++) {
        const w = m[i]! * p[0]! + m[4 + i]! * p[1]! + m[8 + i]! * p[2]! + m[12 + i]!;
        lo[i] = Math.min(lo[i]!, w);
        hi[i] = Math.max(hi[i]!, w);
      }
    }
  }
  return lo[0] === Infinity
    ? undefined
    : [lo as [number, number, number], hi as [number, number, number]];
}

/** The level an element is drawn on: its base or top level, or its host's. */
export function bimElementLevel(doc: BimDocument, id: string, seen = 0): string | undefined {
  const el = doc.elements.find((e) => e.id === id);
  if (!el || seen > 2) return undefined;
  switch (el.kind) {
    case 'wall':
    case 'column':
    case 'roof':
    case 'space':
    case 'part':
      return el.base.level;
    case 'slab':
    case 'beam':
      return el.top.level;
    case 'opening':
    case 'door':
    case 'window':
      return bimElementLevel(doc, el.hostId, seen + 1);
  }
}
