import {
  BimContext,
  bimLayerFaceMaterialIds,
  bimSurfaceMaterialId,
  bimWallAxis,
  type BimDocument,
  type BimElement,
  type BimElementKind,
  type BimPlacement,
} from '@editor-platform/bim-core';
import type { GeometryMesh } from '@editor-platform/geometry-kernel-occt';
import type { GeometryTextureSet } from '@editor-platform/geometry-core';
import type {
  ViewMesh,
  ViewSolid,
  ViewSolidMesh,
  ViewTextureSet,
} from '@editor-platform/geometry-view';
import type { BimElementResult, BimEvaluation } from './evaluate';
import { partFaceBodies, type BimPartStatus } from './parts';

/** Display colour and opacity by element kind. */
export const bimKindStyle: Record<BimElementKind, { color: string; opacity: number }> = {
  wall: { color: '#d6d3d1', opacity: 1 },
  slab: { color: '#a8a29e', opacity: 1 },
  column: { color: '#94a3b8', opacity: 1 },
  beam: { color: '#7c8ea3', opacity: 1 },
  member: { color: '#64748b', opacity: 1 },
  ramp: { color: '#a8a29e', opacity: 1 },
  railing: { color: '#78716c', opacity: 1 },
  stair: { color: '#a8a29e', opacity: 1 },
  opening: { color: '#ffffff', opacity: 0 },
  door: { color: '#b45309', opacity: 1 },
  window: { color: '#38bdf8', opacity: 0.55 },
  roof: { color: '#9f1239', opacity: 1 },
  space: { color: '#22c55e', opacity: 0.18 },
  part: { color: '#a78bfa', opacity: 1 },
};

/** How an element is drawn: colour, opacity and, from its material (#661), a finish. */
export type BimLook = {
  color: string;
  opacity: number;
  roughness?: number;
  metalness?: number;
  /** #662: the material's image maps. */
  textures?: GeometryTextureSet;
};
/**
 * Each element's look: its type's surface material's appearance when that material has one
 * (#661), else its kind's colour, as before materials.
 */
export function bimElementLooks(doc: BimDocument): (el: BimElement) => BimLook {
  const materials = new Map(doc.materials.map((m) => [m.id, m]));
  const types = new Map(doc.types.map((t) => [t.id, t]));
  return (el) => {
    const type = 'typeId' in el ? types.get(el.typeId) : undefined;
    const material = type && materials.get(bimSurfaceMaterialId(type) ?? '');
    return lookOf(material?.appearance, el.kind);
  };
}

const lookOf = (
  a: NonNullable<BimDocument['materials'][number]['appearance']> | undefined,
  kind: BimElementKind,
): BimLook =>
  a
    ? {
        color: a.color,
        opacity: a.opacity,
        roughness: a.roughness,
        metalness: a.metalness,
        ...(a.textures ? { textures: a.textures } : {}),
      }
    : bimKindStyle[kind];

/**
 * #662 (2c): the look of a layered element's last-layer face (a wall's left of its drawing
 * direction, a slab's or roof's top) when it differs from the rest, which shows the first
 * layer's (`bimElementLooks`). Undefined when both faces look the same.
 */
export function bimElementFaceLooks(doc: BimDocument): (el: BimElement) => BimLook | undefined {
  const materials = new Map(doc.materials.map((m) => [m.id, m]));
  const types = new Map(doc.types.map((t) => [t.id, t]));
  return (el) => {
    if (el.kind !== 'wall' && el.kind !== 'slab' && el.kind !== 'roof') return undefined;
    const type = types.get(el.typeId);
    const ids = type && bimLayerFaceMaterialIds(type);
    if (!ids || ids.first === ids.last) return undefined;
    const first = lookOf(materials.get(ids.first)?.appearance, el.kind);
    const last = lookOf(materials.get(ids.last)?.appearance, el.kind);
    return JSON.stringify(first) === JSON.stringify(last) ? undefined : last;
  };
}

/**
 * Which faces of a layered element's mesh show its last layer: per face index, true for a vertical wall
 * face square to the axis that looks to the left of the drawing direction (radially on an arc
 * wall), or a slab or roof face that looks up. Every other face (ends, reveals, edges, underside) is false.
 */
