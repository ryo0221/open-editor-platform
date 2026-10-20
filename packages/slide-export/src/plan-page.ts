import {
  layoutDrawingText,
  shapeNames,
  type Drawing,
  type DrawingTextLayout,
} from '@editor-platform/editor-core';
import {
  slideDrawing,
  slidePaintOrder,
  type Slide,
  type SlideContent,
} from '@editor-platform/slide/model';
import {
  checkExportAbort,
  exportColor,
  missingFontGlyphs,
  type SlideExportAddress,
} from '@editor-platform/export-core';
import { slidePptxCapabilities, type PptxElement, type PptxPage } from './types';
import { pptxImagePlacement } from './geometry';
import { hasXmlControlCharacter, type PptxPlanner } from './planner';
/** Plans one selected slide: page diagnostics, then every drawing in paint order. */
export async function planSlide(p: PptxPlanner, deck: SlideContent, slide: Slide) {
  const { settings } = p;
  const pageAddress: SlideExportAddress = { domain: 'slide', slideId: slide.id };
  if (slide.hidden && !settings.includeHiddenSlides) {
    p.add(
      'HIDDEN_SLIDE_EXCLUDED',
      'info',
      'Hidden page excluded by selection',
      pageAddress,
      'omitted-by-choice',
    );
    for (const object of slide.objects)
      p.reportElements.push({
        address: { ...pageAddress, elementId: object.id },
        representation: 'omitted',
        outputPartNames: [],
        counted: object.type !== 'group',
      });
    return;
  }
  if (slide.hidden)
    p.add(
      'HIDDEN_FLAG_NOT_PRESERVED',
      'warning',
      'Included hidden page becomes an ordinary Office page',
      pageAddress,
      'appearance',
    );
  if (slide.notes && !settings.includeNotes)
    p.add('NOTES_EXCLUDED', 'info', 'Notes excluded by choice', pageAddress, 'omitted-by-choice');
  const page: PptxPage = {
    id: slide.id,
    background: slide.background,
    notes: settings.includeNotes ? slide.notes : undefined,
    elements: [],
  };
  if (!exportColor(page.background))
    p.add(
      'COLOR_UNSUPPORTED',
      'error',
      'Page background is not a supported CSS color',
      pageAddress,
    );
  if (page.notes && hasXmlControlCharacter(page.notes))
    p.add(
      'TEXT_CHARACTER_UNSUPPORTED',
      'error',
      'Notes contain an XML control character',
      pageAddress,
    );
  p.pages.push(page);
  for (const drawing of pageDrawings(deck, slide)) {
    checkExportAbort(p.signal);
    await planElement(p, page, pageAddress, drawing);
  }
}
/** Slide drawings in paint order, preceded by the page background image when present. */
function pageDrawings(deck: SlideContent, slide: Slide) {
  const drawings = slidePaintOrder(slide).map(slideDrawing);
  if (slide.backgroundImage)
    drawings.unshift({
      id: '',
      kind: 'image',
      text: '',
      fill: 'none',
      src: slide.backgroundImage,
      bounds: { x: 0, y: 0, width: deck.width, height: deck.height },
      imageFit: 'fill',
    });
  return drawings;
}
async function planElement(
  p: PptxPlanner,
  page: PptxPage,
  pageAddress: SlideExportAddress,
  drawing: Drawing,
) {
  const address: SlideExportAddress = {
    ...pageAddress,
    ...(drawing.id ? { elementId: drawing.id } : { path: 'backgroundImage' }),
  };
  const element: PptxElement = { address, drawing, representation: 'native' };
  page.elements.push(element);
  if (!drawing.hidden && drawing.kind !== 'group') auditPaint(p, element);
  await convertElement(p, element);
  if (!drawing.hidden && (drawing.kind === 'text' || drawing.kind === 'shape') && drawing.text)
    await planTextFallbacks(p, element);
  if (
    !drawing.hidden &&
    drawing.kind === 'shape' &&
    element.representation === 'native' &&
    !['rectangle', 'ellipse', 'line'].includes(drawing.shape!)
  ) {
    element.representation = 'native-approximation';
    p.add(
      'SHAPE_GEOMETRY_APPROXIMATED',
      'warning',
      'Native Office shape contours can differ from the Editor path',
      address,
      'appearance',
    );
  }
  p.reportElements.push({
    address,
    representation: element.representation,
    outputPartNames: [],
    counted: drawing.kind !== 'group',
  });
}
const dashPattern = /^\s*\d+(?:\.\d+)?(?:[ ,]+\d+(?:\.\d+)?)*\s*$/;
/** Colors, dashes, text layout and glyph coverage of a painted element. */
function auditPaint(p: PptxPlanner, element: PptxElement) {
  const { drawing, address } = element;
  const colors = [
    drawing.fill,
    drawing.stroke,
    drawing.typography?.color,
    ...(drawing.runs ?? []).map((r) => r.style?.color),
  ].filter((c): c is string => c !== undefined);
  if (colors.some((c) => !exportColor(c)))
    p.add('COLOR_UNSUPPORTED', 'error', 'An element contains an unsupported CSS color', address);
  if (drawing.dash && !dashPattern.test(drawing.dash))
    p.add(
      'DASH_UNSUPPORTED',
      'error',
      'Dash lengths must be non-negative CSS pixel numbers',
      address,
    );
  if (drawing.kind === 'text' || (drawing.kind === 'shape' && drawing.text)) {
    element.textLayout = layoutDrawingText(drawing);
    checkText(p, drawing, address, element.textLayout);
  }
  auditDataGlyphs(p, drawing, address);
}
function auditDataGlyphs(p: PptxPlanner, drawing: Drawing, address: SlideExportAddress) {
  const { font } = p;
  if (!font) return;
  if (
    drawing.kind === 'chart' &&
    missingFontGlyphs([drawing.chart?.label, ...(drawing.chart?.labels ?? [])].join(''), font)
      .length
  )
    p.add('FONT_GLYPH_MISSING', 'error', 'The fixed font profile lacks chart glyphs', address);
  if (
    drawing.kind === 'table' &&
    missingFontGlyphs(drawing.table?.rows.flat().join('') ?? '', font).length
  )
    p.add('FONT_GLYPH_MISSING', 'error', 'The fixed font profile lacks table glyphs', address);
}
function checkText(
  p: PptxPlanner,
  drawing: Drawing,
  address: SlideExportAddress,
  layout: DrawingTextLayout,
  split = true,
) {
  const { font } = p;
  if (!font) return;
  if (missingFontGlyphs(drawing.text, font).length)
    p.add('FONT_GLYPH_MISSING', 'error', 'The fixed font profile lacks required glyphs', address);
  if (hasXmlControlCharacter(drawing.text))
    p.add('TEXT_CHARACTER_UNSUPPORTED', 'error', 'Text contains an XML control character', address);
  if (/\p{Extended_Pictographic}|‍|️|[֐-ࣿ]/u.test(drawing.text))
    p.add(
      'TEXT_SHAPING_UNVERIFIED',
      'warning',
      'Emoji or complex shaping needs external rendering review',
      address,
      'appearance',
    );
  const families = new Set([
    drawing.typography?.fontFamily ?? 'Arial, sans-serif',
    ...(drawing.runs ?? []).map((r) => r.style?.fontFamily).filter((f): f is string => !!f),
  ]);
  if ([...families].some((f) => f !== font.family))
    p.add(
      'FONT_SUBSTITUTED',
      'warning',
      `Text will reference ${font.family} instead of ${[...families].join('; ')}`,
      address,
      'appearance',
    );
  if (split && layout.lines.length > 1)
    p.add(
      'TEXT_BOX_SPLIT',
      'warning',
      'Calculated lines become ordered native text boxes; edit each line separately',
      address,
      'editability',
    );
  p.add(
    'TEXT_REFLOW_RISK',
    'warning',
    'Office font metrics may change text after external editing',
    address,
    'appearance',
  );
}
/** Chooses the native, PNG or omitted representation by drawing kind. */
async function convertElement(p: PptxPlanner, element: PptxElement) {
  const { drawing, address } = element;
  if (drawing.hidden) {
    element.representation = 'omitted';
    p.add(
      'HIDDEN_ELEMENT_EXCLUDED',
      'info',
      'Hidden element is not painted',
      address,
      'omitted-by-choice',
    );
  } else if (drawing.kind === 'group')
    p.add(
      'GROUP_FLATTENED',
      'warning',
      'Children keep world coordinates and paint order; the group container is not retained',
      address,
      'editability',
    );
  else if (drawing.kind === 'image') await planImage(p, element);
  else if (drawing.kind === 'chart')
    await p.fallback(element, 'Charts are static snapshots in this exporter');
  else if (drawing.kind === 'shape' && !shapeNames.includes(drawing.shape!))
    p.add(
      'UNSUPPORTED_ELEMENT',
      'error',
      'Unknown shape has no verified native or raster mapping',
      address,
    );
  else if (
    drawing.kind === 'shape' &&
    !(slidePptxCapabilities.nativeShapes as readonly string[]).includes(drawing.shape!)
  )
    await p.fallback(element, 'This shape has no native Office mapping');
  else if (drawing.kind === 'table') await planTable(p, element);
}
async function planImage(p: PptxPlanner, element: PptxElement) {
  const { drawing, address } = element;
  const asset = await p.resolveAsset(drawing.src, address);
  if (!asset) return;
  element.imageKey = `source:${drawing.src}`;
  element.imagePlacement = pptxImagePlacement(drawing, asset.width, asset.height);
  if (!element.imagePlacement) {
    element.representation = 'omitted';
    p.add(
      'IMAGE_EXCLUDED_BY_CROP',
      'info',
      'The crop places the entire bitmap outside its visible region',
      address,
      'omitted-by-choice',
    );
    return;
  }
  if (asset.mime !== 'image/webp' && asset.mime !== 'image/gif') return;
  if (asset.mime === 'image/gif')
    p.add(
      'IMAGE_ANIMATION_FLATTENED',
      'warning',
      'GIF exports its first decoded frame',
      address,
      'appearance',
    );
  await p.fallback(element, 'Office does not retain this image format', asset);
}
type TableContent = NonNullable<Drawing['table']>;
const validTableRows = (table: Drawing['table']): table is TableContent =>
  !!table &&
  Array.isArray(table.rows) &&
  !!table.rows.length &&
  table.rows.every((r) => Array.isArray(r) && r.length && r.every((c) => typeof c === 'string'));
