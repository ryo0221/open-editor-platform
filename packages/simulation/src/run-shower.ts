/**
 * VS10b (docs/cad/vehicle-simulation.md, V3): a shower study run. The seals are measured as a
 * seal study does (`runSealStudy`), then the kernel's analysis surfaces of every analysed body
 * (each closure turned by its seal's hinge) take the water of the study's rain and nozzles
 * (`geometry-cfd` `runShower`): a closed seal's ribbon stops the film, a leaking stretch lets it in.
 * One level: the seal metrics, the volume that went in and the volume left ponding; its checks
 * `mapping`, `seal` and `shower`. The run is `reference` (VS-U5).
 */
import {
  CfdError,
  runShower,
  sealRibbon,
  turnSurface,
  type ShowerEmitter,
  type ShowerEntry,
  type ShowerFrame,
  type ShowerPond,
  type ShowerState,
  type TriangleSurface,
  type Vec3,
} from '@editor-platform/geometry-cfd';
import {
  studyStatus,
  type RunCheck,
  type SimulationDocument,
  type SimulationSealStudy,
  type SimulationShowerStudy,
} from '@editor-platform/simulation-core';
import type { CadDocument } from '@editor-platform/cad-core';
import type { RunEnvironment, RunFailureCode, RunLevel, StudyRun } from './run';
import { runSealStudy, studySeals, type SealRunFields, type SealRunResult } from './run-seal';

/** The kernel's chordal deflection for the water's surfaces (mm). */
export const showerDeflectionMm = 1;
/** Frames kept for the view and a video, at most. */
export const showerFrames = 120;

/** R3e-4c's fields for a shower run: the seals, the surfaces, the water's end and its frames. */
export interface ShowerRunFields {
  kind: 'shower';
  seals: SealRunResult[];
  /** Every analysed body's surface as the water met it (closures turned by their hinges). */
  surface: { points: Float64Array; triangles: Uint32Array };
  particles: number;
  particleVolumeMm3: number;
  counts: Record<ShowerState, number>;
  entries: ShowerEntry[];
  ponds: ShowerPond[];
  enteredBySeal: Record<string, number>;
  frames: ShowerFrame[];
}

/** The emitters of a study over surfaces in box [lo, hi]: rain over the plan, and the nozzles. */
export function showerEmitters(study: SimulationShowerStudy, lo: Vec3, hi: Vec3): ShowerEmitter[] {
  const s = study.shower;
  const out: ShowerEmitter[] = [];
  if (s.rain) {
    const a = (s.rain.angleDeg * Math.PI) / 180;
    const z = (s.rain.azimuthDeg * Math.PI) / 180;
    const direction: Vec3 = [Math.sin(a) * Math.cos(z), Math.sin(a) * Math.sin(z), -Math.cos(a)];
    const height = hi[2] + 200;
    // Upwind by the drift over the fall to the lowest point, so slanted rain covers the plan.
    const drift = (height - lo[2]) * Math.tan(a);
    const margin = 100;
    const shift: [number, number] = [-drift * Math.cos(z), -drift * Math.sin(z)];
    const span = (k: 0 | 1): [number, number] => {
      const from = lo[k] - margin + Math.min(0, shift[k]);
      const to = hi[k] + margin + Math.max(0, shift[k]);
      return [from, to];
    };
    const [x, y] = [span(0), span(1)];
    out.push({
      kind: 'rain',
      rateMmPerH: s.rain.rateMmPerH,
      direction,
      speedMmPerS: 6000,
      min: [x[0], y[0]],
      max: [x[1], y[1]],
      heightMm: height,
    });
  }
  for (const n of s.nozzles)
    out.push({
      kind: 'nozzle',
      origin: n.origin,
      direction: n.direction,
      coneDeg: n.coneDeg,
      speedMmPerS: n.speedMmPerS,
      flowLPerMin: n.flowLPerMin,
    });
  return out;
}

/** Where a hinge puts four points 1 m apart: two hinges that agree turn a closure alike. */
export function placed(h?: { origin: Vec3; axis: Vec3; angleDeg: number }): Float64Array {
  const s: TriangleSurface = {
    positions: new Float64Array([0, 0, 0, 1000, 0, 0, 0, 1000, 0, 0, 0, 1000]),
    triangles: new Uint32Array(0),
  };
  return h ? turnSurface(s, h.origin, h.axis, (h.angleDeg * Math.PI) / 180).positions : s.positions;
}

/** The same place to within a µm (Codex on #1271: the axis's length or origin along it differ). */
export const samePlace = (a: Float64Array, b: Float64Array) =>
  a.every((v, k) => Math.abs(v - b[k]!) < 1e-3);

/** Gravity on a slope: pitch lifts the +x end, roll the +y side (mm/s²). */
export function showerGravity(slopeDeg: readonly [number, number]): Vec3 {
  const [p, r] = slopeDeg.map((d) => (d * Math.PI) / 180) as [number, number];
  const g = 9810;
  return [-g * Math.sin(p), -g * Math.cos(p) * Math.sin(r), -g * Math.cos(p) * Math.cos(r)];
}

const mm3 = (v: number) => `${Math.round(v).toLocaleString('en')} mm³`;

/** The water's end in one sentence. */
export function showerSummary(f: ShowerRunFields): string {
  const c = f.counts;
  return (
    `${f.particles.toLocaleString('en')} particles: ${c.entered} went in` +
    ` (${mm3(c.entered * f.particleVolumeMm3)}), ${c.pond} ponding, ${c.drained} drained,` +
    ` ${c.film + c.drop} still moving`
  );
}

