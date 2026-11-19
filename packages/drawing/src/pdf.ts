import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  drawingLineWidths,
  type DrawingItem,
  type DrawingLineClass,
  type DrawingPaperSheet,
  type Vec2,
} from '@editor-platform/drawing-core';

/**
 * DW6 (docs/cad/drawing-editor.md, 出力): every sheet as a page of one PDF, drawn as vectors in
 * paper millimetres (the page is the sheet's paper). Text is drawn as the outlines of the Host's
 * fixed Japanese font (Noto Sans CJK JP), so every viewer shows the same letters (a subset of its
 * CFF outlines does not embed reliably), with the same text over it, invisible, in the embedded
 * subset, so it searches and copies (as documents print).
 * Line widths and dashes are the SVG's (JIS B 0001); cut faces are filled light grey.
 */
export interface DrawingPdfOptions {
  /** The fixed font's bytes (OpenType), from the Host. */
  font: Uint8Array;
  title?: string;
  /** For a fixed file (an issued sheet): its creation date. */
  date?: Date;
}

/** mm → pt. */
const PT = 72 / 25.4;
const dash: Partial<Record<DrawingLineClass, number[]>> = {
  hidden: [3, 1],
  center: [12, 1.5, 1.5, 1.5],
  placeholder: [2, 1.5],
};
const RED = [0.8667, 0, 0] as const;
const BLACK = [0, 0, 0] as const;

export class DrawingPdfError extends Error {
  constructor(
    readonly code: 'pdf-font-missing',
    readonly chars: string[] = [],
  ) {
    super(code);
  }
}

export async function drawingPdf(
  sheets: readonly DrawingPaperSheet[],
  options: DrawingPdfOptions,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const outlines = fontkit.create(options.font as Buffer) as unknown as OutlineFont;
  // The searchable layer's subset only with text to search: an empty subset does not encode.
  const any = sheets.some((s) => s.items.some((it) => it.type === 'text' && clean(it.text)));
  const font = any ? await pdf.embedFont(options.font, { subset: true }) : undefined;
  // Every character must be in the font: none is drawn as an empty box.
  const supported = new Set(outlines.characterSet);
  const missing = new Set<string>();
  for (const s of sheets)
    for (const it of s.items)
      if (it.type === 'text')
        for (const ch of clean(it.text)) if (!supported.has(ch.codePointAt(0)!)) missing.add(ch);
  if (missing.size) throw new DrawingPdfError('pdf-font-missing', [...missing]);
  const date = options.date ?? new Date();
  pdf.setTitle(options.title ?? 'Drawing');
  pdf.setCreator('Editor Platform drawing');
  pdf.setProducer('Editor Platform drawing (pdf-lib)');
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  for (const s of sheets) {
    const page = pdf.addPage([s.paper[0] * PT, s.paper[1] * PT]);
    drawPage(pdf, page, font, outlines, s.items);
  }
  return pdf.save({ useObjectStreams: false });
}

const clean = (t: string) => t.replace(/[\t\r\n\f\v]/g, ' ');

/** What the outlines need of a fontkit font. */
interface OutlineFont {
  unitsPerEm: number;
  characterSet: number[];
  layout(text: string): {
    glyphs: { path: { commands: { command: string; args: number[] }[] } }[];
    positions: { xAdvance: number; xOffset: number; yOffset: number }[];
  };
}

