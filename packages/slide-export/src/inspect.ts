import {
  drawingSvg,
  gridTextLayout,
  layoutDrawingText,
  usesGridText,
  type Bounds,
  type Drawing,
} from '@editor-platform/editor-core';
import type { OfficeFonts } from '@editor-platform/office-adapters';
import { createOfficeSvgRenderer } from '@editor-platform/office-adapters/raster';
import {
  isDeck,
  slideDrawing,
  slidePaintOrder,
  type Slide,
  type SlideContent,
  type SlideObject,
} from '@editor-platform/slide/model';

/**
 * Headless checks for a Host or a pipeline: a slide as a PNG, and text that does not fit its box.
 * Both read the same drawings the editor and the static exports paint; neither edits the deck.
 */

/** Why an inspection refused its input. */
export class SlideInspectError extends Error {
  constructor(
    readonly code: 'INVALID_DECK' | 'UNKNOWN_SLIDE' | 'INVALID_SCALE',
    message: string,
  ) {
    super(message);
    this.name = 'SlideInspectError';
  }
}

export interface SlidePng {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * One text box whose text does not stay where the deck puts it.
 * - `clipped`: the text needs more room than its box and the box cuts it off (`clip`, or `fit`
 *   that reached the smallest size).
 * - `outside-slide`: the text paints past the slide's edge (`expand`, or a box placed partly off
 *   the slide).
 * - `shrunk`: `fit` drew the text smaller than its set size to keep it inside the box.
 */
export interface SlideTextIssue {
  slideId: string;
  objectId: string;
  kind: 'clipped' | 'outside-slide' | 'shrunk';
  /** The object's box on the slide. */
  box: Bounds;
  /** Where the text paints, before any clipping. */
  painted: Bounds;
  /** The size the text is drawn at, and the size the deck sets, for `shrunk`. */
  fontSize?: number;
  setFontSize?: number;
}

export interface SlideTextOptions {
  /** Only this slide. Without it, every slide that is not hidden. */
  slideId?: string;
}

/** Rounding of laid-out and painted edges that is not a real overflow. */
const tolerance = 0.5;
const maxScale = 4;

function deck(content: unknown): SlideContent {
  if (!isDeck(content)) throw new SlideInspectError('INVALID_DECK', 'Not a valid slide deck');
  return content;
}
function pages(content: SlideContent, slideId: string | undefined): Slide[] {
  if (slideId === undefined) return content.slides.filter((s) => !s.hidden);
  const slide = content.slides.find((s) => s.id === slideId);
  if (!slide) throw new SlideInspectError('UNKNOWN_SLIDE', `No slide ${slideId}`);
  return [slide];
}
const frame = (content: SlideContent): Bounds => ({
  x: 0,
  y: 0,
  width: content.width,
  height: content.height,
});
/** The drawings a slide paints, in paint order. An embedded Animation paints its poster. */
const visibleDrawings = (slide: Slide) =>
  slidePaintOrder(slide)
    .filter((o) => !o.hidden)
    .map((o) => ({ object: o, drawing: slideDrawing(o) }));
const hasText = (object: SlideObject, drawing: Drawing) =>
  (object.type === 'text' || object.type === 'shape') && !!drawing.text?.trim();
function setFontSize(d: Drawing) {
  return d.typography?.fontSize ?? (d.kind === 'text' ? 28 : 18);
}
function drawnFontSize(d: Drawing) {
  return usesGridText(d) ? gridTextLayout(d).fontSize : layoutDrawingText(d).fontSize;
}
/** Only the text of a box, unclipped: a text drawing with the same box, padding and style. */
function textOnly(d: Drawing): Drawing {
  const padding = d.typography?.padding ?? (d.kind === 'text' ? 4 : 10);
  return {
    id: d.id,
    kind: 'text',
    bounds: d.bounds,
    text: d.text,
    runs: d.runs,
    fill: d.typography?.color ?? (d.kind === 'text' ? d.fill : '#253044'),
    // Flips move the text inside its box as the renderer reflects it (rotation is not followed).
    flipX: d.flipX,
    flipY: d.flipY,
    typography: {
      ...d.typography,
      // Defaults depend on the drawing kind: keep the shape's own size and padding.
      fontSize: setFontSize(d),
      padding,
      color: d.typography?.color ?? (d.kind === 'text' ? d.fill : '#253044'),
    },
  } as Drawing;
}
const unclipped = (svg: string) => svg.replace(/ clip-path="url\(#text-[^"]*\)"/g, '');
function issuesFor(
  slide: Slide,
  object: SlideObject,
  drawing: Drawing,
  painted: Bounds,
  bounds: Bounds,
): SlideTextIssue[] {
  const box = drawing.bounds;
  const out: SlideTextIssue[] = [];
  const at = { slideId: slide.id, objectId: object.id, box, painted };
  const past = (inner: Bounds, outer: Bounds) =>
    inner.x < outer.x - tolerance ||
    inner.y < outer.y - tolerance ||
    inner.x + inner.width > outer.x + outer.width + tolerance ||
    inner.y + inner.height > outer.y + outer.height + tolerance;
  const overflow = drawing.typography?.overflow;
  if (overflow !== 'expand' && past(painted, box)) out.push({ ...at, kind: 'clipped' });
  const visible = overflow === 'expand' ? painted : intersect(painted, box);
  if (visible && past(visible, bounds)) out.push({ ...at, kind: 'outside-slide' });
  if (overflow === 'fit') {
    const fontSize = drawnFontSize(drawing),
      set = setFontSize(drawing);
    if (fontSize < set) out.push({ ...at, kind: 'shrunk', fontSize, setFontSize: set });
  }
  return out;
}
function intersect(a: Bounds, b: Bounds): Bounds | undefined {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    r = Math.min(a.x + a.width, b.x + b.width),
    bottom = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bottom > y ? { x, y, width: r - x, height: bottom - y } : undefined;
}

