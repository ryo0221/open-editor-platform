import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { DrawingView } from './index';
import type { Drawing } from '@editor-platform/editor-core';

it('keeps projected path coordinates in the same world space as bounds and transform origin', () => {
  for (const [x, y] of [
    [60, 70],
    [-110, -80],
  ]) {
    const drawing: Drawing = {
      id: 'path',
      kind: 'shape',
      text: '',
      fill: 'none',
      bounds: { x, y, width: 220, height: 160 },
      rotation: 35,
      flipX: true,
      path: {
        d: `M${x} ${y} C0 0 20 30 40 50`,
        fillRule: 'nonzero',
        paintBounds: { x: -200, y: -200, width: 500, height: 500 },
      },
    };
    const html = renderToStaticMarkup(createElement(DrawingView, { drawing }));
    expect(html).toContain(`d="${drawing.path!.d}"`);
    expect(html).toContain(`translate(${x + 110} ${y + 80}) rotate(35) scale(-1 1)`);
    expect(html).not.toContain(`<g transform="translate(${x} ${y})">`);
  }
});

it('renders structured path dash patterns through the same primitive as SVG/PNG export', () => {
  for (const dash of ['8 4', '2 3']) {
    const drawing: Drawing = {
      id: 'dashed',
      kind: 'shape',
      text: '',
      fill: 'none',
      stroke: '#000',
      dash,
      bounds: { x: 0, y: 0, width: 100, height: 20 },
      path: {
        d: 'M0 10 L100 10',
        fillRule: 'nonzero',
        paintBounds: { x: -1, y: 9, width: 102, height: 2 },
      },
    };
    expect(renderToStaticMarkup(createElement(DrawingView, { drawing }))).toContain(
      `stroke-dasharray="${dash}"`,
    );
  }
});
