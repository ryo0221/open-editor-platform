import { bimGeometry, deriveBim, type BimDocument } from '@editor-platform/bim-core';
import {
  BimIfcExportError,
  writeIfc,
  type BimIfcExport,
  type BimIfcPartMesh,
} from '@editor-platform/bim-ifc';
import {
  geometryOrder,
  type GeometryOp,
  type GeometryRequest,
} from '@editor-platform/geometry-core';
import type { BimKernel } from './evaluate';
import { partFaceBodies, type BimPartStatus } from './parts';
import { bimKernelLimits } from './port';

/**
 * A building's IFC file from the app (docs/cad/r2c-architecture.md, IFC; R2c-6). The file is
 * written from the document by `bim-ifc`; what only the kernel knows is measured here, in its
 * own job, so the file never depends on the display: the volumes of elements a roof clips, and
 * each part's export mesh at a fixed tessellation (the screen's LOD and budget never change it).
 */

/**
 * The export mesh of parts (curved faces become its polygons): never finer than 0.5 mm, and no
 * finer than 1/20,000 of the part's diagonal, so a 75 m shell is not cut into millions of
 * triangles. It follows the part type alone (its version's bounds), never the display.
 */
export const bimIfcPartMesh = Object.freeze({
  deflectionMm: 0.5,
  angularDeflectionRad: 0.1,
  diagonalFraction: 1 / 20_000,
});

/** The export mesh of a part whose shape spans `bounds`. */
export function bimIfcPartMeshFor(bounds: { min: number[]; max: number[] }) {
  const diagonal = Math.hypot(...bounds.min.map((v, i) => (bounds.max[i] ?? v) - v));
  return {
    deflectionMm: Math.max(
      bimIfcPartMesh.deflectionMm,
      Number.isFinite(diagonal) ? diagonal * bimIfcPartMesh.diagonalFraction : 0,
    ),
    angularDeflectionRad: bimIfcPartMesh.angularDeflectionRad,
  };
}

/** Requests per kernel job, as the evaluator batches solids. */
const batch = 64;

export interface BimIfcFileOptions {
  artifactId: string;
  /** The content's time (ISO 8601), the only time in the file. */
  timeStamp: string;
  fileName?: string;
  /** Normalized BRep of placed parts, by content hash. */
  assets?: Map<string, Uint8Array>;
  /** A part version's shape state: an available one gives its body kinds. */
  part?(contentHash: string): BimPartStatus | undefined;
  signal?: AbortSignal;
}

export type BimIfcFileResult =
  | { status: 'ok'; file: BimIfcExport }
  /** `ids`: the elements (or entities) the refusal names. */
  | { status: 'error'; code: string; ids: string[] };

