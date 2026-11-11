import { canonicalJson } from '@editor-platform/artifact-core';
import { simulationTargets } from './source';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  SimulationValidationError,
  simulationLimits,
  type SimulationConstraint,
  type SimulationDocument,
  type SimulationStaticStudy,
  type SimulationLoad,
  type SimulationMaterial,
  type SimulationMeshSettings,
  type SimulationPreparation,
  type SimulationStudy,
  type SimulationOverride,
  type SimulationRunRecord,
  type SimulationTarget,
  type SimulationBody,
  type SimulationBond,
  type SimulationMass,
  type SimulationSpotWeld,
  type SimulationIdealisation,
} from './model';
import { settingOwners, validateSimulation } from './validation';

/** The SHA-256 (hex) of a document's canonical JSON, the base an operation is prepared against. */
export const simulationContentHash = (doc: SimulationDocument) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(doc))));
/**
 * R3e: the SHA-256 (hex) of the preparation settings' canonical JSON, the `preparationHash` a
 * stored re-selection is tied to (`SimulationOverride`, `MappingContext`).
 */
export const simulationPreparationHash = (preparation: SimulationPreparation) =>
  bytesToHex(sha256(new TextEncoder().encode(canonicalJson(preparation))));

/**
 * R3e-5c: the SHA-256 (hex) of what a run solves: the document without its run records, removed
 * IDs and name, so recording a run (or renaming the analysis) leaves a record current.
 */
export function simulationInputHash(doc: SimulationDocument) {
  const { runs: _runs, retiredIds: _retired, name: _name, ...inputs } = doc;
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(inputs))));
}

type Collection =
  | 'materials'
  | 'loads'
  | 'constraints'
  | 'studies'
  | 'bonds'
  | 'masses'
  | 'spotWelds';
/** R3a's edits of the analysis setup. Runs (results) are recorded by later stages. */
export type SimulationOperation =
  | { type: 'renameDocument'; name: string }
  | { type: 'rename'; collection: Collection; id: string; name: string }
  /** Points the analysis at another version or body (CAD's content is never changed). */
  /**
   * With `resultFeatureId` (the chosen version's result feature for the body), every target is
   * renamed to it in the same edit; each name still resolves on the new version or is reported.
   */
  | {
      type: 'setSource';
      source: SimulationDocument['source'];
      resultFeatureId?: string;
      /** R3j-2: the chosen version's result feature of each other body, renaming its targets. */
      bodyResultFeatureIds?: { bodyId: string; featureId: string }[];
    }
  | { type: 'addMaterial'; material: SimulationMaterial }
  | { type: 'updateMaterial'; material: SimulationMaterial }
  /** Refused while the body uses it (`material-in-use`). */
  | { type: 'removeMaterial'; id: string }
  /** `bodyId` (R3j-2) names another analysed body; absent, the source body. */
  | { type: 'setBodyMaterial'; materialId: string | null; bodyId?: string }
  /** R3j-2: analyses another body of the source version with the source body (schema 2). */
  | { type: 'addBody'; body: SimulationBody }
  /** R3j-2: refused while a target is on it (`body-in-use`). */
  | { type: 'removeBody'; bodyId: string }
  /** R3j-4: bonds between the analysed bodies (schema 2). */
  | { type: 'addBond'; bond: SimulationBond }
  | { type: 'updateBond'; bond: SimulationBond }
  | { type: 'removeBond'; id: string }
  /** CR5a: an added mass on faces (schema 2). */
  | { type: 'addMass'; mass: SimulationMass }
  | { type: 'updateMass'; mass: SimulationMass }
  | { type: 'removeMass'; id: string }
  /** CR5b: a spot weld row taken from the source version (schema 2). */
  | { type: 'addSpotWeld'; weld: SimulationSpotWeld }
  | { type: 'updateSpotWeld'; weld: SimulationSpotWeld }
  | { type: 'removeSpotWeld'; id: string }
  /** R3j-2: an analysed body's own idealisation, or null for the study's. */
  | { type: 'setBodyIdealisation'; bodyId: string; idealisation: SimulationIdealisation | null }
  /** CR5e: a sheet body's thickness (mm), or null to take it away (schema 2). */
  | { type: 'setSheetThickness'; bodyId: string; thicknessMm: number | null }
  | { type: 'addLoad'; load: SimulationLoad }
  | { type: 'updateLoad'; load: SimulationLoad }
  /** Also drops it from every study, in the same edit. */
  | { type: 'removeLoad'; id: string }
  | { type: 'addConstraint'; constraint: SimulationConstraint }
  | { type: 'updateConstraint'; constraint: SimulationConstraint }
  /** Also drops it from every study, in the same edit. */
  | { type: 'removeConstraint'; id: string }
  | { type: 'setPreparation'; preparation: SimulationPreparation }
  | { type: 'setMeshSettings'; mesh: SimulationMeshSettings }
  | { type: 'addStudy'; study: SimulationStudy }
  | { type: 'updateStudy'; study: SimulationStudy }
  | { type: 'removeStudy'; id: string }
  /** R3c: stores the re-selection of an ambiguous target, replacing one for the same key. */
  | { type: 'setOverride'; override: SimulationOverride }
  /** Removes the re-selections of one target (every version and preparation). */
  | { type: 'clearOverrides'; owner: string; target: SimulationTarget }
  /** R3e-5c: keeps a study's run, replacing the one recorded before for that study. */
  | { type: 'recordRun'; run: SimulationRunRecord };
