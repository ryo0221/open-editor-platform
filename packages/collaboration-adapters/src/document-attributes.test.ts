import { expect, it } from 'vitest';
import {
  Authority,
  initial,
  localAdapter,
  operation,
  evaluate,
  type Action,
} from '@editor-platform/collaboration-core';
import {
  contentToNode,
  documentAttributeTransform,
  nodeToContent,
} from '@editor-platform/document/engine';
import { exportHtml, isDocument, type DocumentContent } from '@editor-platform/document/model';
import { documentCodec, DocumentReplica } from './document';
import { person } from './fixtures';
import { EditorState } from 'prosemirror-state';

const content = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    {
      id: 'body',
      type: 'paragraph',
      text: '氏名と部署',
      rich: [{ text: '氏名', bold: true }, { text: 'と部署' }],
    },
  ],
});
const attributes = (values: Record<string, unknown>): Action => ({
  type: 'document.attributes',
  target: 'text',
  payload: { patches: [{ id: 'body', values }] },
});
function setup() {
  const authority = new Authority(documentCodec, initial('doc', documentCodec, content()));
  const change = (who: string, values: Record<string, unknown>) =>
    authority.commit(
      person(who),
      operation(documentCodec, authority.snapshot(), person(who), [attributes(values)]),
    );
  return { authority, change };
}
it('Undo rebases multiple text batches across native attributes without changing the source or anchors', () => {
  const { authority } = setup();
  const actor = person('A');
  authority.commit(
    actor,
    operation(documentCodec, authority.snapshot(), actor, [
      {
        type: 'thread.create',
        target: 'comment',
        payload: { anchor: { type: 'text', from: 1, to: 3 } },
      },
    ]),
  );
  const before = authority.snapshot();
  let basis = before;
  const actions: Action[] = [];
  const append = (action: Action) => {
    actions.push(action);
    basis = evaluate(documentCodec, basis, [action], actor.actorId).state;
  };
  const insert = (text: string) => {
    const tr = EditorState.create({ doc: contentToNode(basis.content) }).tr.insertText(text, 4);
    append({
      type: 'document.steps',
      target: 'text',
      payload: {
        version: basis.engineVersion,
        steps: tr.steps.map((step) => step.toJSON()),
      },
    });
  };
  insert('一');
  append(attributes({ style: { color: '#336699' } }));
  insert('二');
  const applied = authority.commit(actor, operation(documentCodec, before, actor, actions));
  expect(applied.status).toBe('accepted');
  const after = authority.snapshot();
  expect(after.engineVersion).toBe(3);
  const undone = authority.undo(actor, applied.operationId);
  expect(undone.status).toBe('accepted');
  expect(authority.snapshot().engineVersion).toBe(6);
  expect(authority.snapshot().content).toEqual(
    nodeToContent(contentToNode(before.content), before.content),
  );
  expect(authority.snapshot().threads[0].anchor).toMatchObject({ from: 1, to: 3, orphan: false });
  expect(before.content).toEqual(content());
  expect(authority.undo(actor, undone.operationId, true).status).toBe('accepted');
  expect(authority.snapshot().engineVersion).toBe(9);
  expect(authority.snapshot().content).toEqual(after.content);
});
it('named style and visibility retain semantic IDs, rich content, and engine positions', () => {
  const before = content(),
    tr = documentAttributeTransform(before, [
      {
        id: 'body',
        values: {
          style: { color: '#336699', fontSize: 12 },
          styleName: '本文',
          hidden: true,
        },
      },
    ]);
  const after = nodeToContent(tr.doc, before);
  expect(after.blocks[0]).toMatchObject({ ...before.blocks[0], hidden: true, styleName: '本文' });
  expect(tr.mapping.map(3)).toBe(3);
  expect(exportHtml(after)).not.toContain('氏名');
  delete after.blocks[0].hidden;
  expect(exportHtml(after)).toContain('color:#336699');
  expect(exportHtml(after)).toContain('font-size:12pt');
  expect(nodeToContent(contentToNode(after), after)).toEqual(after);
  expect(isDocument({ ...after, blocks: [{ ...after.blocks[0], style: { fontSize: -1 } }] })).toBe(
    false,
  );
  expect(() =>
    documentAttributeTransform(before, [{ id: 'missing', values: { hidden: true } }]),
  ).toThrow();
  expect(() =>
    documentAttributeTransform(before, [{ id: 'body', values: { text: 'replace' } as never }]),
  ).toThrow();
});
it('an explicit regular run overrides inherited bold in native engine and HTML', () => {
  const value = content();
  value.blocks[0].style = { fontWeight: 700 };
  value.blocks[0].rich = [{ text: '太字' }, { text: '通常', bold: false }];
  value.blocks[0].text = '太字通常';
  const after = nodeToContent(contentToNode(value), value);
  expect(after.blocks[0].rich).toEqual(value.blocks[0].rich);
  expect(exportHtml(after)).toContain('font-weight:400');
});
it('style Undo/Redo preserves same-paragraph remote body input and anchors', async () => {
  const { authority, change } = setup();
  const b = new DocumentReplica(localAdapter(authority, person('B')));
  await b.open();
  authority.commit(
    person('A'),
    operation(documentCodec, authority.snapshot(), person('A'), [
      {
        type: 'thread.create',
        target: 'comment',
        payload: { anchor: { type: 'text', from: 1, to: 3 } },
      },
    ]),
  );
  const styled = change('A', { style: { color: '#336699' }, styleName: '本文' });
  expect(styled.status).toBe('accepted');
  b.dispatch(b.state.tr.insertText('日本語', 3));
  await b.sync();
  await b.flush();
  const undo = authority.undo(person('A'), styled.operationId);
  expect(undo.status).toBe('accepted');
  expect(authority.snapshot().content.blocks[0]).toMatchObject({
    id: 'body',
    text: '氏名日本語と部署',
  });
  expect(authority.snapshot().content.blocks[0].style).toBeUndefined();
  expect(authority.snapshot().threads[0].anchor).toMatchObject({ from: 1, to: 3, orphan: false });
  expect(authority.undo(person('A'), undo.operationId, true).status).toBe('accepted');
  await b.sync();
  expect(b.state.doc.child(0).attrs.style).toEqual({ color: '#336699' });
  expect(b.state.doc.textContent).toBe('氏名日本語と部署');
  b.close();
});
it('own attribute inverse pairs permit older Undo, while foreign ABA remains a conflict', () => {
  const { authority, change } = setup();
  const first = change('A', { style: { color: '#336699' } });
  const second = change('A', { style: { color: '#112233' } });
  expect(authority.undo(person('A'), second.operationId).status).toBe('accepted');
  expect(authority.undo(person('A'), first.operationId).status).toBe('accepted');
  const third = change('A', { style: { color: '#336699' } });
  change('B', { style: { color: '#112233' } });
  change('B', { style: { color: '#336699' } });
  expect(authority.undo(person('A'), third.operationId)).toMatchObject({
    status: 'rejected',
    code: 'undo-conflict',
  });
});
it('stale attributes and restricted authority scopes cannot overwrite style', () => {
  const { authority, change } = setup();
  const stale = operation(documentCodec, authority.snapshot(), person('A'), [
    attributes({ hidden: true }),
  ]);
  change('B', { hidden: true });
  change('B', { hidden: false });
  expect(authority.commit(person('A'), stale)).toMatchObject({
    status: 'rejected',
    code: 'stale-precondition',
  });
  const viewer = person('C');
  viewer.scopes = ['another-block'];
  expect(
    authority.commit(
      viewer,
      operation(documentCodec, authority.snapshot(), viewer, [attributes({ hidden: true })]),
    ).status,
  ).toBe('rejected');
});

