import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import type { CadDocument } from './model';
import {
  applyCadOperation,
  cadContentHash,
  type CadOperation,
  type CadOperationType,
} from './operations';
import { cadId, cadJsonShape, record } from './validation';

/** Exact operation keys; IDs are checked here, nested payloads by the resulting document's validation. */
const operationKeys: Record<
  CadOperationType,
  { required: string[]; optional?: string[]; ids: string[] }
> = {
  insertFeatures: {
    required: ['type', 'features'],
    optional: ['parameters', 'profiles', 'sketches', 'bodies'],
    ids: [],
  },
  setParameter: {
    required: ['type', 'parameterId'],
    optional: ['value', 'expression'],
    ids: ['parameterId'],
  },
  updateFeature: { required: ['type', 'featureId', 'args'], ids: ['featureId'] },
  updateProfile: { required: ['type', 'profileId', 'plane', 'shape'], ids: ['profileId'] },
  updateSketch: {
    required: ['type', 'sketchId', 'plane', 'entities', 'constraints', 'solved'],
    ids: ['sketchId'],
  },
  transformBody: {
    required: ['type', 'bodyId', 'translation', 'rotation'],
    optional: ['unbind'],
    ids: ['bodyId'],
  },
  booleanBodies: {
    required: ['type', 'targetId', 'mode', 'booleanFeatureId', 'placementFeatureId'],
    optional: ['toolId', 'toolIds'],
    ids: ['targetId', 'booleanFeatureId', 'placementFeatureId'],
  },
  setBooleanTools: { required: ['type', 'featureId', 'toolIds'], ids: ['featureId'] },
  patternBodies: {
    required: [
      'type',
      'targetId',
      'toolId',
      'mode',
      'layout',
      'patternFeatureId',
      'placementFeatureId',
    ],
    ids: ['targetId', 'toolId', 'patternFeatureId', 'placementFeatureId'],
  },
  sewBodies: {
    required: [
      'type',
      'targetId',
      'toolIds',
      'toleranceMm',
      'solid',
      'sewFeatureId',
      'placementFeatureId',
    ],
    ids: ['targetId', 'sewFeatureId', 'placementFeatureId'],
  },
  detailBody: {
    required: ['type', 'bodyId', 'feature', 'placementFeatureId'],
    ids: ['bodyId', 'placementFeatureId'],
  },
  rebindReferences: { required: ['type', 'bindings'], optional: ['edit'], ids: [] },
  deleteClosure: { required: ['type', 'ids', 'cascade'], ids: [] },
  duplicateClosure: { required: ['type', 'bodyIds', 'idMap'], ids: [] },
  rename: { required: ['type', 'targetId', 'name'], ids: ['targetId'] },
  saveNamedView: { required: ['type', 'view'], ids: [] },
  reorderFeatures: { required: ['type', 'featureIds'], ids: [] },
  setKernelBuild: { required: ['type', 'kernelId', 'buildHash'], ids: ['kernelId'] },
  setToleranceSet: { required: ['type', 'set'], ids: [] },
  insertImportedBody: { required: ['type', 'assets', 'feature', 'body'], ids: [] },
  insertComponents: { required: ['type', 'parts', 'components'], ids: [] },
  setComponentPlacement: {
    required: ['type', 'componentId', 'placement'],
    ids: ['componentId'],
  },
  setPartProperties: { required: ['type', 'partNumber', 'description'], ids: [] },
  setComponentBom: { required: ['type', 'componentId', 'bom'], ids: ['componentId'] },
  insertComponentPattern: { required: ['type', 'pattern'], ids: [] },
  updateComponentPattern: { required: ['type', 'pattern'], ids: [] },
  replacePartSources: { required: ['type', 'parts'], ids: [] },
  insertJoint: { required: ['type', 'joint'], ids: [] },
  updateJoint: { required: ['type', 'joint'], ids: [] },
  setJointValues: { required: ['type', 'jointId', 'values'], ids: ['jointId'] },
  solveAssemblyPoses: { required: ['type'], ids: [] },
  withSolvedPoses: { required: ['type', 'edit', 'poses'], ids: [] },
};
const idList = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(cadId);