export function bimLastLayerFaces(ctx: BimContext, el: BimElement, mesh: GeometryMesh): boolean[] {
  const normals: [number, number, number][] = [];
  const centres: [number, number, number, number][] = [];
  const p = mesh.positions;
  for (let t = 0; t < mesh.faceIndices.length; t++) {
    const f = mesh.faceIndices[t]!;
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t * 3 + k]! * 3);
    const e1 = [0, 1, 2].map((k) => p[b! + k]! - p[a! + k]!);
    const e2 = [0, 1, 2].map((k) => p[c! + k]! - p[a! + k]!);
    const n: [number, number, number] = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    const area = Math.hypot(...n);
    const sum = (normals[f] ??= [0, 0, 0]);
    const at = (centres[f] ??= [0, 0, 0, 0]);
    for (let k = 0; k < 3; k++) {
      sum[k]! += n[k]!;
      at[k]! += (area * (p[a! + k]! + p[b! + k]! + p[c! + k]!)) / 3;
    }
    at[3]! += area;
  }
  const axis = el.kind === 'wall' ? bimWallAxis(ctx, el) : undefined;
  return normals.map((sum, f) => {
    const len = Math.hypot(...sum);
    if (!(len > 0)) return false;
    const n = sum.map((x) => x / len) as [number, number, number];
    // Any face that looks up is a top: a roof may slope up to 60° (n.z = 0.5), Codex.
    if (!axis) return n[2] > 0.1;
    let left: [number, number];
    if (axis.arc) {
      const c = centres[f]!;
      const r = [c[0]! / c[3]! - axis.arc.center[0], c[1]! / c[3]! - axis.arc.center[1]];
      const lr = Math.hypot(r[0]!, r[1]!) || 1;
      const sign = Math.sign(axis.arc.sweep) || 1;
      left = [(-sign * r[0]!) / lr, (-sign * r[1]!) / lr];
    } else left = [-axis.x[1], axis.x[0]];
    // A side face is vertical (a top cut by a sloping roof stays with the edges) and square to
    // the axis: an end moved by an oblique butt join may still look partly left (Codex).
    // LR2: a wall leaning right by `lean` turns its left face up by as much (Codex).
    const lean = el.kind === 'wall' ? (el.lean ?? 0) : 0;
    const h = Math.hypot(n[0], n[1]);
    if (!(h > 0)) return false;
    const tilt = Math.atan2(n[2], h);
    const along = (n[0] * left[1] - n[1] * left[0]) / h;
    return (
      Math.abs(tilt - lean) < 0.1 &&
      Math.abs(along) < 0.1 &&
      (n[0] * left[0] + n[1] * left[1]) / h > 0.7
    );
  });
}

const faceMeshes = new WeakMap<ViewMesh, Map<string, [ViewMesh, ViewMesh]>>();
/** A mesh split into the triangles of the faces `last` names and the rest. */
function splitByFaces(kernel: GeometryMesh, mesh: ViewMesh, last: boolean[]): [ViewMesh, ViewMesh] {
  const key = last.map((x) => (x ? 1 : 0)).join('');
  let cached = faceMeshes.get(mesh);
  const hit = cached?.get(key);
  if (hit) return hit;
  const parts: [number[], number[]] = [[], []];
  for (let t = 0; t < kernel.faceIndices.length; t++)
    parts[last[kernel.faceIndices[t]!] ? 1 : 0].push(
      mesh.indices[3 * t]!,
      mesh.indices[3 * t + 1]!,
      mesh.indices[3 * t + 2]!,
    );
  const out = parts.map((indices) => ({ ...mesh, indices: new Uint32Array(indices) })) as [
    ViewMesh,
    ViewMesh,
  ];
  if (!cached) faceMeshes.set(mesh, (cached = new Map()));
  cached.set(key, out);
  return out;
}

