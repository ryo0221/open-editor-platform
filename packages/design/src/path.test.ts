import { expect, it } from 'vitest';
import { drawingSvg } from '@editor-platform/editor-core';
import { isDesign, createDesign } from './model';
import {
  designPathPoint,
  projectDesignPath,
  validDesignPath,
  type DesignEditablePath,
} from './path';
import { designPaintBounds } from './paint-bounds';
const path: DesignEditablePath = {
  frame: { x: 0, y: 0, width: 100, height: 100 },
  fillRule: 'evenodd',
  subpaths: [
    {
      id: 's',
      closed: false,
      anchors: [
        { id: 'a', x: 0, y: 0, mode: 'symmetric' },
        { id: 'b', x: 100, y: 0, mode: 'corner' },
      ],
      segments: [
        {
          id: 'c',
          type: 'cubic',
          from: 'a',
          to: 'b',
          c1: { x: 0, y: 200 },
          c2: { x: 100, y: 200 },
        },
      ],
    },
  ],
};
it('accepts fixed-frame outlying handles without modifying modes/coordinates', () => {
  const before = JSON.stringify(path);
  expect(validDesignPath(path)).toBe(true);
  expect(JSON.stringify(path)).toBe(before);
  expect(isDesign({ ...createDesign(), schemaVersion: 3 })).toBe(false);
});
it('rejects unknown segments, references, duplicate IDs and invalid numbers', () => {
  for (const change of [
    (p: DesignEditablePath) => {
      p.subpaths[0].segments[0].to = 'unknown';
    },
    (p: DesignEditablePath) => {
      p.subpaths[0].anchors[1].id = 'a';
    },
    (p: DesignEditablePath) => {
      p.subpaths[0].anchors[0].x = Infinity;
    },
    (p: DesignEditablePath) => {
      p.subpaths[0].segments = [];
    },
  ]) {
    const bad = structuredClone(path);
    change(bad);
    expect(validDesignPath(bad)).toBe(false);
  }
});
it('maps local/world coordinates reversibly through resize, rotation and both flips', () => {
  for (const rotation of [0, 35, 90, 180])
    for (const flipX of [false, true])
      for (const flipY of [false, true]) {
        const drawing = {
          bounds: { x: 125, y: -30, width: 230, height: 90 },
          rotation,
          flipX,
          flipY,
        };
        for (const point of [
          { x: -200, y: 140 },
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ]) {
          const round = designPathPoint(path, drawing, designPathPoint(path, drawing, point), true);
          expect(round.x).toBeCloseTo(point.x, 10);
          expect(round.y).toBeCloseTo(point.y, 10);
        }
      }
});
it('renders beyond the local frame and includes rotated/flip/stroke extrema in paint/export bounds', () => {
  const drawing = {
    id: 'path',
    kind: 'shape' as const,
    text: '',
    fill: '#f00',
    stroke: '#000',
    strokeWidth: 4,
    dash: '8 4',
    bounds: { x: 10, y: 20, width: 100, height: 100 },
  };
  const projected = { ...drawing, path: projectDesignPath(path, drawing) };
  expect(projected.path.paintBounds).toEqual({ x: 8, y: 18, width: 104, height: 154 });
  const paint = designPaintBounds([projected], drawing.bounds)!;
  expect(paint.y + paint.height).toBe(172);
  const svg = drawingSvg([projected], paint);
  expect(svg).toContain('C10 220 110 220 110 20');
  expect(svg).toContain('fill-rule="evenodd"');
  expect(svg).toContain('stroke-dasharray="8 4"');
  expect(svg).not.toContain('clipPath');
  const rotated = projectDesignPath(path, { ...drawing, rotation: 90, flipY: true });
  expect(rotated.paintBounds.width).toBeCloseTo(154);
  expect(rotated.paintBounds.height).toBeCloseTo(104);
});
it('exposes and refuses unsupported projected ranges consistently before line/cubic rendering', () => {
  for (const type of ['line', 'cubic'] as const) {
    const small = structuredClone(path);
    small.frame.width = 1e-9;
    small.subpaths[0].segments[0] =
      type === 'cubic'
        ? small.subpaths[0].segments[0]
        : { id: 'line', type: 'line', from: 'a', to: 'b' };
    expect(validDesignPath(small)).toBe(true);
    expect(() =>
      projectDesignPath(small, { bounds: { x: 0, y: 0, width: 100, height: 100 } }),
    ).toThrow('Unsupported Design path transform');
  }
});
