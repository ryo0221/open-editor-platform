/**
 * VS9b (docs/cad/vehicle-simulation.md, V3): a seal study run. For each seal the kernel gives the
 * analysis surfaces of its body and of its closure (no preparation: the seal sees the modelled
 * shape), the seal's line, base and closure resolve on them (F1 → analysis shape), the closure is
 * turned by the seal's hinge and the line is measured (`geometry-cfd` `measureSeal`). One level:
 * its metrics are the smallest and largest compression where the seals touch and the length that
 * leaks; its checks `mapping` and `seal`. The run is `reference` (VS-U5).
 */
import {
  CfdError,
  measureSeal,
  sealRibbon,
  turnSurface,
  type SealMeasurement,
  type TriangleSurface,
} from '@editor-platform/geometry-cfd';
import {
  buildMapping,
  mappingReady,
  simulationPreparationHash,
  studyStatus,
  type MappingRow,
  type RunCheck,
  type SimulationDocument,
  type SimulationSeal,
  type SimulationSealStudy,
} from '@editor-platform/simulation-core';
import type { CadAnalysisSurface } from '@editor-platform/cad-kernel-occt';
import type { CadDocument } from '@editor-platform/cad-core';
import type { RunEnvironment, RunFailureCode, RunLevel, RunProgress, StudyRun } from './run';

/** The kernel's chordal deflection for a seal's surfaces: under a fifth of the spacing. */
export const sealDeflectionMm = (stepMm: number) => Math.min(1, Math.max(0.05, stepMm / 5));

/** One seal's measure in a run, for the panel and the view. */
export interface SealRunResult {
  sealId: string;
  name: string;
  /** The body the line is on and the closure's. */
  body: string;
  closure: string;
  /** The free height (mm), the range and the hinge angle measured at. */
  diameterMm: number;
  compression: [number, number];
  angleDeg: number;
  measurement: SealMeasurement;
}

/** R3e-4c's fields for a seal run: every seal's measure. Display only. */
export interface SealRunFields {
  kind: 'seal';
  seals: SealRunResult[];
}

/** The seals a study measures: its `sealIds`, or every seal of the document. */
export function studySeals(doc: SimulationDocument, study: SimulationSealStudy): SimulationSeal[] {
  const all = doc.seals ?? [];
  return study.seal.sealIds.length
    ? study.seal.sealIds.map((id) => all.find((s) => s.id === id)!).filter(Boolean)
    : all;
}

const bodyOf = (doc: SimulationDocument, t: { body?: string }) => t.body ?? doc.source.bodyId;

/** The triangles of `faces` (analysis face tags) of a surface, on its points. */
function facesOf(s: CadAnalysisSurface, faces: ReadonlySet<number>): TriangleSurface {
  const out: number[] = [];
  for (let t = 0; t < s.faces.length; t++)
    if (faces.has(s.faces[t]!))
      out.push(s.triangles[3 * t]!, s.triangles[3 * t + 1]!, s.triangles[3 * t + 2]!);
  return { positions: s.points, triangles: new Uint32Array(out) };
}

/** The point chains of analysis edges `edges` (x, y, z per point). */
function chainsOf(s: CadAnalysisSurface, edges: readonly number[]): Float64Array[] {
  return edges.map((e) => {
    const from = s.edges.offsets[e]!;
    const to = s.edges.offsets[e + 1]!;
    const out = new Float64Array(3 * (to - from));
    for (let k = from; k < to; k++) {
      const n = s.edges.nodes[k]!;
      out.set(s.points.subarray(3 * n, 3 * n + 3), 3 * (k - from));
    }
    return out;
  });
}

const pct = (v: number) => `${(Math.round(v * 1000) / 10).toFixed(1)} %`;
const mm = (v: number) => `${Math.round(v * 10) / 10} mm`;

/** A seal's line in one sentence: its compression range and what leaks. */
export function sealSummary(r: SealRunResult): string {
  const m = r.measurement;
  const range = m.compression ? `${pct(m.compression[0])}–${pct(m.compression[1])}` : 'no contact';
  const leaks = m.leakLengthMm > 0 ? `, ${mm(m.leakLengthMm)} leaks` : ', no leak';
  const bends = m.bends.length
    ? `, ${m.bends.length} tight bend${m.bends.length === 1 ? '' : 's'}`
    : '';
  const breaks = m.breaks.length
    ? `, ${m.breaks.length} break${m.breaks.length === 1 ? '' : 's'}`
    : '';
  return `${r.name}: ${mm(m.lengthMm)} long, pressed ${range}${leaks}${bends}${breaks}`;
}

