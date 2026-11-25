import { expect, it } from 'vitest';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import { createDesign, updateElement } from '@editor-platform/design/model';
import { designDivisionCommand } from '@editor-platform/design/division';
import { insertDesignPagePath, insertDesignSpeechBalloon } from '@editor-platform/design/page-artwork';
import { insertDesignPage } from '@editor-platform/design/pagination';
import { designEditorCodec, mangaEditorCodec as codec, prepareEditorCommand } from './index';

const actor = (id: string): Principal => ({
  actorId: id,
  clientId: id,
  sessionId: id,
  scopes: ['*'],
  writable: true,
});
const a = actor('a');
const b = actor('b');

function page() {
  return insertDesignPage({ x: 100, y: 200, width: 600, height: 800 }, 'page').apply(createDesign());
}

const start = designDivisionCommand({
  type: 'startDivision',
  pageId: 'page',
  region: { x: 30, y: 40, width: 540, height: 720 },
  root: { panelId: 'panel' },
});
const split = designDivisionCommand({
  type: 'splitPanel',
  pageId: 'page',
  panelId: 'panel',
  newPanelId: 'new',
  dividerId: 'cut',
  line: { nx: 0, ny: 1, offset: 400 },
  gap: 20,
  retain: 'a',
  insert: 'after',
});

it('uses the existing canvas text engine for artwork inside a native manga panel', () => {
  const balloon = insertDesignSpeechBalloon(
    'panel',
    { x: 180, y: 270, width: 140, height: 100 },
    '最初の台詞',
  );
  const content = balloon.apply(split.apply(start.apply(page())));
  expect(designEditorCodec.validate(content)).toBe(false);
  const state = initial('manga', codec, content);
  const edit = prepareEditorCommand(codec, state, a, updateElement(balloon.textId, { text: '変更後の台詞' }))!;
  expect(edit.actions.map((action) => action.type)).toEqual(['canvas.text-steps']);
  const authority = new Authority(codec, state);
  expect(authority.submit(a, edit).status).toBe('accepted');
  expect(authority.snapshot().content.elements.find((e) => e.id === balloon.textId)?.text).toBe('変更後の台詞');
  const line = insertDesignPagePath('panel', 'line', { x: 165, y: 255, width: 115, height: 17 });
  const draw = prepareEditorCommand(codec, authority.snapshot(), b, line)!;
  expect(authority.submit(b, draw).status).toBe('accepted');
  const artwork = authority.snapshot().content.elements.find((element) => element.id === line.elementId);
  expect(artwork?.parentId).toBe('panel');
  expect(artwork?.path).toBeTruthy();
});

it('commits a linked divider atomically and preserves another author’s dialogue when undoing it', () => {
  const balloon = insertDesignSpeechBalloon(
    'panel',
    { x: 180, y: 270, width: 140, height: 100 },
    '最初の台詞',
  );
  const content = balloon.apply(split.apply(start.apply(page())));
  const initialState = initial('manga', codec, content);
  const authority = new Authority(codec, initialState);
  const move = (offset: number, principal: Principal) => prepareEditorCommand(
    codec, initialState, principal, designDivisionCommand({
      type: 'setDivider', pageId: 'page', dividerId: 'cut', gap: 20,
      line: { nx: 0, ny: 1, offset },
    }),
  )!;
  const first = move(430, a);
  const concurrent = move(460, b);
  const dialogue = prepareEditorCommand(codec, initialState, b,
    updateElement(balloon.textId, { text: '別の人の台詞' }),
  )!;
  expect(authority.submit(a, first).status).toBe('accepted');
  expect(authority.submit(b, concurrent)).toMatchObject({ status: 'rejected', code: 'stale-precondition' });
  expect(authority.submit(b, dialogue).status).toBe('accepted');
  expect(authority.undo(a, first.operationId).status).toBe('accepted');
  const next = authority.snapshot().content;
  expect(next.pagination).toEqual(content.pagination);
  expect(next.elements.find((e) => e.id === 'panel')?.bounds).toEqual(content.elements.find((e) => e.id === 'panel')?.bounds);
  expect(next.elements.find((e) => e.id === balloon.textId)?.text).toBe('別の人の台詞');
});

it('reverts the first division to the original page format', () => {
  const content = page();
  const state = initial('manga', codec, content);
  const authority = new Authority(codec, state);
  const divide = prepareEditorCommand(codec, state, a, start)!;
  expect(authority.submit(a, divide).status).toBe('accepted');
  expect(authority.snapshot().content.schemaVersion).toBe(4);
  expect(authority.undo(a, divide.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(content);
});
