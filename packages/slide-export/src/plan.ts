import { canonicalJson, clone, contentHash, deepFreeze } from '@editor-platform/artifact-core';
import {
  layoutDrawingText,
  shapeNames,
  type Drawing,
  type DrawingTextLayout,
} from '@editor-platform/editor-core';
import {
  isDeck,
  slideDrawing,
  slidePaintOrder,
  type SlideContent,
} from '@editor-platform/slide/model';
import {
  captureExportSnapshot,
  checkExportAbort,
  exportAssetLimits,
  exportDiagnostic,
  exportColor,
  ExportAdapterError,
  hashExportBytes,
  missingFontGlyphs,
  ownExportAsset,
  validExportBasis,
  validFontProfile,
  type CaptureBasis,
  type ExportDiagnostic,
  type ExportFontProfile,
  type SlideExportAddress,
} from '@editor-platform/export-core';
import {
  slidePptxCapabilities,
  type OwnedPptxPlan,
  type PptxAdapters,
  type PptxElement,
  type PptxPage,
  type ResolvedPptxAsset,
  type SlideExportSnapshot,
  type SlidePptxOptions,
  type SlidePptxPlan,
  type SlidePptxReport,
} from './types';
import { pptxImagePlacement, shapeRasterBounds } from './geometry';

export const slidePptxExporterVersion = '1.2.0';
const plans = new WeakMap<SlidePptxPlan, OwnedPptxPlan>();
/** Package-private: consumers cannot manufacture or replace an encoding plan via JSON. */
export function ownedSlidePptxPlan(plan: SlidePptxPlan): OwnedPptxPlan | undefined {
  return plans.get(plan);
}
export const captureSlideExportSnapshot = (content: SlideContent, basis: CaptureBasis) =>
  captureExportSnapshot(content, basis);

