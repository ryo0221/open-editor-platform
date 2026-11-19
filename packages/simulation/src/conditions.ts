/**
 * R3e-4b: loads and constraints on picked faces (docs/cad/r3-analysis.md, 代表操作1). The edits
 * the Surface makes for one user action, as operations applied in order as one Undo step (one
 * `simulationEditorCommand`): a refused one refuses them all.
 */
import {
  resolveTopologyRef,
  topologyRefOf,
  type CadTopologyRef,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import {
  aeroStudy,
  crashStudy,
  headImpactStudy,
  sealStudy,
  showerStudy,
  freshSimulationId,
  simulationLimits,
  sameSimulationTarget,
  thermalConstraintKinds,
  thermalLoadKinds,
  thermalStressConstraintKinds,
  transientLoadKinds,
  transientStudy,
  type SimulationAmplitude,
  type SimulationConstraint,
  type SimulationDocument,
  type SimulationFatigue,
  type SimulationLoad,
  type SimulationOperation,
  type SimulationSpotWeld,
  type SimulationStudy,
  type SimulationTarget,
  type SimulationTransientStudy,
} from '@editor-platform/simulation-core';
import { crashStudyPoints } from './crash-view';

/** What the Surface adds on the selected faces (R3h: and the thermal conditions). */
export type SimulationConditionKind =
  | 'force'
  | 'pressure'
  | 'fixed'
  | 'pinned'
  | 'temperature'
  | 'heat-flux'
  | 'convection'
  | 'radiation'
  | 'enclosure';
export const simulationConditionLabels: Record<SimulationConditionKind, string> = {
  force: 'Force',
  pressure: 'Pressure',
  fixed: 'Fixed support',
  // R3i-5: a shell's translations held, its rotations free (a solid treats it as fixed).
  pinned: 'Pinned support',
  temperature: 'Temperature',
  'heat-flux': 'Heat flux',
  convection: 'Convection',
  // VS11d-2: transient studies only.
  radiation: 'Radiation to the surroundings',
  enclosure: 'Radiation between faces',
};
const constraintKinds: readonly SimulationConditionKind[] = ['fixed', 'pinned', 'temperature'];
/** R3h: whether a load or constraint kind belongs to thermal studies. */
export const isThermalKind = (kind: string) =>
  transientLoadKinds.includes(kind as never) || thermalConstraintKinds.includes(kind as never);
/** VS11d: what a steady thermal study takes: no radiation, no enclosure, no amplitude. */
const steadyHeat = (x: { kind: string; amplitude?: unknown }) =>
  (thermalLoadKinds.includes(x.kind as never) ||
    thermalConstraintKinds.includes(x.kind as never)) &&
  x.amplitude === undefined;
const structural = <T extends { kind: string }>(items: readonly T[]) =>
  items.filter((x) => !isThermalKind(x.kind));
const thermal = <T extends { kind: string }>(items: readonly T[]) =>
  items.filter((x) => isThermalKind(x.kind));
/** Whether a study of this kind takes an item of this kind. */
const takes = (study: SimulationStudy, kind: string, isConstraint: boolean) =>
  // CR5c: a stiffness test keeps its own supports and loads only.
  // VS4a, VS7b: a wind tunnel and a crash test take no loads or constraints.
  (study.kind === 'linear-static' && study.test) || study.kind === 'aero' || study.kind === 'crash'
    ? false
    : study.kind === 'thermal'
      ? thermalLoadKinds.includes(kind as never) || thermalConstraintKinds.includes(kind as never)
      : study.kind === 'transient-thermal'
        ? // Codex on #1268: with thermal stress, a new support holds the body too.
          isThermalKind(kind) ||
          (isConstraint &&
            !!study.transient.stress &&
            thermalStressConstraintKinds.includes(kind as never))
        : !isThermalKind(kind) && (isConstraint || study.kind === 'linear-static');

/** Face targets for face indices of the body's topology table, on its result feature. */
export const faceTargets = (
  table: CadTopologyTable,
  featureId: string,
  faces: readonly number[],
): SimulationTarget[] =>
  faces.map((i) => ({ kind: 'face', ref: topologyRefOf(table, 'face', i, featureId) }));

/** R3j-6a: a picked face, by its index on the topology table of one analysed body. */
export interface SimulationBodyFace {
  bodyId: string;
  face: number;
}
/** R3j-6a: an analysed body as faces are picked on it: its display table and result feature. */
export interface SimulationPickBody {
  table: CadTopologyTable;
  featureId: string;
}

/**
 * R3j-6a: targets for faces picked on any of the analysed bodies, in pick order. A face of a body
 * other than the source names that body (the source body's are named by leaving `body` out).
 * Throws for a body not in `bodies`, or a face its table cannot reference.
 */
export function bodyFaceTargets(
  sourceBodyId: string,
  bodies: ReadonlyMap<string, SimulationPickBody>,
  picked: readonly SimulationBodyFace[],
): SimulationTarget[] {
  return picked.map(({ bodyId, face }) => {
    const b = bodies.get(bodyId);
    if (!b) throw new Error(`body ${bodyId} is not analysed`);
    const [t] = faceTargets(b.table, b.featureId, [face]);
    return bodyId === sourceBodyId ? t! : { ...t!, body: bodyId };
  });
}

/**
 * R3j-6a: the faces targets resolve to on each analysed body, and how many resolve on none (a
 * target on a body not given, or a name its table does not find).
 */
export function targetFacesByBody(
  sourceBodyId: string,
  bodies: ReadonlyMap<string, SimulationPickBody>,
  targets: readonly SimulationTarget[],
): { faces: SimulationBodyFace[]; unresolved: number } {
  const faces: SimulationBodyFace[] = [];
  let unresolved = 0;
  for (const t of targets) {
    if (t.kind !== 'face') continue;
    const bodyId = t.body ?? sourceBodyId;
    const b = bodies.get(bodyId);
    const r = b ? targetFaces(b.table, [t]) : undefined;
    if (r?.faces.length) faces.push({ bodyId, face: r.faces[0]! });
    else unresolved++;
  }
  return { faces, unresolved };
}

/** R3j-1: a rim face next to the selection, with its size on the shape (mm). */
export interface SimulationRimFace {
  face: number;
  /** Its longest edge, and its area over that length (the wall's thickness for a plate's rim). */
  length: number;
  width: number;
}
/** A face is a rim when its width is at most this share of its longest edge. */
export const rimWidthShare = 0.1;
/**
 * R3j-1 (docs/cad/r3-analysis.md, A4): the narrow faces sharing an edge with a selected face, as a
 * plate's rims are, which a click in the view cannot hit (a 1 mm rim is under a pixel). A face is
 * narrow when its area over its longest edge is at most `rimWidthShare` of that edge. Selected
 * faces are left out; the list is in face order.
 */
export function rimFaces(
  table: CadTopologyTable,
  selected: readonly number[],
): SimulationRimFace[] {
  if (!selected.length) return [];
  const chosen = new Set(selected);
  const next = new Set<number>();
  for (const e of table.edges)
    if (e.faces.some((f) => chosen.has(f)))
      for (const f of e.faces) if (!chosen.has(f)) next.add(f);
  const narrow = narrowFaces(table);
  return [...next]
    .sort((a, b) => a - b)
    .flatMap((face) => {
      const rim = narrow.get(face);
      return rim ? [rim] : [];
    });
}
/** R3j-1: every narrow face of the shape (see `rimFaces`), by face index. */
export function narrowFaces(table: CadTopologyTable): Map<number, SimulationRimFace> {
  const longest = new Float64Array(table.faces.length);
  for (const e of table.edges)
    for (const f of e.faces)
      if (f >= 0 && f < longest.length && e.length > longest[f]!) longest[f] = e.length;
  const out = new Map<number, SimulationRimFace>();
  table.faces.forEach((f, face) => {
    const length = longest[face]!;
    if (!(length > 0) || !(f.area > 0)) return;
    const width = f.area / length;
    if (width <= rimWidthShare * length) out.set(face, { face, length, width });
  });
  return out;
}

/**
 * The faces the targets resolve to on the shown shape. A target that is ambiguous or missing there
 * is counted, not drawn (re-selecting it is R3c's flow, shown when the study runs).
 */
export function targetFaces(table: CadTopologyTable, targets: readonly SimulationTarget[]) {
  const faces: number[] = [];
  let unresolved = 0;
  for (const t of targets) {
    if (t.kind !== 'face') continue;
    const r = resolveTopologyRef(table, t.ref);
    if (r.status === 'resolved') faces.push(r.index);
    else unresolved++;
  }
  return { faces, unresolved };
}

/** CR5c: the loads and constraints a stiffness test holds, which no other study takes. */
const testItems = (doc: SimulationDocument) =>
  new Set(
    doc.studies.flatMap((s) =>
      s.kind === 'linear-static' && s.test ? [...s.loadIds, ...s.constraintIds] : [],
    ),
  );

/**
 * A new study of every load and constraint (but a stiffness test's): linear static, three mesh
 * levels.
 */
export function defaultStudy(doc: SimulationDocument): SimulationStudy {
  const held = testItems(doc);
  return {
    id: freshSimulationId(doc, 'static'),
    name: 'Static',
    kind: 'linear-static',
    loadIds: structural(doc.loads)
      .filter((l) => !held.has(l.id))
      .map((l) => l.id),
    constraintIds: structural(doc.constraints)
      .filter((c) => !held.has(c.id))
      .map((c) => c.id),
    solver: { tolerance: 1e-8, maxIterations: 10_000 },
    convergence: { levels: 3, metrics: ['max-displacement', 'max-von-mises'], tolerance: 0.02 },
  };
}

/**
 * R3h-2: a thermal study of every temperature, heat flux and convection: two mesh levels comparing
 * the highest temperature and the largest flux. It needs a held temperature or a convection.
 */
export function defaultThermalStudy(doc: SimulationDocument): SimulationStudy {
  return {
    id: freshSimulationId(doc, 'thermal'),
    name: numbered(
      doc.studies.map((s) => s.name),
      'Thermal',
    ),
    kind: 'thermal',
    loadIds: doc.loads.filter(steadyHeat).map((l) => l.id),
    constraintIds: doc.constraints.filter(steadyHeat).map((c) => c.id),
    solver: { tolerance: 1e-10, maxIterations: 100_000 },
    convergence: { levels: 2, metrics: ['max-temperature', 'max-heat-flux'], tolerance: 0.02 },
  };
}
/**
 * VS11d: a transient thermal study of every heat item: 10 min in 10 s steps from 293.15 K, one
 * mesh level; with enclosure loads, 293.15 K surroundings and 64 rays per patch.
 */
export function defaultTransientStudy(doc: SimulationDocument): SimulationStudy {
  const study = transientStudy(
    freshSimulationId(doc, 'transient'),
    numbered(
      doc.studies.map((s) => s.name),
      'Transient heat',
    ),
  );
  study.loadIds = thermal(doc.loads).map((l) => l.id);
  study.constraintIds = thermal(doc.constraints).map((c) => c.id);
  if (doc.loads.some((l) => l.kind === 'enclosure'))
    study.transient.enclosure = { ...defaultEnclosure };
  return study;
}
/** VS11d-2: a new enclosure's surroundings (K) and rays from each patch. */
export const defaultEnclosure = { ambient: 293.15, raysPerPatch: 64 } as const;
/** VS11d-2: whether a transient study can be made: any thermal load or constraint. */
export const transientStudyReady = (doc: SimulationDocument) =>
  doc.loads.some((l) => isThermalKind(l.kind)) ||
  doc.constraints.some((c) => c.kind === 'temperature');

/**
 * Codex on #1268: a transient study with new settings; turning thermal stress on takes the
 * document's supports (fixed, roller, displacement) into the study, turning it off takes them out.
 */
export function transientSettingsStudy(
  doc: SimulationDocument,
  study: SimulationTransientStudy,
  transient: SimulationTransientStudy['transient'],
): SimulationTransientStudy {
  const supports = new Set(stressSupports(doc).map((c) => c.id));
  const was = !!study.transient.stress;
  const is = !!transient.stress;
  const constraintIds =
    was === is
      ? study.constraintIds
      : is
        ? [
            ...study.constraintIds,
            ...[...supports].filter((id) => !study.constraintIds.includes(id)),
          ]
        : study.constraintIds.filter((id) => !supports.has(id));
  if (!was || is) return { ...study, constraintIds, transient };
  // Off: the stress's metric goes too (Codex on #1268), leaving the temperature if nothing is left.
  const kept = study.convergence.metrics.filter((m) => m !== 'max-von-mises');
  const metrics = kept.length ? kept : (['max-temperature'] as typeof kept);
  return { ...study, constraintIds, transient, convergence: { ...study.convergence, metrics } };
}
/**
 * Codex on #1268: the supports thermal stress holds the body by: fixed, roller, displacement, but
 * not a stiffness test's (its imposed twist or bend would load the body).
 */
const stressSupports = (doc: SimulationDocument) => {
  const held = testItems(doc);
  return doc.constraints.filter(
    (c) => thermalStressConstraintKinds.includes(c.kind) && !held.has(c.id),
  );
};
/** Codex on #1268: whether the document has a support thermal stress can hold the body by. */
export const hasStressSupport = (doc: SimulationDocument) => stressSupports(doc).length > 0;
/** VS11d-2: an amplitude as the panel writes it: `time:factor` pairs, e.g. `0:0.5, 60:1`. */
export const formatAmplitude = (a: SimulationAmplitude | undefined) =>
  a ? a.times.map((t, i) => `${t}:${a.factors[i]}`).join(', ') : '';
/**
 * VS11d-2: an amplitude from the panel's text; empty is none (the value at every time), and text
 * that is not `time:factor` pairs with increasing times and factors ≥ 0 is refused (undefined).
 */
export function parseAmplitude(
  text: string,
  /** Codex on #1268: a heat flux may turn to cooling (negative factors); the others may not. */
  signed = false,
): SimulationAmplitude | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const times: number[] = [];
  const factors: number[] = [];
  for (const pair of trimmed.split(/[,;]/)) {
    const m = /^\s*([^:\s]+)\s*:\s*([^:\s]+)\s*$/.exec(pair);
    if (!m) return undefined;
    const t = Number(m[1]),
      f = Number(m[2]);
    if (!Number.isFinite(t) || !Number.isFinite(f) || t < 0 || (!signed && f < 0)) return undefined;
    if (times.length && t <= times.at(-1)!) return undefined;
    times.push(t);
    factors.push(f);
  }
  return { times, factors };
}
/**
 * VS11d-2: setting (or clearing, `null`) an item's amplitude. An item with one leaves the steady
 * thermal studies, which take none.
 */
