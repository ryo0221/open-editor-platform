import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
  type LocalCommandContext,
} from '@editor-platform/editor-core';
import type { SchematicDocument } from './model';
import {
  applySchematicOperation,
  assertSchematicOperation,
  schematicContentHash,
  type SchematicOperation,
  type SchematicOperationType,
} from './operations';

export interface SchematicCommandOptions {
  /** contentHash of the base the operation was prepared against; `apply` throws on any other base. */
  expectedHash: string;
  /** Trusted, current edit authority, re-read on apply. */
  canEdit: () => boolean;
  context?: LocalCommandContext;
}
const labels: Record<SchematicOperationType, string> = {
  insert: 'Add',
  update: 'Edit',
  delete: 'Delete',
  setSheet: 'Edit sheet',
  move: 'Move',
};

/** One ordinary EditorSession transaction for an operation; re-checks base, authority and schema. */
export function schematicEditorCommand(
  op: SchematicOperation,
  options: SchematicCommandOptions,
): EditorCommand<SchematicDocument> {
  assertSchematicOperation(op);
  const prepared = structuredClone(op);
  const run = (content: SchematicDocument) => {
    if (!options.canEdit()) throw new Error('permission-denied');
    if (schematicContentHash(content) !== options.expectedHash)
      throw new Error('schematic-base-mismatch');
    return applySchematicOperation(content, prepared);
  };
  const cmd = options.context
    ? immutableCommand(`schematic.${op.type}`, labels[op.type], run, options.context)
    : immutableCommand(`schematic.${op.type}`, labels[op.type], run);
  return withCommandReads(cmd, { content: ['*'] });
}