/** Shape gate for operation data from UI, headless callers or proposals. Payload JSON stays data. */
export function assertCadOperation(op: unknown): asserts op is CadOperation {
  // Rejects accessors, cycles, non-finite numbers and class instances before any branch.
  if (cadJsonShape(op)) throw new Error('operation-schema');
  if (!record(op) || typeof op.type !== 'string' || !Object.hasOwn(operationKeys, op.type))
    throw new Error('unsupported-operation');
  const schema = operationKeys[op.type as CadOperationType];
  const allowed = [...schema.required, ...(schema.optional ?? [])];
  if (
    schema.required.some((k) => !Object.hasOwn(op, k)) ||
    Object.keys(op).some((k) => !allowed.includes(k))
  )
    throw new Error('operation-schema');
  if (schema.ids.some((k) => !cadId(op[k]))) throw new Error('operation-schema');
  const ok =
    op.type === 'insertFeatures'
      ? ['features', 'parameters', 'profiles', 'sketches', 'bodies'].every(
          (k) => op[k] === undefined || Array.isArray(op[k]),
        )
      : op.type === 'setParameter'
        ? Object.hasOwn(op, 'expression')
          ? !Object.hasOwn(op, 'value') && record(op.expression)
          : typeof op.value === 'number' && Number.isFinite(op.value)
        : op.type === 'transformBody'
          ? op.unbind === undefined || op.unbind === true
          : op.type === 'booleanBodies'
            ? ['union', 'cut', 'common'].includes(op.mode as string) &&
              (Object.hasOwn(op, 'toolIds')
                ? !Object.hasOwn(op, 'toolId') && idList(op.toolIds)
                : cadId(op.toolId))
            : op.type === 'setBooleanTools'
              ? idList(op.toolIds)
              : op.type === 'patternBodies'
                ? ['union', 'cut'].includes(op.mode as string) && record(op.layout)
                : op.type === 'sewBodies'
                  ? idList(op.toolIds) &&
                    typeof op.toleranceMm === 'number' &&
                    typeof op.solid === 'boolean'
                  : op.type === 'detailBody'
                    ? record(op.feature)
                    : op.type === 'rebindReferences'
                      ? Array.isArray(op.bindings) &&
                        op.bindings.length > 0 &&
                        op.bindings.every(
                          (b) =>
                            record(b) &&
                            cadId(b.featureId) &&
                            Array.isArray(b.path) &&
                            record(b.ref),
                        ) &&
                        (op.edit === undefined ||
                          (record(op.edit) &&
                            op.edit.type !== 'rebindReferences' &&
                            op.edit.type !== 'withSolvedPoses' &&
                            (assertCadOperation(op.edit), true)))
                      : op.type === 'withSolvedPoses'
                        ? record(op.poses) &&
                          record(op.edit) &&
                          op.edit.type !== 'withSolvedPoses' &&
                          (assertCadOperation(op.edit), true)
                        : op.type === 'insertJoint' || op.type === 'updateJoint'
                          ? record(op.joint)
                          : op.type === 'setJointValues'
                            ? record(op.values)
                            : op.type === 'solveAssemblyPoses'
                              ? true
                              : op.type === 'deleteClosure'
                                ? idList(op.ids) && typeof op.cascade === 'boolean'
                                : op.type === 'duplicateClosure'
                                  ? idList(op.bodyIds) && record(op.idMap)
                                  : op.type === 'rename'
                                    ? typeof op.name === 'string'
                                    : op.type === 'saveNamedView'
                                      ? record(op.view)
                                      : op.type === 'reorderFeatures'
                                        ? idList(op.featureIds)
                                        : op.type === 'setKernelBuild'
                                          ? typeof op.buildHash === 'string'
                                          : op.type === 'setToleranceSet'
                                            ? typeof op.set === 'string'
                                            : op.type === 'insertImportedBody'
                                              ? Array.isArray(op.assets) &&
                                                record(op.feature) &&
                                                record(op.body)
                                              : op.type === 'insertComponents'
                                                ? Array.isArray(op.parts) &&
                                                  Array.isArray(op.components) &&
                                                  op.components.length > 0
                                                : op.type === 'setComponentPlacement'
                                                  ? record(op.placement)
                                                  : op.type === 'replacePartSources'
                                                    ? Array.isArray(op.parts) &&
                                                      op.parts.length > 0 &&
                                                      op.parts.every(
                                                        (p) =>
                                                          record(p) &&
                                                          cadId(p.partId) &&
                                                          record(p.source) &&
                                                          record(p.hint),
                                                      )
                                                    : op.type === 'insertComponentPattern' ||
                                                        op.type === 'updateComponentPattern'
                                                      ? record(op.pattern)
                                                      : op.type === 'setComponentBom'
                                                        ? op.bom === 'include' ||
                                                          op.bom === 'exclude'
                                                        : op.type === 'setPartProperties'
                                                          ? typeof op.partNumber === 'string' &&
                                                            typeof op.description === 'string'
                                                          : op.type === 'updateFeature'
                                                            ? record(op.args)
                                                            : op.type === 'updateSketch'
                                                              ? record(op.plane) &&
                                                                Array.isArray(op.entities) &&
                                                                Array.isArray(op.constraints) &&
                                                                record(op.solved)
                                                              : record(op.plane) &&
                                                                record(op.shape);
  if (!ok) throw new Error('operation-schema');
}

