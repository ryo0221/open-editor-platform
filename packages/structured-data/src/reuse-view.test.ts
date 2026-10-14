import { it, expect } from 'vitest';
import { createData, makeRow } from './model';
import { defaultView, reconcileDataView } from './views';
import { chartSvg } from './charts';
it('saved Data view adoption changes native chart output while preserving private unsaved query settings', () => {
  const data = createData();
  data.rows = [makeRow(data)];
  const before = defaultView(data),
    incoming = { ...before, accent: '#d92644', projection: 'Chart' as const, search: 'library' };
  const current = { ...before, search: '案件', frozen: 3 };
  const next = reconcileDataView(current, before, incoming);
  expect(next).toMatchObject({ accent: '#d92644', projection: 'Chart', search: '案件', frozen: 3 });
  expect(chartSvg(data, data.rows, next.chart, 900, 430, next.accent)).toContain('fill="#d92644"');
  expect(chartSvg(data, data.rows, next.chart, 900, 430, 'unsafe')).not.toContain('unsafe');
  expect(reconcileDataView(current, before, undefined)).toBe(current);
});
