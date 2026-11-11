import { expect, it } from 'vitest';
import { drawingPrimitives, type Drawing, type SvgPrimitive } from './index';

const nodes = (input: SvgPrimitive[]): SvgPrimitive[] =>
  input.flatMap((node) => [
    node,
    ...nodes(
      (node.children ?? []).filter((child): child is SvgPrimitive => typeof child !== 'string'),
    ),
  ]);
const tags = (input: SvgPrimitive[]) => nodes(input).map((node) => node.tag);
const label: Drawing = {
  id: 'label',
  kind: 'shape',
  shape: 'rectangle',
  text: 'Send',
  fill: '#e6edf6',
  bounds: { x: 0, y: 0, width: 120, height: 40 },
  typography: { fontSize: 16 },
};

it('leaves out text under half a screen pixel but keeps the box it sits in (#124)', () => {
  // 16 × 0.02 = 0.32 px: unreadable, so the label text is left out.
  const far = tags(drawingPrimitives(label, 'far', { screenScale: 0.02 }));
  expect(far).toContain('rect');
  expect(far).not.toContain('text');
  // 16 × 0.04 = 0.64 px: kept, and so is every other zoom and every export.
  expect(tags(drawingPrimitives(label, 'near', { screenScale: 0.04 }))).toContain('text');
  expect(tags(drawingPrimitives(label, 'export'))).toContain('text');
  // A larger run keeps the text when only the base font is small.
  const run = { ...label, runs: [{ text: 'Send', style: { fontSize: 40 } }] };
  expect(tags(drawingPrimitives(run, 'run', { screenScale: 0.02 }))).toContain('text');
});

it('leaves out a painted drawing under half a screen pixel both ways, never a hit box (#124)', () => {
  const dot: Drawing = { ...label, text: '', bounds: { x: 0, y: 0, width: 20, height: 20 } };
  // With its stroke allowance the dot paints 26 units: 0.39 px at 0.015, 0.78 px at 0.03.
  expect(drawingPrimitives(dot, 'dot', { screenScale: 0.015 })).toEqual([]);
  expect(drawingPrimitives(dot, 'dot', { screenScale: 0.03 })).not.toEqual([]);
  // A long thin rule stays: it is still visible along its length.
  const rule = { ...dot, bounds: { x: 0, y: 0, width: 400, height: 1 } };
  expect(drawingPrimitives(rule, 'rule', { screenScale: 0.015 })).not.toEqual([]);
  // Transparent, unstroked hit boxes paint nothing and stay for hit testing.
  const hit = { ...dot, fill: 'transparent', stroke: 'none' };
  expect(drawingPrimitives(hit, 'hit', { screenScale: 0.001 })).not.toEqual([]);
  expect(drawingPrimitives(dot, 'export')).not.toEqual([]);
  // Drawings that may paint past their box stay: expanded text and fixed-size arrowheads.
  const expanded: Drawing = {
    id: 'expanded',
    kind: 'text',
    text: 'Big',
    fill: '#253044',
    bounds: { x: 0, y: 0, width: 20, height: 20 },
    typography: { fontSize: 100, overflow: 'expand' },
  };
  expect(drawingPrimitives(expanded, 'expanded', { screenScale: 1 / 64 })).not.toEqual([]);
  const arrow: Drawing = { ...dot, shape: 'arrow', arrowhead: 'end', stroke: '#253044' };
  expect(drawingPrimitives(arrow, 'arrow', { screenScale: 0.015 })).not.toEqual([]);
});