export function amplitudeOps(
  doc: SimulationDocument,
  item: SimulationLoad | SimulationConstraint,
  amplitude: SimulationAmplitude | null,
): SimulationOperation[] {
  if (item.kind !== 'temperature' && item.kind !== 'heat-flux' && item.kind !== 'convection')
    return [];
  const { amplitude: _old, ...rest } = item;
  const next = amplitude ? { ...rest, amplitude } : rest;
  const isConstraint = item.kind === 'temperature';
  // The studies first: each operation is checked on its own, and a steady study may not hold an
  // item with an amplitude. One left unheld (no temperature, no convection) is removed.
  const ops: SimulationOperation[] = [];
  if (amplitude)
    for (const study of doc.studies)
      if (study.kind === 'thermal') {
        const ids = isConstraint ? study.constraintIds : study.loadIds;
        if (!ids.includes(item.id)) continue;
        const kept = ids.filter((x) => x !== item.id);
        const left = isConstraint ? { ...study, constraintIds: kept } : { ...study, loadIds: kept };
        const held =
          left.constraintIds.length > 0 ||
          left.loadIds.some((l) => doc.loads.find((x) => x.id === l)?.kind === 'convection');
        ops.push(
          held ? { type: 'updateStudy', study: left } : { type: 'removeStudy', id: study.id },
        );
      }
  ops.push(
    isConstraint
      ? { type: 'updateConstraint', constraint: next as SimulationConstraint }
      : { type: 'updateLoad', load: next as SimulationLoad },
  );
  return ops;
}
/** Whether a thermal study can be made: a held temperature or a convection. */
export const thermalStudyReady = (doc: SimulationDocument) =>
  doc.constraints.some((c) => c.kind === 'temperature') ||
  doc.loads.some((l) => l.kind === 'convection');