export type SimulationOperationType = SimulationOperation['type'];

const fail = (code: string, message = code): never => {
  throw new SimulationValidationError([{ code, path: '$', message }]);
};

/** Applies one operation to a copy and checks the whole result; throws, never half-applies. */
/**
 * CR5c: a stiffness test that lost its driven constraint or its force becomes an ordinary study:
 * its `test` goes, and so does the `stiffness` it compared (the largest displacement instead) and
 * that its recorded run measured (Codex on #982: an ordinary study's record has none).
 */
function untest(doc: SimulationDocument, s: SimulationStaticStudy) {
  delete s.test;
  const metrics = s.convergence.metrics.filter((m) => m !== 'stiffness');
  s.convergence.metrics = metrics.length ? metrics : ['max-displacement'];
  for (const r of doc.runs ?? [])
    if (r.studyId === s.id) for (const l of r.levels) delete l.metrics.stiffness;
}

export function applySimulationOperation(
  doc: SimulationDocument,
  op: SimulationOperation,
): SimulationDocument {
  const next = structuredClone(doc);
  const at = <T extends { id: string }>(items: T[], id: string) => {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) fail('not-found', `no ${id}`);
    return i;
  };
  const bodyAt = (bodyId: string) => {
    const b = next.bodies?.find((x) => x.bodyId === bodyId);
    if (!b) fail('not-found', `no body ${bodyId}`);
    return b!;
  };
  const retire = (id: string) => {
    const r = new Set(next.retiredIds ?? []);
    r.add(id);
    if (r.size > simulationLimits.retiredIds) fail('limit-exceeded', 'retired IDs');
    next.retiredIds = [...r];
  };
  switch (op.type) {
    case 'renameDocument':
      next.name = op.name;
      break;
    case 'rename': {
      const items = (next[op.collection] ?? []) as { id: string; name: string }[];
      items[at(items, op.id)]!.name = op.name;
      break;
    }
    case 'addBond':
      next.schemaVersion = 2;
      next.bonds = [...(next.bonds ?? []), structuredClone(op.bond)];
      break;
    case 'updateBond': {
      const bonds = next.bonds ?? [];
      bonds[at(bonds, op.bond.id)] = structuredClone(op.bond);
      break;
    }
    case 'removeBond': {
      const bonds = next.bonds ?? [];
      bonds.splice(at(bonds, op.id), 1);
      if (!bonds.length) delete next.bonds;
      retire(op.id);
      break;
    }
    case 'addSpotWeld':
      next.schemaVersion = 2;
      next.spotWelds = [...(next.spotWelds ?? []), structuredClone(op.weld)];
      break;
    case 'updateSpotWeld': {
      const welds = next.spotWelds ?? [];
      welds[at(welds, op.weld.id)] = structuredClone(op.weld);
      break;
    }
    case 'removeSpotWeld': {
      const welds = next.spotWelds ?? [];
      welds.splice(at(welds, op.id), 1);
      if (!welds.length) delete next.spotWelds;
      retire(op.id);
      break;
    }
    case 'addMass':
      next.schemaVersion = 2;
      next.masses = [...(next.masses ?? []), structuredClone(op.mass)];
      break;
    case 'updateMass': {
      const masses = next.masses ?? [];
      masses[at(masses, op.mass.id)] = structuredClone(op.mass);
      break;
    }
    case 'removeMass': {
      const masses = next.masses ?? [];
      masses.splice(at(masses, op.id), 1);
      if (!masses.length) delete next.masses;
      retire(op.id);
      break;
    }
    case 'setSource': {
      next.source = structuredClone(op.source);
      const features = new Map((op.bodyResultFeatureIds ?? []).map((b) => [b.bodyId, b.featureId]));
      for (const { target } of simulationTargets(next)) {
        const featureId =
          target.body === undefined ? op.resultFeatureId : features.get(target.body);
        if (featureId !== undefined) target.ref.featureId = featureId;
      }
      break;
    }
    case 'addMaterial':
      next.materials.push(structuredClone(op.material));
      break;
    case 'updateMaterial':
      next.materials[at(next.materials, op.material.id)] = structuredClone(op.material);
      break;
    case 'removeMaterial':
      if (next.materialId === op.id || next.bodies?.some((b) => b.materialId === op.id))
        fail('material-in-use', 'a body uses this material');
      next.materials.splice(at(next.materials, op.id), 1);
      retire(op.id);
      break;
    case 'setBodyMaterial':
      if (op.bodyId === undefined) next.materialId = op.materialId;
      else bodyAt(op.bodyId).materialId = op.materialId;
      break;
    case 'addBody':
      next.schemaVersion = 2;
      next.bodies = [...(next.bodies ?? []), structuredClone(op.body)];
      break;
    case 'removeBody': {
      bodyAt(op.bodyId);
      if (simulationTargets(next).some(({ target }) => target.body === op.bodyId))
        fail('body-in-use', 'a load, constraint or setting is on this body');
      next.bodies = next.bodies!.filter((b) => b.bodyId !== op.bodyId);
      if (!next.bodies.length) delete next.bodies;
      // CR5e: its sheet thickness goes with it.
      if (next.sheets) {
        next.sheets = next.sheets.filter((t) => t.bodyId !== op.bodyId);
        if (!next.sheets.length) delete next.sheets;
      }
      break;
    }
    case 'setSheetThickness': {
      const rest = (next.sheets ?? []).filter((t) => t.bodyId !== op.bodyId);
      if (op.thicknessMm !== null) {
        next.schemaVersion = 2;
        const i = (next.sheets ?? []).findIndex((t) => t.bodyId === op.bodyId);
        const entry = { bodyId: op.bodyId, thicknessMm: op.thicknessMm };
        if (i < 0) rest.push(entry);
        else rest.splice(i, 0, entry);
      }
      if (rest.length) next.sheets = rest;
      else delete next.sheets;
      break;
    }
    case 'setBodyIdealisation': {
      const b = bodyAt(op.bodyId);
      if (op.idealisation === null) delete b.idealisation;
      else b.idealisation = op.idealisation;
      break;
    }
    case 'addLoad':
      next.loads.push(structuredClone(op.load));
      break;
    case 'updateLoad':
      next.loads[at(next.loads, op.load.id)] = structuredClone(op.load);
      break;
    case 'removeLoad':
      next.loads.splice(at(next.loads, op.id), 1);
      for (const s of next.studies) {
        s.loadIds = s.loadIds.filter((x) => x !== op.id);
        // CR5c: a test without its load is an ordinary study.
        if (s.kind === 'linear-static' && s.test?.kind === 'bending' && s.test.load === op.id)
          untest(next, s);
      }
      retire(op.id);
      break;
    case 'addConstraint':
      next.constraints.push(structuredClone(op.constraint));
      break;
    case 'updateConstraint':
      next.constraints[at(next.constraints, op.constraint.id)] = structuredClone(op.constraint);
      break;
    case 'removeConstraint':
      next.constraints.splice(at(next.constraints, op.id), 1);
      for (const s of next.studies) {
        s.constraintIds = s.constraintIds.filter((x) => x !== op.id);
        if (
          s.kind === 'linear-static' &&
          s.test?.kind === 'torsion' &&
          (s.test.left === op.id || s.test.right === op.id)
        )
          untest(next, s);
      }
      retire(op.id);
      break;
    case 'setPreparation':
      next.preparation = structuredClone(op.preparation);
      break;
    case 'setMeshSettings':
      next.mesh = structuredClone(op.mesh);
      break;
    case 'addStudy':
      next.studies.push(structuredClone(op.study));
      break;
    case 'updateStudy':
      next.studies[at(next.studies, op.study.id)] = structuredClone(op.study);
      break;
    case 'removeStudy':
      next.studies.splice(at(next.studies, op.id), 1);
      retire(op.id);
      // Its recorded run goes with it.
      for (const r of next.runs ?? []) if (r.studyId === op.id) retire(r.id);
      next.runs = (next.runs ?? []).filter((r) => r.studyId !== op.id);
      if (!next.runs.length) delete next.runs;
      break;
    case 'recordRun': {
      if (!next.studies.some((s) => s.id === op.run.studyId)) fail('study-missing', op.run.studyId);
      const before = (next.runs ?? []).filter((r) => r.studyId === op.run.studyId);
      for (const r of before) retire(r.id);
      next.runs = [
        ...(next.runs ?? []).filter((r) => r.studyId !== op.run.studyId),
        structuredClone(op.run),
      ];
      break;
    }
    case 'setOverride': {
      const o = op.override;
      if (!holdsTarget(next, o.owner, o.target))
        fail('override-target', 'not a target of its owner');
      const same = (x: SimulationOverride) =>
        x.owner === o.owner &&
        canonicalJson(x.target) === canonicalJson(o.target) &&
        x.versionId === o.versionId &&
        x.preparationHash === o.preparationHash &&
        x.kernelBuild === o.kernelBuild;
      next.overrides = [...(next.overrides ?? []).filter((x) => !same(x)), structuredClone(o)];
      break;
    }
    case 'clearOverrides':
      next.overrides = (next.overrides ?? []).filter(
        (x) => !(x.owner === op.owner && canonicalJson(x.target) === canonicalJson(op.target)),
      );
      break;
    default:
      fail('unknown-operation');
  }
  // A re-selection belongs to a target its owner still holds; one whose target an edit removed
  // (a load removed or retargeted, a face no longer removed) is dropped in the same edit.
  if (next.overrides) {
    next.overrides = next.overrides.filter((o) => holdsTarget(next, o.owner, o.target));
    if (!next.overrides.length) delete next.overrides;
  }
  const problems = validateSimulation(next);
  if (problems.length) throw new SimulationValidationError(problems);
  return next;
}

