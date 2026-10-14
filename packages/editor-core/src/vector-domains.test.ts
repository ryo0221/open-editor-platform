import { expect, it } from 'vitest';
import {
  createDeck,
  isDeck,
  makeSlideObject,
  slideDrawing,
  exportSlideSvg,
} from '@editor-platform/slide/model';
import {
  createWhiteboard,
  isWhiteboard,
  insertNode,
  whiteboardDrawing,
  exportWhiteboardSvg,
} from '@editor-platform/whiteboard/model';
import { drawingPrimitives } from '@editor-platform/editor-core';
import { checkVector } from '../../../tests/fixtures/design-reuse/content';

it.each([{}, { viewBox: {}, provenance: {}, paths: null }, checkVector])(
  'keeps undeclared vector payloads out of Slide and Whiteboard projections: %j',
  (vector) => {
    const deck = createDeck();
    deck.slides[0].objects = [makeSlideObject('shape', 0)];
    const originalSlide = exportSlideSvg(deck, deck.slides[0]);
    Object.assign(deck.slides[0].objects[0], { vector });
    expect(isDeck(deck)).toBe(true);
    const drawing = slideDrawing(deck.slides[0].objects[0]);
    expect(drawing.vector).toBeUndefined();
    expect(() => drawingPrimitives(drawing)).not.toThrow();
    expect(exportSlideSvg(deck, deck.slides[0])).toBe(originalSlide);

    const board = insertNode('rectangle').apply(createWhiteboard());
    const originalBoard = exportWhiteboardSvg(board);
    Object.assign(board.nodes[0], { vector });
    expect(isWhiteboard(board)).toBe(true);
    const node = whiteboardDrawing(board.nodes[0]);
    expect(node.vector).toBeUndefined();
    expect(() => drawingPrimitives(node)).not.toThrow();
    expect(exportWhiteboardSvg(board)).toBe(originalBoard);
  },
);