/**
 * R3g-2: a modal study of every constraint (loads do not enter a modal study): the six lowest
 * modes, two mesh levels comparing the first frequency.
 */
export function defaultModalStudy(doc: SimulationDocument): SimulationStudy {
  return {
    id: freshSimulationId(doc, 'modal'),
    name: numbered(
      doc.studies.map((s) => s.name),
      'Modal',
    ),
    kind: 'modal',
    modes: 6,
    loadIds: [],
    constraintIds: structural(doc.constraints)
      .filter((c) => !testItems(doc).has(c.id))
      .map((c) => c.id),
    solver: { tolerance: 1e-4, maxIterations: 2000 },
    convergence: { levels: 2, metrics: ['first-frequency'], tolerance: 0.02 },
  };
}

/**
 * VS4b: a wind tunnel past the analysed bodies, with `aeroStudy`'s settings (no condition); the
 * Host mesh scaled to the bodies' largest side `lengthMm` when the shapes are shown.
 */
export function defaultAeroStudy(doc: SimulationDocument, lengthMm?: number): SimulationStudy {
  return aeroStudy(
    freshSimulationId(doc, 'aero'),
    numbered(
      doc.studies.map((s) => s.name),
      'Wind tunnel',
    ),
    lengthMm,
  );
}

/**
 * VS7c-2: a new crash study: a frontal wall at 56 km/h, or a 254 mm pole at 32 km/h and 75°,
 * with its accelerometer (and the pole's line) placed from the analysed bodies' bounds (mm,
 * vehicle frame) by `crashStudyPoints`; the origin when they are not known yet. VS8b: or a head
 * impact (`head`), the adult headform at 40 km/h on the top of the bodies.
 */
