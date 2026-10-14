import { expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import {
  Authority,
  initial,
  localAdapter,
  type DomainCodec,
  type Principal,
} from '@editor-platform/collaboration-core';
import { canvasTextSchema } from '@editor-platform/canvas-ui/text-engine';
import { createDeck, makeSlideObject, type SlideContent } from '@editor-platform/slide/model';
import { createDesign, makeDesignElement, type DesignContent } from '@editor-platform/design/model';
import {
  createWhiteboard,
  makeWhiteboardNode,
  type WhiteboardContent,
} from '@editor-platform/whiteboard/model';
import { slideEditorCodec, designEditorCodec, whiteboardEditorCodec } from './editor-transactions';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
type Canvas = SlideContent | DesignContent | WhiteboardContent;
const base = { bold: true, italic: true, underline: true, strike: true, fontSize: 28 };
const item = (content: Canvas) =>
  'slides' in content
    ? content.slides[0].objects[0]
    : 'nodes' in content
      ? content.nodes[0]
      : content.elements[0];
const fixtures = [
  {
    domain: 'slide',
    codec: slideEditorCodec,
    content: () => {
      const d = createDeck();
      d.slides[0].objects = [
        { ...makeSlideObject('text', 0), id: 'text', text: 'Hello', typography: base },
      ];
      return d;
    },
  },
  {
    domain: 'design',
    codec: designEditorCodec,
    content: () => ({
      ...createDesign(),
      elements: [{ ...makeDesignElement('text'), id: 'text', text: 'Hello', typography: base }],
    }),
  },
  {
    domain: 'whiteboard',
    codec: whiteboardEditorCodec,
    content: () => ({
      ...createWhiteboard(),
      nodes: [{ ...makeWhiteboardNode('text'), id: 'text', text: 'Hello', typography: base }],
    }),
  },
];
const actor = (id: string): Principal => ({
  actorId: id,
  clientId: id,
  sessionId: id,
  writable: true,
  scopes: ['*'],
});
it.each(
  fixtures.flatMap((fixture) =>
    (['bold', 'italic', 'underline', 'strike'] as const).map((mark) => ({ ...fixture, mark })),
  ),
)(
  '$domain shared inherited $mark removal survives peers, projection, checkpoint and selective Undo',
  async ({ codec: originalCodec, content, mark }) => {
    const codec = originalCodec as DomainCodec<Canvas>,
      source = content();
    const authority = new Authority(codec, initial('canvas-inheritance', codec, source));
    const open = async (principal: Principal) => {
      const adapter = Object.assign(localAdapter(authority, principal), {
        versions: async () => [],
        undo: async (id: string, redo?: boolean) => authority.undo(principal, id, redo),
      }) as unknown as EditorHostAdapter<Canvas>;
      const session = new SharedEditorSession(codec, adapter);
      await session.open();
      return session;
    };
    const a = await open(actor('A')),
      b = await open(actor('B'));
    try {
      const x = a.text('text'),
        y = b.text('text');
      expect(x.state.doc.rangeHasMark(1, 6, canvasTextSchema.marks[mark])).toBe(true);
      x.dispatch(x.state.tr.setSelection(TextSelection.create(x.state.doc, 2, 4)));
      toggleMark(canvasTextSchema.marks[mark])(x.state, (transaction) => x.dispatch(transaction));
      const expected = [{ text: 'H' }, { text: 'el', style: { [mark]: false } }, { text: 'lo' }];
      expect(item(a.viewContent).runs).toEqual(expected);
      expect(item(a.confirmed.content).runs).toBeUndefined();
      await a.flush();
      await b.sync();
      expect(item(authority.snapshot().content).runs).toEqual(expected);
      expect(y.state.doc.rangeHasMark(2, 4, canvasTextSchema.marks[mark])).toBe(false);
      expect(y.state.doc.rangeHasMark(1, 2, canvasTextSchema.marks[mark])).toBe(true);
      y.dispatch(y.state.tr.insertText('!', 6));
      await b.flush();
      await a.sync();
      await a.history('undo');
      await b.sync();
      expect(item(b.content).text).toBe('Hello!');
      expect(y.state.doc.rangeHasMark(1, 6, canvasTextSchema.marks[mark])).toBe(true);
      await a.history('redo');
      await b.sync();
      expect(item(b.content).runs?.find((run) => run.text === 'el')?.style?.[mark]).toBe(false);
      expect(item(b.content).typography).toEqual(base);
      const reopened = new SharedEditorSession(codec, b.adapter);
      reopened.resume(b.checkpoint());
      await reopened.open();
      expect(reopened.text('text').state.doc).toEqual(y.state.doc);
      reopened.close();
    } finally {
      a.close();
      b.close();
    }
  },
);
