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
  freshSimulationId,
  sameSimulationTarget,
  thermalConstraintKinds,
  thermalLoadKinds,
  type SimulationConstraint,
  type SimulationDocument,
  type SimulationLoad,
  type SimulationOperation,
  type SimulationSpotWeld,
  type SimulationStudy,
  type SimulationTarget,
} from '@editor-platform/simulation-core';

/** What the Surface adds on the selected faces (R3h: and the thermal conditions). */
export type SimulationConditionKind =
  | 'force'
  | 'pressure'
  | 'fixed'
  | 'pinned'
  | 'temperature'
  | 'heat-flux'
  | 'convection';
export const simulationConditionLabels: Record<SimulationConditionKind, string> = {
  force: 'Force',
  pressure: 'Pressure',
  fixed: 'Fixed support',
  // R3i-5: a shell's translations held, its rotations free (a solid treats it as fixed).
  pinned: 'Pinned support',
  temperature: 'Temperature',
  'heat-flux': 'Heat flux',
  convection: 'Convection',
};
const constraintKinds: readonly SimulationConditionKind[] = ['fixed', 'pinned', 'temperature'];
/** R3h: whether a load or constraint kind belongs to thermal studies. */
export const isThermalKind = (kind: string) =>
  thermalLoadKinds.includes(kind as never) || thermalConstraintKinds.includes(kind as never);
const structural = <T extends { kind: string }>(items: readonly T[]) =>
  items.filter((x) => !isThermalKind(x.kind));
const thermal = <T extends { kind: string }>(items: readonly T[]) =>
  items.filter((x) => isThermalKind(x.kind));
/** Whether a study of this kind takes an item of this kind. */
const takes = (study: SimulationStudy, kind: string, isConstraint: boolean) =>
  // CR5c: a stiffness test keeps its own supports and loads only.
  // VS4a: a wind tunnel takes no loads or constraints.
  (study.kind === 'linear-static' && study.test) || study.kind === 'aero'
    ? false
    : study.kind === 'thermal'
      ? isThermalKind(kind)
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
    loadIds: thermal(doc.loads).map((l) => l.id),
    constraintIds: thermal(doc.constraints).map((c) => c.id),
    solver: { tolerance: 1e-10, maxIterations: 100_000 },
    convergence: { levels: 2, metrics: ['max-temperature', 'max-heat-flux'], tolerance: 0.02 },
  };
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
    if (takes(study, kind, isConstraint))
      ops.push({
        type: 'updateStudy',
        study: isConstraint
          ? { ...study, constraintIds: [...study.constraintIds, added] }
          : { ...study, loadIds: [...study.loadIds, added] },
      });
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
    // VS4a: a wind tunnel takes no conditions; removing one leaves it as it is.
    if (s.kind === 'aero') return true;
    const constraints = s.constraintIds.filter((c) => collection === 'loads' || c !== id);
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
    item.kind === 'convection'
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
