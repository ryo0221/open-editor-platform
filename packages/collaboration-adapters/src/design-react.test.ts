import { it, expect } from 'vitest';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import { designEditorCodec, prepareEditorCommand } from './editor-transactions';
import { designReactFixture } from '../../design-react-core/src/fixture';
import {
  editDesignReact,
  convertDesignToReact,
  reviewDesignReactDocumentRegeneration,
  applyDesignReactDocumentRegeneration,
} from '@editor-platform/design-react-core';
import { reactUiEditorCodec } from './react-ui';
import { updateElement } from '@editor-platform/design/model';
const A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] },
  B: Principal = { ...A, actorId: 'B', clientId: 'B', sessionId: 'B' };
it('#29 React props share native authority, selective Undo, geometry and write permission', () => {
  const authority = new Authority(
    designEditorCodec,
    initial('design-react', designEditorCodec, designReactFixture()),
  );
  const prop = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    A,
    editDesignReact('buy', { prop: 'label', value: 'Purchase' }),
  )!;
  expect(authority.commit(A, prop)).toMatchObject({ status: 'accepted' });
  const move = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    B,
    updateElement('buy', { bounds: { x: 40, y: 50, width: 360, height: 80 } }),
  )!;
  expect(authority.commit(B, move)).toMatchObject({ status: 'accepted' });
  expect(authority.undo(A, prop.operationId)).toMatchObject({ status: 'accepted' });
  expect(
    authority.snapshot().content.elements.find((e) => e.id === 'buy')?.react?.props.label,
  ).toBe('Continue');
  expect(authority.snapshot().content.elements.find((e) => e.id === 'buy')?.bounds.x).toBe(40);
  const denied = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    A,
    editDesignReact('buy', { prop: 'label', value: 'Forbidden' }),
  )!;
  expect(authority.commit({ ...A, writable: false }, denied).status).not.toBe('accepted');
});
it('#29 same external metadata field rejects a stale peer write instead of overwriting public input', () => {
  const authority = new Authority(
    designEditorCodec,
    initial('design-react', designEditorCodec, designReactFixture()),
  );
  const a = prepareEditorCommand(
      designEditorCodec,
      authority.snapshot(),
      A,
      editDesignReact('buy', { prop: 'label', value: 'A' }),
    )!,
    b = prepareEditorCommand(
      designEditorCodec,
      authority.snapshot(),
      B,
      editDesignReact('buy', { prop: 'variant', value: 'secondary' }),
    )!;
  expect(authority.commit(A, a)).toMatchObject({ status: 'accepted' });
  expect(authority.commit(B, b).status).not.toBe('accepted');
  expect(
    authority.snapshot().content.elements.find((e) => e.id === 'buy')?.react?.props.label,
  ).toBe('A');
});
it('#29 regeneration uses React UI authority, permission checks and selective Undo', () => {
  const d = designReactFixture(),
    basis = convertDesignToReact(d).document;
  const next = convertDesignToReact(
    updateElement('link', { text: 'Native link update' }).apply(d),
  ).document;
  const plan = reviewDesignReactDocumentRegeneration(basis, basis, next);
  const authority = new Authority(
    reactUiEditorCodec,
    initial('generated-react', reactUiEditorCodec, basis),
  );
  const cmd = applyDesignReactDocumentRegeneration(plan);
  const op = prepareEditorCommand(reactUiEditorCodec, authority.snapshot(), A, cmd)!;
  expect(authority.commit({ ...A, writable: false }, op).status).not.toBe('accepted');
  expect(authority.commit(A, op).status).toBe('accepted');
  expect(authority.snapshot().content.nodes.find((n) => n.id === 'link')?.props.text).toBe(
    'Native link update',
  );
  expect(authority.undo(A, op.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.nodes.find((n) => n.id === 'link')?.props.text).toBe(
    basis.nodes.find((n) => n.id === 'link')?.props.text,
  );
});
it.each(['accept', 'publish', 'svg'] as const)(
  '#30 %s reads survive preparation and reject stale element/component/style/collection edits at authority',
  async (kind) => {
    const { acceptDesignConversion, exportDesignReact, retainDesignPublications } = await import(
      '@editor-platform/design-react-core'
    );
    const { referenceResolution } = await import('../../../apps/react-ui-reference/src/catalog');
    const { command } = await import('@editor-platform/editor-core');
    const { makeDesignElement } = await import('@editor-platform/design/model');
    for (const change of ['element', 'component', 'style', 'insert', 'remove', 'order', 'reuse']) {
      const d = designReactFixture();
      d.styles = [{ id: 'style', name: 'Retained', appearance: { fill: '#123456' } }];
      const authority = new Authority(
        designEditorCodec,
        initial('receipt-' + kind + '-' + change, designEditorCodec, d),
      );
      const cmd =
        kind === 'publish'
          ? retainDesignPublications(convertDesignToReact(d))
          : acceptDesignConversion(
              exportDesignReact(
                d,
                referenceResolution,
                kind === 'svg' ? { mode: 'svg', rootIds: ['heading'] } : {},
              ),
            );
      const prepared = prepareEditorCommand(designEditorCodec, authority.snapshot(), A, cmd)!;
      const peer = command('review.peer', 'Peer edit', (source: typeof d) => {
        if (change === 'element') return updateElement('buy', { text: 'Peer edit' }).apply(source);
        if (change === 'component')
          return {
            ...source,
            components: source.components.map((c) => ({ ...c, name: c.name + ' peer' })),
          };
        if (change === 'style')
          return { ...source, styles: source.styles!.map((s) => ({ ...s, name: 'Peer style' })) };
        if (change === 'insert')
          return {
            ...source,
            elements: [
              ...source.elements,
              { ...makeDesignElement('text'), id: 'peer-insert', web: { tag: 'span' as const } },
            ],
          };
        if (change === 'remove')
          return { ...source, elements: source.elements.filter((e) => e.id !== 'buy') };
        return { ...source, elements: [...source.elements].reverse() };
      });
      const peerOp =
        change === 'reuse'
          ? (await import('@editor-platform/collaboration-core')).operation(
              designEditorCodec,
              authority.snapshot(),
              B,
              [{ type: 'reuse.mode', target: '*', payload: { value: 'peer-mode' } }],
            )
          : prepareEditorCommand(designEditorCodec, authority.snapshot(), B, peer)!;
      expect(authority.commit(B, peerOp).status).toBe('accepted');
      expect(authority.commit(A, JSON.parse(JSON.stringify(prepared))).status, change).not.toBe(
        'accepted',
      );
      expect(authority.snapshot().content.web!.accepted).toBeUndefined();
      expect(authority.snapshot().content.web!.publications).toBeUndefined();
    }
  },
);
