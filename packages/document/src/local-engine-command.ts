import type { Node as PMNode } from 'prosemirror-model';
import { canonicalJson, clone, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { immutableCommand, type LocalCommandContext } from '@editor-platform/editor-core';
import { nodeToContent } from './engine';
import type { DocumentContent } from './model';

// Compare the complete native projection before retaining an old block. Unlike
// a JSON fingerprint this keeps signed zero, holes and property presence distinct.
// Every retained branch must be certified immutable, including hidden children.
function sameProjection(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return Object.is(left, right);
  if (!isDeepFrozen(left)) return false;
  const prototype = Object.getPrototypeOf(left);
  if (
    prototype !== Object.getPrototypeOf(right) ||
    (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
  )
    return false;
  const keys = Reflect.ownKeys(left);
  if (keys.length !== Reflect.ownKeys(right).length) return false;
  for (const key of keys) {
    const a = Object.getOwnPropertyDescriptor(left, key)!;
    const b = Object.getOwnPropertyDescriptor(right, key);
    if (
      !b ||
      a.enumerable !== b.enumerable ||
      !('value' in a) ||
      !('value' in b) ||
      !sameProjection(a.value, b.value)
    )
      return false;
  }
  return true;
}

/** Private local-view boundary: EditorState has already applied its transactions.
 * Wire/shared updates still use the engine codec and its complete replay checks.
 * Own the projection before exposing it, since engine attrs can hold mutable data.
 */
export function localDocumentCommand(
  base: DocumentContent,
  doc: PMNode,
  context: LocalCommandContext,
) {
  doc.check();
  const basis = isDeepFrozen(base) ? base : deepFreeze(clone(base));
  const projected = nodeToContent(doc, basis);
  const previous = new Map(basis.blocks.map((block) => [block.id, block]));
  const content: DocumentContent = deepFreeze({
    ...basis,
    schemaVersion: 2,
    blocks: projected.blocks.map((block) => {
      const before = previous.get(block.id);
      return before && sameProjection(before, block) ? before : clone(block);
    }),
  });
  let fingerprint: string | undefined;
  const command = immutableCommand<DocumentContent>(
    'document.engine',
    'Edit document',
    (current) => {
      if (current !== basis && canonicalJson(current) !== (fingerprint ??= canonicalJson(basis)))
        throw new Error('Document draft changed before the engine update was committed');
      return content;
    },
    context,
  );
  return { command, content };
}