export function defaultCrashStudy(
  doc: SimulationDocument,
  barrier: 'wall' | 'pole' | 'head',
  bounds?: { lo: readonly number[]; hi: readonly number[] },
): SimulationStudy {
  const points = crashStudyPoints(bounds?.lo ?? [0, 0, 0], bounds?.hi ?? [0, 0, 0]);
  // VS8b: a head impact on the top of the bodies.
  if (barrier === 'head')
    return headImpactStudy(
      freshSimulationId(doc, 'crash'),
      points.head.targetMm,
      points.head.holdBeyondMm,
      numbered(
        doc.studies.map((s) => s.name),
        'Head impact',
      ),
    );
  return crashStudy(
    freshSimulationId(doc, 'crash'),
    points.accelerometer,
    barrier === 'pole' ? points.pole : undefined,
    numbered(
      doc.studies.map((s) => s.name),
      barrier === 'pole' ? 'Pole crash' : 'Frontal crash',
    ),
  );
}

/** VS9b: a seal study over every seal of the document, with `sealStudy`'s settings. */
export function defaultSealStudy(doc: SimulationDocument): SimulationStudy {
  return sealStudy(
    freshSimulationId(doc, 'seals'),
    numbered(
      doc.studies.map((s) => s.name),
      'Seals',
    ),
  );
}