it('image attribute adoption and selective Undo retain peer image captions, document body and anchors', () => {
  const before = content();
  before.blocks.push({ id: 'image', type: 'image', text: '', src: '', alt: '旧画像', width: 48 });
  const authority = new Authority(documentCodec, initial('doc', documentCodec, before));
  const asset =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const change = (actor: string, values: Record<string, unknown>) =>
    authority.commit(
      person(actor),
      operation(documentCodec, authority.snapshot(), person(actor), [
        {
          type: 'document.attributes',
          target: 'text',
          payload: { patches: [{ id: 'image', values }] },
        },
      ]),
    );
  const adopted = change('A', { src: asset });
  expect(adopted.status).toBe('accepted');
  expect(authority.snapshot().content.blocks[1].src).toBe(asset);
  expect(change('B', { alt: '別の人の代替テキスト', caption: '追記した説明' }).status).toBe(
    'accepted',
  );
  const undone = authority.undo(person('A'), adopted.operationId);
  expect(undone.status).toBe('accepted');
  expect(authority.snapshot().content.blocks[1]).toMatchObject({
    src: '',
    alt: '別の人の代替テキスト',
    caption: '追記した説明',
  });
  expect(authority.snapshot().content.blocks[0]).toEqual(
    nodeToContent(contentToNode(before), before).blocks[0],
  );
  expect(authority.undo(person('A'), undone.operationId, true).status).toBe('accepted');
  expect(authority.snapshot().content.blocks[1].src).toBe(asset);
  expect(() =>
    documentAttributeTransform(before, [{ id: 'body', values: { src: asset } }]),
  ).toThrow();
  expect(() =>
    documentAttributeTransform(before, [{ id: 'image', values: { hidden: true } }]),
  ).toThrow();
  const tr = documentAttributeTransform(before, [{ id: 'image', values: { src: asset } }]);
  expect(tr.mapping.map(3)).toBe(3);
});
