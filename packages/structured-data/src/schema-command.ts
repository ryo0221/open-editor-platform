import type { EditorCommand } from '@editor-platform/editor-core';
import type { StructuredData } from './model';

/** Internal capability of the public column command factories, never a wire credential. */
const intents = new WeakMap<
  EditorCommand<StructuredData>,
  { columnId: string; kind: 'update' | 'remove' }
>();
export function columnSchemaCommand(
  columnId: string,
  kind: 'update' | 'remove',
  command: EditorCommand<StructuredData>,
) {
  const fixed = Object.freeze({ ...command });
  intents.set(fixed, { columnId, kind });
  return fixed;
}
export const columnSchemaIntent = (command: EditorCommand<StructuredData>) => intents.get(command);
