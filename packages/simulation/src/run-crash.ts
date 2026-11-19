import {
  crashMeasures,
  crashModel,
  crashSetup,
  explicitDefaults,
  explicitWeldNodes,
  headImpactMeasures,
  headImpactSetup,
  ExplicitError,
  ExplicitSolver,
  kmhToMmPerS,
  nearestNode,
  type CrashMeasures,
  type CrashPart,
  type CrashWeldRow,
  type HeadImpactMeasures,
  type ExplicitEnergies,
  type ExplicitMaterial,
  type ExplicitModel,
  type ExplicitResult,
  type ExplicitSettings,
} from '@editor-platform/geometry-fem';
import type {
  RunCheck,
  SimulationCrashSettings,
  SimulationMaterial,
  SimulationMetric,
} from '@editor-platform/simulation-core';

/**
 * VS7c (docs/cad/vehicle-simulation.md, VS7): one crash run of the analysed bodies' shells. The
 * bodies become parts of one explicit model (`crashModel`), the barrier and the initial velocity
 * are set (`crashSetup`), the explicit solver runs to the end time (in chunks, so the browser's
 * Worker reports its progress; a Host gives its own `solve`), and the measures are read at the
 * accelerometer (`crashMeasures`). The checks are the solver's: energy balance, hourglass energy
 * and added mass.
 */
export interface CrashRunFields {
  kind: 'crash';
  /** Every body's midsurface in one: nodes (mm) and triangles, and each body's share. */
  nodes: Float64Array;
  triangles: Uint32Array;
  bodies: {
    bodyId: string;
    nodeOffset: number;
    nodes: number;
    shellOffset: number;
    shells: number;
  }[];
  /** Frames of the motion (displacement 3 per node, mm; plastic strain and erasure per triangle). */
  frames: ExplicitResult['frames'];
  energies: ExplicitEnergies[];
  /** A wall or pole test's measures (null for a head impact). */
  measures: CrashMeasures | null;
  /**
   * VS8b: a head impact's measures, its headform's centre node and shells (the last of
   * `triangles`), and its unit direction of travel (null for a wall or pole test).
   */
  head: {
    measures: HeadImpactMeasures;
    centre: number;
    shells: { first: number; count: number };
    direction: [number, number, number];
    /** The vehicle's held nodes. */
    held: number;
  } | null;
  /** The accelerometer's and each intrusion's nodes. */
  accelerometer: number;
  intrusions: { name: string; point: number; reference: number }[];
  /** The barrier as placed (for the view). */
  walls: NonNullable<ExplicitModel['walls']>;
  poles: NonNullable<ExplicitModel['poles']>;
  addedMassShare: number;
}

export interface CrashLevelInput {
  settings: SimulationCrashSettings;
  bodies: { bodyId: string; part: CrashPart }[];
  welds: CrashWeldRow[];
  /** Overrides of the explicit settings (tests); the end time and frames come from the study. */
  explicit?: Partial<Omit<ExplicitSettings, 'endTime' | 'frameEvery' | 'historyNodes'>>;
  /** A Host's solver; without it the run steps the solver here, reporting `progress`. */
  solve?(model: ExplicitModel, settings: ExplicitSettings): Promise<ExplicitResult>;
  progress?(time: number, endTime: number): Promise<void> | void;
}

export type CrashLevelResult =
  | {
      metrics: Partial<Record<SimulationMetric, number>>;
      checks: RunCheck[];
      fields: CrashRunFields;
    }
  | { failure: { code: 'material-missing' | 'solve'; detail: string } };

/** Frames of a crash run: enough for a smooth video, within the solver's frame limit. */
export const crashFrames = 60;