/** True when `owner` (a load, a constraint, `preparation` or `mesh`) stores `target`. */
function holdsTarget(doc: SimulationDocument, owner: string, target: SimulationTarget): boolean {
  const l = doc.loads.find((x) => x.id === owner);
  const c = doc.constraints.find((x) => x.id === owner);
  const bond = doc.bonds?.find((x) => x.id === owner);
  const mass = doc.masses?.find((x) => x.id === owner);
  const weld = doc.spotWelds?.find((x) => x.id === owner);
  if (weld) {
    const form = canonicalJson(target);
    return [...weld.follower, ...weld.on].some((t) => canonicalJson(t) === form);
  }
  if (mass) {
    const form = canonicalJson(target);
    return mass.targets.some((t) => canonicalJson(t) === form);
  }
  if (bond) {
    const form = canonicalJson(target);
    return [...bond.follower, ...bond.on].some((t) => canonicalJson(t) === form);
  }
  const held = l
    ? l.kind === 'gravity'
      ? []
      : l.targets
    : c
      ? c.targets
      : owner === 'preparation'
        ? doc.preparation.removeFaces
        : owner === 'mesh'
          ? doc.mesh.local.map((x) => x.target)
          : [];
  const form = canonicalJson(target);
  return held.some((t) => canonicalJson(t) === form);
}