export async function runSealStudy(
  doc: SimulationDocument,
  cad: CadDocument,
  study: SimulationSealStudy,
  env: RunEnvironment,
  refuse: (code: RunFailureCode, detail: string, level?: number) => StudyRun,
): Promise<StudyRun> {
  const step = (s: RunProgress['step']) => env.checkpoint?.({ level: 0, levels: 1, step: s });
  if (env.remote) return refuse('host', 'a seal study is measured in the browser');
  const seals = studySeals(doc, study);
  if (!seals.length) return refuse('study-missing', `${study.id}: no seal to measure`);
  const deflectionMm = sealDeflectionMm(study.seal.stepMm);
  await step('surface');
  const surfaces = new Map<string, CadAnalysisSurface>();
  for (const seal of seals)
    for (const bodyId of [bodyOf(doc, seal.base[0]!), bodyOf(doc, seal.mating[0]!)]) {
      if (surfaces.has(bodyId)) continue;
      const r = await env.surface(cad, { bodyId, deflectionMm, clampDeflection: true });
      if (!('surface' in r)) return refuse('surface', `${bodyId}: ${r.code}`, 0);
      surfaces.set(bodyId, r.surface);
    }
  await step('mapping');
  const context = {
    versionId: doc.source.versionId,
    preparationHash: simulationPreparationHash(doc.preparation),
    kernelBuild: env.builds.kernel,
  };
  const owners = new Set(seals.map((s) => s.id));
  const mapping: MappingRow[] = [...surfaces].flatMap(([bodyId, s]) =>
    buildMapping(
      doc,
      s.bodyTopology,
      s.history,
      {
        faces: () => true,
        edges: (e) => e < s.shapeEdges && s.edges.offsets[e + 1]! > s.edges.offsets[e]!,
      },
      context,
      { bodyId },
    )
      .filter((r) => owners.has(r.owner))
      .map((r) => ({ ...r, body: bodyId })),
  );
  if (!mappingReady(mapping)) {
    const open = mapping.filter((r) => r.status !== 'resolved');
    return {
      ...refuse(
        'mapping',
        open.map((r) => `${r.body} ${r.path}: ${r.status} (${r.reason ?? r.stage})`).join('; '),
        0,
      ),
      mapping,
    };
  }
  const analysis = (sealIndex: number, side: 'line' | 'base' | 'mating') => {
    const prefix = `$.seals[${sealIndex}].${side}[`;
    return [
      ...new Set(mapping.filter((r) => r.path.startsWith(prefix)).flatMap((r) => r.analysis)),
    ];
  };
  await step('solve');
  const results: SealRunResult[] = [];
  for (const seal of seals) {
    const i = (doc.seals ?? []).indexOf(seal);
    const body = bodyOf(doc, seal.base[0]!);
    const closure = bodyOf(doc, seal.mating[0]!);
    const own = surfaces.get(body)!;
    const other = surfaces.get(closure)!;
    let mating = facesOf(other, new Set(analysis(i, 'mating')));
    const angleDeg = seal.hinge?.angleDeg ?? 0;
    if (seal.hinge && angleDeg !== 0)
      mating = turnSurface(mating, seal.hinge.origin, seal.hinge.axis, (angleDeg * Math.PI) / 180);
    try {
      results.push({
        sealId: seal.id,
        name: seal.name,
        body,
        closure,
        diameterMm: seal.section.diameterMm,
        compression: [...seal.section.compression],
        angleDeg,
        measurement: measureSeal({
          chains: chainsOf(own, analysis(i, 'line')),
          base: facesOf(own, new Set(analysis(i, 'base'))),
          mating,
          insetMm: seal.insetMm,
          section: {
            diameterMm: seal.section.diameterMm,
            compressionMin: seal.section.compression[0],
            compressionMax: seal.section.compression[1],
            minBendRadiusMm: seal.section.minBendRadiusMm,
          },
          stepMm: study.seal.stepMm,
          gapThresholdMm: study.seal.gapThresholdMm,
        }),
      });
    } catch (e) {
      if (e instanceof CfdError)
        return { ...refuse('solve', `${seal.name}: ${e.message}`, 0), mapping };
      throw e;
    }
  }
  await step('checks');
  const touched = results.flatMap((r) => r.measurement.compression ?? []);
  const points = results.reduce((n, r) => n + r.measurement.points.length, 0);
  const checks: RunCheck[] = [
    {
      name: 'mapping',
      pass: true,
      detail: `${mapping.length} targets of ${seals.length} seal${seals.length === 1 ? '' : 's'} resolved`,
    },
    {
      name: 'seal',
      pass: true,
      detail: results.map(sealSummary).join('; '),
    },
  ];
  const level: RunLevel = {
    settings: { ...doc.mesh, size: study.seal.stepMm, minSize: study.seal.stepMm, local: [] },
    nodes: points,
    elements: results.length,
    metrics: {
      'min-compression': touched.length ? Math.min(...touched) : 0,
      'max-compression': touched.length ? Math.max(...touched) : 0,
      'leak-length': results.reduce((n, r) => n + r.measurement.leakLengthMm, 0),
    },
    checks,
  };
  return {
    studyId: study.id,
    status: studyStatus({ study, checks, levels: [level.metrics] }),
    levels: [level],
    mapping,
    fields: { kind: 'seal', seals: results },
    builds: env.builds,
  };
}

/** The ribbon of every seal of a run as triangles, with per point its compression, gap and leak. */
export function sealRibbonMesh(fields: SealRunFields) {
  const nodes: number[] = [];
  const triangles: number[] = [];
  const compression: number[] = [];
  const gap: number[] = [];
  const leak: number[] = [];
  for (const r of fields.seals) {
    const ribbon = sealRibbon(r.measurement, {
      diameterMm: r.diameterMm,
      compressionMin: r.compression[0],
      compressionMax: r.compression[1],
      minBendRadiusMm: 0,
    });
    const first = nodes.length / 3;
    const n = ribbon.length;
    ribbon.forEach((p, k) => {
      const m = r.measurement.points[k]!;
      nodes.push(...p.base, ...p.top);
      for (let j = 0; j < 2; j++) {
        compression.push(100 * (m.compression ?? 0));
        gap.push(m.gapMm ?? r.diameterMm);
        leak.push(m.leak ? 1 : 0);
      }
    });
    // A closed loop: the last point joins the first (a break is its own leaking stretch).
    for (let k = 0; k < n; k++) {
      const a = first + 2 * k;
      const b = first + 2 * ((k + 1) % n);
      triangles.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  return {
    nodes: new Float64Array(nodes),
    triangles: new Uint32Array(triangles),
    compression: new Float64Array(compression),
    gap: new Float64Array(gap),
    leak: new Float64Array(leak),
  };
}