/** A material of the document as the explicit solver's (its plasticity as it is). */
export function explicitMaterial(m: SimulationMaterial): ExplicitMaterial {
  return {
    density: m.density,
    youngsModulus: m.youngsModulus,
    poissonRatio: m.poissonsRatio,
    ...(m.plasticity
      ? {
          plastic: {
            strain: [...m.plasticity.strain],
            stress: [...m.plasticity.stress],
            ...(m.plasticity.cowperSymonds
              ? { cowperSymonds: { ...m.plasticity.cowperSymonds } }
              : {}),
            ...(m.plasticity.failureStrain !== undefined
              ? { failureStrain: m.plasticity.failureStrain }
              : {}),
          },
        }
      : {}),
  };
}

export async function runCrashLevel(input: CrashLevelInput): Promise<CrashLevelResult> {
  const s = input.settings;
  if (s.barrier === 'head') return runHeadLevel(input);
  const parts = input.bodies.map((b) => b.part);
  const elastic = input.bodies.filter((b) => !b.part.material.plastic);
  if (elastic.length)
    return {
      failure: {
        code: 'material-missing',
        detail: `${elastic.map((b) => b.bodyId).join(', ')}: a crash study needs the material's plasticity`,
      },
    };
  let result: ExplicitResult;
  let setup: ReturnType<typeof crashSetup>;
  let built: ReturnType<typeof crashModel>;
  let accelerometer: number;
  let pairs: CrashRunFields['intrusions'];
  try {
    built = crashModel(parts, input.welds, s.friction);
    const x = built.model.nodes;
    accelerometer = nearestNode(x, s.accelerometer);
    pairs = s.intrusions.map((q) => ({
      name: q.name,
      point: nearestNode(x, q.point),
      reference: nearestNode(x, q.reference),
    }));
    setup = crashSetup(built.model, {
      barrier:
        s.barrier === 'wall' || !s.pole
          ? { kind: 'wall' }
          : {
              kind: 'pole',
              diameter: s.pole.diameterMm,
              angleDeg: s.pole.angleDeg,
              side: s.pole.side,
              at: [s.pole.xMm, s.pole.zMm],
            },
      speed: s.speedKmh * kmhToMmPerS,
      gravity: s.gravity,
      friction: s.friction,
    });
    result = await solveWith(input, setup.model, runSettings(input, [accelerometer]));
  } catch (e) {
    if (e instanceof ExplicitError || e instanceof RangeError)
      return {
        failure: {
          code: 'solve',
          detail: e instanceof ExplicitError ? `${e.problem}: ${e.detail}` : e.message,
        },
      };
    throw e;
  }
  let measures: CrashMeasures;
  try {
    measures = crashMeasures(result, {
      accelerometer,
      direction: setup.direction,
      barrier: setup.barrier,
      intrusions: pairs.map((q) => ({ name: q.name, p: q.point, q: q.reference })),
    });
  } catch (e) {
    if (e instanceof RangeError) return { failure: { code: 'solve', detail: e.message } };
    throw e;
  }
  if (!measures.olc)
    return {
      failure: {
        code: 'solve',
        detail: `the occupant did not move 300 mm relative to the vehicle by ${s.endTimeMs} ms (no OLC): lengthen the end time`,
      },
    };
  const quads = setup.model.shells;
  const triangles = new Uint32Array((quads.length / 4) * 3);
  for (let e = 0; e < quads.length / 4; e++)
    triangles.set([quads[4 * e]!, quads[4 * e + 1]!, quads[4 * e + 2]!], 3 * e);
  return {
    metrics: {
      'peak-deceleration': measures.peakG.cfc60,
      'occupant-load-criterion': measures.olc.olcG,
      crush: measures.crush.max,
      'max-intrusion': measures.intrusions.reduce((m, q) => Math.max(m, q.max), 0),
    },
    checks: result.checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
    fields: {
      kind: 'crash',
      nodes: setup.model.nodes,
      triangles,
      bodies: input.bodies.map((b, k) => ({
        bodyId: b.bodyId,
        nodeOffset: built.nodeOffset[k]!,
        nodes: b.part.mesh.nodes.length / 3,
        shellOffset: built.shellOffset[k]!,
        shells: b.part.mesh.triangles.length / 3,
      })),
      frames: result.frames,
      energies: result.energies,
      measures,
      head: null,
      accelerometer,
      intrusions: pairs,
      walls: setup.model.walls ?? [],
      poles: setup.model.poles ?? [],
      addedMassShare: result.addedMassShare,
    },
  };
}