/** Every ID of the document's one namespace, removed ones included (they are never reused). */
export function simulationIds(doc: SimulationDocument): Set<string> {
  const out = new Set<string>();
  for (const x of [
    ...doc.materials,
    ...doc.loads,
    ...doc.constraints,
    ...doc.studies,
    ...(doc.bonds ?? []),
    ...(doc.masses ?? []),
    ...(doc.spotWelds ?? []),
    ...(doc.runs ?? []),
  ])
    out.add(x.id);
  for (const id of doc.retiredIds ?? []) out.add(id);
  for (const id of settingOwners) out.add(id);
  return out;
}
/** `base`, or `base-2`, `base-3` …: the first that the document does not use yet. */
export function freshSimulationId(doc: SimulationDocument, base: string) {
  const taken = simulationIds(doc);
  const stem = [...base].slice(0, simulationLimits.idCodePoints - 8).join('');
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

export interface SimulationCommandOptions {
  /** `simulationContentHash` of the base the operation was prepared against. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  context?: LocalCommandContext;
}
const labels: Record<SimulationOperationType, string> = {
  renameDocument: 'Rename analysis',
  rename: 'Rename',
  setSource: 'Change CAD version',
  addMaterial: 'Add material',
  updateMaterial: 'Edit material',
  removeMaterial: 'Remove material',
  setBodyMaterial: 'Assign material',
  addBody: 'Add body',
  removeBody: 'Remove body',
  setBodyIdealisation: 'Set body idealisation',
  setSheetThickness: 'Set sheet thickness',
  addBond: 'Add bond',
  updateBond: 'Edit bond',
  removeBond: 'Remove bond',
  addSpotWeld: 'Add spot welds',
  updateSpotWeld: 'Edit spot welds',
  removeSpotWeld: 'Remove spot welds',
  addMass: 'Add mass',
  updateMass: 'Edit mass',
  removeMass: 'Remove mass',
  addLoad: 'Add load',
  updateLoad: 'Edit load',
  removeLoad: 'Remove load',
  addConstraint: 'Add constraint',
  updateConstraint: 'Edit constraint',
  removeConstraint: 'Remove constraint',
  setPreparation: 'Set preparation',
  setMeshSettings: 'Set mesh',
  addStudy: 'Add study',
  updateStudy: 'Edit study',
  removeStudy: 'Remove study',
  setOverride: 'Choose faces',
  clearOverrides: 'Clear face choice',
  recordRun: 'Record result',
};
/**
 * One ordinary EditorSession transaction; re-checks base, authority and the whole document. Several
 * operations (one user action, e.g. a material and its assignment) apply in order as one Undo
 * step, each checked on the result of the one before; any refused refuses them all.
 */
export function simulationEditorCommand(
  operations: SimulationOperation | readonly SimulationOperation[],
  options: SimulationCommandOptions,
): EditorCommand<SimulationDocument> {
  const prepared = structuredClone(
    Array.isArray(operations) ? [...operations] : [operations],
  ) as SimulationOperation[];
  const op = prepared[0];
  if (!op) throw new Error('no-operation');
  const run = (content: SimulationDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (simulationContentHash(content) !== options.expectedHash)
      throw new Error('simulation-base-mismatch');
    return prepared.reduce(applySimulationOperation, content);
  };
  const cmd = options.context
    ? immutableCommand(`simulation.${op.type}`, labels[op.type], run, options.context)
    : immutableCommand(`simulation.${op.type}`, labels[op.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}