/** VS10b: a shower over every seal of the document, with `showerStudy`'s settings. */
export function defaultShowerStudy(doc: SimulationDocument): SimulationStudy {
  return showerStudy(
    freshSimulationId(doc, 'shower'),
    numbered(
      doc.studies.map((s) => s.name),
      'Shower',
    ),
  );
}

const numbered = (names: readonly string[], base: string) => {
  for (let n = 1; ; n++) if (!names.includes(`${base} ${n}`)) return `${base} ${n}`;
};

/**
 * Adding a load or constraint on the targets: the item, then the study. The first study is made
 * once there is a load and a constraint; the existing studies take the new item in.
 */
export function addConditionOps(
  doc: SimulationDocument,
  kind: SimulationConditionKind,
  targets: SimulationTarget[],
): SimulationOperation[] {
  const ops: SimulationOperation[] = [];
  const next = structuredClone(doc);
  const isConstraint = constraintKinds.includes(kind);
  const label = simulationConditionLabels[kind];
  if (isConstraint) {
    const common = {
      id: freshSimulationId(doc, kind),
      name: numbered(
        doc.constraints.map((c) => c.name),
        kind === 'fixed' ? 'Fixed' : kind === 'pinned' ? 'Pinned' : label,
      ),
      targets,
    };
    const constraint: SimulationConstraint =
      kind === 'temperature'
        ? { ...common, kind: 'temperature', temperature: 293.15 }
        : { ...common, kind: kind === 'pinned' ? 'pinned' : 'fixed' };
    next.constraints.push(constraint);
    ops.push({ type: 'addConstraint', constraint });
  } else {
    const common = {
      id: freshSimulationId(doc, kind),
      name: numbered(
        doc.loads.map((l) => l.name),
        label,
      ),
      targets,
    };
    const load: SimulationLoad =
      kind === 'force'
        ? { ...common, kind, force: [0, 0, -100] }
        : kind === 'heat-flux'
          ? { ...common, kind, flux: 1 }
          : kind === 'convection'
            ? { ...common, kind, coefficient: 0.01, ambient: 293.15 }
            : kind === 'radiation'
              ? { ...common, kind, emissivity: 0.8, ambient: 293.15 }
              : kind === 'enclosure'
                ? { ...common, kind, emissivity: 0.8 }
                : { ...common, kind: 'pressure', pressure: 1 };
    next.loads.push(load);
    ops.push({ type: 'addLoad', load });
  }
  const added = isConstraint ? next.constraints.at(-1)! : next.loads.at(-1)!;
  return [...ops, ...joinStudies(doc, next, kind, isConstraint, added.id)];
}

