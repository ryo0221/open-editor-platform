import { Transform } from 'prosemirror-transform';
import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { contentToNode } from '@editor-platform/document/engine';
import { copy, fail, type DomainCodec } from '@editor-platform/collaboration-core';
import type { DocumentContent } from '@editor-platform/document/model';
import { documentCodec } from './document';
import { editorAssetCodec } from './editor-assets';
import { withNativeReuse } from './reuse';
/** Conditional immutable-version restore uses engine steps, preserving the shared history. */
const codec: DomainCodec<DocumentContent> = {
  ...documentCodec,
  resource: (content, key) =>
    key === 'page' ? content.page : documentCodec.resource(content, key),
  resources: (content, keys) => {
    const native = documentCodec.resources!(content, keys);
    return keys.map((key, index) => (key === 'page' ? content.page : native[index]));
  },
  apply(content, action, version) {
    if (action.type === 'document.page') {
      const previous = content.page ?? null;
      if (action.payload.value === null) delete content.page;
      else content.page = copy(action.payload.value as DocumentContent['page']);
      if (!documentCodec.validate(content))
        fail('invalid-operation', 'Invalid Document page settings');
      return {
        content,
        required: ['page'],
        touched: ['page'],
        targets: ['*'],
        inverse: [{ type: action.type, target: '*', payload: { value: previous } }],
      };
    }
    if (action.type !== 'domain.restore') return documentCodec.apply(content, action, version);
    if (!documentCodec.validate(action.payload.content))
      fail('invalid-operation', 'Invalid Document version');
    const tr = new Transform(contentToNode(content)).replaceWith(
      0,
      contentToNode(content).content.size,
      contentToNode(action.payload.content).content,
    );
    const effect = documentCodec.apply(
      content,
      {
        type: 'document.steps',
        target: 'text',
        payload: { version, steps: tr.steps.map((s) => s.toJSON()) },
      },
      version,
    );
    const restored = action.payload.content as DocumentContent;
    if (restored.page) effect.content.page = copy(restored.page);
    else delete effect.content.page;
    effect.inverse.push({
      type: 'document.page',
      target: '*',
      payload: { value: content.page ?? null },
    });
    return { ...effect, required: ['*'], touched: [...effect.touched, 'page', '*'] };
  },
  mapAnchor(anchor, before, action) {
    if (action.type !== 'domain.restore')
      return documentCodec.mapAnchor?.(anchor, before, action) ?? anchor;
    // A restored version is a new reviewed text state, not continuity evidence for an old range.
    return { ...anchor, orphan: true };
  },
  rebaseInverse(event, later, current) {
    if (later.some((e) => e.operation.actions.some((a) => a.type === 'domain.restore')))
      fail('undo-conflict', 'A later restored version owns this text');
    return documentCodec.rebaseInverse!(event, later, current);
  },
};
// Page settings write only the root; text/attribute transforms return a new
// native projection. Restore also owns its new root and copied page settings.
codec.applyReadonly = (content, action, version, textVersions) => {
  const effect = codec.apply({ ...content }, action, version, textVersions);
  // The outer asset adapter owns decoded action data. Retain checked block/engine
  // structure across metadata updates only when every borrowed source branch is
  // already immutable; a shallow-frozen Host root is not sufficient.
  if (Object.values(content).every(isDeepFrozen)) deepFreeze(effect.content);
  return effect;
};
export const documentEditorCodec = editorAssetCodec(withNativeReuse(codec));
