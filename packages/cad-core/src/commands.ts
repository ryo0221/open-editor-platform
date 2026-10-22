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
    optional: ['parameters', 'profiles', 'bodies'],
    ids: [],
  },
  setParameter: { required: ['type', 'parameterId', 'value'], ids: ['parameterId'] },
  updateFeature: { required: ['type', 'featureId', 'args'], ids: ['featureId'] },
  updateProfile: { required: ['type', 'profileId', 'plane', 'shape'], ids: ['profileId'] },
  transformBody: {
    required: ['type', 'bodyId', 'translation', 'rotation'],
    optional: ['unbind'],
    ids: ['bodyId'],
  },
  booleanBodies: {
    required: ['type', 'targetId', 'toolId', 'mode', 'booleanFeatureId', 'placementFeatureId'],
    ids: ['targetId', 'toolId', 'booleanFeatureId', 'placementFeatureId'],
  },
  deleteClosure: { required: ['type', 'ids', 'cascade'], ids: [] },
  duplicateClosure: { required: ['type', 'bodyIds', 'idMap'], ids: [] },
  rename: { required: ['type', 'targetId', 'name'], ids: ['targetId'] },
  saveNamedView: { required: ['type', 'view'], ids: [] },
  reorderFeatures: { required: ['type', 'featureIds'], ids: [] },
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
      ? ['features', 'parameters', 'profiles', 'bodies'].every(
          (k) => op[k] === undefined || Array.isArray(op[k]),
        )
      : op.type === 'setParameter'
        ? typeof op.value === 'number' && Number.isFinite(op.value)
        : op.type === 'transformBody'
          ? op.unbind === undefined || op.unbind === true
          : op.type === 'booleanBodies'
            ? ['union', 'cut', 'common'].includes(op.mode as string)
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
                      : op.type === 'updateFeature'
                        ? record(op.args)
                        : record(op.plane) && record(op.shape);
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
  transformBody: 'Move body',
  booleanBodies: 'Combine bodies',
  deleteClosure: 'Delete',
  duplicateClosure: 'Duplicate',
  rename: 'Rename',
  saveNamedView: 'Save view',
  reorderFeatures: 'Reorder features',
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
  const cmd = options.context
    ? immutableCommand(`cad.${op.type}`, labels[op.type], run, options.context)
    : immutableCommand(`cad.${op.type}`, labels[op.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}
export type { CadDocument };