/**
 * The study edits for an item just added (`added`, in `next`): a structural constraint enters
 * every structural study, a structural load every static study, a thermal item every thermal
 * study; the static study is made when there is none yet and there is a load and a constraint.
 */
function joinStudies(
  doc: SimulationDocument,
  next: SimulationDocument,
  kind: string,
  isConstraint: boolean,
  added: string,
): SimulationOperation[] {
  const ops: SimulationOperation[] = [];
  for (const study of doc.studies)
    if (takes(study, kind, isConstraint)) {
      const joined = isConstraint
        ? { ...study, constraintIds: [...study.constraintIds, added] }
        : { ...study, loadIds: [...study.loadIds, added] };
      // VS11d-2: an enclosure needs the study's surroundings and rays.
      if (
        joined.kind === 'transient-thermal' &&
        kind === 'enclosure' &&
        !joined.transient.enclosure
      )
        joined.transient = { ...joined.transient, enclosure: { ...defaultEnclosure } };
      ops.push({ type: 'updateStudy', study: joined });
    }
  // The static study is made when there is none yet (also beside a modal or thermal one, or
  // after it was removed): a new structural load would otherwise belong to no study.
  // CR5c (Codex on #982): a stiffness test is no study for the other conditions.
  if (isThermalKind(kind) || doc.studies.some((s) => s.kind === 'linear-static' && !s.test))
    return ops;
  const made = defaultStudy(next);
  if (made.loadIds.length && made.constraintIds.length) ops.push({ type: 'addStudy', study: made });
  return ops;
}

/** CR0b: standard gravity in the documents' units (mm/s², mm–N–MPa–t–s). */
export const standardGravityMmS2 = 9806.65;

/**
 * CR0b (docs/cad/car-design.md, S2a): the body's own weight, a `gravity` load of standard gravity
 * downwards (−z) on every body of the study. It enters the static studies only (a modal study has
 * no loads); the static study is made once there is a constraint.
 */
export function addGravityOps(doc: SimulationDocument): SimulationOperation[] {
  const load: SimulationLoad = {
    id: freshSimulationId(doc, 'gravity'),
    name: numbered(
      doc.loads.map((l) => l.name),
      'Gravity',
    ),
    kind: 'gravity',
    acceleration: [0, 0, -standardGravityMmS2],
  };
  const next = structuredClone(doc);
  next.loads.push(load);
  return [{ type: 'addLoad', load }, ...joinStudies(doc, next, 'gravity', false, load.id)];
}

/**
 * CR5a (S2b): a part's mass carried by the selected faces (an engine, a passenger), as an added
 * mass: it falls with gravity in static studies and moves with the faces in modal ones, so it
 * counts in the natural frequencies and the `mass` check. It adds no stiffness. `massKg` is in
 * kilograms; the document keeps tonnes.
 */
export function addMassOps(
  doc: SimulationDocument,
  targets: SimulationTarget[],
  massKg: number,
): SimulationOperation[] {
  if (!Number.isFinite(massKg) || massKg <= 0) throw new RangeError('the mass must be above 0 kg');
  const names = (doc.masses ?? []).map((m) => m.name);
  const base = `Mass ${+massKg.toPrecision(6)} kg`;
  return [
    {
      type: 'addMass',
      mass: {
        id: freshSimulationId(doc, 'mass'),
        name: names.includes(base) ? numbered(names, base) : base,
        targets,
        mass: massKg / 1000,
      },
    },
  ];
}

/**
 * CR0b (S2a): the weight of a part carried by the selected faces (an engine, a passenger), as
 * an equivalent static load: a `force` of m g along the document's gravity (−z when it has
 * none). It is a force like any other: it acts in static studies only and adds nothing to the
 * natural frequencies, the modal `mass` check or any mass total. `massKg` is in kilograms.
 */
