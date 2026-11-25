import { expect, it } from 'vitest';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import { updateElement } from '@editor-platform/design/model';
import { setDesignInteractions, setDesignPrototype } from '@editor-platform/design';
import { prototypeFixture } from '../../../tests/fixtures/design-prototype/content';
import { designEditorCodec, prepareEditorCommand } from './editor-transactions';
const principal = (id: string, writable = true): Principal => ({
  actorId: id,
  sessionId: id,
  clientId: id,
  writable,
  scopes: ['*'],
});
it('serializes prototype metadata through trusted Design authority and selective Undo', () => {
  const A = principal('A'),
    B = principal('B');
  const authority = new Authority(
    designEditorCodec,
    initial('design', designEditorCodec, {
      ...prototypeFixture(),
      elements: prototypeFixture().elements.map((e) =>
        e.id === 'next/instance' ? { ...e, id: 'next-instance' } : e,
      ),
    }),
  );
  const link = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    A,
    setDesignInteractions('No link', [
      { trigger: 'tap', action: { type: 'navigate', frameId: 'Review' } },
    ]),
  )!;
  expect(authority.commit(A, link).status).toBe('accepted');
  const fill = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    B,
    updateElement('No link', { fill: '#112233' }),
  )!;
  expect(authority.commit(B, fill).status).toBe('accepted');
  expect(authority.undo(A, link.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.elements.find((e) => e.id === 'No link')).toMatchObject({
    fill: '#112233',
  });
  expect(
    authority.snapshot().content.elements.find((e) => e.id === 'No link')!.interactions,
  ).toBeUndefined();
  const before = authority.snapshot();
  const flows = prepareEditorCommand(
    designEditorCodec,
    before,
    A,
    setDesignPrototype({ schemaVersion: 1, startFrameId: 'Review', flows: [] }),
  )!;
  expect(authority.commit(principal('A', false), flows).status).toBe('rejected');
  expect(authority.snapshot().content).toEqual(before.content);
  expect(authority.commit(A, flows).status).toBe('accepted');
  expect(authority.snapshot().content.prototyping!.startFrameId).toBe('Review');
  expect(authority.undo(A, flows.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.prototyping).toEqual(before.content.prototyping);
});
