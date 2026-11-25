import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { initial, validateSnapshot } from '@editor-platform/collaboration-core';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import { createData, addRow } from '@editor-platform/structured-data/model';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { documentEditorCodec } from './document-editor';
import { createDeck, insertObject, isDeck, type SlideObject } from '@editor-platform/slide/model';
import {
  createWhiteboard,
  insertNode,
  connectNodes,
  isWhiteboard,
} from '@editor-platform/whiteboard/model';
import {
  dataEditorCodec,
  designEditorCodec,
  whiteboardEditorCodec,
  slideEditorCodec,
} from './editor-transactions';

it('rechecks mutable Document blocks, new IDs, page settings and reuse metadata around immutable bodies', () => {
  const content: DocumentContent = {
    schemaVersion: 2,
    blocks: [{ id: 'body', type: 'paragraph', text: '本文', style: { color: '#336699' } }],
  };
  Object.freeze(content.blocks);
  expect(documentEditorCodec.validate(content)).toBe(true);
  content.blocks[0].style!.color = 'invalid';
  expect(isDocument(content)).toBe(false);
  content.blocks[0].style!.color = '#336699';
  deepFreeze(content);
  expect(documentEditorCodec.validate(content)).toBe(true);
  expect(isDocument({ ...content, page: { size: 'A4', margin: -1 } })).toBe(false);
  expect(isDocument({ ...content, reuse: { schemaVersion: 999 } })).toBe(false);
  expect(
    documentEditorCodec.validate({ ...content, blocks: [content.blocks[0], content.blocks[0]] }),
  ).toBe(false);
  expect(
    documentEditorCodec.validate({ ...content, blocks: [{ ...content.blocks[0], id: '' }] }),
  ).toBe(false);
  expect(documentEditorCodec.validate(content)).toBe(true);
});

it('rechecks changed Slide geometry, hierarchy and deck envelopes around retained immutable lists', () => {
  const empty = createDeck();
  const content = insertObject(empty.slides[0].id, 'shape').apply(empty);
  const page = content.slides[0];
  Object.freeze(page.objects);
  expect(isDeck(content)).toBe(true);
  page.objects[0].bounds.width = -1;
  expect(isDeck(content)).toBe(false);
  page.objects[0].bounds.width = 100;
  deepFreeze(content);
  expect(isDeck(content)).toBe(true);
  expect(isDeck({ ...content, width: -1 })).toBe(false);
  expect(isDeck({ ...content, slides: [page, page] })).toBe(false);
  const objects: SlideObject[] = [{ ...page.objects[0], groupId: 'absent' }];
  expect(isDeck({ ...content, slides: [{ ...page, objects }] })).toBe(false);
  delete objects[0].groupId;
  expect(isDeck({ ...content, slides: [{ ...page, objects }] })).toBe(true);
  objects.push(objects[0]);
  expect(isDeck({ ...content, slides: [{ ...page, objects }] })).toBe(false);
  expect(slideEditorCodec.validate({ ...content, slides: [page, { ...page, id: 'second' }] })).toBe(
    false,
  );
  expect(slideEditorCodec.validate(content)).toBe(true);
});

it('indexes Whiteboard endpoint checks without accepting a dangling shared reference with a fallback point', () => {
  let content = insertNode('sticky').apply(insertNode('sticky').apply(createWhiteboard()));
  content = connectNodes(content.nodes[0].id, content.nodes[1].id).apply(content);
  expect(whiteboardEditorCodec.validate(content)).toBe(true);
  const connector = content.connectors[0];
  connector.from = 'missing';
  expect(isWhiteboard(content)).toBe(false);
  connector.fromPoint = { x: 0, y: 0 };
  expect(isWhiteboard(content)).toBe(true); // Native fallback remains a supported drawing.
  expect(whiteboardEditorCodec.validate(content)).toBe(false); // Shared references must resolve.
  connector.from = '';
  expect(whiteboardEditorCodec.validate(content)).toBe(true);
  connector.toPoint = { x: 10, y: 10 };
  content.nodes = [];
  expect(isWhiteboard(content)).toBe(true);
  expect(whiteboardEditorCodec.validate(content)).toBe(false);
  connector.to = '';
  expect(whiteboardEditorCodec.validate(content)).toBe(true);
});

