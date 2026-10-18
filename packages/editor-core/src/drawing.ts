import { escapeXml, type Bounds } from './geometry';
import { layoutTextRuns } from './text';
import { newId } from '@editor-platform/artifact-core';
export const defaultDrawingFontFamily = 'Noto Sans CJK JP, sans-serif';
export const shapeNames = [
  'rectangle',
  'rounded-rectangle',
  'ellipse',
  'triangle',
  'right-triangle',
  'diamond',
  'parallelogram',
  'trapezoid',
  'pentagon',
  'hexagon',
  'octagon',
  'star',
  'arrow-right',
  'arrow-left',
  'arrow-up',
  'arrow-down',
  'arrow-both',
  'chevron',
  'callout',
  'cloud',
  'line',
  'arrow',
  'double-arrow',
  'elbow',
  'curve',
] as const;
export type ShapeKind = (typeof shapeNames)[number];
export interface TextStyle {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  lineHeight?: number;
  letterSpacing?: number;
  align?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  padding?: number;
  list?: boolean;
  overflow?: 'clip' | 'expand' | 'fit';
}
export interface TextRun {
  text: string;
  style?: TextStyle;
}
export interface VisualStyle {
  shape?: ShapeKind;
  stroke?: string;
  strokeWidth?: number;
  dash?: string;
  opacity?: number;
  radius?: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  locked?: boolean;
  hidden?: boolean;
  typography?: TextStyle;
  runs?: TextRun[];
  imageFit?: 'fit' | 'fill';
  crop?: { x: number; y: number; scale: number };
  alt?: string;
  arrowhead?: 'none' | 'end' | 'both';
}
export interface SvgPrimitive {
  tag:
    | 'g'
    | 'path'
    | 'rect'
    | 'ellipse'
    | 'line'
    | 'text'
    | 'tspan'
    | 'image'
    | 'defs'
    | 'clipPath';
  attrs: Record<string, string | number>;
  children?: Array<SvgPrimitive | string>;
}
const p = (
  tag: SvgPrimitive['tag'],
  attrs: SvgPrimitive['attrs'],
  children?: SvgPrimitive['children'],
): SvgPrimitive => ({ tag, attrs, children });
/** Rendering-only projection, created by each domain adapter. Never persisted as domain content. */
export interface Drawing extends VisualStyle {
  id: string;
  kind: 'shape' | 'text' | 'image' | 'group' | 'table' | 'chart' | 'freehand';
  bounds: Bounds;
  clipBounds?: (Bounds & { rotation?: number })[];
  text: string;
  fill: string;
  src?: string;
  /** A domain-owned vector projected to safe geometry, never executable SVG markup. */
  vector?: {
    viewBox: Bounds;
    paths: string[];
    provenance: { source: string; name: string; version: string; license: string };
  };
  points?: Array<{ x: number; y: number }>;
  table?: {
    rows: string[][];
    header?: boolean;
    merges?: { row: number; col: number; rows: number; cols: number }[];
    columnWidths?: number[];
    rowHeights?: number[];
  };
  chart?: {
    labels: string[];
    values: number[];
    type?: 'bar' | 'line' | 'pie';
    label?: string;
    legend?: boolean;
  };
}
export function shapePath(kind: ShapeKind, w: number, h: number): string {
  const polygon = (points: number[][]) =>
    points.map((xy, i) => `${i ? 'L' : 'M'}${xy[0] * w} ${xy[1] * h}`).join(' ') + 'Z';
  switch (kind) {
    case 'triangle':
      return polygon([
        [0.5, 0],
        [1, 1],
        [0, 1],
      ]);
    case 'right-triangle':
      return polygon([
        [0, 0],
        [1, 1],
        [0, 1],
      ]);
    case 'diamond':
      return polygon([
        [0.5, 0],
        [1, 0.5],
        [0.5, 1],
        [0, 0.5],
      ]);
    case 'parallelogram':
      return polygon([
        [0.2, 0],
        [1, 0],
        [0.8, 1],
        [0, 1],
      ]);
    case 'trapezoid':
      return polygon([
        [0.2, 0],
        [0.8, 0],
        [1, 1],
        [0, 1],
      ]);
    case 'pentagon':
    case 'hexagon':
    case 'octagon':
    case 'star': {
      const count = kind === 'pentagon' ? 5 : kind === 'hexagon' ? 6 : kind === 'octagon' ? 8 : 10;
      return polygon(
        Array.from({ length: count }, (_, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / count,
            r = kind === 'star' && i % 2 ? 0.22 : 0.5;
          return [0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r];
        }),
      );
    }
    case 'arrow-right':
      return polygon([
        [0, 0.25],
        [0.6, 0.25],
        [0.6, 0],
        [1, 0.5],
        [0.6, 1],
        [0.6, 0.75],
        [0, 0.75],
      ]);
    case 'arrow-left':
      return polygon([
        [1, 0.25],
        [0.4, 0.25],
        [0.4, 0],
        [0, 0.5],
        [0.4, 1],
        [0.4, 0.75],
        [1, 0.75],
      ]);
    case 'arrow-up':
      return polygon([
        [0.25, 1],
        [0.25, 0.4],
        [0, 0.4],
        [0.5, 0],
        [1, 0.4],
        [0.75, 0.4],
        [0.75, 1],
      ]);
    case 'arrow-down':
      return polygon([
        [0.25, 0],
        [0.25, 0.6],
        [0, 0.6],
        [0.5, 1],
        [1, 0.6],
        [0.75, 0.6],
        [0.75, 0],
      ]);
    case 'arrow-both':
      return polygon([
        [0, 0.5],
        [0.25, 0],
        [0.25, 0.3],
        [0.75, 0.3],
        [0.75, 0],
        [1, 0.5],
        [0.75, 1],
        [0.75, 0.7],
        [0.25, 0.7],
        [0.25, 1],
      ]);
    case 'chevron':
      return polygon([
        [0, 0],
        [0.65, 0],
        [1, 0.5],
        [0.65, 1],
        [0, 1],
        [0.35, 0.5],
      ]);
    case 'callout':
      return polygon([
        [0, 0],
        [1, 0],
        [1, 0.78],
        [0.45, 0.78],
        [0.2, 1],
        [0.2, 0.78],
        [0, 0.78],
      ]);
    case 'cloud':
      return `M ${w * 0.16} ${h * 0.78} C ${-w * 0.08} ${h * 0.78} ${-w * 0.02} ${h * 0.3} ${w * 0.2} ${h * 0.32} C ${w * 0.12} ${-h * 0.08} ${w * 0.65} ${-h * 0.08} ${w * 0.68} ${h * 0.23} C ${w * 1.02} ${h * 0.02} ${w * 1.15} ${h * 0.65} ${w * 0.88} ${h * 0.7} C ${w * 0.9} ${h * 1.08} ${w * 0.43} ${h * 1.02} ${w * 0.41} ${h * 0.82} C ${w * 0.32} ${h * 1.08} ${w * 0.1} ${h * 0.98} ${w * 0.16} ${h * 0.78} Z`;
    case 'line':
    case 'arrow':
    case 'double-arrow':
      return `M0 ${h / 2} H${w}`;
    case 'elbow':
      return `M0 0 H${w / 2} V${h} H${w}`;
    case 'curve':
      return `M0 ${h} C${w / 2} ${h} ${w / 2} 0 ${w} 0`;
    default:
      return `M0 0H${w}V${h}H0Z`;
  }
}
export function shapePrimitives(
  kind: ShapeKind,
  b: Bounds,
  style: VisualStyle,
  fill: string,
): SvgPrimitive[] {
  const attrs = {
    fill,
    stroke: style.stroke ?? '#5b6472',
    'stroke-width': style.strokeWidth ?? 1,
    'stroke-dasharray': style.dash ?? '',
  };
  if (kind === 'ellipse')
    return [
      p('ellipse', {
        cx: b.x + b.width / 2,
        cy: b.y + b.height / 2,
        rx: b.width / 2,
        ry: b.height / 2,
        ...attrs,
      }),
    ];
  if (kind === 'rectangle' || kind === 'rounded-rectangle')
    return [
      p('rect', {
        ...b,
        rx: kind === 'rounded-rectangle' ? (style.radius ?? 16) : (style.radius ?? 0),
        ...attrs,
      }),
    ];
  const line = ['line', 'arrow', 'double-arrow', 'elbow', 'curve'].includes(kind);
  const children = [
    p('path', {
      d: shapePath(kind, b.width, b.height),
      transform: `translate(${b.x} ${b.y})`,
      ...attrs,
      fill: line ? 'none' : fill,
    }),
  ];
  if (
    kind === 'arrow' ||
    kind === 'double-arrow' ||
    style.arrowhead === 'end' ||
    style.arrowhead === 'both'
  ) {
    const y = kind === 'elbow' ? b.y + b.height : kind === 'curve' ? b.y : b.y + b.height / 2;
    children.push(
      p('path', {
        d: `M${b.x + b.width - 10} ${y - 6} L${b.x + b.width} ${y} L${b.x + b.width - 10} ${y + 6}`,
        fill: 'none',
        stroke: attrs.stroke,
        'stroke-width': attrs['stroke-width'],
      }),
    );
  }
  if (kind === 'double-arrow' || style.arrowhead === 'both')
    children.push(
      p('path', {
        d: `M${b.x + 10} ${b.y + b.height / 2 - 6} L${b.x} ${b.y + b.height / 2} L${b.x + 10} ${b.y + b.height / 2 + 6}`,
        fill: 'none',
        stroke: attrs.stroke,
        'stroke-width': attrs['stroke-width'],
      }),
    );
  return children;
}
export function textLines(text: string, width: number, style: TextStyle = {}): string[] {
  const size = style.fontSize ?? 24,
    spacing = style.letterSpacing ?? 0,
    advance = (s: string) =>
      Array.from(s).reduce(
        (sum, char) =>
          sum +
          ((char.codePointAt(0) ?? 0) > 255 ? 1 : /[il.,' ]/.test(char) ? 0.3 : 0.58) * size +
          spacing,
        0,
      );
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '',
      used = 0;
    for (const token of paragraph.match(/[A-Za-z0-9_]+| +|./gu) ?? []) {
      const length = advance(token);
      if (used + length > width && line) {
        lines.push(line.trimEnd());
        line = '';
        used = 0;
        if (!token.trim()) continue;
      }
      if (length > width) {
        for (const char of token) {
          const n = advance(char);
          if (used + n > width && line) {
            lines.push(line);
            line = '';
            used = 0;
          }
          line += char;
          used += n;
        }
      } else {
        line += token;
        used += length;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
/** The same calculated fit, line runs, padding and origins drive SVG and Office plans. */
export function layoutDrawingText(d: Drawing) {
  const s = d.typography ?? {},
    pad = s.padding ?? (d.kind === 'text' ? 4 : 10),
    b = d.bounds;
  let font = s.fontSize ?? (d.kind === 'text' ? 28 : 18);
  const original = font;
  const layout = () =>
    layoutTextRuns(
      d.text,
      d.runs?.map((r) => ({
        ...r,
        style: {
          ...r.style,
          fontSize: Math.max(8, ((r.style?.fontSize ?? original) * font) / original),
        },
      })),
      Math.max(1, b.width - pad * 2 - (s.list ? font : 0)),
      { ...s, fontSize: font },
    );
  let lines = layout();
  if (s.overflow === 'fit')
    while (font > 8 && lines.reduce((n, line) => n + line.height, 0) > b.height - pad * 2) {
      font--;
      lines = layout();
    }
  const total = lines.reduce((n, line) => n + line.height, 0);
  const start =
    b.y +
    pad +
    (s.verticalAlign === 'middle'
      ? (b.height - pad * 2 - total) / 2
      : s.verticalAlign === 'bottom'
        ? b.height - pad * 2 - total
        : 0);
  const x =
    s.align === 'center'
      ? b.x + b.width / 2
      : s.align === 'right'
        ? b.x + b.width - pad
        : b.x + pad;
  return { fontSize: font, padding: pad, lines, totalHeight: total, startY: start, x };
}
export type DrawingTextLayout = ReturnType<typeof layoutDrawingText>;
export interface DrawingRenderOptions {
  /** Screen rendering may omit lines outside the existing clip, retaining font overscan.
   * Native text/layout and the default export primitives always retain the full content. */
  visibleTextOnly?: boolean;
}
export function textPrimitives(d: Drawing, options: DrawingRenderOptions = {}): SvgPrimitive[] {
  const s = d.typography ?? {},
    b = d.bounds;
  const { fontSize: font, lines, startY: start, x } = layoutDrawingText(d);
  const margin = 4 * lines.reduce((size, line) => Math.max(size, line.ascent), font);
  let offset = 0;
  const renderedLines = lines.flatMap((line) => {
    const top = start + offset;
    offset += line.height;
    if (
      options.visibleTextOnly &&
      s.overflow !== 'expand' &&
      (start + offset < b.y - margin || top > b.y + b.height + margin)
    )
      return [];
    return [
      p('tspan', { x, y: top + line.ascent }, [
        ...(s.list ? ['• '] : []),
        ...line.runs.map((run) =>
          p(
            'tspan',
            {
              'font-family': run.style?.fontFamily ?? s.fontFamily ?? defaultDrawingFontFamily,
              'font-size': run.style?.fontSize ?? font,
              'font-weight': run.style?.bold ? '700' : '400',
              'font-style': run.style?.italic ? 'italic' : 'normal',
              'text-decoration':
                [run.style?.underline ? 'underline' : '', run.style?.strike ? 'line-through' : '']
                  .filter(Boolean)
                  .join(' ') || 'none',
              'letter-spacing': run.style?.letterSpacing ?? 0,
              fill: run.style?.color ?? s.color ?? (d.kind === 'text' ? d.fill : '#253044'),
            },
            [run.text],
          ),
        ),
      ]),
    ];
  });
  const text = p(
    'text',
    {
      'font-family': s.fontFamily ?? defaultDrawingFontFamily,
      'font-size': font,
      'font-weight': s.bold ? '700' : '400',
      'font-style': s.italic ? 'italic' : 'normal',
      // Decorations on the parent cannot be removed by a child run's false override.
      'text-decoration': 'none',
      'letter-spacing': s.letterSpacing ?? 0,
      fill: s.color ?? (d.kind === 'text' ? d.fill : '#253044'),
      'text-anchor': s.align === 'center' ? 'middle' : s.align === 'right' ? 'end' : 'start',
      ...(options.visibleTextOnly ? { 'aria-label': d.text } : {}),
    },
    renderedLines,
  );
  return s.overflow === 'expand'
    ? [text]
    : [
        p('defs', {}, [p('clipPath', { id: `text-${d.id}` }, [p('rect', { ...b })])]),
        p('g', { 'clip-path': `url(#text-${d.id})` }, [text]),
      ];
}
export function chartPrimitives(d: Drawing): SvgPrimitive[] {
  const chart = d.chart;
  if (!chart) return [];
  if (chart.label) {
    const titleHeight = Math.min(28, d.bounds.height * 0.2);
    return [
      p(
        'text',
        {
          x: d.bounds.x + 12,
          y: d.bounds.y + titleHeight * 0.75,
          'font-size': Math.min(16, titleHeight * 0.65),
          fill: '#242a32',
        },
        [chart.label],
      ),
      ...chartPrimitives({
        ...d,
        chart: { ...chart, label: undefined },
        bounds: { ...d.bounds, y: d.bounds.y + titleHeight, height: d.bounds.height - titleHeight },
      }),
    ];
  }
  const b = d.bounds,
    n = chart.values.length;
  if (!n) return [p('text', { x: b.x + 12, y: b.y + 24 }, ['No chart data'])];
  if (chart.type === 'pie') {
    if (chart.values.some((v) => v < 0) || chart.values.reduce((a, b) => a + b, 0) <= 0)
      return [
        p('text', { x: b.x + 12, y: b.y + 24, fill: '#a42626' }, [
          'Pie needs non-negative values and a positive total',
        ]),
      ];
    const total = chart.values.reduce((a, b) => a + b, 0),
      r = Math.min(b.width, b.height - 30) * 0.42,
      cx = b.x + b.width / 2,
      cy = b.y + b.height / 2;
    let angle = -Math.PI / 2;
    return chart.values.flatMap((v, i) => {
      if (!v) return [];
      const start = angle;
      angle += (v / total) * Math.PI * 2;
      const end = angle;
      return [
        p('path', {
          d:
            v === total
              ? `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`
              : `M${cx} ${cy}L${cx + Math.cos(start) * r} ${cy + Math.sin(start) * r}A${r} ${r} 0 ${end - start > Math.PI ? 1 : 0} 1 ${cx + Math.cos(end) * r} ${cy + Math.sin(end) * r}Z`,
          fill: ['#3978c6', '#62b3a0', '#ecb963', '#9474be', '#d67a87'][i % 5],
        }),
        p('text', { x: b.x + 5, y: b.y + 16 + i * 15, 'font-size': 11 }, [
          `${chart.labels[i]}: ${v}`,
        ]),
      ];
    });
  }
  const min = Math.min(0, ...chart.values),
    max = Math.max(1, ...chart.values),
    plotH = b.height - 60,
    step = (b.width - 35) / n,
    y = (v: number) => b.y + 20 + ((max - v) / (max - min)) * plotH,
    zero = y(0);
  const nodes: SvgPrimitive[] = [
    p('line', { x1: b.x + 30, y1: zero, x2: b.x + b.width, y2: zero, stroke: '#9aa4b4' }),
    p('text', { x: b.x + 2, y: b.y + 14, 'font-size': 11 }, [String(max)]),
    p('text', { x: b.x + 2, y: b.y + b.height - 30, 'font-size': 11 }, [String(min)]),
  ];
  if (chart.type === 'line')
    nodes.push(
      p('path', {
        d: chart.values
          .map((v, i) => `${i ? 'L' : 'M'}${b.x + 35 + (i + 0.35) * step} ${y(v)}`)
          .join(' '),
        stroke: d.fill,
        fill: 'none',
        'stroke-width': 3,
      }),
    );
  chart.values.forEach((v, i) => {
    const x = b.x + 35 + i * step;
    if (chart.type !== 'line')
      nodes.push(
        p('rect', {
          x,
          y: Math.min(y(v), zero),
          width: step * 0.7,
          height: Math.max(1, Math.abs(y(v) - zero)),
          fill: d.fill,
        }),
      );
    nodes.push(
      p('text', { x, y: b.y + b.height - 12, 'font-size': Math.min(12, step / 4) }, [
        (chart.labels[i] ?? '').slice(0, 15),
      ]),
      p('text', { x, y: y(v) - 5, 'font-size': 11 }, [String(v)]),
    );
  });
  return nodes;
}
/** Resources belong to a drawing occurrence. Exporters can provide a stable document-local ID. */
/** SVG image documents use their own root aspect ratio when embedded in an image viewport. */
function fittedImageSource(src: string, imageFit: Drawing['imageFit']): string {
  const prefix = 'data:image/svg+xml;base64,';
  if (!src.startsWith(prefix)) return src;
  try {
    // Keep UTF-8 bytes intact; only the ASCII root attribute changes for rendering.
    const svg = atob(src.slice(prefix.length));
    const root = svg.match(/<svg\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/)?.[0];
    if (!root) return src;
    const clean = root.replace(/\s+preserveAspectRatio\s*=\s*(?:"[^"]*"|'[^']*')/g, '');
    const close = clean.endsWith('/>') ? '/>' : '>';
    const aspect = imageFit === 'fit' ? 'xMidYMid meet' : 'xMidYMid slice';
    const fitted = clean.slice(0, -close.length) + ` preserveAspectRatio="${aspect}"` + close;
    return prefix + btoa(svg.replace(root, fitted));
  } catch {
    // Preserve the existing missing-image behavior for an invalid data URI.
    return src;
  }
}
export function drawingPrimitives(
  d: Drawing,
  resourceId = newId('graphic'),
  options: DrawingRenderOptions = {},
): SvgPrimitive[] {
  if (d.hidden) return [];
  d = { ...d, id: resourceId };
  const b = d.bounds;
  let nodes: SvgPrimitive[] = [];
  if (d.kind === 'image') {
    // An unbound native image slot remains editable, but has no visual asset to export.
    if (!d.src) return [];
    const crop = d.crop ?? { x: 0, y: 0, scale: 1 };
    nodes = [
      p('defs', {}, [p('clipPath', { id: `image-${d.id}` }, [p('rect', { ...b })])]),
      p('g', { 'clip-path': `url(#image-${d.id})` }, [
        p('image', {
          x: b.x + crop.x,
          y: b.y + crop.y,
          width: b.width * crop.scale,
          height: b.height * crop.scale,
          href: fittedImageSource(d.src, d.imageFit),
          preserveAspectRatio: d.imageFit === 'fit' ? 'xMidYMid meet' : 'xMidYMid slice',
        }),
      ]),
    ];
  } else if (d.kind === 'chart') nodes = chartPrimitives(d);
  else if (d.kind === 'table' && d.table) {
    const rows = d.table.rows,
      cols = Math.max(1, ...rows.map((r) => r.length));
    const widths = d.table.columnWidths ?? Array(cols).fill(b.width / cols);
    const heights = d.table.rowHeights ?? Array(rows.length).fill(b.height / rows.length);
    let y = b.y;
    for (let r = 0; r < rows.length; r++) {
      let x = b.x;
      for (let c = 0; c < cols; c++) {
        const covered = d.table.merges?.some(
          (m) =>
            r >= m.row &&
            r < m.row + m.rows &&
            c >= m.col &&
            c < m.col + m.cols &&
            (r !== m.row || c !== m.col),
        );
        const merge = d.table.merges?.find((m) => m.row === r && m.col === c);
        const cell = {
          x,
          y,
          width: widths.slice(c, c + (merge?.cols ?? 1)).reduce((a, v) => a + v, 0),
          height: heights.slice(r, r + (merge?.rows ?? 1)).reduce((a, v) => a + v, 0),
        };
        if (!covered)
          nodes.push(
            p('rect', {
              ...cell,
              fill: r === 0 && d.table.header !== false ? '#e6edf6' : '#ffffff',
              stroke: d.stroke ?? '#8e9eb5',
              'stroke-width': 1,
            }),
            ...textPrimitives(
              {
                ...d,
                id: `${d.id}-${r}-${c}`,
                kind: 'text',
                bounds: cell,
                text: rows[r][c] ?? '',
                typography: { fontSize: 16, padding: 8, ...d.typography, bold: r === 0 },
                fill: '#253044',
              },
              options,
            ),
          );
        x += widths[c];
      }
      y += heights[r];
    }
  } else if (d.kind === 'freehand')
    nodes = [
      p('path', {
        d:
          d.points
            ?.map((v, i) => `${i ? 'L' : 'M'}${b.x + v.x * b.width} ${b.y + v.y * b.height}`)
            .join(' ') ?? '',
        fill: 'none',
        stroke: d.stroke ?? d.fill,
        'stroke-width': d.strokeWidth ?? 3,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    ];
  else if (d.kind === 'group') nodes = [];
  else if (d.kind === 'text') nodes = textPrimitives(d, options);
  else {
    if (d.vector) {
      const v = d.vector.viewBox;
      const scale = Math.min(b.width / v.width, b.height / v.height);
      nodes = [
        p(
          'g',
          {
            transform: `translate(${b.x + (b.width - v.width * scale) / 2} ${b.y + (b.height - v.height * scale) / 2}) scale(${scale}) translate(${-v.x} ${-v.y})`,
            'data-vector-source': d.vector.provenance.source,
            'data-vector-name': d.vector.provenance.name,
            'data-vector-version': d.vector.provenance.version,
            'data-vector-license': d.vector.provenance.license,
          },
          [
            p('defs', {}, [
              p('clipPath', { id: `vector-${d.id}`, clipPathUnits: 'userSpaceOnUse' }, [
                p('rect', { x: v.x, y: v.y, width: v.width, height: v.height }),
              ]),
            ]),
            p(
              'g',
              { 'clip-path': `url(#vector-${d.id})` },
              d.vector.paths.map((path) =>
                p('path', {
                  d: path,
                  fill: d.fill,
                  stroke: d.stroke ?? 'none',
                  'stroke-width': d.strokeWidth ?? 2,
                  'stroke-linecap': 'round',
                  'stroke-linejoin': 'round',
                }),
              ),
            ),
          ],
        ),
      ];
    } else nodes = shapePrimitives(d.shape ?? 'rectangle', b, d, d.fill);
    if (d.text) nodes.push(...textPrimitives(d, options));
  }
  const cx = b.x + b.width / 2,
    cy = b.y + b.height / 2;
  const rendered = [
    p(
      'g',
      {
        opacity: d.opacity ?? 1,
        'font-family': d.typography?.fontFamily ?? defaultDrawingFontFamily,
        transform: `translate(${cx} ${cy}) rotate(${d.rotation ?? 0}) scale(${d.flipX ? -1 : 1} ${d.flipY ? -1 : 1}) translate(${-cx} ${-cy})`,
      },
      nodes,
    ),
  ];
  return (d.clipBounds ?? []).reduce<SvgPrimitive[]>(
    (children, clip, i) => [
      p('defs', {}, [
        p('clipPath', { id: `frame-${d.id}-${i}` }, [
          p('rect', {
            x: clip.x,
            y: clip.y,
            width: clip.width,
            height: clip.height,
            transform: `rotate(${clip.rotation ?? 0} ${clip.x + clip.width / 2} ${clip.y + clip.height / 2})`,
          }),
        ]),
      ]),
      p('g', { 'clip-path': `url(#frame-${d.id}-${i})` }, children),
    ],
    rendered,
  );
}
export function serializeSvg(nodes: SvgPrimitive[]): string {
  return nodes
    .map(
      (n) =>
        `<${n.tag}${Object.entries(n.attrs)
          .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
          .join(
            '',
          )}>${n.children?.map((c) => (typeof c === 'string' ? escapeXml(c) : serializeSvg([c]))).join('') ?? ''}</${n.tag}>`,
    )
    .join('');
}
export function drawingSvg(drawings: Drawing[], bounds: Bounds, background?: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}">${background ? serializeSvg([p('rect', { ...bounds, fill: background })]) : ''}${serializeSvg(drawings.flatMap((d, i) => drawingPrimitives(d, `graphic-${i}`)))}</svg>`;
}
