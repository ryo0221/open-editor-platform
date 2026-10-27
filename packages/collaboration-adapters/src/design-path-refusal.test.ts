import { expect, it } from 'vitest';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import { createDesign, insertDesignPath, presetDesignPath } from '@editor-platform/design/model';
import { designEditorCodec, prepareEditorCommand } from './editor-transactions';
import { designCodec } from './canvas';
const actor: Principal = {
  actorId: 'a',
  clientId: 'a',
  sessionId: 'a',
  writable: true,
  scopes: ['*'],
};
it('refuses schema3 at shared connect and introduction into an existing shared session', () => {
  const before = createDesign(),
    insert = insertDesignPath(presetDesignPath('cubic')),
    v3 = insert.apply(before);
  expect(designEditorCodec.validate(v3)).toBe(false);
  expect(designCodec.validate(v3)).toBe(false);
  expect(
    () => new Authority(designEditorCodec, initial('artifact', designEditorCodec, v3)),
  ).toThrow();
  const authority = new Authority(
      designEditorCodec,
      initial('artifact', designEditorCodec, before),
    ),
    snapshot = authority.snapshot();
  expect(() => prepareEditorCommand(designEditorCodec, snapshot, actor, insert)).toThrow();
  expect(authority.snapshot()).toEqual(snapshot);
});