/**
 * Text that does not fit, from the editor's own text layout (no fonts needed). Line breaks and
 * heights are exact to what the editor draws; the width of a line is not measured, so text that
 * runs past the right edge with real glyphs is only found by `createSlideInspector`.
 */
export function estimateSlideTextOverflow(
  content: unknown,
  options: SlideTextOptions = {},
): SlideTextIssue[] {
  const d = deck(content);
  return pages(d, options.slideId).flatMap((slide) =>
    visibleDrawings(slide).flatMap(({ object, drawing }) => {
      if (!hasText(object, drawing)) return [];
      const b = drawing.bounds;
      let painted: Bounds;
      if (usesGridText(drawing)) {
        // The cells the glyphs occupy (gridTextExtent is a conservative enclosure of the box).
        const layout = gridTextLayout(drawing);
        const cells = layout.lines.flatMap((l) => l.glyphs);
        if (!cells.length) return [];
        const xs = cells.map((g) => g.x),
          ys = cells.map((g) => g.y),
          half = layout.fontSize / 2;
        painted = {
          x: Math.min(...xs) - half,
          y: Math.min(...ys) - half,
          width: Math.max(...xs) - Math.min(...xs) + layout.fontSize,
          height: Math.max(...ys) - Math.min(...ys) + layout.fontSize,
        };
      } else {
        const layout = layoutDrawingText(drawing);
        painted = { x: b.x, y: layout.startY, width: b.width, height: layout.totalHeight };
      }
      return issuesFor(slide, object, drawing, painted, frame(d));
    }),
  );
}

/**
 * Renders slides with the fixed Office fonts and the pinned SVG renderer, the same in Node and
 * browser workers, and never fetches: images must already be embedded in the deck.
 */
export async function createSlideInspector(wasm: Uint8Array, fonts: OfficeFonts) {
  const render = await createOfficeSvgRenderer(wasm, fonts);
  return {
    /** The slide as the static exports paint it, `scale` pixels per slide unit (1 to 4). */
    renderPng(content: unknown, slideId: string, options: { scale?: number } = {}): SlidePng {
      const d = deck(content);
      const [slide] = pages(d, slideId);
      const scale = options.scale ?? 1;
      if (!Number.isFinite(scale) || scale <= 0 || scale > maxScale)
        throw new SlideInspectError(
          'INVALID_SCALE',
          `Scale must be above 0 and at most ${maxScale}`,
        );
      const width = Math.max(1, Math.round(d.width * scale)),
        height = Math.max(1, Math.round(d.height * scale));
      const drawings = visibleDrawings(slide).map((v) => v.drawing);
      // The page background image first, as the static exports paint it.
      if (slide.backgroundImage)
        drawings.unshift({
          id: '',
          kind: 'image',
          text: '',
          fill: 'none',
          src: slide.backgroundImage,
          bounds: frame(d),
          imageFit: 'fill',
        });
      const svg = drawingSvg(drawings, frame(d), slide.background, slide.title).replace(
        /<svg\b[^>]*>/,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${d.width} ${d.height}" preserveAspectRatio="none">`,
      );
      const asset = render(svg, width, height);
      return { png: asset.bytes, width, height };
    },
    /** Text that does not fit, measured from the glyphs the renderer actually paints. */
    textOverflow(content: unknown, options: SlideTextOptions = {}): SlideTextIssue[] {
      const d = deck(content);
      return pages(d, options.slideId).flatMap((slide) =>
        visibleDrawings(slide).flatMap(({ object, drawing }) => {
          if (!hasText(object, drawing)) return [];
          const painted = render.measure(unclipped(drawingSvg([textOnly(drawing)], frame(d))));
          return painted ? issuesFor(slide, object, drawing, painted, frame(d)) : [];
        }),
      );
    },
  };
}
export type SlideInspector = Awaited<ReturnType<typeof createSlideInspector>>;
