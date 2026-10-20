import PptxGenJS from 'pptxgenjs';
import { strFromU8, strToU8, unzipSync, zip } from 'fflate';
import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import {
  shapePath,
  type Bounds,
  type Drawing,
  type ShapeKind,
  type TextRun,
} from '@editor-platform/editor-core';
import { checkExportAbort, exportColor, hashExportBytes } from '@editor-platform/export-core';
import { transformDrawingBox } from './geometry';
import type { OwnedPptxPlan, PptxElement, SlidePptxReport, SlidePptxResult } from './types';

const inch = (px: number) => px / 96;
const pt = (px: number) => px * 0.75;
const emu = (px: number) => Math.round(px * 9525);
const box = (b: Bounds) => ({ x: inch(b.x), y: inch(b.y), w: inch(b.width), h: inch(b.height) });
const transform = (d: Drawing) => ({
  rotate: (((d.rotation ?? 0) % 360) + 360) % 360,
  flipH: !!d.flipX,
  flipV: !!d.flipY,
});
function color(value: string, opacity = 1) {
  const c = exportColor(value);
  if (!c) throw new Error('Unplanned color');
  return { color: c.hex, transparency: (1 - c.alpha * opacity) * 100 };
}
function dataUri(asset: OwnedPptxPlan['assets'] extends Map<string, infer A> ? A : never) {
  let raw = '';
  for (let i = 0; i < asset.bytes.length; i += 0x8000)
    raw += String.fromCharCode(...asset.bytes.subarray(i, i + 0x8000));
  return `data:${asset.mime};base64,${btoa(raw)}`;
}
type Patches = Map<string, (xml: string) => string>;
function once(xml: string, expression: RegExp, replace: string): string {
  if (!expression.test(xml)) throw new Error('Generated Office structure changed');
  return xml.replace(expression, replace);
}