export interface CadCommandOptions {
  /** contentHash of the base the operation was prepared against; `apply` throws on any other base. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  /** contentHash of the kernel-verified candidate; `apply` throws if its result differs. */
  expectedResultHash?: string;
  context?: LocalCommandContext;
}
const labels: Record<CadOperationType, string> = {
  insertFeatures: 'Add features',
  setParameter: 'Change dimension',
  updateFeature: 'Edit feature',
  updateProfile: 'Edit profile',
  updateSketch: 'Edit sketch',
  transformBody: 'Move body',
  booleanBodies: 'Combine bodies',
  deleteClosure: 'Delete',
  duplicateClosure: 'Duplicate',
  rename: 'Rename',
  saveNamedView: 'Save view',
  reorderFeatures: 'Reorder features',
  setKernelBuild: 'Change kernel build',
  setToleranceSet: 'Change tolerance set',
  insertImportedBody: 'Import STEP',
  insertComponents: 'Insert part',
  setComponentPlacement: 'Move component',
  setPartProperties: 'Part properties',
  setComponentBom: 'Count in BOM',
  insertComponentPattern: 'Pattern component',
  updateComponentPattern: 'Edit component pattern',
  replacePartSources: 'Update part version',
  detailBody: 'Add detail',
  setBooleanTools: 'Change Boolean tools',
  patternBodies: 'Pattern body',
  sewBodies: 'Sew sheets',
  rebindReferences: 'Choose references again',
  insertJoint: 'Add joint',
  updateJoint: 'Edit joint',
  setJointValues: 'Move joint',
  solveAssemblyPoses: 'Solve poses again',
  withSolvedPoses: 'Edit',
};

/**
 * One ordinary EditorSession transaction for an operation. Geometry-producing operations
 * reach this only through the kernel coordinator's prepare/ticket boundary (operations.md);
 * the command still re-checks base, authority and schema itself.
 */
export function cadEditorCommand(
  op: CadOperation,
  options: CadCommandOptions,
): EditorCommand<CadDocument> {
  assertCadOperation(op);
  const prepared = structuredClone(op);
  const run = (content: CadDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (cadContentHash(content) !== options.expectedHash) throw new Error('cad-base-mismatch');
    const next = applyCadOperation(content, prepared);
    if (options.expectedResultHash && cadContentHash(next) !== options.expectedResultHash)
      throw new Error('cad-candidate-mismatch');
    return next;
  };
  // Solved poses ride on the edit they belong to: it is named as that edit.
  const shown = op.type === 'withSolvedPoses' ? op.edit : op;
  const cmd = options.context
    ? immutableCommand(`cad.${shown.type}`, labels[shown.type], run, options.context)
    : immutableCommand(`cad.${shown.type}`, labels[shown.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}
export type { CadDocument };
