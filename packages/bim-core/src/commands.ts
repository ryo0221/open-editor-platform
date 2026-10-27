import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import type { BimDocument } from './model';
import {
  applyBimOperation,
  assertBimOperation,
  bimContentHash,
  type BimOperation,
  type BimOperationType,
} from './operations';

export interface BimCommandOptions {
  /** contentHash of the base the operation was prepared against; `apply` throws on any other base. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  context?: LocalCommandContext;
}
const labels: Record<BimOperationType, string> = {
  insert: 'Add',
  update: 'Edit',
  delete: 'Delete',
  setProject: 'Edit project',
};

/** One ordinary EditorSession transaction for an operation; re-checks base, authority and schema. */
export function bimEditorCommand(
  op: BimOperation,
  options: BimCommandOptions,
): EditorCommand<BimDocument> {
  assertBimOperation(op);
  const prepared = structuredClone(op);
  const run = (content: BimDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (bimContentHash(content) !== options.expectedHash) throw new Error('bim-base-mismatch');
    return applyBimOperation(content, prepared);
  };
  const cmd = options.context
    ? immutableCommand(`bim.${op.type}`, labels[op.type], run, options.context)
    : immutableCommand(`bim.${op.type}`, labels[op.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}
