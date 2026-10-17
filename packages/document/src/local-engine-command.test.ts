import { expect, it, vi } from 'vitest';
import * as engine from './engine';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { splitBlock } from 'prosemirror-commands';
import { addRowAfter, addColumnAfter } from 'prosemirror-tables';
import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  contentToNode,
  captureDocumentUpdate,
  documentUpdateCommand,
  documentSchema,
  stableIds,
} from './engine';
import { localDocumentCommand } from './local-engine-command';
import type { DocumentContent } from './model';

const context = { origin: 'local' as const, transactionId: 'local-engine-test' };
function fixture(): DocumentContent {
  return {
    schemaVersion: 2,
    page: { size: 'Letter', margin: 32, landscape: true },
    reuse: { schemaVersion: 1, artifactMode: 'dark', closures: [], instances: [] },
    blocks: [
      {
        id: 'body',
        type: 'paragraph',
        text: '日本語の本文',
        rich: [{ text: '日本語', bold: true }, { text: 'の本文' }],
        style: { color: '#f00', fontSize: 16 },
        styleName: 'Body',
        hidden: true,
      },
      {
        id: 'table',
        type: 'table',
        text: '',
        cells: [
          ['氏名', '部署'],
          ['山田', '設計'],
        ],
      },
    ],
  };
}

it('commits applied rich text and split IDs through the existing local Undo/Redo session', () => {
  const base = deepFreeze(fixture());
  let state = EditorState.create({ doc: contentToNode(base), plugins: [stableIds] });
  const batches: Transaction[] = [];
  const apply = (tr: Transaction) => {
    const result = state.applyTransaction(tr);
    state = result.state;
    batches.push(...result.transactions);
  };
  apply(state.tr.insertText('入力', 4).addMark(4, 6, documentSchema.marks.italic.create()));
  apply(state.tr.setSelection(TextSelection.create(state.doc, 6)));
  expect(splitBlock(state, apply)).toBe(true);
  const { command, content } = localDocumentCommand(base, state.doc, context);
  const wire = documentUpdateCommand(base, captureDocumentUpdate(batches), context);
  expect(content).toEqual(wire.apply(base));
  expect(new Set(content.blocks.map((block) => block.id)).size).toBe(3);
  expect(content.blocks[0]).toMatchObject({ id: 'body', styleName: 'Body', hidden: true });
  const session = new EditorSession(base);
  expect(session.executeView(command)).toEqual(content);
  expect(isDeepFrozen(content)).toBe(true);
  expect(session.undo()).toEqual(base);
  expect(session.redo()).toEqual(content);
  expect(content.page).toEqual(base.page);
  expect(content.reuse).toEqual(base.reuse);
});

it('keeps table edits identical to the fully validated wire codec', () => {
  const base: DocumentContent = { ...fixture(), blocks: [fixture().blocks[1]] };
  let state = EditorState.create({ doc: contentToNode(base), plugins: [stableIds] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4)));
  const transactions: Transaction[] = [];
  for (const operation of [addRowAfter, addColumnAfter])
    expect(
      operation(state, (tr) => {
        const result = state.applyTransaction(tr);
        state = result.state;
        transactions.push(...result.transactions);
      }),
    ).toBe(true);
  const local = localDocumentCommand(base, state.doc, context);
  expect(local.content).toEqual(
    documentUpdateCommand(base, captureDocumentUpdate(transactions), context).apply(base),
  );
  expect(local.content.blocks[0].cells).toHaveLength(3);
  expect(local.content.blocks[0].cells![0]).toHaveLength(3);
  expect(contentToNode(local.content).eq(state.doc)).toBe(true);
});

it('owns native data and engine attrs and rejects a changed base even after a previous commit', () => {
  const base = fixture(),
    original = structuredClone(base);
  const state = EditorState.create({ doc: contentToNode(base), plugins: [stableIds] });
  const applied = state.applyTransaction(state.tr.insertText('確定', 1));
  const local = localDocumentCommand(base, applied.state.doc, context);
  const expected = structuredClone(local.content);
  applied.state.doc.firstChild!.attrs.style.color = '#00f';
  base.page!.margin = 99;
  base.blocks[1].cells![0][0] = 'outside';
  expect(local.content).toEqual(expected);
  expect(local.command.apply(original)).toEqual(expected);
  expect(() => local.command.apply(base)).toThrow('draft changed');
  original.blocks[0].text = 'later edit';
  expect(() => local.command.apply(original)).toThrow('draft changed');
  expect(() => local.content.blocks[0].rich!.push({ text: 'outside' })).toThrow();
});

it('rejects an invalid engine document before exposing a native command', () => {
  const emptyDoc = documentSchema.nodes.doc.create();
  expect(() => localDocumentCommand(fixture(), emptyDoc, context)).toThrow();
});

