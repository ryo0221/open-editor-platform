import { expect, it } from 'vitest';
import { slideUnknownFields } from './fields';

const deck = (objects: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  width: 960,
  height: 540,
  slides: [{ id: 's1', title: '表紙', background: '#ffffff', objects, ...extra }],
});
const text = (extra: Record<string, unknown> = {}) => ({
  id: 'o1',
  type: 'text',
  bounds: { x: 0, y: 0, width: 100, height: 40 },
  text: '売上',
  fill: '#000000',
  ...extra,
});

it('finds nothing in a deck that only uses known fields', () => {
  expect(
    slideUnknownFields(
      deck([
        text({ typography: { fontSize: 24 }, runs: [{ text: '売上', style: { bold: true } }] }),
      ]),
    ),
  ).toEqual([]);
});

it('points a text style written on the object to typography', () => {
  expect(slideUnknownFields(deck([text({ fontSize: 40 })]))).toEqual([
    {
      slideId: 's1',
      objectId: 'o1',
      path: 'slides[0].objects[0].fontSize',
      hint: 'typography.fontSize に書く',
    },
  ]);
});

it('reports unknown fields at every level, with hints only for known fields', () => {
  const found = slideUnknownFields({
    ...deck(
      [text({ typography: { size: 20 }, runs: [{ text: 'a', bold: true, style: { weight: 7 } }] })],
      { transitionMs: 300, rotation: 5 },
    ),
    author: 'x',
    notes: 'deck notes',
  });
  expect(found.map((f) => [f.path, f.hint])).toEqual([
    ['author', undefined],
    ['notes', 'slides[] の要素に書く'],
    ['slides[0].transitionMs', undefined],
    ['slides[0].rotation', 'slides[].objects[] の要素に書く'],
    ['slides[0].objects[0].typography.size', undefined],
    ['slides[0].objects[0].runs[0].bold', 'runs[].style.bold に書く'],
    ['slides[0].objects[0].runs[0].style.weight', undefined],
  ]);
});

it('reads malformed input without throwing', () => {
  expect(slideUnknownFields(null)).toEqual([]);
  expect(slideUnknownFields({ slides: [null, { objects: 'x' }] })).toEqual([]);
});