export function addWeightOps(
  doc: SimulationDocument,
  targets: SimulationTarget[],
  massKg: number,
): SimulationOperation[] {
  if (!Number.isFinite(massKg) || massKg <= 0) throw new RangeError('the mass must be above 0 kg');
  const g = doc.loads.find((l) => l.kind === 'gravity')?.acceleration;
  const length = g ? Math.hypot(...g) : 0;
  const down: [number, number, number] =
    g && length > 0 ? [g[0] / length, g[1] / length, g[2] / length] : [0, 0, -1];
  // kg × m/s² = N; the gravity's length in mm/s² gives its m/s².
  const weight = massKg * (length > 0 ? length / 1000 : standardGravityMmS2 / 1000);
  const ops = addConditionOps(doc, 'force', targets);
  const names = doc.loads.map((l) => l.name);
  const base = `Weight ${+massKg.toPrecision(6)} kg`;
  const name = names.includes(base) ? numbered(names, base) : base;
  return ops.map((op) =>
    op.type === 'addLoad' && op.load.kind === 'force'
      ? {
          ...op,
          load: {
            ...op.load,
            name,
            force: down.map((d) => (d === 0 ? 0 : d * weight)) as [number, number, number],
          },
        }
      : op,
  );
}

/**
 * Removing a load or constraint (the core drops it from every study). A study that would be left
 * without a constraint (a thermal one: without a temperature or a convection) cannot be solved
 * and is removed first.
 */
export function removeConditionOps(
  doc: SimulationDocument,
  collection: 'loads' | 'constraints',
  id: string,
): SimulationOperation[] {
  const held = (s: SimulationStudy) => {
    // VS4a, VS7b: a wind tunnel and a crash test take no conditions; removing one leaves them.
    if (s.kind === 'aero' || s.kind === 'crash') return true;
    // A transient study's heat capacity solves it with nothing held; with thermal stress it keeps
    // the rule of the rest (Codex on #1264).
    if (s.kind === 'transient-thermal' && !s.transient.stress) return true;
    const constraints = s.constraintIds.filter((c) => collection === 'loads' || c !== id);
    // With thermal stress it also needs a structural support left (Codex on #1264).
    if (s.kind === 'transient-thermal')
      return constraints.some((c) =>
        thermalStressConstraintKinds.includes(
          doc.constraints.find((x) => x.id === c)?.kind as never,
        ),
      );
    const convection = s.loadIds.some(
      (l) =>
        !(collection === 'loads' && l === id) &&
        doc.loads.find((x) => x.id === l)?.kind === 'convection',
    );
    return constraints.length > 0 || (s.kind === 'thermal' && convection);
  };
  const ops: SimulationOperation[] = doc.studies
    .filter((s) => !held(s))
    .map((s) => ({ type: 'removeStudy', id: s.id }));
  return [
    ...ops,
    collection === 'loads' ? { type: 'removeLoad', id } : { type: 'removeConstraint', id },
  ];
}

/** Replacing an item's targets with the selected faces. */
export function retargetOp(
  item: SimulationLoad | SimulationConstraint,
  targets: SimulationTarget[],
): SimulationOperation | undefined {
  if (item.kind === 'gravity') return undefined;
  if (
    item.kind === 'force' ||
    item.kind === 'pressure' ||
    item.kind === 'heat-flux' ||
    item.kind === 'convection' ||
    item.kind === 'radiation' ||
    item.kind === 'enclosure'
  )
    return { type: 'updateLoad', load: { ...item, targets } };
  return { type: 'updateConstraint', constraint: { ...item, targets } };
}

/**
 * R3e-5a: a finer mesh on picked faces (docs/cad/r3-analysis.md, 代表操作2). The size a new face
 * starts at: half the element size, never below the smallest size.
 */
export const localSizeDefault = (doc: SimulationDocument) =>
  Math.max(doc.mesh.minSize, doc.mesh.size / 2);

/** Adds a local size for each target not already sized (one setMeshSettings), else undefined. */
export function addLocalSizesOp(
  doc: SimulationDocument,
  targets: readonly SimulationTarget[],
): SimulationOperation | undefined {
  const added = targets
    .filter((t, i) => !targets.slice(0, i).some((u) => sameSimulationTarget(t, u)))
    .filter((t) => !doc.mesh.local.some((l) => sameSimulationTarget(l.target, t)))
    .map((target) => ({ target, size: localSizeDefault(doc) }));
  if (!added.length) return undefined;
  return { type: 'setMeshSettings', mesh: { ...doc.mesh, local: [...doc.mesh.local, ...added] } };
}

