import { expect, it } from 'vitest';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import {
  createDesign,
  makeDesignElement,
  updateElement,
  makeDesignVector,
  createComponent,
} from '@editor-platform/design/model';
import { checkVector } from '../../../tests/fixtures/design-reuse/content';
import { designEditorCodec, prepareEditorCommand } from './editor-transactions';

it('serializes vector geometry, rejects malformed/readonly changes and selectively undoes without losing peer colors', () => {
  const A: Principal = {
    actorId: 'A',
    clientId: 'A',
    sessionId: 'A',
    writable: true,
    scopes: ['*'],
  };
  const B = { ...A, actorId: 'B', clientId: 'B', sessionId: 'B' };
  const content = { ...createDesign(), elements: [{ ...makeDesignElement('shape'), id: 'icon' }] };
  const authority = new Authority(designEditorCodec, initial('vector', designEditorCodec, content));
  const vector = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    A,
    updateElement('icon', { vector: makeDesignVector(checkVector).vector }),
  )!;
  expect(authority.commit({ ...A, writable: false }, vector).status).toBe('rejected');
  expect(authority.snapshot().content).toEqual(content);
  expect(authority.commit(A, vector).status).toBe('accepted');
  const fill = prepareEditorCommand(
    designEditorCodec,
    authority.snapshot(),
    B,
    updateElement('icon', { stroke: '#abcdef', fill: 'none' }),
  )!;
  expect(authority.commit(B, fill).status).toBe('accepted');
  const undone = authority.undo(A, vector.operationId);
  expect(undone.status).toBe('accepted');
  expect(authority.snapshot().content.elements[0]).toMatchObject({
    stroke: '#abcdef',
    fill: 'none',
  });
  expect(authority.snapshot().content.elements[0].vector).toBeUndefined();
  expect(authority.undo(A, undone.operationId, true).status).toBe('accepted');
  expect(authority.snapshot().content.elements[0].vector).toEqual(checkVector);
  const before = authority.snapshot();
  expect(() =>
    prepareEditorCommand(
      designEditorCodec,
      before,
      A,
      updateElement('icon', { vector: { ...checkVector, paths: ['<script>'] } }),
    ),
  ).toThrow();
  expect(authority.snapshot()).toEqual(before);
});

it('rejects non-shape vector overrides at trusted preparation without changing authority state', () => {
  const A: Principal = {
    actorId: 'A',
    clientId: 'A',
    sessionId: 'A',
    writable: true,
    scopes: ['*'],
  };
  const label = { ...makeDesignElement('text'), id: 'label' };
  const content = createComponent(label.id).apply({ ...createDesign(), elements: [label] });
  const authority = new Authority(designEditorCodec, initial('vector', designEditorCodec, content));
  const before = authority.snapshot();
  expect(() =>
    prepareEditorCommand(
      designEditorCodec,
      before,
      A,
      updateElement(label.id, { overrides: { root: { vector: checkVector } } }),
    ),
  ).toThrow();
  expect(authority.snapshot()).toEqual(before);
});