/**
 * VS8c: a crash run's mass scaling: the smallest shells (slivers and bends of the CAD mesh, which
 * would otherwise set the whole run's step) get mass up to this share of the model's (the
 * `mass-scaling` check allows 5 %).
 */
export const crashMassScalingShare = 0.03;

/** The explicit settings of a run: the study's end time and frames, the history nodes. */
function runSettings(input: CrashLevelInput, historyNodes: number[], historyEvery?: number) {
  const endTime = input.settings.endTimeMs / 1000;
  const settings: ExplicitSettings = {
    ...explicitDefaults,
    thicknessPoints: 3,
    massScalingShare: crashMassScalingShare,
    ...input.explicit,
    endTime,
    frameEvery: endTime / crashFrames,
    historyNodes,
    ...(historyEvery ? { historyEvery } : {}),
  };
  return settings;
}

async function solveWith(
  input: CrashLevelInput,
  model: ExplicitModel,
  settings: ExplicitSettings,
): Promise<ExplicitResult> {
  if (input.solve) return input.solve(model, settings);
  const solver = new ExplicitSolver(model, settings);
  while (!solver.done) {
    solver.advance(2_000);
    await input.progress?.(solver.time, settings.endTime);
  }
  return solver.result();
}

/**
 * VS8b: a head impact: the bodies at rest (nodes beyond `holdBeyondMm` of the target held), the
 * headform aimed at the target, its centre's history every step (for CFC 1000), its measures.
 */