async function planTable(p: PptxPlanner, element: PptxElement) {
  const { drawing, address } = element;
  const table = drawing.table;
  if (!validTableRows(table))
    p.add('INVALID_CONTENT', 'error', 'Table rows must contain text cells', address);
  else if (drawing.flipX || drawing.flipY || (drawing.rotation ?? 0) % 360 !== 0)
    await p.fallback(
      element,
      'The verified Office renderer cannot rotate or mirror native table cell text and fills consistently',
    );
  else if (table.merges?.length)
    await p.fallback(element, 'Slide merged tables require element rendering');
  else if ((drawing.opacity ?? 1) < 1 || (exportColor(drawing.stroke ?? '#8e9eb5')?.alpha ?? 1) < 1)
    await p.fallback(
      element,
      'The verified Office renderer ignores native table border transparency',
    );
  else planTableCells(p, element, table);
}
/** Lays out each native table cell as a fixed text box; invalid grids are diagnosed. */
function planTableCells(p: PptxPlanner, element: PptxElement, table: TableContent) {
  const { drawing, address } = element;
  const columns = Math.max(...table.rows.map((r) => r.length));
  const widths = table.columnWidths ?? Array(columns).fill(drawing.bounds.width / columns);
  const heights =
    table.rowHeights ?? Array(table.rows.length).fill(drawing.bounds.height / table.rows.length);
  if (
    widths.length !== columns ||
    heights.length !== table.rows.length ||
    [...widths, ...heights].some((n) => !Number.isFinite(n) || n <= 0)
  ) {
    p.add(
      'INVALID_CONTENT',
      'error',
      'Table dimensions must be positive and match its grid',
      address,
    );
    return;
  }
  const cells: NonNullable<PptxElement['tableCells']> = (element.tableCells = []);
  let y = drawing.bounds.y;
  for (let r = 0; r < table.rows.length; r++) {
    let x = drawing.bounds.x;
    for (let c = 0; c < columns; c++) {
      const cell: Drawing = {
        ...drawing,
        kind: 'text',
        text: table.rows[r][c] ?? '',
        bounds: { x, y, width: widths[c], height: heights[r] },
        typography: { fontSize: 16, padding: 8, ...drawing.typography, bold: r === 0 },
        fill: '#253044',
      };
      const layout = layoutDrawingText(cell);
      const cellAddress = { ...address, path: `table.rows[${r}][${c}]` };
      checkText(p, cell, cellAddress, layout, false);
      if (layout.totalHeight > cell.bounds.height - layout.padding * 2)
        p.add(
          'TEXT_LAYOUT_UNREPRESENTABLE',
          'error',
          'Native table cell would overflow its fixed row; resize the row',
          cellAddress,
        );
      cells.push({ row: r, col: c, bounds: cell.bounds, text: cell.text, layout });
      x += widths[c];
    }
    y += heights[r];
  }
}
/** Mirrored or clipped text cannot stay editable Office text. */
async function planTextFallbacks(p: PptxPlanner, element: PptxElement) {
  const { drawing } = element;
  if ((drawing.flipX || drawing.flipY) && element.representation !== 'png')
    await p.fallback(element, 'Office keeps native text readable instead of mirroring its glyphs');
  if (
    drawing.typography?.overflow !== 'expand' &&
    element.textLayout!.totalHeight > drawing.bounds.height - element.textLayout!.padding * 2 &&
    element.representation !== 'png'
  )
    await p.fallback(element, 'Visible clipped text cannot be represented as editable Office text');
}