it('retains only unchanged owned blocks while matching the wire projection exactly', () => {
  const first = fixture();
  const initial = EditorState.create({ doc: contentToNode(first), plugins: [stableIds] });
  const normalized = localDocumentCommand(first, initial.doc, context).content;
  const state = EditorState.create({ doc: contentToNode(normalized), plugins: [stableIds] });
  const applied = state.applyTransaction(state.tr.insertText('追加', 1));
  const result = localDocumentCommand(normalized, applied.state.doc, context);
  expect(result.content.blocks[0]).not.toBe(normalized.blocks[0]);
  expect(result.content.blocks[1]).toBe(normalized.blocks[1]);
  expect(result.content).toEqual(
    documentUpdateCommand(normalized, captureDocumentUpdate(applied.transactions), context).apply(
      normalized,
    ),
  );
  const sourceWithSignedZero = deepFreeze({
    ...result.content,
    blocks: result.content.blocks.map((b, index) => (index ? b : { ...b, indent: -0 })),
  });
  const nextState = EditorState.create({
    doc: contentToNode(sourceWithSignedZero),
    plugins: [stableIds],
  });
  const tr = nextState.tr.setNodeMarkup(0, undefined, {
    ...nextState.doc.firstChild!.attrs,
    indent: 0,
  });
  const next = localDocumentCommand(
    sourceWithSignedZero,
    nextState.applyTransaction(tr).state.doc,
    context,
  );
  expect(next.content.blocks[0]).not.toBe(sourceWithSignedZero.blocks[0]);
  expect(Object.is(next.content.blocks[0].indent, 0)).toBe(true);
});

it('local EditorView projection reuses persistent untouched nodes across typing and keeps wire parity', async () => {
  const { createLocalDocumentCommand } = await import('./local-engine-command');
  const prepare = createLocalDocumentCommand();
  let content = deepFreeze(fixture());
  let state = EditorState.create({ doc: contentToNode(content), plugins: [stableIds] });
  content = prepare(content, state.doc, context).content;
  const unchanged = content.blocks[1];
  for (const text of ['a', 'b', 'c']) {
    const applied = state.applyTransaction(state.tr.insertText(text, 1));
    const result = prepare(content, applied.state.doc, context);
    expect(result.content).toEqual(
      documentUpdateCommand(content, captureDocumentUpdate(applied.transactions), context).apply(
        content,
      ),
    );
    expect(result.content.blocks[1]).toBe(unchanged);
    expect(result.command.apply(structuredClone(content))).toBe(result.content);
    state = applied.state;
    content = result.content;
  }
  const external = deepFreeze({
    ...content,
    blocks: content.blocks.map((b, i) =>
      i ? { id: b.id, type: 'table' as const, text: '', cells: [['External']] } : b,
    ),
  });
  const replaced = EditorState.create({ doc: contentToNode(external), plugins: [stableIds] });
  expect(prepare(external, replaced.doc, context).content.blocks[1].cells).toEqual([['External']]);
});

it('projects only the changed top-level engine node after initialization', async () => {
  const { createLocalDocumentCommand } = await import('./local-engine-command');
  const prepare = createLocalDocumentCommand();
  let source = deepFreeze(fixture());
  let state = EditorState.create({ doc: contentToNode(source), plugins: [stableIds] });
  source = prepare(source, state.doc, context).content;
  const project = vi.spyOn(engine, 'nodeToContent');
  try {
    state = state.applyTransaction(state.tr.insertText('x', 1)).state;
    const next = prepare(source, state.doc, context);
    expect(next.content.blocks[0].text).toContain('x');
    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0][0].childCount).toBe(1);
    expect(next.content.blocks[1]).toBe(source.blocks[1]);
  } finally {
    project.mockRestore();
  }
});

it('does not certify an identity shortcut through hidden mutable children or accessors', async () => {
  const { sameDocumentProjection } = await import('./local-engine-command');
  const hidden = { text: 'mutable' };
  const value = Object.defineProperty({ text: 'visible' }, 'hidden', { value: hidden });
  deepFreeze(value);
  expect(sameDocumentProjection(value, value)).toBe(false);
  hidden.text = 'changed';
  expect(sameDocumentProjection(value, value)).toBe(false);
  const getter = deepFreeze({
    get text() {
      return hidden.text;
    },
  });
  expect(sameDocumentProjection(getter, getter)).toBe(false);
  const owned = deepFreeze({ text: 'owned', nested: { text: 'stable' } });
  expect(sameDocumentProjection(owned, owned)).toBe(true);
  expect(sameDocumentProjection(owned, structuredClone(owned))).toBe(true);
});
