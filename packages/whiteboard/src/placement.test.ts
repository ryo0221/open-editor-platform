import { describe, expect, it } from 'vitest';
import { intersects } from '@editor-platform/editor-core';
import { createWhiteboard, makeWhiteboardNode } from './model';
import { freeBounds } from './placement';

const at = (x: number, y: number) => ({
  ...makeWhiteboardNode('sticky'),
  bounds: { x, y, width: 170, height: 120 },
});

describe('freeBounds', () => {
  it('keeps the wanted bounds on an empty spot', () => {
    const wanted = { x: 500, y: 300, width: 170, height: 120 };
    expect(freeBounds(createWhiteboard(), wanted)).toBe(wanted);
  });
  it('moves the least distance that clears every node', () => {
    const board = { ...createWhiteboard(), nodes: [at(500, 300), at(690, 300), at(500, 440)] };
    const placed = freeBounds(board, { x: 500, y: 300, width: 170, height: 120 });
    for (const n of board.nodes) expect(intersects(n.bounds, placed)).toBe(false);
    // Straight up, the first 24px step past the note's height.
    expect(placed).toMatchObject({ x: 500, y: 300 - 144 });
    expect(placed).toMatchObject({ width: 170, height: 120 });
  });
  it('falls back to the wanted bounds when nothing nearby is free', () => {
    const wall = { ...at(-2000, -2000), bounds: { x: -2000, y: -2000, width: 4000, height: 4000 } };
    const wanted = { x: 0, y: 0, width: 170, height: 120 };
    expect(freeBounds({ ...createWhiteboard(), nodes: [wall] }, wanted)).toBe(wanted);
  });
});
