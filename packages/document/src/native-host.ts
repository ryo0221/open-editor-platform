import {
  hostTextOperations,
  HOST_TEXT_REPLACEMENT,
  NativeTargetError,
} from '@editor-platform/editor-host';
import type { EditorHostAdapter } from '@editor-platform/editor-host';
import { isDocument, documentTextBlocks, type DocumentContent } from './model';
import { documentTextAccess, documentTextEditCommand } from './text-access';

function blocksAt(content: DocumentContent, selector: string) {
  const matches = content.blocks.filter((block) => block.id === selector);
  if (matches.length > 1) throw new NativeTargetError('ambiguous', 'Document element');
  if (!matches.length && documentTextBlocks(content).has(selector))
    throw new NativeTargetError('unsupported', 'Nested Document target');
  return matches;
}
function plainParagraph(content: DocumentContent, selector: string) {
  const matches = blocksAt(content, selector);
  if (!matches.length) throw new NativeTargetError('missing', 'Document element');
  if (matches[0].type !== 'paragraph' || matches[0].rich || typeof matches[0].text !== 'string')
    throw new NativeTargetError('unsupported', 'Plain paragraph replacement');
  return matches[0].text;
}

/** Pure native adapter; pending text inputs, authorization and storage belong to the Host. */
export const documentHostAdapter: EditorHostAdapter<DocumentContent> = {
  kind: 'document',
  validate: isDocument,
  capabilities: {
    proposals: true,
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
  },
  text: documentTextAccess,
  native: {
    read(content, selector) {
      const matches = blocksAt(content, selector);
      return matches[0] ?? null;
    },
    text: {
      read: plainParagraph,
      replace(content, change) {
        if (plainParagraph(content, change.selector) !== change.before)
          throw new Error('The paragraph changed');
        return documentTextEditCommand(content, [
          {
            segmentId: change.selector,
            start: 0,
            end: change.before.length,
            expected: change.before,
            text: change.after,
          },
        ]);
      },
    },
  },
};

export const documentOperationDeclarations = [HOST_TEXT_REPLACEMENT] as const;
export const documentOperations = hostTextOperations(documentHostAdapter);