/** Changes (a size) or removes (undefined) the local size at `index`. */
export function setLocalSizeOp(
  doc: SimulationDocument,
  index: number,
  size: number | undefined,
): SimulationOperation {
  const local =
    size === undefined
      ? doc.mesh.local.filter((_, i) => i !== index)
      : doc.mesh.local.map((l, i) => (i === index ? { ...l, size } : l));
  return { type: 'setMeshSettings', mesh: { ...doc.mesh, local } };
}

/** CR5b: a spot weld row of the CAD version, as the analysis offers it. */
export interface SimulationWeldRow {
  id: string;
  name: string;
  /** The first flange's nodes are tied near the points onto the second flange. */
  flanges: [{ bodyId: string; face: CadTopologyRef }, { bodyId: string; face: CadTopologyRef }];
  /** The row's largest gap (mm): the weld's tie tolerance starts at it. */
  maxGapMm: number;
  /** Its points as the kernel placed them; absent with `error` when the row did not evaluate. */
  points?: number;
  error?: string;
}
/** CR5b (docs/cad/car-design.md, CR5の分け方): a weld's radius, a 6 mm point. */
export const spotWeldRadiusDefaultMm = 3;

/**
 * CR5b: the analysis spot weld taking CAD row `row`: each flange re-referenced on its body's
 * result feature (as a pick would be), radius 3 mm, tolerance the row's largest gap. Throws for a
 * flange body not analysed, both flanges on one body, or a flange its body's table cannot find.
 */
export function spotWeldOf(
  doc: SimulationDocument,
  row: SimulationWeldRow,
  bodies: ReadonlyMap<string, SimulationPickBody>,
): SimulationSpotWeld {
  if (row.flanges[0].bodyId === row.flanges[1].bodyId)
    throw new Error('both flanges are on one body');
  const side = ({ bodyId, face }: SimulationWeldRow['flanges'][number]): SimulationTarget[] => {
    const b = bodies.get(bodyId);
    if (!b) throw new Error(`body ${bodyId} is not analysed`);
    const at = resolveTopologyRef(b.table, face);
    if (face.kind !== 'face' || at.status !== 'resolved')
      throw new Error(`a flange of ${bodyId} is not found on its body`);
    return bodyFaceTargets(doc.source.bodyId, bodies, [{ bodyId, face: at.index }]);
  };
  return {
    id: freshSimulationId(doc, 'weld'),
    name: row.name,
    weldId: row.id,
    follower: side(row.flanges[0]),
    on: side(row.flanges[1]),
    radiusMm: spotWeldRadiusDefaultMm,
    tolerance: row.maxGapMm,
  };
}

/**
 * VS13b: a sample rough road for a fatigue history, `points` long (deterministic): three waves
 * and a fine saw tooth about 0, peaks near ±2 (the study's loads × 2 at the worst bump).
 */
export function sampleRoadHistory(points = 2000): number[] {
  return Array.from({ length: points }, (_, i) =>
    Number(
      (
        Math.sin(i / 7) +
        0.6 * Math.sin(i / 2.3 + 1) +
        0.3 * Math.sin(i * 1.7) +
        ((i % 13) - 6) / 30
      ).toFixed(4),
    ),
  );
}
/** VS13b: a new fatigue setting: the sample road and the steel S-N line (`steelSn`). */
export const defaultFatigue = (): SimulationFatigue => ({
  history: sampleRoadHistory(),
  sn: { amplitude: 250, cycles: 1e6, slope: 10, endurance: 250, ultimate: 510 },
});
/** VS13b: a history as the panel writes it, factors separated by commas. */
export const formatHistory = (h: readonly number[]) => h.join(', ');
/**
 * VS13b: a history from the panel's text (factors separated by commas, spaces, semicolons or
 * lines); undefined when not 2 to `simulationLimits.fatiguePoints` finite numbers.
 */
export function parseHistory(text: string): number[] | undefined {
  const parts = text.split(/[\s,;]+/).filter((x) => x.length);
  if (parts.length < 2 || parts.length > simulationLimits.fatiguePoints) return undefined;
  const out = parts.map(Number);
  return out.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e6) ? out : undefined;
}