async function runHeadLevel(input: CrashLevelInput): Promise<CrashLevelResult> {
  const s = input.settings;
  const h = s.head;
  if (!h) return { failure: { code: 'solve', detail: 'a head impact needs its headform' } };
  const parts = input.bodies.map((b) => b.part);
  const elastic = input.bodies.filter((b) => !b.part.material.plastic);
  if (elastic.length)
    return {
      failure: {
        code: 'material-missing',
        detail: `${elastic.map((b) => b.bodyId).join(', ')}: a crash study needs the material's plasticity`,
      },
    };
  let built: ReturnType<typeof crashModel>;
  let setup: ReturnType<typeof headImpactSetup>;
  let result: ExplicitResult;
  let held = 0;
  try {
    built = crashModel(parts, input.welds, s.friction);
    const x = built.model.nodes;
    const n = x.length / 3;
    let fixed: Uint8Array | undefined;
    if (h.holdBeyondMm !== null) {
      fixed = new Uint8Array(n);
      const [tx, ty, tz] = h.targetMm;
      for (let i = 0; i < n; i++)
        if (Math.hypot(x[3 * i]! - tx, x[3 * i + 1]! - ty, x[3 * i + 2]! - tz) > h.holdBeyondMm) {
          fixed[i] = 63;
          held++;
        }
    }
    // Rigid bodies and the nodes each spot weld ties (the solver refuses a held one) stay free.
    if (fixed) {
      const free = (i: number) => {
        if (fixed![i]) {
          fixed![i] = 0;
          held--;
        }
      };
      // The nodes of the rigid bodies and the welds' links.
      const linked = new Set<number>();
      for (const b of built.model.rigidBodies ?? [])
        for (const i of b.nodes) {
          free(i);
          linked.add(i);
        }
      const welds = built.model.welds ?? [];
      if (welds.length && built.model.shellPart) {
        const shellsOf = new Map<number, number[]>();
        built.model.shellPart.forEach((part, e) => {
          const list = shellsOf.get(part);
          if (list) list.push(e);
          else shellsOf.set(part, [e]);
        });
        for (const w of welds)
          for (const part of w.parts)
            for (const i of explicitWeldNodes(
              built.model,
              shellsOf.get(part) ?? [],
              w.point,
              w.radius,
              w.nearestNode,
            )) {
              free(i);
              linked.add(i);
            }
      }
      // VS8c: a tie (a bond's seam) may hold both its nodes or neither: a follower held while
      // the node it follows is free (a weld's, say) is freed, again along a chain; a tie into a
      // weld's or a rigid body's nodes joins that body, so both are freed.
      const ties = built.model.ties ?? new Uint32Array();
      for (let changed = true; changed; ) {
        changed = false;
        for (let t = 0; t < ties.length; t += 2) {
          const [a, b] = [ties[t]!, ties[t + 1]!];
          if (linked.has(a) !== linked.has(b)) {
            for (const i of [a, b]) {
              free(i);
              linked.add(i);
            }
            changed = true;
          } else if (fixed[a] && !fixed[b]) {
            free(a);
            changed = true;
          }
        }
      }
    }
    setup = headImpactSetup(
      { ...built.model, ...(fixed ? { fixed } : {}) },
      {
        target: [...h.targetMm] as [number, number, number],
        headform: h.headform,
        angleDeg: h.angleDeg,
        speed: s.speedKmh * kmhToMmPerS,
        friction: s.friction,
      },
    );
    result = await solveWith(input, setup.model, runSettings(input, [setup.centre], 1));
  } catch (e) {
    if (e instanceof ExplicitError || e instanceof RangeError)
      return {
        failure: {
          code: 'solve',
          detail: e instanceof ExplicitError ? `${e.problem}: ${e.detail}` : e.message,
        },
      };
    throw e;
  }
  let measures: HeadImpactMeasures;
  try {
    measures = headImpactMeasures(result, {
      centre: setup.centre,
      direction: setup.direction,
      approach: setup.approach,
    });
  } catch (e) {
    if (e instanceof RangeError) return { failure: { code: 'solve', detail: e.message } };
    throw e;
  }
  if (!measures.hic15)
    return {
      failure: {
        code: 'solve',
        detail: `the headform did not reach the vehicle by ${s.endTimeMs} ms (no HIC15): lengthen the end time`,
      },
    };
  const quads = setup.model.shells;
  const triangles = new Uint32Array((quads.length / 4) * 6);
  // The vehicle's triangles as they came (4th node repeated); the headform's quads split in two,
  // each half with its quad's frame values.
  const shellOf: number[] = [];
  let k = 0;
  for (let e = 0; e < quads.length / 4; e++) {
    const q = [0, 1, 2, 3].map((c) => quads[4 * e + c]!);
    triangles.set([q[0]!, q[1]!, q[2]!], 3 * k++);
    shellOf.push(e);
    if (e >= setup.shells.first) {
      triangles.set([q[0]!, q[2]!, q[3]!], 3 * k++);
      shellOf.push(e);
    }
  }
  const frames = result.frames.map((f) => ({
    ...f,
    plasticStrain: Float32Array.from(shellOf, (e) => f.plasticStrain[e]!),
    erased: Uint8Array.from(shellOf, (e) => f.erased[e]!),
  }));
  return {
    metrics: {
      hic15: measures.hic15.hic,
      'head-peak-acceleration': measures.peakG,
      'head-deflection': measures.deflection,
    },
    checks: result.checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
    fields: {
      kind: 'crash',
      nodes: setup.model.nodes,
      triangles: triangles.slice(0, 3 * k),
      bodies: input.bodies.map((b, q) => ({
        bodyId: b.bodyId,
        nodeOffset: built.nodeOffset[q]!,
        nodes: b.part.mesh.nodes.length / 3,
        shellOffset: built.shellOffset[q]!,
        shells: b.part.mesh.triangles.length / 3,
      })),
      frames,
      energies: result.energies,
      measures: null,
      head: {
        measures,
        centre: setup.centre,
        shells: setup.shells,
        direction: setup.direction,
        held,
      },
      accelerometer: setup.centre,
      intrusions: [],
      walls: [],
      poles: [],
      addedMassShare: result.addedMassShare,
    },
  };
}
