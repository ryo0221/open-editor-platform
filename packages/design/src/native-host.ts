import {
  hostTextOperations,
  HOST_TEXT_REPLACEMENT,
  NativeTargetError,
} from '@editor-platform/editor-host';
import type { EditorHostAdapter } from '@editor-platform/editor-host';
import { isDesignWithPaths, updateElement, type DesignContent } from './model';

function plainText(content: DesignContent, selector: string) {
  const matches = content.elements.filter((element) => element.id === selector);
  if (!matches.length) throw new NativeTargetError('missing', 'Design element');
  if (matches.length > 1) throw new NativeTargetError('ambiguous', 'Design element');
  if (matches[0].type !== 'text' || matches[0].runs || typeof matches[0].text !== 'string')
    throw new NativeTargetError('unsupported', 'Plain text replacement');
  return matches[0].text;
}

export const designHostAdapter: EditorHostAdapter<DesignContent> = {
  kind: 'design',
  validate: isDesignWithPaths,
  capabilities: {
    proposals: true,
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
  },
  native: {
    read(content, selector) {
      const matches = content.elements.filter((element) => element.id === selector);
      if (matches.length > 1) throw new NativeTargetError('ambiguous', 'Design element');
      return matches[0] ?? null;
    },
    text: {
      read: plainText,
      replace(content, change) {
        if (plainText(content, change.selector) !== change.before)
          throw new Error('The text element changed');
        return updateElement(change.selector, { text: change.after });
      },
    },
  },
};

/** Pagination is a domain constraint, not a Host editor-name convention. */
export const designPagesHostAdapter: EditorHostAdapter<DesignContent> = {
  ...designHostAdapter,
  validate: (value: unknown): value is DesignContent =>
    isDesignWithPaths(value) && (value.pagination?.pages.length ?? 0) > 0,
};

export const designOperationDeclarations = [HOST_TEXT_REPLACEMENT] as const;
export const designOperations = hostTextOperations(designHostAdapter);
export const designPagesOperations = hostTextOperations(designPagesHostAdapter);
