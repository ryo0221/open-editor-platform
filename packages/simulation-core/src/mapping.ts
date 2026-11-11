import {
  resolveTopologyRef,
  type CadReferenceResolution,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { SimulationDocument, SimulationOverride, SimulationTarget } from './model';
import { simulationTargets } from './source';

/**
 * The history of one shape preparation (docs/cad/r3-analysis.md, 荷重・拘束の引き継ぎ): for each
 * face and edge of the evaluated CAD body, in its topology table's order, the analysis-shape
 * elements it became, as the kernel's `Modified` / `IsDeleted` report them. An element the
 * preparation did not touch maps to itself (one image). No entry is ever guessed by geometry.
 */
export interface PreparationHistory {
  /**
   * R3i-4: on a midsurface (`midsurface`), a side of the wall is `deleted` with the midsurface
   * `edges` it runs along, and a wall face on the far side of the midsurface is `reversed`.
   */
  faces: { deleted: boolean; images: number[]; edges?: number[]; reversed?: boolean }[];
  edges: { deleted: boolean; images: number[] }[];
  /** Counts of the analysis shape (the mesh's `shapeFaces` / `shapeEdges`). */
  analysisFaces: number;
  analysisEdges: number;
  /**
   * R3i-4: the analysis shape is the body's midsurface (a shell study). Both faces of the wall
   * become one midsurface face and a side becomes edges by design, so neither is ambiguous.
   */
  midsurface?: boolean;
}

/** What one stage made of a target. `analysis` lists analysis-shape faces or edges. */
export type MappingStatus = 'resolved' | 'ambiguous' | 'missing';
export interface MappingRow {
  /** Path of the target in the document, e.g. `$.loads[0].targets[1]`. */
  path: string;
  /** R3j-4b: the body it is on, in a run of several bodies. */
  body?: string;
  /** The load, constraint or setting that owns it: an element ID, or `preparation` / `mesh`. */
  owner: string;
  kind: 'face' | 'edge';
  status: MappingStatus;
  /**
   * Where it stopped (`cad`, `preparation`, `mesh`), or `mesh` when it resolved through. A
   * removal instruction (`preparation`) resolves at `cad` with no analysis elements.
   */
  stage: 'cad' | 'preparation' | 'mesh';
  /** The body's element in the CAD table, when F1 resolved it. */
  cad?: number;
  /** Analysis-shape elements the target applies to (resolved), or the candidates (ambiguous). */
  analysis: number[];
  /** Why it is not resolved, for the diagnostic list. */
  reason?:
    | 'cad-missing'
    | 'cad-ambiguous'
    | 'removed-by-preparation'
    /** R3i-4: an edge through the wall's thickness (between two sides) has no midsurface image. */
    | 'off-midsurface'
    | 'split-by-preparation'
    | 'merged-by-preparation'
    | 'not-meshed';
  /** True when a stored re-selection decided it. */
  overridden?: boolean;
  /** R3i-4: a face target that applies to midsurface edges (a side of the wall): `analysis` lists edges. */
  as?: 'edge';
  /** R3i-4: a face target on the far side of the midsurface (its outward normal is the opposite). */
  reversed?: boolean;
}

/** Which elements of the analysis shape the mesh has (boundary faces per tag, edge chains). */
export interface MeshPresence {
  faces: (tag: number) => boolean;
  edges: (index: number) => boolean;
}

/** The key that ties a stored re-selection to one evaluation's analysis shape. */
export interface MappingContext {
  versionId: string;
  preparationHash: string;
  kernelBuild: string;
}

/**
 * Builds the mapping table of every stored target of a document: CAD face/edge (F1) → analysis
 * shape (preparation history) → mesh. A split (one element into several) or a merge (several
 * targeted or untargeted elements into one) is ambiguous; a deleted element is missing. A stored
 * re-selection (`overrides`) decides an ambiguous preparation step only for the same version,
 * preparation and kernel build, and only among the candidates. Nearness is never used.
 */
export function buildMapping(
  doc: SimulationDocument,
  table: CadTopologyTable,
  history: PreparationHistory,
  mesh: MeshPresence,
  context: MappingContext,
  /**
   * R3j-4b: map only the targets on this body (a target naming no body is on the source body;
   * removals and mesh sizes are the source body's). Absent: every target.
   */
  options: { bodyId?: string } = {},
): MappingRow[] {
  const rows: MappingRow[] = [];
  // Analysis element → the CAD elements that became it (to find merges).
  const preimages = (kind: 'face' | 'edge') => {
    const out = new Map<number, number[]>();
    history[kind === 'face' ? 'faces' : 'edges'].forEach((h, i) => {
      if (!h.deleted) for (const a of h.images) out.set(a, [...(out.get(a) ?? []), i]);
    });
    return out;
  };
  const pre = { face: preimages('face'), edge: preimages('edge') };
  const overrideOf = (owner: string, target: SimulationTarget): SimulationOverride | undefined =>
    (doc.overrides ?? []).find(
      (o) =>
        o.owner === owner &&
        canonicalJson(o.target) === canonicalJson(target) &&
        o.versionId === context.versionId &&
        o.preparationHash === context.preparationHash &&
        o.kernelBuild === context.kernelBuild,
    );
  const onBody = (path: string, target: SimulationTarget) =>
    options.bodyId === undefined ||
    (path.startsWith('$.preparation') || path.startsWith('$.mesh')
      ? options.bodyId === doc.source.bodyId
      : (target.body ?? doc.source.bodyId) === options.bodyId);
  for (const { path, target, owner } of ownedTargets(doc)) {
    if (!onBody(path, target)) continue;
    const row: MappingRow = {
      path,
      owner,
      kind: target.kind,
      status: 'resolved',
      stage: 'cad',
      analysis: [],
    };
    const r: CadReferenceResolution = resolveTopologyRef(table, target.ref);
    if (r.status !== 'resolved') {
      rows.push({
        ...row,
        status: r.status,
        reason: r.status === 'missing' ? 'cad-missing' : 'cad-ambiguous',
        analysis: [],
      });
      continue;
    }
    row.cad = r.index;
    // A face to remove only has to exist on the CAD body: preparation deletes it by design.
    if (owner === 'preparation') {
      rows.push(row);
      continue;
    }
    row.stage = 'preparation';
    const h = (target.kind === 'face' ? history.faces : history.edges)[r.index];
    if (history.midsurface && h) {
      // A shell study: the wall's faces and edges, and its sides as edges, map as the kernel says.
      const face = target.kind === 'face' ? history.faces[r.index]! : undefined;
      const side = !!face && face.deleted && !!face.edges?.length;
      const images = [...(side ? face.edges! : h.images)].sort((a, b) => a - b);
      if (!images.length) {
        rows.push({ ...row, status: 'missing', reason: 'off-midsurface' });
        continue;
      }
      row.stage = 'mesh';
      const present = face && !side ? mesh.faces : mesh.edges;
      const extra = {
        ...(side ? { as: 'edge' as const } : {}),
        ...(face?.reversed ? { reversed: true } : {}),
      };
      rows.push(
        images.every((a) => present(a))
          ? { ...row, ...extra, analysis: images }
          : { ...row, ...extra, status: 'missing', reason: 'not-meshed', analysis: images },
      );
      continue;
    }
    if (!h || h.deleted || !h.images.length) {
      rows.push({ ...row, status: 'missing', reason: 'removed-by-preparation' });
      continue;
    }
    const merged = h.images.some((a) => (pre[target.kind].get(a)?.length ?? 0) > 1);
    let images = [...h.images].sort((a, b) => a - b);
    if (h.images.length > 1 || merged) {
      const o = overrideOf(owner, target);
      const chosen = o ? [...new Set(o.chosen)].sort((a, b) => a - b) : null;
      if (!chosen || !chosen.length || !chosen.every((a) => images.includes(a))) {
        rows.push({
          ...row,
          status: 'ambiguous',
          reason: h.images.length > 1 ? 'split-by-preparation' : 'merged-by-preparation',
          analysis: images,
        });
        continue;
      }
      images = chosen;
      row.overridden = true;
    }
    row.stage = 'mesh';
    const present = target.kind === 'face' ? mesh.faces : mesh.edges;
    if (!images.every((a) => present(a))) {
      rows.push({ ...row, status: 'missing', reason: 'not-meshed', analysis: images });
      continue;
    }
    rows.push({ ...row, analysis: images });
  }
  return rows;
}

/** True when every row resolved: only then may a solve start (段階案). */
export const mappingReady = (rows: MappingRow[]) => rows.every((r) => r.status === 'resolved');

function ownedTargets(
  doc: SimulationDocument,
): { path: string; target: SimulationTarget; owner: string }[] {
  return simulationTargets(doc).map(({ path, target }) => {
    const m = /^\$\.(loads|constraints|bonds|masses|spotWelds)\[(\d+)\]/.exec(path);
    const owner = m
      ? (m[1] === 'bonds'
          ? doc.bonds!
          : m[1] === 'masses'
            ? doc.masses!
            : m[1] === 'spotWelds'
              ? doc.spotWelds!
              : doc[m[1] as 'loads' | 'constraints'])[Number(m[2])]!.id
      : path.startsWith('$.preparation')
        ? 'preparation'
        : 'mesh';
    return { path, target, owner };
  });
}

/** One check of what a load put on the mesh against what the document asks for. */
export interface LoadApplicationCheck {
  owner: string;
  quantity: 'force' | 'area' | 'length' | 'nodes';
  expected: number;
  actual: number;
  ok: boolean;
}
/**
 * Relative tolerances of the post-application checks (design: area starts at 0.5 %). A pressure's
 * resultant is compared with the kernel's exact ∫ p n dA, so it carries the mesh's geometric error
 * and uses the area tolerance.
 */
export const loadApplicationTolerance = Object.freeze({
  force: 1e-9,
  pressure: 0.005,
  area: 0.005,
  length: 0.005,
});

/**
 * Compares, per load, the nodal force sum on the mesh with the expected resultant (a force: the
 * requested total; a pressure: p × the inward normal integrated over the analysis shape, which
 * differs from p × area on a curved face), component by component, and separately the mesh area or
 * length with the analysis shape's; and per constraint that it holds at least one node. Every
 * mismatch is reported (`load-mismatch` in the run's checks).
 */
export function checkLoadApplication(input: {
  loads: {
    owner: string;
    kind: 'force' | 'pressure';
    /** The expected resultant (N): always given, so a load with no force on the mesh fails. */
    requested: [number, number, number];
    applied: [number, number, number];
    /** The distributed load's size (N): |force| for a force, |p| × the shape's area for a pressure. */
    gross: number;
    meshMeasure: number;
    shapeMeasure: number;
    measure: 'area' | 'length';
  }[];
  constraints: { owner: string; nodes: number }[];
}): LoadApplicationCheck[] {
  const out: LoadApplicationCheck[] = [];
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
  for (const l of input.loads) {
    const tol = loadApplicationTolerance[l.kind];
    // Per component. A force is distributed exactly: each component within tol of itself (a zero
    // component within tol of the total). A pressure carries the mesh's geometric error, which
    // scales with the distributed force |p| × area, so a component may differ by tol of that;
    // a net-zero pressure (opposed faces) then passes, and a lost or reversed one does not.
    const allowed = (r: number) =>
      l.kind === 'pressure' ? tol * l.gross : tol * (r !== 0 ? Math.abs(r) : l.gross);
    out.push({
      owner: l.owner,
      quantity: 'force',
      expected: Math.hypot(...l.requested),
      actual: Math.hypot(...l.applied),
      ok: l.gross > 0 && l.requested.every((r, i) => Math.abs(l.applied[i]! - r) <= allowed(r)),
    });
    out.push({
      owner: l.owner,
      quantity: l.measure,
      expected: l.shapeMeasure,
      actual: l.meshMeasure,
      ok:
        l.shapeMeasure > 0 &&
        rel(l.meshMeasure, l.shapeMeasure) <= loadApplicationTolerance[l.measure],
    });
  }
  for (const c of input.constraints)
    out.push({ owner: c.owner, quantity: 'nodes', expected: 1, actual: c.nodes, ok: c.nodes > 0 });
  return out;
}
