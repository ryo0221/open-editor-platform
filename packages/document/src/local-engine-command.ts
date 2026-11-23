import { assertReferenceItems, unpackLiveReferences } from '@editor-platform/artifact-references';
import type { Node as PMNode } from 'prosemirror-model';
import { canonicalJson, clone, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { immutableCommand, type LocalCommandContext } from '@editor-platform/editor-core';
import { nodeToContent, projectedSchemaVersion } from './engine';
import {
  packDocumentLiveReferences,
  validDocumentLiveReferences,
  type DocumentBlock,
  type DocumentContent,
} from './model';

// Compare the complete native projection before retaining an old block. Unlike
// a JSON fingerprint this keeps signed zero, holes and property presence distinct.
// Every retained branch must be certified immutable, including hidden children.
const checkedProjectionTrees = new WeakSet<object>();
export function sameDocumentProjection(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return Object.is(left, right);
  if (!isDeepFrozen(left)) return false;
  if (left === right && checkedProjectionTrees.has(left)) return true;
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
      !sameDocumentProjection(a.value, b.value)
    )
      return false;
  }
  checkedProjectionTrees.add(left);
  return true;
}

/** Private local-view boundary: EditorState has already applied its transactions.
 * Wire/shared updates still use the engine codec and its complete replay checks.
 * Own the projection before exposing it, since engine attrs can hold mutable data.
 */
function prepareLocalDocumentCommand(
  base: DocumentContent,
  doc: PMNode,
  context: LocalCommandContext,
  project: typeof nodeToContent,
) {
  doc.check();
  const basis = isDeepFrozen(base) ? base : deepFreeze(clone(base));
  const projected = project(doc, basis);
  assertReferenceItems(projected.blocks);
  if (!validDocumentLiveReferences(projected.blocks, projected.liveSnapshots))
    throw new Error('引用が不正か、件数または容量の上限を超えています。');
  const previous = new Map(basis.blocks.map((block) => [block.id, block]));
  const { liveSnapshots: _previousRows, ...rest } = basis;
  const content: DocumentContent = deepFreeze({
    ...rest,
    ...(projected.liveSnapshots ? { liveSnapshots: projected.liveSnapshots } : {}),
    schemaVersion: projected.schemaVersion,
    blocks: projected.blocks.map((block) => {
      const before = previous.get(block.id);
      return before && sameDocumentProjection(before, block) ? before : clone(block);
    }),
  });
  let fingerprint: string | undefined;
  const command = immutableCommand<DocumentContent>(
    'document.engine',
    'Edit document',
    (current) => {
      if (
        current !== basis &&
        !sameDocumentProjection(basis, current) &&
        canonicalJson(current) !== (fingerprint ??= canonicalJson(basis))
      )
        throw new Error('Document draft changed before the engine update was committed');
      return content;
    },
    context,
  );
  return { command, content };
}

// Public/internal one-shot callers retain defensive ownership of arbitrary engine attrs.
export function localDocumentCommand(
  base: DocumentContent,
  doc: PMNode,
  context: LocalCommandContext,
) {
  return prepareLocalDocumentCommand(base, doc, context, nodeToContent);
}

/** One local EditorView owns this cache. ProseMirror nodes are persistent values:
 * transactions replace changed nodes; Host/shared replacements use fresh nodes.
 * Never share this cache with the mutable-attrs one-shot or wire codec boundary.
 */
export function createLocalDocumentCommand() {
  // Each node's block as the editor holds it: citations with their versions. The document's
  // table (finding 79) is packed again from all blocks, so it always matches the citations.
  const retained = new WeakMap<PMNode, DocumentBlock>();
  return (base: DocumentContent, doc: PMNode, context: LocalCommandContext) =>
    prepareLocalDocumentCommand(base, doc, context, (node, basis) => {
      const working: DocumentBlock[] = [];
      node.forEach((child) => {
        let block = retained.get(child);
        if (!block) {
          const one = nodeToContent(node.type.create(null, [child]), basis);
          block = one.liveSnapshots
            ? unpackLiveReferences(one.blocks[0], one.liveSnapshots)
            : one.blocks[0];
          retained.set(child, block);
        }
        working.push(block);
      });
      const { liveSnapshots: previous, ...rest } = basis;
      const packed = packDocumentLiveReferences(working, previous);
      return {
        ...rest,
        schemaVersion: projectedSchemaVersion(basis, packed.blocks),
        blocks: packed.blocks,
        ...(packed.liveSnapshots ? { liveSnapshots: packed.liveSnapshots } : {}),
      };
    });
}