export async function runShowerStudy(
  doc: SimulationDocument,
  cad: CadDocument,
  study: SimulationShowerStudy,
  env: RunEnvironment,
  refuse: (code: RunFailureCode, detail: string, level?: number) => StudyRun,
): Promise<StudyRun> {
  if (env.remote) return refuse('host', 'a shower study runs in the browser');
  const { shower: _shower, ...rest } = study;
  const sealStudy: SimulationSealStudy = { ...rest, kind: 'seal' };
  // One position per closure: every seal on it turns it the same way, or the water would meet a
  // closure where one seal's ribbon was not measured (Codex on #1271).
  const turned = new Map<string, NonNullable<ReturnType<typeof studySeals>[number]['hinge']>>();
  const turns = new Map<string, { key: Float64Array; seal: string }>();
  for (const s of studySeals(doc, sealStudy)) {
    const body = s.mating[0]?.body ?? doc.source.bodyId;
    const h = s.hinge && s.hinge.angleDeg !== 0 ? s.hinge : undefined;
    const key = placed(h);
    const seen = turns.get(body);
    if (seen && !samePlace(seen.key, key))
      return refuse(
        'simulation-invalid',
        `seals ${seen.seal} and ${s.id} turn closure ${body} differently; the water needs one`,
      );
    turns.set(body, { key, seal: s.id });
    if (h) turned.set(body, h);
  }
  const sealed = await runSealStudy(doc, cad, sealStudy, env, refuse);
  if (sealed.failure || !sealed.fields) return { ...sealed, studyId: study.id };
  const seals = (sealed.fields as SealRunFields).seals;
  await env.checkpoint?.({ level: 0, levels: 1, step: 'surface' });
  // Every analysed body, each closure turned as its seals' hinge says.
  const bodies = [doc.source.bodyId, ...(doc.bodies ?? []).map((b) => b.bodyId)];
  const positions: number[] = [];
  const triangles: number[] = [];
  for (const bodyId of bodies) {
    const r = await env.surface(cad, {
      bodyId,
      deflectionMm: showerDeflectionMm,
      clampDeflection: true,
    });
    if (!('surface' in r)) return { ...refuse('surface', `${bodyId}: ${r.code}`, 0), mapping: [] };
    let s: TriangleSurface = { positions: r.surface.points, triangles: r.surface.triangles };
    const h = turned.get(bodyId);
    if (h) s = turnSurface(s, h.origin, h.axis, (h.angleDeg * Math.PI) / 180);
    const first = positions.length / 3;
    for (const v of s.positions) positions.push(v);
    for (const t of s.triangles) triangles.push(first + t);
  }
  const surface = { positions: new Float64Array(positions), triangles: new Uint32Array(triangles) };
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, positions[i + k]!);
      hi[k] = Math.max(hi[k]!, positions[i + k]!);
    }
  await env.checkpoint?.({ level: 0, levels: 1, step: 'solve' });
  const s = study.shower;
  const steps = Math.ceil(s.durationS / s.stepS - 1e-9);
  const frames: ShowerFrame[] = [];
  let result: ReturnType<typeof runShower>;
  try {
    result = runShower({
      surface,
      seals: seals.map((r) => ({
        id: r.sealId,
        ribbon: sealRibbon(r.measurement, {
          diameterMm: r.diameterMm,
          compressionMin: r.compression[0],
          compressionMax: r.compression[1],
          minBendRadiusMm: 0,
        }),
      })),
      emitters: showerEmitters(study, lo, hi),
      gravity: showerGravity(s.slopeDeg),
      durationS: s.durationS,
      stepS: s.stepS,
      particlesPerS: s.particlesPerS,
      emitUntilS: s.emitUntilS,
      filmSpeedMmPerS: s.filmSpeedMmPerS,
      seed: s.seed,
      frameEvery: Math.max(1, Math.ceil(steps / showerFrames)),
      onFrame: (f) => frames.push(f),
    });
  } catch (e) {
    if (e instanceof CfdError) return { ...refuse('solve', e.message, 0), mapping: sealed.mapping };
    throw e;
  }
  await env.checkpoint?.({ level: 0, levels: 1, step: 'checks' });
  const fields: ShowerRunFields = {
    kind: 'shower',
    seals,
    surface: { points: surface.positions, triangles: surface.triangles },
    particles: result.particles,
    particleVolumeMm3: result.particleVolumeMm3,
    counts: result.counts,
    entries: result.entries,
    ponds: result.ponds,
    enteredBySeal: result.enteredBySeal,
    frames,
  };
  const sealLevel = sealed.levels[0]!;
  const checks: RunCheck[] = [
    ...sealLevel.checks,
    { name: 'shower', pass: true, detail: showerSummary(fields) },
  ];
  const level: RunLevel = {
    ...sealLevel,
    nodes: result.particles,
    elements: triangles.length / 3,
    metrics: {
      ...sealLevel.metrics,
      'entered-volume': result.counts.entered * result.particleVolumeMm3,
      'pond-volume': result.ponds.reduce((n, p) => n + p.volumeMm3, 0),
    },
    checks,
  };
  return {
    studyId: study.id,
    status: studyStatus({ study, checks, levels: [level.metrics] }),
    levels: [level],
    mapping: sealed.mapping,
    fields,
    builds: env.builds,
  };
}
