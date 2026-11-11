import { describe, expect, it } from 'vitest';
import {
  ArtifactEditor,
  prepareHostTextReplacement,
  readHostContent,
  readHostElement,
  readHostElementText,
} from '@editor-platform/editor-host';
import { createArtifact, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { documentHostAdapter } from '@editor-platform/document/native-host';
import type { DocumentContent } from './model';
const content = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    { id: 'body', type: 'paragraph', text: 'first\nsecond' },
    { id: 'title', type: 'heading', level: 1, text: 'keep' },
  ],
});
describe('Document native Host adapter', () => {
  it('uses native text steps with line breaks, stable IDs and one undoable proposal', () => {
    const c = content(),
      editor = new ArtifactEditor(
        createArtifact('document', 'doc', c),
        documentHostAdapter,
        new MemoryStorage<Artifact<DocumentContent>>(),
      );
    const command = prepareHostTextReplacement(documentHostAdapter, editor.content, {
      selector: 'body',
      before: 'first\nsecond',
      after: 'one\ntwo',
    });
    expect(command.type).toBe('document.engine');
    editor.propose({
      id: 'p',
      summary: 'text',
      commands: [command],
      baseLocalRevision: editor.revision,
    });
    editor.acceptProposal('p');
    expect(readHostElementText(documentHostAdapter, editor.content, 'body')).toBe('one\ntwo');
    expect(editor.content.blocks[1]).toEqual(c.blocks[1]);
    editor.undo();
    expect(editor.content).toEqual(c);
    editor.redo();
    expect(readHostElementText(documentHostAdapter, editor.content, 'body')).toBe('one\ntwo');
    editor.close('discard');
  });
  it('rejects missing, ambiguous, nonparagraph and rich targets without flattening content', () => {
    const c = content();
    expect(readHostElement(documentHostAdapter, c, 'missing')).toBeNull();
    for (const id of ['missing', 'title'])
      expect(() => readHostElementText(documentHostAdapter, c, id)).toThrow();
    c.blocks[0].rich = [{ text: 'styled', bold: true }];
    expect(() => readHostElementText(documentHostAdapter, c, 'body')).toThrow('unsupported');
    const duplicate = content();
    duplicate.blocks.push({ ...duplicate.blocks[0] });
    expect(() => readHostElement(documentHostAdapter, duplicate, 'body')).toThrow();
  });
});

it('separates whole content from literal whole IDs and distinguishes target failures', () => {
  const c = content();
  c.blocks[0].id = 'whole';
  expect(readHostElement(documentHostAdapter, c, 'whole')).toEqual(c.blocks[0]);
  expect(readHostElementText(documentHostAdapter, c, 'whole')).toBe('first\nsecond');
  const copy = readHostContent(documentHostAdapter, c);
  copy.blocks[0].text = 'copy';
  expect(c.blocks[0].text).toBe('first\nsecond');
  expect(() => readHostElementText(documentHostAdapter, c, 'missing')).toThrow('missing:');
  expect(() => readHostElementText(documentHostAdapter, c, 'title')).toThrow('unsupported:');
  c.blocks.push({ ...c.blocks[0] });
  expect(() => documentHostAdapter.native!.text!.read(c, 'whole')).toThrow('ambiguous:');
});
it('reports nested list and table paragraph IDs as unsupported rather than absent', () => {
  const c = content();
  c.blocks.push({
    id: 'list',
    type: 'bulleted-list',
    text: '',
    items: [{ id: 'item', paragraphId: 'nested', rich: [{ text: 'list text' }] }],
  });
  c.blocks.push({
    id: 'table',
    type: 'table',
    text: '',
    cells: [['cell']],
    cellParagraphIds: [['cell-id']],
  });
  for (const selector of ['nested', 'item', 'cell-id'])
    expect(() => readHostElement(documentHostAdapter, c, selector)).toThrow('unsupported:');
  expect(readHostElement(documentHostAdapter, c, 'absent')).toBeNull();
});
