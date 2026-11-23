import type { TextRun, TextStyle } from '@editor-platform/editor-core';
import type { Slide, SlideContent, SlideObject } from './model';

/**
 * The fields a deck may hold, per level. Each list is checked against the model's type, so a field
 * added to (or removed from) the model does not compile until it is listed here as well.
 */
const deckFields = {
  schemaVersion: true,
  reuse: true,
  theme: true,
  width: true,
  height: true,
  slides: true,
  liveSnapshots: true,
} as const satisfies Record<keyof SlideContent, true>;
const slideFields = {
  id: true,
  title: true,
  background: true,
  objects: true,
  notes: true,
  hidden: true,
  backgroundImage: true,
} as const satisfies Record<keyof Slide, true>;
const objectFields = {
  reference: true,
  liveQuote: true,
  animation: true,
  id: true,
  type: true,
  bounds: true,
  text: true,
  fill: true,
  src: true,
  chart: true,
  table: true,
  groupId: true,
  shape: true,
  stroke: true,
  strokeWidth: true,
  dash: true,
  opacity: true,
  radius: true,
  rotation: true,
  flipX: true,
  flipY: true,
  locked: true,
  hidden: true,
  typography: true,
  runs: true,
  imageFit: true,
  crop: true,
  alt: true,
  arrowhead: true,
  lineDirection: true,
} as const satisfies Record<keyof SlideObject, true>;
const textStyleFields = {
  fontFamily: true,
  fontSize: true,
  bold: true,
  italic: true,
  underline: true,
  strike: true,
  color: true,
  lineHeight: true,
  letterSpacing: true,
  align: true,
  verticalAlign: true,
  padding: true,
  list: true,
  overflow: true,
  writingMode: true,
} as const satisfies Record<keyof TextStyle, true>;
const runFields = { text: true, style: true } as const satisfies Record<keyof TextRun, true>;

/** A field the deck holds that the Slide model does not read, so the editor ignores it. */
export interface SlideUnknownField {
  /** The page it is on, when it is inside one. */
  slideId?: string;
  /** The object it is on, when it is inside one. */
  objectId?: string;
  /** Where it is, as `slides[2].objects[3].fontSize`. */
  path: string;
  /** Where the field belongs, when it is a known field written at the wrong level. */
  hint?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const known = (fields: object, key: string) => Object.hasOwn(fields, key);
const idOf = (v: Record<string, unknown>) => (typeof v.id === 'string' ? v.id : undefined);

function hintFor(level: 'deck' | 'slide' | 'object' | 'style' | 'run', key: string) {
  if (level === 'object' && known(textStyleFields, key)) return `typography.${key} に書く`;
  if (level === 'run' && known(textStyleFields, key)) return `runs[].style.${key} に書く`;
  if (level === 'slide' && known(objectFields, key)) return `slides[].objects[] の要素に書く`;
  if (level === 'deck' && known(slideFields, key)) return `slides[] の要素に書く`;
  return undefined;
}

/**
 * Fields in a deck that the Slide model does not read. The editor keeps reading such a deck and
 * silently ignores them, so a writer that put a value in the wrong place gets no error; this
 * lists them with the place each known field belongs. Values are not validated here.
 */
export function slideUnknownFields(content: unknown): SlideUnknownField[] {
  const out: SlideUnknownField[] = [];
  if (!isRecord(content)) return out;
  const report = (
    record: Record<string, unknown>,
    fields: object,
    level: 'deck' | 'slide' | 'object' | 'style' | 'run',
    path: string,
    at: { slideId?: string; objectId?: string },
  ) => {
    for (const key of Object.keys(record))
      if (!known(fields, key)) {
        const hint = hintFor(level, key);
        out.push({ ...at, path: path ? `${path}.${key}` : key, ...(hint ? { hint } : {}) });
      }
  };
  const style = (value: unknown, path: string, at: { slideId?: string; objectId?: string }) => {
    if (isRecord(value)) report(value, textStyleFields, 'style', path, at);
  };
  report(content, deckFields, 'deck', '', {});
  const slides = Array.isArray(content.slides) ? content.slides : [];
  slides.forEach((slide, i) => {
    if (!isRecord(slide)) return;
    const slideId = idOf(slide),
      slidePath = `slides[${i}]`;
    report(slide, slideFields, 'slide', slidePath, { slideId });
    const objects = Array.isArray(slide.objects) ? slide.objects : [];
    objects.forEach((object, j) => {
      if (!isRecord(object)) return;
      const at = { slideId, objectId: idOf(object) },
        path = `${slidePath}.objects[${j}]`;
      report(object, objectFields, 'object', path, at);
      style(object.typography, `${path}.typography`, at);
      if (Array.isArray(object.runs))
        object.runs.forEach((run, k) => {
          if (!isRecord(run)) return;
          report(run, runFields, 'run', `${path}.runs[${k}]`, at);
          style(run.style, `${path}.runs[${k}].style`, at);
        });
    });
  });
  return out;
}
