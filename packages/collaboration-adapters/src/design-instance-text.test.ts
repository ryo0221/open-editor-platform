import { expect, it } from 'vitest';
import { command } from '@editor-platform/editor-core';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import { overrideInstance, patchDesign, updateComponentPart } from '@editor-platform/design/model';
import { nestedTextFixture } from '../../../tests/fixtures/design-nested-text/content';
import { designEditorCodec, prepareEditorCommand } from './editor-transactions';

const A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] };
const B: Principal = { ...A, actorId: 'B', clientId: 'B', sessionId: 'B' };

it('rejects a stale legacy override after a primitive definition becomes composite', () => {
  const content = nestedTextFixture();
  const parts = content.components[0].elements!;
  delete content.components[0].elements;
  content.elements[0].overrides = { section: { overrides: { root: { text: 'Scoped title' } } } };
  const authority = new Authority(designEditorCodec, initial('legacy', designEditorCodec, content));
  const edit = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    A,
    overrideInstance('card', 'section', { text: 'Stale Inspector' }),
  )!;
  const peer = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    B,
    command('host.definition', 'Replace definition', (d) => ({
      ...d,
      components: d.components.map((c) => (c.id === 'inner' ? { ...c, elements: parts } : c)),
    })),
  )!;
  expect(authority.commit(B, peer).status).toBe('accepted');
  const before = authority.snapshot();
  expect(authority.commit(A, JSON.parse(JSON.stringify(edit))).status).toBe('rejected');
  expect(authority.snapshot()).toEqual(before);
});
it('uses normal authority and selective history for nested text while retaining peer changes', () => {
  const content = nestedTextFixture();
  const authority = new Authority(designEditorCodec, initial('nested', designEditorCodec, content));
  const text = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    A,
    overrideInstance('card', ['section', 'title'], { text: 'A title' }),
  )!;
  expect(authority.commit({ ...A, writable: false }, text).status).toBe('rejected');
  expect(authority.snapshot().content).toEqual(content);
  expect(authority.commit(A, text).status).toBe('accepted');
  const peer = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    B,
    overrideInstance('other', ['section', 'title'], { text: 'B title' }),
  )!;
  expect(authority.commit(B, peer).status).toBe('accepted');
  const undo = authority.undo(A, text.operationId);
  expect(undo.status).toBe('accepted');
  expect(authority.snapshot().content.elements[0].overrides).toEqual({});
  expect(authority.snapshot().content.elements[1].overrides?.section.overrides?.title.text).toBe(
    'B title',
  );
  expect(authority.undo(A, undo.operationId, true).status).toBe('accepted');
  expect(authority.snapshot().content.elements[0].overrides?.section.overrides?.title.text).toBe(
    'A title',
  );
});

it.each(['definition', 'override', 'lock'])(
  'rejects a stale nested edit after a peer changes its %s',
  (change) => {
    const content = nestedTextFixture();
    const authority = new Authority(
      designEditorCodec,
      initial('nested', designEditorCodec, content),
    );
    const edit = prepareEditorCommand(
      designEditorCodec,
      authority.snapshot(),
      A,
      overrideInstance('card', ['section', 'title'], { text: 'Stale' }),
    )!;
    const peerCommand =
      change === 'definition'
        ? updateComponentPart('inner', 'title', { text: 'New definition' })
        : change === 'override'
          ? overrideInstance('card', ['section', 'body'], { text: 'Peer body' })
          : patchDesign(['card'], { locked: true });
    const peer = prepareEditorCommand(designEditorCodec, authority.snapshot(), B, peerCommand)!;
    expect(authority.commit(B, peer).status).toBe('accepted');
    const before = authority.snapshot();
    expect(authority.commit(A, edit).status).toBe('rejected');
    expect(authority.snapshot()).toEqual(before);
  },
);