/** A flat-shaded box over `bounds`, centred on them. */
function boxViewMesh([lo, hi]: ViewSolid['bounds']): ViewMesh {
  const origin = [0, 1, 2].map((i) => (lo[i]! + hi[i]!) / 2) as [number, number, number];
  const half = [0, 1, 2].map((i) => Math.max((hi[i]! - lo[i]!) / 2, 0.005));
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const base = positions.length / 3;
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const p = [0, 0, 0];
        p[axis] = sign * half[axis]!;
        p[u] = a! * half[u]!;
        p[v] = b! * half[v]!;
        positions.push(...p);
        const n = [0, 0, 0];
        n[axis] = sign;
        normals.push(...n);
      }
      // Counter-clockwise seen from outside.
      if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  return {
    origin,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

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
  v = { origin, positions, normals: mesh.normals, uvs: mesh.uvs, indices: mesh.indices };
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
  /** #662: a material's texture set as the view draws it (its decoded images). */
  textures?: (set: GeometryTextureSet) => ViewTextureSet | undefined;
  /**
   * TW0b: a working plan's lower limit (mm): elements wholly below it are left out, so they are
   * neither drawn nor picked. An element reaching above it is drawn whole.
   */
  belowMm?: number;
  /**
   * CR7d: keep a part's bodies apart (one mesh per body, its `body` set) instead of one mesh per
   * look, for a check that reads each body as its own solid.
   */
  bodies?: boolean;
  /**
   * CS1b (docs/cad/construction-site.md): an element's look by its ID, over its own. `null`
   * leaves the element out (neither drawn nor picked); `undefined` keeps its own look. A tinted
   * element is drawn in one look: its last-layer face and part bodies are not told apart.
   */
  tint?: (id: string) => BimLook | null | undefined;
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
  const looks = bimElementLooks(doc);
  const faceLooks = bimElementFaceLooks(doc);
  let ctx: BimContext | undefined;
  for (const el of doc.elements) {
    if (options.hiddenKinds?.has(el.kind)) continue;
    const tint = options.tint?.(el.id);
    if (tint === null) continue;
    const r = evaluation.elements.get(el.id);
    if (options.belowMm !== undefined && r) {
      const top = elementBounds(doc, el.id, r)?.[1][2];
      if (top !== undefined && top < options.belowMm) continue;
    }
    if (el.kind === 'part' && r?.status === 'error' && r.placement) {
      // Still being read, or unavailable: the bounds the Host reported for the version.
      const type = doc.types.find((t) => t.id === el.typeId);
      if (type?.kind !== 'part') continue;
      const loading = options.parts?.get(type.source.contentHash)?.status === 'loading';
      const bounds: ViewSolid['bounds'] = [type.hintBounds.min, type.hintBounds.max];
      // A tinted part is still a box, drawn solid in its tint (e.g. a construction state).
      const key = tint
        ? `${type.id}\u0000box\u0000${JSON.stringify(tint)}`
        : `${type.id}\u0000box\u0000${loading}`;
      let solid = solids.get(key);
      if (!solid) {
        solid = tint
          ? {
              meshes: [
                {
                  mesh: boxViewMesh(bounds),
                  color: tint.color,
                  opacity: tint.opacity,
                  sheet: false,
                },
              ],
              bounds,
              instances: [],
            }
          : { bounds, box: loading ? 'pending' : 'unavailable', instances: [] };
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
    const style = tint ?? looks(el);
    const lastLook = tint ? undefined : faceLooks(el);
    // A wall's faces are told apart by its drawing direction: its solid is its own.
    const key = `${r.solid}\u0000${el.kind}\u0000${JSON.stringify(style)}${
      lastLook ? `\u0000${JSON.stringify(lastLook)}\u0000${el.kind === 'wall' ? el.id : ''}` : ''
    }`;
    const status =
      el.kind === 'part' && !tint ? partStatus(doc, el.typeId, options.parts) : undefined;
    let solid = solids.get(key);
    if (!solid) {
      const mesh = viewMesh(r.mesh, r.measure.bounds);
      const bodies = status && partBodyMeshes(r.mesh, mesh, status, options.bodies);
      const sheet = !!status?.kinds.includes('sheet');
      const drawn = (m: ViewMesh, look: BimLook): ViewSolidMesh => ({
        mesh: m,
        color: look.color,
        opacity: look.opacity,
        ...(look.roughness === undefined ? {} : { roughness: look.roughness }),
        ...(look.metalness === undefined ? {} : { metalness: look.metalness }),
        ...(look.textures && options.textures ? { textures: options.textures(look.textures) } : {}),
        sheet,
      });
      let faces: ViewSolidMesh[] | undefined;
      if (lastLook) {
        ctx ??= new BimContext(doc);
        const [rest, last] = splitByFaces(r.mesh, mesh, bimLastLayerFaces(ctx, el, r.mesh));
        faces = [
          ...(rest.indices.length ? [drawn(rest, style)] : []),
          ...(last.indices.length ? [drawn(last, lastLook)] : []),
        ];
      }
      solid = {
        meshes: bodies ?? faces ?? [drawn(mesh, style)],
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
  byBody = false,
): ViewSolidMesh[] | undefined {
  const bodyOf = partFaceBodies(status);
  if (!bodyOf) return undefined;
  const { looks, kinds } = status as Required<typeof status>;
  const key = JSON.stringify([looks, status.faces, kinds, byBody]);
  let cached = bodyMeshes.get(mesh);
  if (cached?.has(key)) return cached.get(key);
  const groupOf = looks.map(
    (l, i) =>
      `${l.color.toLowerCase()} ${l.opacity} ${l.roughness ?? ''} ${l.metalness ?? ''} ${kinds[i]}`,
  );
  const triangles = new Map<string, number[]>();
  let ok = true;
  for (let t = 0; t < kernel.faceIndices.length && ok; t++) {
    const body = bodyOf[kernel.faceIndices[t]!];
    if (body === undefined) ok = false;
    else {
      const g = byBody ? `${body}` : groupOf[body]!;
      let list = triangles.get(g);
      if (!list) triangles.set(g, (list = []));
      list.push(mesh.indices[3 * t]!, mesh.indices[3 * t + 1]!, mesh.indices[3 * t + 2]!);
    }
  }
  let out: ViewSolidMesh[] | undefined;
  if (ok && triangles.size) {
    out = [...triangles].map(([g, indices]) => {
      const body = byBody ? Number(g) : groupOf.indexOf(g);
      return {
        mesh: triangles.size === 1 ? mesh : { ...mesh, indices: new Uint32Array(indices) },
        color: looks[body]!.color,
        opacity: looks[body]!.opacity,
        ...(looks[body]!.roughness === undefined ? {} : { roughness: looks[body]!.roughness }),
        ...(looks[body]!.metalness === undefined ? {} : { metalness: looks[body]!.metalness }),
        sheet: kinds[body] === 'sheet',
        ...(byBody ? { body: g } : {}),
      };
    });
  }
  if (!cached) bodyMeshes.set(mesh, (cached = new Map()));
  cached.set(key, out);
  return out;
}

/** An element's placed bounds in the building (a part without its shape: its type's bounds). */
function elementBounds(
  doc: BimDocument | undefined,
  id: string,
  r: BimElementResult,
): [number[], number[]] | undefined {
  let bounds: [number[], number[]] | undefined;
  if (r.status === 'ok') bounds = r.measure.bounds;
  // A part drawn as its type's bounds (its shape is not read) is framed as that box.
  else if (r.placement && doc) {
    const el = doc.elements.find((e) => e.id === id);
    const type = el?.kind === 'part' ? doc.types.find((t) => t.id === el.typeId) : undefined;
    if (type?.kind === 'part') bounds = [type.hintBounds.min, type.hintBounds.max];
  }
  if (!bounds) return undefined;
  const m = placementMatrix(r.placement);
  const [a, b] = bounds;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? b[0] : a[0], c & 2 ? b[1] : a[1], c & 4 ? b[2] : a[2]];
    for (let i = 0; i < 3; i++) {
      const w = m[i]! * p[0]! + m[4 + i]! * p[1]! + m[8 + i]! * p[2]! + m[12 + i]!;
      lo[i] = Math.min(lo[i]!, w);
      hi[i] = Math.max(hi[i]!, w);
    }
  }
  return [lo, hi];
}

/**
 * The elements a selection frames: each selected element, a hosted one (a door, a window, an
 * opening) by its host.
 */
export function bimViewFramed(doc: BimDocument | undefined, ids: readonly string[]): Set<string> {
  const wanted = new Set<string>();
  for (const id of ids) {
    const el = doc?.elements.find((e) => e.id === id);
    wanted.add(el && 'hostId' in el ? el.hostId : id);
  }
  return wanted;
}
/**
 * World bounds of every evaluated element and part box, for framing the camera. FU1: of the
 * elements `ids` only, when given; an opening (which has no shape of its own) stands for its host
 * wall. FU7: a door or window frames its own panel, the host only while the panel has no shape.
 */
export function bimViewBounds(
  evaluation: Extract<BimEvaluation, { status: 'ok' }> | undefined,
  doc?: BimDocument,
  ids?: readonly string[],
): [[number, number, number], [number, number, number]] | undefined {
  if (!evaluation) return undefined;
  let wanted: Set<string> | undefined;
  if (ids) {
    wanted = new Set();
    for (const id of ids) {
      const r = evaluation.elements.get(id);
      if (r && elementBounds(doc, id, r)) wanted.add(id);
      else for (const framed of bimViewFramed(doc, [id])) wanted.add(framed);
    }
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const [id, r] of evaluation.elements) {
    if (wanted && !wanted.has(id)) continue;
    const b = elementBounds(doc, id, r);
    if (!b) continue;
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i]!, b[0][i]!);
      hi[i] = Math.max(hi[i]!, b[1][i]!);
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
    case 'member':
      return el.start.height.level;
    case 'ramp':
    case 'stair':
      return el.base.level;
    case 'opening':
    case 'door':
    case 'window':
    case 'railing':
      return bimElementLevel(doc, el.hostId, seen + 1);
  }
}
