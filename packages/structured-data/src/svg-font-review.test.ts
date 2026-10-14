import { expect, it } from 'vitest';
import { defaultDrawingFontFamily } from '@editor-platform/editor-core';
import { createData, makeRow } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import { chartSvg } from './charts';

it.each(['bar', 'line', 'pie'] as const)(
  'uses the common SVG fallback for a Japanese %s chart without changing source data',
  (type) => {
    const data = createData();
    data.rows = [makeRow(data)];
    data.rows[0].values[data.columns[0].id] = '日本語 <&>';
    const config = { ...defaultView(data).chart, type, x: data.columns[0].id };
    const before = JSON.stringify(data);
    const svg = chartSvg(data, data.rows, config);
    expect(svg).toContain(`<g font-family="${defaultDrawingFontFamily}"`);
    expect(svg).toContain('日本語 &lt;&amp;&gt;');
    expect(svg).not.toContain('Arial');
    expect(chartSvg(data, data.rows, config)).toBe(svg);
    expect(JSON.stringify(data)).toBe(before);
  },
);
