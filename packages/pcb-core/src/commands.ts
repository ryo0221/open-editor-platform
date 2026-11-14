import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import type { PcbDocument } from './model';
import {
  applyPcbOperation,
  applyPcbOperations,
  assertPcbOperation,
  pcbContentHash,
  type PcbOperation,
  type PcbOperationType,
} from './operations';

export interface PcbCommandOptions {
  /** contentHash of the base the operation was prepared against; `apply` throws on any other base. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  context?: LocalCommandContext;
}
const labels: Record<PcbOperationType, string> = {
  insert: 'Add',
  update: 'Edit',
  updateMany: 'Move',
  delete: 'Delete',
  setBoard: 'Edit board',
  setNets: 'Edit nets',
};

/** One ordinary EditorSession transaction for an operation; re-checks base, authority and schema. */
export function pcbEditorCommand(
  op: PcbOperation,
  options: PcbCommandOptions,
): EditorCommand<PcbDocument> {
  assertPcbOperation(op);
  const prepared = structuredClone(op);
  const run = (content: PcbDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (pcbContentHash(content) !== options.expectedHash) throw new Error('pcb-base-mismatch');
    return applyPcbOperation(content, prepared);
  };
  const cmd = options.context
    ? immutableCommand(`pcb.${op.type}`, labels[op.type], run, options.context)
    : immutableCommand(`pcb.${op.type}`, labels[op.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}

/**
 * Several operations as one EditorSession transaction (one Undo), applied by
 * `applyPcbOperations`: the result is validated as a whole and any refusal leaves the content
 * untouched. For edits made of steps that each need the previous one (a schematic sent to the
 * board, SL3).
 */
export function pcbBatchCommand(
  ops: readonly PcbOperation[],
  label: string,
  options: PcbCommandOptions,
): EditorCommand<PcbDocument> {
  if (ops.length === 0) throw new Error('operation-empty');
  ops.forEach((op) => assertPcbOperation(op));
  const prepared = structuredClone(ops) as PcbOperation[];
  const run = (content: PcbDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (pcbContentHash(content) !== options.expectedHash) throw new Error('pcb-base-mismatch');
    return applyPcbOperations(content, prepared);
  };
  const cmd = options.context
    ? immutableCommand('pcb.batch', label, run, options.context)
    : immutableCommand('pcb.batch', label, run);
  return withCommandReads(cmd, { content: ['*'] });
}
