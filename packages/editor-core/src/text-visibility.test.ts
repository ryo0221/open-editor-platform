import { expect, it } from 'vitest';
import {
  drawingPrimitives,
  drawingSvg,
  layoutDrawingText,
  textPrimitives,
  type Drawing,
  type SvgPrimitive,
} from './index';

const drawing: Drawing = {
  id: 'long-text',
  kind: 'text',
  text: Array.from({ length: 200 }, (_, i) => `Line ${i}: 日本語🙂`).join('\n'),
  bounds: { x: 10, y: 20, width: 280, height: 52 },
  fill: '#253044',
  typography: { fontSize: 24 },
};
const nodes = (input: SvgPrimitive[]): SvgPrimitive[] =>
  input.flatMap((node) => [
    node,
    ...nodes(
      (node.children ?? []).filter((child): child is SvgPrimitive => typeof child !== 'string'),
    ),
  ]);

it.each(['top', 'middle', 'bottom'] as const)(
  'omits clipped lines while retaining exact visible positions, full accessible text and export (%s)',
  (verticalAlign) => {
    const source = { ...drawing, typography: { ...drawing.typography, verticalAlign } };
    const before = structuredClone(source);
    const fullText = nodes(textPrimitives(source)).find((node) => node.tag === 'text')!;
    const screenText = nodes(textPrimitives(source, { visibleTextOnly: true })).find(
      (node) => node.tag === 'text',
    )!;
    const fullLines = fullText.children as SvgPrimitive[];
    const screenLines = screenText.children as SvgPrimitive[];
    expect(fullLines.length).toBe(200);
    expect(screenLines.length).toBeLessThan(15);
    expect(screenLines.length).toBeGreaterThan(1);
    for (const line of screenLines) expect(fullLines).toContainEqual(line);
    expect(screenText.attrs['aria-label']).toBe(source.text);
    expect(drawingSvg([source], source.bounds).includes('Line 199:')).toBe(true);
    expect(source).toEqual(before);
  },
);

it.each(['expand', 'fit'] as const)('uses the complete text for %s layout', (overflow) => {
  const source = { ...drawing, typography: { fontSize: 24, overflow } };
  const text = nodes(textPrimitives(source, { visibleTextOnly: true })).find(
    (node) => node.tag === 'text',
  )!;
  expect(text.attrs['font-size']).toBe(layoutDrawingText(source).fontSize);
  if (overflow === 'expand')
    expect(text.children).toEqual(
      nodes(textPrimitives(source)).find((node) => node.tag === 'text')!.children,
    );
});

it('passes screen clipping to shape text and each table cell, preserving default full primitives', () => {
  for (const source of [
    { ...drawing, kind: 'shape' as const },
    { ...drawing, kind: 'table' as const, table: { rows: [[drawing.text, drawing.text]] } },
  ]) {
    const full = nodes(drawingPrimitives(source, 'stable'));
    const screen = nodes(drawingPrimitives(source, 'stable', { visibleTextOnly: true }));
    expect(screen.filter((node) => node.tag === 'tspan').length).toBeLessThan(60);
    expect(full.filter((node) => node.tag === 'tspan').length).toBeGreaterThan(300);
    expect(drawingSvg([source], source.bounds).includes('Line 199:')).toBe(true);
  }
});
