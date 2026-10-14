import { defaultDrawingFontFamily, escapeXml } from '@editor-platform/editor-core';
import { displayCell, type StructuredData, type DataRow } from './model';
import { summarize, type ChartConfig } from './views';
const palette = ['#5269c8', '#29a393', '#e4a04b', '#a86db5', '#df6d73', '#6695c5'];
export interface SeriesPoint {
  label: string;
  series: string;
  value: number | null;
}
export function chartPoints(
  data: StructuredData,
  rows: DataRow[],
  config: ChartConfig,
): SeriesPoint[] {
  const x = data.columns.find((c) => c.id === config.x),
    series = data.columns.find((c) => c.id === config.series),
    groups = new Map<string, { label: string; series: string; rows: DataRow[] }>();
  for (const row of rows) {
    const label = x ? displayCell(data, row, x) || '(empty)' : 'All records',
      seriesLabel = series ? displayCell(data, row, series) || '(empty)' : '',
      key = JSON.stringify([label, seriesLabel]),
      group = groups.get(key) ?? { label, series: seriesLabel, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const result = [...groups.values()].map((g) => ({
    label: g.label,
    series: g.series,
    value: summarize(data, g.rows, config.y, config.aggregate),
  }));
  return result.sort((a, b) =>
    config.sort === 'label'
      ? a.label.localeCompare(b.label)
      : ((a.value ?? 0) - (b.value ?? 0)) * (config.sort === 'descending' ? -1 : 1),
  );
}
export function chartSvg(
  data: StructuredData,
  rows: DataRow[],
  config: ChartConfig,
  width = 900,
  height = 430,
  accent?: string,
): string {
  const colors = accent && /^#[a-f0-9]{6}$/i.test(accent) ? [accent, ...palette.slice(1)] : palette;
  const points = chartPoints(data, rows, config),
    series = [...new Set(points.map((p) => p.series))],
    labels = [...new Set(points.map((p) => p.label))],
    e = escapeXml;
  const y = data.columns.find((c) => c.id === config.y),
    title = `${config.aggregate} · ${y?.name ?? 'Records'}`;
  const format = (n: number) =>
    new Intl.NumberFormat(
      undefined,
      config.format === 'currency'
        ? { style: 'currency', currency: y?.currency ?? 'USD', maximumFractionDigits: 1 }
        : config.format === 'percent'
          ? { style: 'percent', maximumFractionDigits: 1 }
          : { maximumFractionDigits: 1 },
    ).format(n);
  let body = `<rect width="${width}" height="${height}" fill="white"/><text x="24" y="30" font-size="16" font-weight="600">${e(title)}</text>`;
  const valid = points.filter((p): p is SeriesPoint & { value: number } => p.value !== null),
    values = valid.map((p) => p.value);
  if (!valid.length)
    body += `<text x="24" y="90" fill="#697386">No numeric data for this configuration</text>`;
  else if (config.type === 'pie') {
    const total = values.reduce((a, b) => a + b, 0);
    if (values.some((v) => v < 0) || total <= 0)
      body += `<text x="24" y="90" fill="#a4343b">Pie charts require nonnegative values and a positive total</text>`;
    else {
      let angle = -Math.PI / 2;
      const radius = Math.min(height * 0.34, width * 0.22),
        cx = width * 0.33,
        cy = height * 0.53;
      valid.forEach((point, i) => {
        const next = angle + (point.value / total) * Math.PI * 2,
          x1 = cx + Math.cos(angle) * radius,
          y1 = cy + Math.sin(angle) * radius,
          x2 = cx + Math.cos(next) * radius,
          y2 = cy + Math.sin(next) * radius;
        body +=
          point.value === total
            ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${colors[i % colors.length]}"/>`
            : `<path d="M${cx} ${cy}L${x1} ${y1}A${radius} ${radius} 0 ${next - angle > Math.PI ? 1 : 0} 1 ${x2} ${y2}Z" fill="${colors[i % colors.length]}"><title>${e(point.label)} / ${e(point.series || 'no series')}: ${e(format(point.value))}</title></path>`;
        if (config.legend || config.labels)
          body += `<rect x="${width * 0.63}" y="${60 + i * 24}" width="12" height="12" fill="${colors[i % colors.length]}"/><text x="${width * 0.63 + 20}" y="${71 + i * 24}" font-size="12">${e((point.label + (point.series ? ' / ' + point.series : '')).slice(0, 25))}${config.labels ? ': ' + e(format(point.value)) : ''}</text>`;
        angle = next;
      });
    }
  } else {
    const left = 90,
      right = 24,
      top = 65,
      bottom = 85,
      plotW = width - left - right,
      plotH = height - top - bottom,
      min = Math.min(0, ...values),
      max = Math.max(0, ...values),
      range = max - min || 1,
      yy = (v: number) => top + ((max - v) / range) * plotH,
      slot = plotW / Math.max(1, labels.length),
      xx = (i: number) => left + slot * (i + 0.5);
    for (let i = 0; i <= 4; i++) {
      const value = min + (range * i) / 4,
        y = yy(value);
      body += `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#e0e5ed"/><text x="${left - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#697386">${e(format(value))}</text>`;
    }
    series.forEach((name, si) => {
      const entries = labels.map((label) =>
        points.find((p) => p.label === label && p.series === name),
      );
      if (config.type === 'line') {
        let path = '',
          continuing = false;
        entries.forEach((p, i) => {
          if (p?.value === null || p?.value === undefined) {
            continuing = false;
            return;
          }
          path += `${continuing ? 'L' : 'M'}${xx(i)} ${yy(p.value)} `;
          continuing = true;
        });
        body += `<path d="${path}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="2.5"/>`;
      }
      entries.forEach((p, i) => {
        if (p?.value === null || p?.value === undefined) return;
        const color = colors[si % colors.length],
          bw = Math.max(2, Math.min(48, (slot * 0.8) / series.length)),
          x = xx(i) - (series.length * bw) / 2 + si * bw,
          cy = yy(p.value);
        body +=
          config.type === 'bar'
            ? `<rect x="${x}" y="${Math.min(cy, yy(0))}" width="${bw - 1}" height="${Math.max(1, Math.abs(cy - yy(0)))}" rx="2" fill="${color}"><title>${e(p.label)} / ${e(p.series || 'no series')}: ${e(format(p.value))}</title></rect>`
            : `<circle cx="${xx(i)}" cy="${cy}" r="3.5" fill="${color}"><title>${e(p.label)} / ${e(p.series || 'no series')}: ${e(format(p.value))}</title></circle>`;
        if (config.labels)
          body += `<text x="${config.type === 'bar' ? x + bw / 2 : xx(i)}" y="${cy + (p.value < 0 ? 16 : -7)}" text-anchor="middle" font-size="10" fill="${color}">${e(format(p.value))}</text>`;
      });
    });
    labels.forEach((label, i) => {
      if (labels.length > 20 && i % Math.ceil(labels.length / 20)) return;
      body += `<text x="${xx(i)}" y="${height - bottom + 22}" text-anchor="middle" font-size="11" fill="#697386">${e(label.slice(0, 12))}<title>${e(label)}</title></text>`;
    });
    if (config.legend)
      series.forEach((name, i) => {
        const x = left + i * 180;
        body += `<rect x="${x}" y="${height - 24}" width="10" height="10" fill="${colors[i % colors.length]}"/><text x="${x + 16}" y="${height - 14}" font-size="11">${e(name || y?.name || 'Records')}</text>`;
      });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Data chart: ${e(config.aggregate)} · ${rows.length} records · category ${e(data.columns.find((column) => column.id === config.x)?.name ?? 'All records')} · value ${e(y?.name ?? 'Records')} · series ${e(data.columns.find((column) => column.id === config.series)?.name ?? 'none')} · ${e(points.map((point) => `${point.label} / ${point.series || 'no series'}: ${point.value ?? 'no value'}`).join('; '))} · sum of displayed aggregates ${points.reduce((sum, point) => sum + (point.value ?? 0), 0)}"><g font-family="${defaultDrawingFontFamily}" fill="#253044">${body}</g></svg>`;
}