export async function prepareSlidePptx(
  snapshot: SlideExportSnapshot,
  options: SlidePptxOptions,
  adapters: PptxAdapters,
  signal?: AbortSignal,
): Promise<SlidePptxPlan> {
  checkExportAbort(signal);
  // Copy every caller-controlled synchronous input before awaiting either hashes or adapters.
  let input: SlideExportSnapshot, settings: SlidePptxOptions;
  try {
    input = deepFreeze(clone(snapshot));
    settings = deepFreeze(clone(options));
  } catch {
    return invalidPlan('Input must be serializable domain data');
  }
  const services = {
    resolveFont: adapters?.resolveFont?.bind(adapters),
    resolveAsset: adapters?.resolveAsset?.bind(adapters),
    rasterize: adapters?.rasterize?.bind(adapters),
  };
  const diagnostics: ExportDiagnostic<SlideExportAddress>[] = [];
  const diagnosticIds = new Set<string>();
  const reportElements: SlidePptxReport['elements'] = [];
  const add = (
    code: string,
    severity: ExportDiagnostic['severity'],
    message: string,
    address?: SlideExportAddress,
    effect?: ExportDiagnostic['effect'],
  ) => {
    const d = exportDiagnostic(code, severity, message, address, effect);
    if (!diagnosticIds.has(d.id)) {
      diagnostics.push(d);
      diagnosticIds.add(d.id);
    }
  };
  let valid = false;
  try {
    valid = isDeck(input?.content) && validExportBasis(input?.basis);
  } catch {
    /* Invalid native input. */
  }
  if (!valid) return invalidPlan('Invalid Slide content or export basis', input?.basis);
  const deck = input.content as SlideContent;
  if (deck.reuse && (deck.reuse.instances.length || deck.reuse.artifactMode))
    add(
      'REUSABLE_LINKS_RESOLVED',
      'warning',
      'Exports the adopted native appearance. Library links, token modes, variant controls and typed slots are not retained in PPTX or restored by Office import.',
      { domain: 'slide' },
      'editability',
    );
  if ((await contentHash(deck)) !== input.basis.contentHash)
    add('SNAPSHOT_HASH_MISMATCH', 'error', 'Captured content does not match its declared hash');
  checkExportAbort(signal);
  if (
    !settings ||
    !['reject', 'element-png'].includes(settings.fallback) ||
    typeof settings.includeHiddenSlides !== 'boolean' ||
    typeof settings.includeNotes !== 'boolean' ||
    typeof settings.fontProfileId !== 'string' ||
    !settings.fontProfileId
  )
    return invalidPlan('Invalid export options', input.basis);
  const chosen = settings.pageIds === 'all' ? deck.slides.map((s) => s.id) : settings.pageIds;
  if (
    !Array.isArray(chosen) ||
    !chosen.length ||
    new Set(chosen).size !== chosen.length ||
    chosen.some((id) => typeof id !== 'string' || !deck.slides.some((s) => s.id === id))
  )
    add('INVALID_PAGE_SELECTION', 'error', 'Choose distinct existing pages');
  if (
    [deck.width, deck.height].some(
      (n) => n < slidePptxCapabilities.minPageSide || n > slidePptxCapabilities.maxPageSide,
    )
  )
    add('PAGE_SIZE_UNSUPPORTED', 'error', 'Page sides must be between 100 and 3840 CSS pixels');
  const pages: PptxPage[] = [],
    assets = new Map<string, ResolvedPptxAsset>();
  const selected = Array.isArray(chosen) ? deck.slides.filter((s) => chosen.includes(s.id)) : [];
  if (
    selected.length > slidePptxCapabilities.slides ||
    selected.reduce((n, s) => n + s.objects.length, 0) > slidePptxCapabilities.objects
  )
    add('LIMIT_EXCEEDED', 'error', 'At most 100 slides and 10,000 objects can be exported');
  let font: ExportFontProfile | undefined;
  if (!services.resolveFont)
    add('ADAPTER_UNAVAILABLE', 'error', 'A verified font resolver is required');
  else {
    try {
      font = deepFreeze(clone(await services.resolveFont(settings.fontProfileId, signal)));
      checkExportAbort(signal);
      if (!validFontProfile(font, settings.fontProfileId)) {
        add('FONT_INVALID', 'error', 'Font manifest is incomplete or belongs to another profile');
        font = undefined;
      } else {
        add(
          'FONT_REFERENCED_NOT_EMBEDDED',
          'info',
          `Recipients need ${font.family} ${font.version}; fonts are not embedded`,
        );
        if (!font.verified)
          add(
            'FONT_UNVERIFIED',
            'warning',
            'Font rendering has not been verified',
            undefined,
            'appearance',
          );
      }
    } catch {
      checkExportAbort(signal);
      add('FONT_UNAVAILABLE', 'error', 'The selected font profile could not be resolved');
    }
  }
  let assetBytes = 0;
  const storeAsset = async (key: string, value: Parameters<typeof ownExportAsset>[0]) => {
    const asset = ownExportAsset(value);
    if (assetBytes + asset.bytes.length > exportAssetLimits.totalBytes)
      throw new Error('Total image bytes exceed 64 MiB');
    const resolved = { ...asset, hash: await hashExportBytes(asset.bytes) };
    checkExportAbort(signal);
    assetBytes += resolved.bytes.length;
    if (assetBytes > exportAssetLimits.totalBytes)
      throw new Error('Total image bytes exceed 64 MiB');
    assets.set(key, resolved);
    return resolved;
  };
  const resolve = async (source: string | undefined, address: SlideExportAddress) => {
    if (!source) {
      add('ASSET_UNAVAILABLE', 'error', 'An image source is missing', address);
      return;
    }
    if (assets.has(`source:${source}`)) return assets.get(`source:${source}`);
    if (!services.resolveAsset) {
      add('ADAPTER_UNAVAILABLE', 'error', 'An image resolver is required', address);
      return;
    }
    let value;
    try {
      value = await services.resolveAsset(source, signal);
    } catch {
      checkExportAbort(signal);
      add('ASSET_UNAVAILABLE', 'error', 'Image resolution failed', address);
      return;
    }
    try {
      return await storeAsset(`source:${source}`, value);
    } catch {
      checkExportAbort(signal);
      add('ASSET_INVALID', 'error', 'Image data, dimensions or byte limits are invalid', address);
    }
  };
  const checkText = (
    drawing: Drawing,
    address: SlideExportAddress,
    layout: DrawingTextLayout,
    split = true,
  ) => {
    if (!font) return;
    if (missingFontGlyphs(drawing.text, font).length)
      add('FONT_GLYPH_MISSING', 'error', 'The fixed font profile lacks required glyphs', address);
    if (
      Array.from(drawing.text).some((c) => {
        const n = c.codePointAt(0)!;
        return (
          (n < 32 && ![9, 10, 13].includes(n)) ||
          (n >= 0xd800 && n <= 0xdfff) ||
          n === 0xfffe ||
          n === 0xffff
        );
      })
    )
      add('TEXT_CHARACTER_UNSUPPORTED', 'error', 'Text contains an XML control character', address);
    if (/\p{Extended_Pictographic}|\u200d|\ufe0f|[\u0590-\u08ff]/u.test(drawing.text))
      add(
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
    if ([...families].some((f) => f !== font!.family))
      add(
        'FONT_SUBSTITUTED',
        'warning',
        `Text will reference ${font.family} instead of ${[...families].join('; ')}`,
        address,
        'appearance',
      );
    if (split && layout.lines.length > 1)
      add(
        'TEXT_BOX_SPLIT',
        'warning',
        'Calculated lines become ordered native text boxes; edit each line separately',
        address,
        'editability',
      );
    add(
      'TEXT_REFLOW_RISK',
      'warning',
      'Office font metrics may change text after external editing',
      address,
      'appearance',
    );
  };
  const fallback = async (
    element: PptxElement,
    reason: string,
    sourceImage?: ResolvedPptxAsset,
  ) => {
    if (settings.fallback === 'reject') {
      add('UNSUPPORTED_ELEMENT', 'error', reason, element.address);
      return;
    }
    if (!services.rasterize) {
      add(
        'ADAPTER_UNAVAILABLE',
        'error',
        'Element PNG conversion requires a raster adapter',
        element.address,
      );
      return;
    }
    try {
      const key = `raster:${canonicalJson(element.address)}`;
      const drawing = clone(element.drawing);
      // A fallback owns local paint only. The Office picture applies the outer transform once.
      drawing.rotation = 0;
      drawing.flipX = false;
      drawing.flipY = false;
      drawing.opacity = 1;
      if (font) {
        drawing.typography = { ...drawing.typography, fontFamily: font.family };
        drawing.runs = drawing.runs?.map((r) => ({
          ...r,
          style: { ...r.style, fontFamily: font.family },
        }));
      }
      const b = shapeRasterBounds(drawing);
      const outset =
        drawing.kind === 'shape'
          ? (drawing.strokeWidth ?? 1) / 2
          : drawing.kind === 'table'
            ? 0.5
            : 0;
      const layout = element.textLayout;
      const top =
        drawing.typography?.overflow === 'expand' && layout ? Math.min(b.y, layout.startY) : b.y;
      const bottom =
        drawing.typography?.overflow === 'expand' && layout
          ? Math.max(b.y + b.height, layout.startY + layout.totalHeight)
          : b.y + b.height;
      const bounds = {
        x: b.x - outset,
        y: top - outset,
        width: b.width + outset * 2,
        height: bottom - top + outset * 2,
      };
      const result = await services.rasterize(
        {
          drawing,
          bounds: clone(bounds),
          scale: 2,
          ...(sourceImage ? { sourceImage: ownExportAsset(sourceImage) } : {}),
        },
        signal,
      );
      if (result.mime !== 'image/png') throw new Error('Raster adapter must return PNG');
      const region = result.bounds ? clone(result.bounds) : bounds;
      if (
        ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
        region.width <= 0 ||
        region.height <= 0 ||
        region.x > bounds.x ||
        region.y > bounds.y ||
        region.x + region.width < bounds.x + bounds.width ||
        region.y + region.height < bounds.y + bounds.height
      )
        throw new Error('Raster adapter cannot crop the requested paint region');
      if (
        result.width !== Math.max(1, Math.ceil(region.width * 2)) ||
        result.height !== Math.max(1, Math.ceil(region.height * 2))
      )
        throw new Error('Raster dimensions do not match the requested region and scale');
      await storeAsset(key, result);
      element.imageKey = key;
      element.imagePlacement = { bounds: region, crop: { left: 0, right: 0, top: 0, bottom: 0 } };
      element.representation = 'png';
      if (element.drawing.kind === 'image')
        add(
          'IMAGE_CROP_BAKED',
          'warning',
          'The visible crop and fit are baked into this PNG; the original framing cannot be recovered',
          element.address,
          'editability',
        );
      add(
        'ELEMENT_RASTERIZED',
        'warning',
        `${reason}. This element, including its text, becomes an uneditable picture`,
        element.address,
        'editability',
      );
    } catch (error) {
      checkExportAbort(signal);
      if (error instanceof ExportAdapterError)
        add(error.code, 'error', error.message, element.address);
      else add('RASTER_FAILED', 'error', 'Element PNG rendering failed', element.address);
    }
  };
  if (
    !diagnostics.some((d) =>
      ['INVALID_PAGE_SELECTION', 'PAGE_SIZE_UNSUPPORTED', 'LIMIT_EXCEEDED'].includes(d.code),
    )
  )
    for (const slide of selected) {
      checkExportAbort(signal);
      const pageAddress: SlideExportAddress = { domain: 'slide', slideId: slide.id };
      if (slide.hidden && !settings.includeHiddenSlides) {
        add(
          'HIDDEN_SLIDE_EXCLUDED',
          'info',
          'Hidden page excluded by selection',
          pageAddress,
          'omitted-by-choice',
        );
        for (const object of slide.objects)
          reportElements.push({
            address: { ...pageAddress, elementId: object.id },
            representation: 'omitted',
            outputPartNames: [],
            counted: object.type !== 'group',
          });
        continue;
      }
      if (slide.hidden)
        add(
          'HIDDEN_FLAG_NOT_PRESERVED',
          'warning',
          'Included hidden page becomes an ordinary Office page',
          pageAddress,
          'appearance',
        );
      if (slide.notes && !settings.includeNotes)
        add('NOTES_EXCLUDED', 'info', 'Notes excluded by choice', pageAddress, 'omitted-by-choice');
      const page: PptxPage = {
        id: slide.id,
        background: slide.background,
        notes: settings.includeNotes ? slide.notes : undefined,
        elements: [],
      };
      if (!exportColor(page.background))
        add(
          'COLOR_UNSUPPORTED',
          'error',
          'Page background is not a supported CSS color',
          pageAddress,
        );
      if (
        page.notes &&
        Array.from(page.notes).some((c) => {
          const n = c.codePointAt(0)!;
          return (
            (n < 32 && ![9, 10, 13].includes(n)) ||
            (n >= 0xd800 && n <= 0xdfff) ||
            n === 0xfffe ||
            n === 0xffff
          );
        })
      )
        add(
          'TEXT_CHARACTER_UNSUPPORTED',
          'error',
          'Notes contain an XML control character',
          pageAddress,
        );
      pages.push(page);
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
      for (const drawing of drawings) {
        checkExportAbort(signal);
        const address: SlideExportAddress = {
          ...pageAddress,
          ...(drawing.id ? { elementId: drawing.id } : { path: 'backgroundImage' }),
        };
        const element: PptxElement = { address, drawing, representation: 'native' };
        page.elements.push(element);
        if (!drawing.hidden && drawing.kind !== 'group') {
          const colors = [
            drawing.fill,
            drawing.stroke,
            drawing.typography?.color,
            ...(drawing.runs ?? []).map((r) => r.style?.color),
          ].filter((c): c is string => c !== undefined);
          if (colors.some((c) => !exportColor(c)))
            add(
              'COLOR_UNSUPPORTED',
              'error',
              'An element contains an unsupported CSS color',
              address,
            );
          if (drawing.dash && !/^\s*\d+(?:\.\d+)?(?:[ ,]+\d+(?:\.\d+)?)*\s*$/.test(drawing.dash))
            add(
              'DASH_UNSUPPORTED',
              'error',
              'Dash lengths must be non-negative CSS pixel numbers',
              address,
            );
          if (drawing.kind === 'text' || (drawing.kind === 'shape' && drawing.text)) {
            element.textLayout = layoutDrawingText(drawing);
            checkText(drawing, address, element.textLayout);
          }
          if (
            font &&
            drawing.kind === 'chart' &&
            missingFontGlyphs(
              [drawing.chart?.label, ...(drawing.chart?.labels ?? [])].join(''),
              font,
            ).length
          )
            add(
              'FONT_GLYPH_MISSING',
              'error',
              'The fixed font profile lacks chart glyphs',
              address,
            );
          if (
            font &&
            drawing.kind === 'table' &&
            missingFontGlyphs(drawing.table?.rows.flat().join('') ?? '', font).length
          )
            add(
              'FONT_GLYPH_MISSING',
              'error',
              'The fixed font profile lacks table glyphs',
              address,
            );
        }
        if (drawing.hidden) {
          element.representation = 'omitted';
          add(
            'HIDDEN_ELEMENT_EXCLUDED',
            'info',
            'Hidden element is not painted',
            address,
            'omitted-by-choice',
          );
        } else if (drawing.kind === 'group') {
          add(
            'GROUP_FLATTENED',
            'warning',
            'Children keep world coordinates and paint order; the group container is not retained',
            address,
            'editability',
          );
        } else if (drawing.kind === 'image') {
          const asset = await resolve(drawing.src, address);
          if (asset) {
            element.imageKey = `source:${drawing.src}`;
            element.imagePlacement = pptxImagePlacement(drawing, asset.width, asset.height);
            if (!element.imagePlacement) {
              element.representation = 'omitted';
              add(
                'IMAGE_EXCLUDED_BY_CROP',
                'info',
                'The crop places the entire bitmap outside its visible region',
                address,
                'omitted-by-choice',
              );
            } else if (asset.mime === 'image/webp' || asset.mime === 'image/gif') {
              if (asset.mime === 'image/gif')
                add(
                  'IMAGE_ANIMATION_FLATTENED',
                  'warning',
                  'GIF exports its first decoded frame',
                  address,
                  'appearance',
                );
              await fallback(element, 'Office does not retain this image format', asset);
            }
          }
        } else if (drawing.kind === 'chart')
          await fallback(element, 'Charts are static snapshots in this exporter');
        else if (drawing.kind === 'shape' && !shapeNames.includes(drawing.shape!))
          add(
            'UNSUPPORTED_ELEMENT',
            'error',
            'Unknown shape has no verified native or raster mapping',
            address,
          );
        else if (
          drawing.kind === 'shape' &&
          !(slidePptxCapabilities.nativeShapes as readonly string[]).includes(drawing.shape!)
        )
          await fallback(element, 'This shape has no native Office mapping');
        else if (drawing.kind === 'table') {
          const table = drawing.table;
          if (
            !table ||
            !Array.isArray(table.rows) ||
            !table.rows.length ||
            !table.rows.every(
              (r) => Array.isArray(r) && r.length && r.every((c) => typeof c === 'string'),
            )
          ) {
            add('INVALID_CONTENT', 'error', 'Table rows must contain text cells', address);
          } else if (drawing.flipX || drawing.flipY || (drawing.rotation ?? 0) % 360 !== 0)
            await fallback(
              element,
              'The verified Office renderer cannot rotate or mirror native table cell text and fills consistently',
            );
          else if (table.merges?.length)
            await fallback(element, 'Slide merged tables require element rendering');
          else if (
            (drawing.opacity ?? 1) < 1 ||
            (exportColor(drawing.stroke ?? '#8e9eb5')?.alpha ?? 1) < 1
          )
            await fallback(
              element,
              'The verified Office renderer ignores native table border transparency',
            );
          else {
            const columns = Math.max(...table.rows.map((r) => r.length));
            const widths =
              table.columnWidths ?? Array(columns).fill(drawing.bounds.width / columns);
            const heights =
              table.rowHeights ??
              Array(table.rows.length).fill(drawing.bounds.height / table.rows.length);
            if (
              widths.length !== columns ||
              heights.length !== table.rows.length ||
              [...widths, ...heights].some((n) => !Number.isFinite(n) || n <= 0)
            )
              add(
                'INVALID_CONTENT',
                'error',
                'Table dimensions must be positive and match its grid',
                address,
              );
            else {
              element.tableCells = [];
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
                  checkText(cell, cellAddress, layout, false);
                  if (layout.totalHeight > cell.bounds.height - layout.padding * 2)
                    add(
                      'TEXT_LAYOUT_UNREPRESENTABLE',
                      'error',
                      'Native table cell would overflow its fixed row; resize the row',
                      cellAddress,
                    );
                  element.tableCells.push({
                    row: r,
                    col: c,
                    bounds: cell.bounds,
                    text: cell.text,
                    layout,
                  });
                  x += widths[c];
                }
                y += heights[r];
              }
            }
          }
        }
        if (
          !drawing.hidden &&
          (drawing.kind === 'text' || drawing.kind === 'shape') &&
          drawing.text
        ) {
          if ((drawing.flipX || drawing.flipY) && element.representation !== 'png')
            await fallback(
              element,
              'Office keeps native text readable instead of mirroring its glyphs',
            );
          if (
            drawing.typography?.overflow !== 'expand' &&
            element.textLayout!.totalHeight >
              drawing.bounds.height - element.textLayout!.padding * 2 &&
            element.representation !== 'png'
          )
            await fallback(
              element,
              'Visible clipped text cannot be represented as editable Office text',
            );
        }
        if (
          !drawing.hidden &&
          drawing.kind === 'shape' &&
          element.representation === 'native' &&
          !['rectangle', 'ellipse', 'line'].includes(drawing.shape!)
        ) {
          element.representation = 'native-approximation';
          add(
            'SHAPE_GEOMETRY_APPROXIMATED',
            'warning',
            'Native Office shape contours can differ from the Editor path',
            address,
            'appearance',
          );
        }
        reportElements.push({
          address,
          representation: element.representation,
          outputPartNames: [],
          counted: drawing.kind !== 'group',
        });
      }
    }
  if (!pages.length && !diagnostics.some((d) => d.severity === 'error'))
    add('INVALID_PAGE_SELECTION', 'error', 'No visible selected page remains');
  const counts = { native: 0, approximated: 0, rasterized: 0, omitted: 0 };
  for (const e of reportElements)
    if (e.counted)
      counts[
        e.representation === 'native-approximation'
          ? 'approximated'
          : e.representation === 'png'
            ? 'rasterized'
            : e.representation
      ]++;
  const planHash = await contentHash({
    exporterVersion: slidePptxExporterVersion,
    basis: input.basis,
    options: settings,
    font,
    pages,
    assets: [...assets].map(([key, a]) => ({
      key,
      hash: a.hash,
      mime: a.mime,
      width: a.width,
      height: a.height,
    })),
    diagnostics: diagnostics.map(({ id, code, severity, effect, requiresAcceptance }) => ({
      id,
      code,
      severity,
      effect,
      requiresAcceptance,
    })),
  });
  checkExportAbort(signal);
  const report: SlidePptxReport = {
    schemaVersion: 1,
    exporterVersion: slidePptxExporterVersion,
    planHash,
    basis: clone(input.basis),
    selectedPageIds: pages.map((p) => p.id),
    diagnostics,
    elements: reportElements,
    counts,
  };
  return register({
    report: deepFreeze(report),
    width: deck.width,
    height: deck.height,
    options: settings,
    pages: deepFreeze(pages),
    font,
    assets,
  });
}
function register(state: OwnedPptxPlan): SlidePptxPlan {
  const handle = Object.freeze({ report: state.report }) as SlidePptxPlan;
  plans.set(handle, state);
  return handle;
}
async function invalidPlan(
  message: string,
  origin?: SlideExportSnapshot['basis'],
): Promise<SlidePptxPlan> {
  const basis = validExportBasis(origin as never)
    ? clone(origin!)
    : {
        kind: 'local-draft' as const,
        artifactId: 'invalid-input',
        contentHash: await contentHash(null),
      };
  const diagnostics = [exportDiagnostic<SlideExportAddress>('INVALID_CONTENT', 'error', message)];
  const report: SlidePptxReport = {
    schemaVersion: 1,
    exporterVersion: slidePptxExporterVersion,
    basis,
    planHash: await contentHash({ basis, code: 'INVALID_CONTENT' }),
    diagnostics,
    selectedPageIds: [],
    elements: [],
    counts: { native: 0, approximated: 0, rasterized: 0, omitted: 0 },
  };
  return register({
    report: deepFreeze(report),
    width: 0,
    height: 0,
    pages: [],
    assets: new Map(),
    options: {
      pageIds: 'all',
      includeHiddenSlides: false,
      includeNotes: false,
      fontProfileId: '',
      fallback: 'reject',
    },
  });
}