export async function exportBimIfc(
  doc: BimDocument,
  kernel: BimKernel,
  options: BimIfcFileOptions,
): Promise<BimIfcFileResult> {
  const derived = deriveBim(doc);
  const geometry = bimGeometry(doc, derived);
  const nodes = geometry.graph.nodes;
  const assets = options.assets ?? new Map<string, Uint8Array>();
  const typeOf = new Map(doc.types.map((t) => [t.id, t]));

  // What the kernel must answer: clipped elements' volumes, and parts' meshes.
  const asks: { id: string; request: GeometryRequest; role: 'net' | 'gross' | 'part' }[] = [];
  const kinds = new Map<string, BimIfcPartMesh['kind']>();
  const looks = new Map<string, Extract<BimPartStatus, { status: 'available' }>>();
  const failed: { id: string; code: string }[] = [];
  for (const e of doc.elements) {
    const g = geometry.elements.get(e.id);
    if (e.kind === 'part') {
      const t = typeOf.get(e.typeId);
      const status = t?.kind === 'part' ? options.part?.(t.source.contentHash) : undefined;
      if (!g || status?.status !== 'available') {
        // The reason the Host gave (a build mismatch, a missing version), else not read yet.
        const code = status?.status === 'unavailable' ? status.code : 'part-unavailable';
        failed.push({ id: e.id, code });
        continue;
      }
      looks.set(e.id, status);
      const read = status.kinds;
      kinds.set(
        e.id,
        read.every((k) => k === 'solid')
          ? 'solid'
          : read.every((k) => k === 'sheet')
            ? 'sheet'
            : 'mixed',
      );
      const mesh = bimIfcPartMeshFor((t as Extract<typeof t, { kind: 'part' }>).hintBounds);
      asks.push({ id: e.id, request: { node: g.node, mesh }, role: 'part' });
      continue;
    }
    if (derived.quantities.get(e.id)?.source !== 'kernel') continue;
    if (!g) {
      failed.push({ id: e.id, code: 'not-derived' });
      continue;
    }
    asks.push({ id: e.id, request: { node: g.node, measure: true }, role: 'net' });
    if (g.gross) asks.push({ id: e.id, request: { node: g.gross, measure: true }, role: 'gross' });
  }

  const kernelQuantities = new Map<string, Record<string, number>>();
  const parts = new Map<string, BimIfcPartMesh>();
  for (let i = 0; i < asks.length; i += batch) {
    const part = asks.slice(i, i + batch);
    const sub: Record<string, GeometryOp> = {};
    for (const a of part)
      for (const n of geometryOrder({ nodes }, a.request.node)) sub[n] = nodes[n]!;
    // A part's mesh is one request that cannot be split: its job has the export's limit.
    const out = await kernel.run(
      { nodes: sub },
      part.map((a) => a.request),
      assets,
      options.signal,
      part.some((a) => a.role === 'part')
        ? { timeoutMs: bimKernelLimits.exportTimeoutMs }
        : undefined,
    );
    if (out.status !== 'ok')
      return {
        status: 'error',
        code:
          out.status === 'error'
            ? out.code
            : out.status === 'timeout'
              ? 'element-timeout'
              : out.status === 'cancelled'
                ? 'cancelled'
                : 'graph-invalid',
        ids: [],
      };
    out.results.forEach((r, j) => {
      const a = part[j]!;
      if (r.status !== 'ok') return failed.push({ id: a.id, code: r.code });
      if (a.role === 'part') {
        const mesh = r.mesh!;
        parts.set(a.id, {
          kind: kinds.get(a.id)!,
          closed: meshClosed(mesh.positions, mesh.indices),
          positions: [...mesh.positions],
          triangles: [...mesh.indices],
          deflectionMm: a.request.mesh!.deflectionMm,
          ...partStyles(mesh.faceIndices, looks.get(a.id)!),
        });
      } else {
        const q = kernelQuantities.get(a.id) ?? {};
        q[a.role === 'net' ? 'netVolume' : 'grossVolume'] = r.measure!.volumeMm3;
        kernelQuantities.set(a.id, q);
      }
    });
  }
  // An element the kernel could not build is named, with the first reason.
  if (failed.length) {
    const ids = [...new Set(failed.map((f) => f.id))].sort();
    return { status: 'error', code: failed[0]!.code, ids };
  }
  try {
    return {
      status: 'ok',
      file: writeIfc(doc, {
        artifactId: options.artifactId,
        timeStamp: options.timeStamp,
        ...(options.fileName ? { fileName: options.fileName } : {}),
        kernelQuantities,
        parts,
      }),
    };
  } catch (error) {
    if (error instanceof BimIfcExportError)
      return { status: 'error', code: error.code, ids: error.ids };
    throw error;
  }
}

/**
 * OH-U1: each triangle's look, from its face's body (a face index counts the BRep's faces in
 * body order). Nothing when the version has no looks or the faces do not add up.
 */
export function partStyles(
  faceIndices: ArrayLike<number>,
  status: Extract<BimPartStatus, { status: 'available' }>,
): Pick<BimIfcPartMesh, 'styles' | 'triangleStyles'> {
  const bodyOf = partFaceBodies(status);
  if (!bodyOf) return {};
  const triangleStyles: number[] = [];
  for (let t = 0; t < faceIndices.length; t++) {
    const body = bodyOf[faceIndices[t]!];
    if (body === undefined) return {};
    triangleStyles.push(body);
  }
  return { styles: status.looks!.map((l) => ({ ...l })), triangleStyles };
}

/**
 * Whether a mesh bounds a volume: every edge, with vertices joined by position (faces are
 * meshed apart), is shared by exactly two triangles. A sheet that does is an `IfcClosedShell`.
 */
export function meshClosed(positions: ArrayLike<number>, indices: ArrayLike<number>): boolean {
  if (!indices.length) return false;
  const key = (v: number) => `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = key(indices[t + k]!);
      const b = key(indices[t + ((k + 1) % 3)]!);
      if (a === b) continue;
      const e = a < b ? `${a};${b}` : `${b};${a}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  return [...edges.values()].every((n) => n === 2);
}