it('revalidates Whiteboard schema and graph relationships around unchanged frozen node bodies', () => {
  const mutable = insertNode('sticky').apply(createWhiteboard());
  Object.freeze(mutable.nodes[0]);
  expect(isWhiteboard(mutable)).toBe(true);
  mutable.nodes[0].bounds.width = -1;
  expect(isWhiteboard(mutable)).toBe(false);
  mutable.nodes[0].bounds.width = 100;
  const owned = deepFreeze(structuredClone(mutable));
  expect(isWhiteboard(owned)).toBe(true);
  const node = owned.nodes[0];
  expect(isWhiteboard({ ...owned, nodes: [node, node] })).toBe(false);
  expect(isWhiteboard({ ...owned, nodes: [{ ...node, groupId: 'missing' }] })).toBe(false);
  expect(isWhiteboard({ ...owned, nodes: [{ ...node, bounds: { ...node.bounds, x: NaN } }] })).toBe(
    false,
  );
  const frame = deepFreeze({ ...node, kind: 'frame' as const });
  expect(isWhiteboard({ ...owned, schemaVersion: 2, nodes: [frame] })).toBe(true);
  expect(isWhiteboard({ ...owned, schemaVersion: 3, nodes: [frame] })).toBe(false);
});

it('does not retain Whiteboard validation for a frozen Host node with a stateful bounds accessor', () => {
  const source = insertNode('sticky').apply(createWhiteboard());
  let width = 100;
  const node = source.nodes[0];
  const bounds = {
    ...node.bounds,
    get width() {
      return width;
    },
  };
  const content = deepFreeze({ ...source, nodes: [{ ...node, bounds }] });
  expect(isWhiteboard(content)).toBe(true);
  width = -1;
  expect(isWhiteboard(content)).toBe(false);
});

it('rechecks mutable nested data and every snapshot envelope around validated frozen content', () => {
  const content = addRow().apply(createData());
  Object.freeze(content);
  expect(dataEditorCodec.validate(content)).toBe(true);
  content.rows[0].values.unknown = 1;
  expect(dataEditorCodec.validate(content)).toBe(false);
  delete content.rows[0].values.unknown;
  deepFreeze(content);
  expect(dataEditorCodec.validate(content)).toBe(true);
  const snapshot = { ...initial('validation', dataEditorCodec, content), content };
  expect(() => validateSnapshot(dataEditorCodec, snapshot)).not.toThrow();
  expect(() =>
    validateSnapshot(dataEditorCodec, { ...snapshot, stamps: { invalid: 10 } }),
  ).toThrow();
  expect(() => validateSnapshot(dataEditorCodec, { ...snapshot, revision: -1 })).toThrow();
  expect(() =>
    validateSnapshot(dataEditorCodec, {
      ...snapshot,
      threads: [
        {
          id: 'missing',
          resolved: false,
          replies: [],
          anchor: { type: 'element', elementId: 'absent' },
        },
      ],
    }),
  ).toThrow();
});

it('validates indexed Design parents, component references, duplicate definitions and frozen replacements', () => {
  const frame = makeDesignElement('frame');
  const child = { ...makeDesignElement('rectangle'), parentId: frame.id };
  const content = { ...createDesign(), elements: [child, frame] };
  expect(designEditorCodec.validate(content)).toBe(true);
  frame.type = 'rectangle';
  expect(designEditorCodec.validate(content)).toBe(false);
  frame.type = 'frame';
  child.parentId = 'absent';
  expect(designEditorCodec.validate(content)).toBe(false);
  child.parentId = frame.id;
  deepFreeze(content);
  expect(designEditorCodec.validate(content)).toBe(true);
  expect(
    designEditorCodec.validate({
      ...content,
      elements: [{ ...child, componentId: 'absent' }, frame],
    }),
  ).toBe(false);
  const component = {
    id: 'definition',
    name: 'Definition',
    template: { type: 'rectangle' as const, text: '', fill: '#fff' },
    width: 100,
    height: 100,
  };
  expect(designEditorCodec.validate({ ...content, components: [component, component] })).toBe(
    false,
  );
  expect(designEditorCodec.validate(content)).toBe(true);
});