function drawPage(
  pdf: PDFDocument,
  page: PDFPage,
  font: PDFFont | undefined,
  outlines: OutlineFont,
  items: readonly DrawingItem[],
) {
  const key = font ? page.node.newFontDictionary('DWFont', font.ref).asString() : '';
  // The page's content as one stream of operators, written as text: a large drawing has too
  // many to make one object each (Codex on #1244).
  const out: string[] = [];
  const n = (v: number) => {
    const r = Math.round(v * 1e4) / 1e4;
    return Object.is(r, -0) ? '0' : String(r);
  };
  const op = (...parts: (string | number)[]) =>
    out.push(parts.map((p) => (typeof p === 'number' ? n(p) : p)).join(' '));
  // Paper mm, y up: the page's own axes, scaled; round caps and joins.
  op('q', PT, 0, 0, PT, 0, 0, 'cm', 1, 'J', 1, 'j');
  const rgb = (c: readonly number[], fill: boolean) => op(c[0]!, c[1]!, c[2]!, fill ? 'rg' : 'RG');
  const strokeStyle = (cls: DrawingLineClass) => {
    op(drawingLineWidths[cls], 'w');
    out.push(`[${(dash[cls] ?? []).map(n).join(' ')}] 0 d`);
    rgb(cls === 'error' ? RED : BLACK, false);
  };
  const path = (pts: readonly Vec2[], closed: boolean) => {
    op(pts[0]![0], pts[0]![1], 'm');
    for (let i = 1; i < pts.length; i++) op(pts[i]![0], pts[i]![1], 'l');
    if (closed) op('h');
  };
  const arcPath = (c: Vec2, r: number, a0: number, a1: number) => {
    let sweep = a1 - a0;
    while (sweep <= 0) sweep += 2 * Math.PI;
    const count = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
    const d = sweep / count;
    const k = (4 / 3) * Math.tan(d / 4) * r;
    const at = (t: number): Vec2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
    op(...at(a0), 'm');
    for (let i = 0; i < count; i++) {
      const t0 = a0 + i * d;
      const t1 = t0 + d;
      const p0 = at(t0);
      const p1 = at(t1);
      op(
        p0[0] - k * Math.sin(t0),
        p0[1] + k * Math.cos(t0),
        p1[0] + k * Math.sin(t1),
        p1[1] - k * Math.cos(t1),
        p1[0],
        p1[1],
        'c',
      );
    }
  };
  for (const it of items)
    switch (it.type) {
      case 'line':
        strokeStyle(it.cls);
        path([it.a, it.b], false);
        op('S');
        break;
      case 'segments':
        if (it.points.length < 4) break;
        strokeStyle(it.cls);
        for (let i = 0; i + 3 < it.points.length; i += 4)
          op(it.points[i]!, it.points[i + 1]!, 'm', it.points[i + 2]!, it.points[i + 3]!, 'l');
        op('S');
        break;
      case 'polyline':
        if (it.points.length < 2) break;
        if (it.fill) {
          rgb(it.cls === 'error' ? RED : BLACK, true);
          path(it.points, true);
          op('f');
        } else {
          strokeStyle(it.cls);
          path(it.points, it.closed);
          op('S');
        }
        break;
      case 'circle':
        if (it.fill) rgb(BLACK, true);
        else strokeStyle(it.cls);
        arcPath(it.center, it.radius, 0, 2 * Math.PI);
        op('h', it.fill ? 'f' : 'S');
        break;
      case 'arc':
        strokeStyle(it.cls);
        arcPath(it.center, it.radius, it.start, it.end);
        op('S');
        break;
      case 'area':
        // A cut face: light grey (the SVG's 12 % black), even-odd for its holes.
        rgb([0.88, 0.88, 0.88], true);
        for (const l of it.loops) if (l.length >= 3) path(l, true);
        op('f*');
        break;
      case 'text': {
        const text = clean(it.text);
        if (!text) break;
        const size = it.heightMm;
        const run = outlines.layout(text);
        const k = size / outlines.unitsPerEm;
        const w = run.positions.reduce((a, p) => a + p.xAdvance, 0) * k;
        const dx = it.anchor === 'start' ? 0 : it.anchor === 'middle' ? -w / 2 : -w;
        const r = it.rotation ?? 0;
        const [c, s] = [Math.cos(r), Math.sin(r)];
        // The letters' outlines, filled, in the text's own axes.
        op('q', c, s, -s, c, it.at[0], it.at[1], 'cm');
        rgb(it.error ? RED : BLACK, true);
        let x = dx / k;
        let any = false;
        run.glyphs.forEach((glyph, i) => {
          const pos = run.positions[i]!;
          const ox = x + pos.xOffset;
          const oy = pos.yOffset;
          const P = (px: number, py: number): [number, number] => [(ox + px) * k, (oy + py) * k];
          let last: [number, number] = [0, 0];
          for (const { command, args: a } of glyph.path.commands) {
            if (command === 'moveTo') op(...(last = P(a[0]!, a[1]!)), 'm');
            else if (command === 'lineTo') op(...(last = P(a[0]!, a[1]!)), 'l');
            else if (command === 'quadraticCurveTo') {
              const q = P(a[0]!, a[1]!);
              const e = P(a[2]!, a[3]!);
              op(
                last[0] + (2 / 3) * (q[0] - last[0]),
                last[1] + (2 / 3) * (q[1] - last[1]),
                e[0] + (2 / 3) * (q[0] - e[0]),
                e[1] + (2 / 3) * (q[1] - e[1]),
                ...e,
                'c',
              );
              last = e;
            } else if (command === 'bezierCurveTo') {
              const e = P(a[4]!, a[5]!);
              op(...P(a[0]!, a[1]!), ...P(a[2]!, a[3]!), ...e, 'c');
              last = e;
            } else if (command === 'closePath') op('h');
            any = true;
          }
          x += pos.xAdvance;
        });
        if (any) op('f');
        // The same text, invisible, stretched over the letters: search and copy.
        if (font) {
          const tw = font.widthOfTextAtSize(text, size);
          op('BT', key, size, 'Tf', 3, 'Tr', tw > 0 ? w / tw : 1, 0, 0, 1, dx, 0, 'Tm');
          out.push(`${font.encodeText(text).toString()} Tj`, 'ET');
        }
        op('Q');
        break;
      }
    }
  op('Q');
  const stream = pdf.context.flateStream(out.join('\n'));
  page.node.addContentStream(pdf.context.register(stream));
}
