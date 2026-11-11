import type { EditorHostAdapter } from '@editor-platform/editor-host';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { documentTextAccess } from '@editor-platform/document/text';
import { isDesignWithPaths, type DesignContent } from '@editor-platform/design/model';

const capabilities = {
  undo: true,
  nativeJson: true,
  formats: [],
  preview: 'none',
  shared: false,
} as const;
export const workspaceDocumentAdapter: EditorHostAdapter<DocumentContent> = {
  kind: 'document',
  validate: isDocument,
  capabilities,
  text: documentTextAccess,
};
export const workspaceComicAdapter: EditorHostAdapter<DesignContent> = {
  kind: 'design',
  validate: isDesignWithPaths,
  capabilities,
};

/** Per-workspace initialization only. Existing dedicated Setting sessions are never replaced. */
export interface CreativeWorkspaceOptions {
  documentAdapter?: EditorHostAdapter<DocumentContent>;
}

export function captureWorkspaceDocumentAdapter(
  adapter: EditorHostAdapter<DocumentContent> = workspaceDocumentAdapter,
): EditorHostAdapter<DocumentContent> {
  const c = adapter.capabilities;
  if (
    adapter.kind !== 'document' ||
    typeof adapter.validate !== 'function' ||
    !c ||
    c.shared !== false ||
    c.undo !== true ||
    c.nativeJson !== true ||
    !['none', 'host-isolated'].includes(c.preview) ||
    !Array.isArray(c.formats) ||
    c.formats.some((f) => typeof f !== 'string') ||
    (c.proposals !== undefined && typeof c.proposals !== 'boolean') ||
    typeof adapter.text?.read !== 'function' ||
    (c.proposals && typeof adapter.changedElements !== 'function')
  )
    throw Error('Workspace Document adapterのkind・capability・text契約が不正です。');
  const validate = adapter.validate;
  return Object.freeze({
    ...adapter,
    validate: (value: unknown): value is DocumentContent => isDocument(value) && validate(value),
    capabilities: Object.freeze({ ...c, formats: Object.freeze([...c.formats]) }),
    text: Object.freeze({ ...adapter.text }),
  });
}