/** Parses only the known M/L/Z paths emitted by our native polygon/line projection. */
function points(path: string): NonNullable<PptxGenJS.ShapeProps['points']> {
  const tokens = path.match(/[MLZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const result: NonNullable<PptxGenJS.ShapeProps['points']> = [];
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++];
    if (command === 'Z') result.push({ close: true });
    else if (command === 'M' || command === 'L') {
      const x = Number(tokens[i++]),
        y = Number(tokens[i++]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid shape path');
      result.push({ x: inch(x), y: inch(y), moveTo: command === 'M' });
    } else throw new Error('Unplanned shape path');
  }
  return result;
}

const lineKinds: readonly string[] = ['line', 'arrow', 'double-arrow'];
/** Native M/L/Z outline of a non-rectangular shape, including drawn arrowheads. */
function shapeOutline(d: Drawing, kind: ShapeKind) {
  const b = d.bounds;
  let path = lineKinds.includes(kind)
    ? `M0 ${b.height / 2} L${b.width} ${b.height / 2}`
    : shapePath(kind, b.width, b.height);
  if (
    kind === 'arrow' ||
    kind === 'double-arrow' ||
    d.arrowhead === 'end' ||
    d.arrowhead === 'both'
  )
    path += ` M${b.width - 10} ${b.height / 2 - 6} L${b.width} ${b.height / 2} L${b.width - 10} ${b.height / 2 + 6}`;
  if (kind === 'double-arrow' || d.arrowhead === 'both')
    path += ` M10 ${b.height / 2 - 6} L0 ${b.height / 2} L10 ${b.height / 2 + 6}`;
  return path;
}
/** Office custom dash XML for a CSS dash list, or undefined when nothing is dashed. */
function customDash(d: Drawing) {
  if (!d.dash || (d.strokeWidth ?? 1) <= 0) return undefined;
  let pattern = d.dash.trim().split(/[ ,]+/).map(Number);
  if (pattern.length % 2) pattern = [...pattern, ...pattern];
  if (!pattern.some((n) => n > 0)) return undefined;
  const factor = 100000 / (d.strokeWidth ?? 1);
  return `<a:custDash>${Array.from({ length: pattern.length / 2 }, (_, i) => `<a:ds d="${Math.round(pattern[i * 2] * factor)}" sp="${Math.round(pattern[i * 2 + 1] * factor)}"/>`).join('')}</a:custDash>`;
}
function addShape(slide: PptxGenJS.Slide, e: PptxElement, name: string, patches: Patches) {
  const d = e.drawing,
    b = d.bounds,
    kind = d.shape ?? 'rectangle';
  const options: PptxGenJS.ShapeProps = {
    ...box(b),
    ...transform(d),
    objectName: name,
    fill: color(lineKinds.includes(kind) ? 'none' : d.fill, d.opacity),
    line: {
      ...color(d.stroke ?? '#5b6472', d.opacity),
      width: pt(d.strokeWidth ?? 1),
      dashType: 'solid',
      beginArrowType: 'none',
      endArrowType: 'none',
    },
  };
  if (kind === 'ellipse') slide.addShape('ellipse', options);
  else if (kind === 'rectangle' || kind === 'rounded-rectangle') {
    const radius = Math.min(d.radius ?? (kind === 'rectangle' ? 0 : 16), b.width / 2, b.height / 2);
    slide.addShape(radius > 0 ? 'roundRect' : 'rect', { ...options, rectRadius: inch(radius) });
  }
  // 4.0.1 implements custGeom + points but omits this enum member from its declarations.
  else
    slide.addShape('custGeom' as PptxGenJS.ShapeType, {
      ...options,
      points: points(shapeOutline(d, kind)),
    });
  const dash = customDash(d);
  if (dash) patches.set(name, (xml) => once(xml, /<a:prstDash[^>]*\/>/, dash));
}

function textRuns(
  runs: TextRun[],
  d: Drawing,
  family: string,
  baseSize: number,
): PptxGenJS.TextProps[] {
  return runs.map((run) => {
    const style = run.style ?? {};
    return {
      text: run.text,
      options: {
        fontFace: family,
        fontSize: pt(style.fontSize ?? baseSize),
        bold: style.bold ?? false,
        italic: style.italic ?? false,
        underline: { style: style.underline ? 'sng' : 'none' },
        strike: style.strike ? 'sngStrike' : false,
        ...color(
          style.color ?? d.typography?.color ?? (d.kind === 'text' ? d.fill : '#253044'),
          d.opacity,
        ),
        charSpacing: pt(style.letterSpacing ?? 0),
        lang: 'ja-JP',
      },
    };
  });
}
function addText(slide: PptxGenJS.Slide, e: PptxElement, prefix: string, family: string): string[] {
  const d = e.drawing,
    layout = e.textLayout;
  if (!layout) return [];
  const names: string[] = [];
  let y = layout.startY;
  for (const [index, line] of layout.lines.entries()) {
    const name = `${prefix}-text-${index + 1}`;
    const bounds = {
      x: d.bounds.x + layout.padding,
      y,
      width: Math.max(1, d.bounds.width - 2 * layout.padding),
      height: line.height,
    };
    const runs = textRuns(line.runs, d, family, layout.fontSize);
    if (d.typography?.list)
      runs.unshift({
        text: '• ',
        options: {
          fontFace: family,
          fontSize: pt(layout.fontSize),
          ...color(d.typography.color ?? d.fill, d.opacity),
        },
      });
    slide.addText(runs.length ? runs : [{ text: '' }], {
      ...box(transformDrawingBox(bounds, d)),
      ...transform(d),
      objectName: name,
      fontFace: family,
      fontSize: pt(layout.fontSize),
      margin: 0,
      align: d.typography?.align ?? 'left',
      valign: 'top',
      wrap: false,
      fit: 'none',
      // Each line has its own box. Extra paragraph leading moves Office's first baseline;
      // the shared layout already positions subsequent boxes using the requested line height.
      lineSpacing: pt(line.ascent * 1.2),
      paraSpaceBefore: 0,
      paraSpaceAfter: 0,
      breakLine: false,
      lang: 'ja-JP',
    });
    names.push(name);
    y += line.height;
  }
  return names;
}

function addTable(
  slide: PptxGenJS.Slide,
  e: PptxElement,
  name: string,
  family: string,
  patches: Patches,
) {
  const d = e.drawing,
    cells = e.tableCells;
  if (!cells?.length || !d.table) throw new Error('Missing native cell plan');
  const widths = cells.filter((c) => c.row === 0).map((c) => c.bounds.width);
  const heights = cells.filter((c) => c.col === 0).map((c) => c.bounds.height);
  const rows: PptxGenJS.TableRow[] = heights.map(() => []);
  for (const c of cells) {
    const cellDrawing = { ...d, kind: 'text' as const, fill: '#253044' };
    const text = c.layout.lines.flatMap((line, index) => {
      const runs = textRuns(line.runs, cellDrawing, family, c.layout.fontSize);
      if (!runs.length) runs.push({ text: '' });
      // Explicitly carry the shared line layout into native cell paragraphs.
      runs[0].options = {
        ...runs[0].options,
        lineSpacing: pt(line.height),
        paraSpaceAfter: 0,
        paraSpaceBefore: 0,
      };
      if (index < c.layout.lines.length - 1)
        runs[runs.length - 1].options = { ...runs.at(-1)!.options, breakLine: true };
      return runs;
    });
    rows[c.row].push({
      text,
      options: {
        fontFace: family,
        fontSize: pt(c.layout.fontSize),
        align: d.typography?.align ?? 'left',
        valign: 'top',
        margin: 0,
        color: '253044',
        fill: color(c.row === 0 && d.table.header !== false ? '#e6edf6' : '#ffffff', d.opacity),
        border: { type: 'solid', pt: 0.75, color: exportColor(d.stroke ?? '#8e9eb5')!.hex },
      },
    });
  }
  const bounds = {
    ...d.bounds,
    width: widths.reduce((a, b) => a + b, 0),
    height: heights.reduce((a, b) => a + b, 0),
  };
  slide.addTable(rows, {
    ...box(bounds),
    objectName: name,
    colW: widths.map(inch),
    rowH: heights.map(inch),
    autoPage: false,
    margin: 0,
    fontFace: family,
    fontSize: pt(cells[0].layout.fontSize),
  });
  patches.set(name, (xml) => {
    let index = 0;
    xml = xml.replace(/<a:tc>([\s\S]*?)<\/a:tc>/g, (_match, body: string) => {
      const cell = cells[index++];
      if (!cell) throw new Error('Unexpected native cell');
      // Library versions use ambiguous points/inches heuristics. Write exact CSS-pixel insets.
      const p = cell.layout.padding;
      const top = cell.layout.startY - cell.bounds.y;
      body = body.replace(
        /<a:tcPr\b[^>]*>/,
        `<a:tcPr marL="${emu(p)}" marR="${emu(p)}" marT="${emu(top)}" marB="0" anchor="t">`,
      );
      body = body.replace(
        /<a:bodyPr\b[^>]*\/>|<a:bodyPr\b[^>]*>[\s\S]*?<\/a:bodyPr>/,
        '<a:bodyPr wrap="none" anchor="t"><a:noAutofit/></a:bodyPr>',
      );
      return `<a:tc>${body}</a:tc>`;
    });
    if (index !== cells.length) throw new Error('Native table cell count differs from the plan');
    return xml;
  });
}

/** Adds one planned picture with its exact crop; reuses each image's data URI by hash. */
function addPicture(
  slide: PptxGenJS.Slide,
  e: PptxElement,
  name: string,
  plan: OwnedPptxPlan,
  encodedImages: Map<string, string>,
  patch: Patches,
) {
  const d = e.drawing;
  const asset = e.imageKey && plan.assets.get(e.imageKey),
    placement = e.imagePlacement;
  if (!asset || !placement) throw new Error('Missing owned image plan');
  if (!encodedImages.has(asset.hash)) encodedImages.set(asset.hash, dataUri(asset));
  slide.addImage({
    ...box(transformDrawingBox(placement.bounds, d)),
    ...transform(d),
    objectName: name,
    data: encodedImages.get(asset.hash)!,
    altText: d.alt ?? '',
    transparency: (1 - (d.opacity ?? 1)) * 100,
  });
  const c = placement.crop;
  patch.set(name, (xml) =>
    once(
      xml,
      /<a:stretch>/,
      `<a:srcRect l="${Math.round(c.left * 100000)}" r="${Math.round(c.right * 100000)}" t="${Math.round(c.top * 100000)}" b="${Math.round(c.bottom * 100000)}"/><a:stretch>`,
    ),
  );
}
/** Adds one planned element; returns the Office object names it produced. */
function addElement(
  slide: PptxGenJS.Slide,
  e: PptxElement,
  name: string,
  plan: OwnedPptxPlan,
  family: string,
  encodedImages: Map<string, string>,
  patch: Patches,
): string[] {
  const d = e.drawing;
  if (e.representation === 'png' || d.kind === 'image') {
    addPicture(slide, e, name, plan, encodedImages, patch);
    return [name];
  }
  if (d.kind === 'table') {
    addTable(slide, e, name, family, patch);
    return [name];
  }
  if (d.kind !== 'text' && d.kind !== 'shape') throw new Error('Element has no planned encoding');
  const names: string[] = [];
  if (d.kind === 'shape') {
    addShape(slide, e, name, patch);
    names.push(name);
  }
  names.push(...addText(slide, e, name, family));
  return names;
}
/**
 * PptxGenJS repeats data-URI media across slides. Keep each distinct image once,
 * preserving every picture's independent placement/crop/alt text and relationship.
 */
async function deduplicateMedia(files: Record<string, Uint8Array>, signal?: AbortSignal) {
  const mediaByHash = new Map<string, string>();
  const mediaTargets = new Map<string, string>();
  for (const path of Object.keys(files).filter((p) =>
    /^ppt\/media\/[^/]+\.(png|jpeg|jpg)$/.test(p),
  )) {
    checkExportAbort(signal);
    const key = `${path.split('.').at(-1)}/${await hashExportBytes(files[path])}`;
    const first = mediaByHash.get(key);
    if (first) {
      mediaTargets.set(path.slice(4), first.slice(4));
      delete files[path];
    } else mediaByHash.set(key, path);
  }
  // PptxGenJS 4.0.1 declares one slideMaster override per page although all
  // slides share its one actual master. Keep the generated OPC index consistent.
  files['[Content_Types].xml'] = strToU8(
    strFromU8(files['[Content_Types].xml']).replace(
      /<Override\b[^>]*\bPartName="\/([^"]+)"[^>]*\/>/g,
      (declaration: string, part: string) => (files[part] ? declaration : ''),
    ),
  );
  for (const path of Object.keys(files).filter((p) => p.endsWith('.rels')))
    files[path] = strToU8(
      strFromU8(files[path]).replace(/Target="\.\.\/(media\/[^"/]+)"/g, (whole, target: string) => {
        const replacement = mediaTargets.get(target);
        return replacement ? `Target="../${replacement}"` : whole;
      }),
    );
}
/** Applies each page's per-object XML patches and renumbers drawing ids. */
function patchSlides(files: Record<string, Uint8Array>, patches: Patches[]) {
  for (const [pageIndex, patch] of patches.entries()) {
    const path = `ppt/slides/slide${pageIndex + 1}.xml`;
    let xml = strFromU8(files[path]);
    const applied = new Set<string>();
    xml = xml.replace(/<p:(sp|pic|graphicFrame)>([\s\S]*?)<\/p:\1>/g, (object: string) => {
      const name = /<p:cNvPr\b[^>]*\bname="([^"]+)"/.exec(object)?.[1];
      if (name && patch.has(name)) {
        applied.add(name);
        return patch.get(name)!(object);
      }
      return object;
    });
    if (applied.size !== patch.size) throw new Error('An output part is missing');
    // PptxGenJS tables otherwise generate overlapping ids when mixed with shapes.
    let id = 0;
    xml = xml.replace(
      /<p:cNvPr\b([^>]*)\bid="\d+"/g,
      (_m, before: string) => `<p:cNvPr${before}id="${++id}"`,
    );
    files[path] = strToU8(xml);
  }
}
function createPresentation(plan: OwnedPptxPlan, family: string) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'Editor', width: inch(plan.width), height: inch(plan.height) });
  pptx.layout = 'Editor';
  pptx.author = '';
  pptx.company = '';
  pptx.subject = '';
  pptx.title = '';
  pptx.theme = { headFontFace: family, bodyFontFace: family };
  return pptx;
}
export async function encodeOwnedPptx(
  plan: OwnedPptxPlan,
  signal?: AbortSignal,
): Promise<SlidePptxResult> {
  if (!plan.font) throw new Error('Missing font plan');
  const family = plan.font.family;
  const pptx = createPresentation(plan, family);
  const report = clone(plan.report) as SlidePptxReport;
  const byAddress = new Map(report.elements.map((e) => [canonicalJson(e.address), e]));
  const patches: Patches[] = [];
  const encodedImages = new Map<string, string>();
  let processed = 0;
  for (const [pageIndex, page] of plan.pages.entries()) {
    checkExportAbort(signal);
    const slide = pptx.addSlide(),
      patch: Patches = new Map();
    patches.push(patch);
    slide.background = color(page.background);
    if (page.notes) slide.addNotes(page.notes);
    for (const [elementIndex, e] of page.elements.entries()) {
      checkExportAbort(signal);
      if (++processed % 20 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        checkExportAbort(signal);
      }
      if (e.representation === 'omitted' || e.drawing.kind === 'group') continue;
      const names = addElement(
        slide,
        e,
        `e${elementIndex + 1}`,
        plan,
        family,
        encodedImages,
        patch,
      );
      byAddress.get(canonicalJson(e.address))!.outputPartNames = names.map(
        (n) => `ppt/slides/slide${pageIndex + 1}.xml#${n}`,
      );
    }
  }
  checkExportAbort(signal);
  // Patching requires unpacking anyway. Compress only the final, deduplicated package.
  const raw = await pptx.write({ outputType: 'uint8array', compression: false });
  checkExportAbort(signal);
  if (!(raw instanceof Uint8Array)) throw new Error('Unexpected Office bytes');
  const files = unzipSync(raw);
  await deduplicateMedia(files, signal);
  if (
    Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).length !==
    plan.pages.length
  )
    throw new Error('Encoder added or removed pages');
  patchSlides(files, patches);
  checkExportAbort(signal);
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, { level: 6 }, (err, result) => (err ? reject(err) : resolve(result))),
  );
  checkExportAbort(signal);
  return {
    status: 'ok',
    bytes,
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    report: deepFreeze(report),
  };
}
