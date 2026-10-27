import type { SourceRef } from '@editor-platform/animation-core';
import {
  validEmbeddedReference,
  validReferenceItems,
  describeReference,
  type EmbeddedReference,
} from '@editor-platform/artifact-references';
import {
  inspectPlayableAnimationEmbed,
  retainPlayableAnimationInputs,
  type PlayableAnimationEmbed,
  type AnimationHostContent,
} from '@editor-platform/animation-core/v2';
import { slideAnimationPoster } from './animation-poster';
import {
  clone,
  canonicalJson,
  describeChanges,
  isDeepFrozen,
  newId,
  type CompareResult,
} from '@editor-platform/artifact-core';
import { validNativeReuse, type ReuseState } from '@editor-platform/reuse-core';
import {
  command,
  immutableCommand,
  withCommandReads,
  drawingSvg,
  alignGeometry,
  distributeGeometry,
  transformGeometry,
  descendantIds,
  selectedRoots,
  assertEditable,
  type VisualStyle,
  type Drawing,
  type Alignment,
  type TransformDelta,
  type GeometryItem,
  unionBounds,
  validBounds,
  validVisualStyle,
  validHierarchy,
  describeDrawing,
  patchVisualStyle,
  matchingSizeBounds,
  reflectGeometry,
  reorderedSiblingIds,
  hierarchyPaintOrder,
  type Bounds,
  type EditorCommand,
} from '@editor-platform/editor-core';
export type SlideObjectType =
  | 'text'
  | 'shape'
  | 'image'
  | 'chart'
  | 'group'
  | 'table'
  | 'animation';
/** Generic insertion has no retained source; use placeSlideAnimation for that variant. */
export type SlideInsertType = Exclude<SlideObjectType, 'animation'>;
export interface ChartSnapshot {
  label: string;
  labels: string[];
  values: number[];
  capturedAt: string;
  type?: 'bar' | 'line' | 'pie';
  legend?: boolean;
}
export interface SlideObject extends VisualStyle {
  /** Reference source is canonical; src is a retained rendering cache. */
  reference?: EmbeddedReference;
  animation?: PlayableAnimationEmbed;
  id: string;
  type: SlideObjectType;
  bounds: Bounds;
  text: string;
  fill: string;
  src?: string;
  chart?: ChartSnapshot;
  table?: Drawing['table'];
  groupId?: string;
}
export interface Slide {
  id: string;
  title: string;
  background: string;
  objects: SlideObject[];
  notes?: string;
  hidden?: boolean;
  backgroundImage?: string;
}
export interface SlideContent {
  schemaVersion: 1 | 2;
  reuse?: ReuseState;
  theme?: { color: string; fontFamily: string };
  width: number;
  height: number;
  slides: Slide[];
}
export interface SlideAnimationSource {
  source: SourceRef;
  content: AnimationHostContent;
  label: string;
  versionLabel: string;
}
export const hasSlideAnimations = (content: SlideContent) =>
  content.slides.some((page) => page.objects.some((object) => object.type === 'animation'));
/** Only schema 2 embeds participate in the ordinary shared codec. */
export const hasLegacySlideAnimations = (content: SlideContent) =>
  content.slides.some((page) =>
    page.objects.some(
      (object) => object.type === 'animation' && object.animation?.format !== 'animation-embed-2',
    ),
  );
/** Retained reuse and Animation are separate capabilities in the current Slide gate. */
export const hasSlideReuse = (content: SlideContent) =>
  !!(
    content.reuse?.instances.length ||
    content.reuse?.closures.length ||
    content.reuse?.artifactMode
  );
/** Largest frame with the composition's aspect ratio that fits inside the slide's
 * margins, centred on the slide. */
export function slideAnimationBounds(
  deck: Pick<SlideContent, 'width' | 'height'>,
  animation: PlayableAnimationEmbed,
): Bounds {
  const composition = animation.snapshot.compositions.find(
      (c) => c.id === animation.source.compositionId,
    ),
    source =
      composition && composition.width > 0 && composition.height > 0
        ? composition
        : { width: 16, height: 9 },
    margin = Math.round(Math.min(deck.width, deck.height) * 0.08),
    scale = Math.min(
      (deck.width - margin * 2) / source.width,
      (deck.height - margin * 2) / source.height,
    ),
    // Very narrow compositions keep the 1 px minimum that valid bounds require.
    width = Math.max(1, Math.round(source.width * scale)),
    height = Math.max(1, Math.round(source.height * scale));
  return {
    x: Math.round((deck.width - width) / 2),
    y: Math.round((deck.height - height) / 2),
    width,
    height,
  };
}
export function placeSlideAnimation(
  pageId: string,
  animation: PlayableAnimationEmbed,
  id: string,
): EditorCommand<SlideContent> {
  const owned = retainPlayableAnimationInputs(animation);
  return immutableCommand('slide.animation.insert', 'Place saved Animation', (content) => {
    if (hasSlideReuse(content))
      throw Error(
        '再利用部品・テンプレート・表示モードを含む Slide への Animation 配置は未対応です。',
      );
    if (!content.slides.some((p) => p.id === pageId))
      throw Error('配置先のページが削除されました。');
    const next = {
      ...content,
      slides: content.slides.map((page) =>
        page.id === pageId
          ? {
              ...page,
              objects: [
                ...page.objects,
                {
                  ...baseSlideObject('animation', page.objects.length),
                  id,
                  animation: owned,
                  bounds: slideAnimationBounds(content, owned),
                },
              ],
            }
          : page,
      ),
    };
    if (!isDeck(next)) throw Error('アニメーションの形式または保持上限が不正です。');
    return next;
  });
}
export function replaceSlideAnimation(
  pageId: string,
  objectId: string,
  expected: PlayableAnimationEmbed,
  animation: PlayableAnimationEmbed,
): EditorCommand<SlideContent> {
  const before = canonicalJson(expected),
    owned = retainPlayableAnimationInputs(animation);
  return immutableCommand('slide.animation.replace', 'Adopt Animation version', (content) => {
    const page = content.slides.find((p) => p.id === pageId),
      object = page?.objects.find((o) => o.id === objectId);
    if (!object || object.type !== 'animation' || canonicalJson(object.animation) !== before)
      throw Error('配置済みアニメーションが変更されました。選び直してください。');
    assertEditable(page!.objects, [objectId]);
    if (canonicalJson(owned) === before) return content;
    const next = {
      ...content,
      slides: content.slides.map((p) =>
        p.id === pageId
          ? {
              ...p,
              objects: p.objects.map((o) => (o.id === objectId ? { ...o, animation: owned } : o)),
            }
          : p,
      ),
    };
    if (!isDeck(next)) throw Error('アニメーションの形式または保持上限が不正です。');
    return next;
  });
}
type IdMint = (prefix: string) => string;
/**
 * Commands may be applied more than once (checked before commit, replayed or
 * rebased), so IDs created inside apply must repeat. Call the returned function
 * at the start of each apply with the IDs already in its input; it hands out the
 * same IDs in the same order, and rejects reapplying the command to its own result.
 */
function stableIds(): (taken: ReadonlySet<string>) => IdMint {
  const minted: string[] = [];
  return (taken) => {
    let next = 0;
    return (prefix) => {
      const id = (minted[next++] ??= newId(prefix));
      if (taken.has(id)) throw new Error('This command was already applied; its new IDs exist');
      return id;
    };
  };
}
function slideIds(d: SlideContent): Set<string> {
  return new Set(d.slides.flatMap((s) => [s.id, ...s.objects.map((o) => o.id)]));
}
export function makeSlide(index = 0, mint: IdMint = newId): Slide {
  return {
    id: mint('slide'),
    title: `Slide ${index + 1}`,
    background: '#ffffff',
    objects: [
      {
        id: mint('object'),
        type: 'text',
        bounds: { x: 65, y: 65, width: 760, height: 90 },
        text: index === 0 ? 'Ideas worth sharing' : `A new perspective`,
        fill: '#304a39',
      },
    ],
  };
}
export const createDeck = (): SlideContent => ({
  schemaVersion: 2,
  width: 960,
  height: 540,
  slides: [slideWithLayout(0, 'blank')],
});
export const resizeDeck = (width: number, height: number): EditorCommand<SlideContent> =>
  command('slide.size', 'Resize pages, preserve object geometry', (d) => {
    if (![width, height].every((n) => Number.isFinite(n) && n >= 100 && n <= 6000))
      throw new Error('Page dimensions must be between 100 and 6000 pixels');
    return { ...d, width, height };
  });
export const addSlide = (): EditorCommand<SlideContent> => {
  const ids = stableIds();
  return command('slide.insert', 'Add slide', (d) => ({
    ...d,
    slides: [...d.slides, makeSlide(d.slides.length, ids(slideIds(d)))],
  }));
};
export const deleteSlide = (id: string): EditorCommand<SlideContent> =>
  command('slide.delete', 'Delete slide', (d) => ({
    ...d,
    slides: d.slides.filter((s) => s.id !== id),
  }));
export const reorderSlide = (id: string, delta: number): EditorCommand<SlideContent> =>
  command('slide.reorder', 'Reorder slide', (d) => {
    const slides = [...d.slides],
      index = slides.findIndex((s) => s.id === id),
      target = index + delta;
    if (index < 0 || target < 0 || target >= slides.length) return d;
    slides.splice(target, 0, slides.splice(index, 1)[0]);
    return { ...d, slides };
  });
export const updateSlide = (
  id: string,
  patch: Partial<Pick<Slide, 'title' | 'background' | 'notes' | 'hidden' | 'backgroundImage'>>,
): EditorCommand<SlideContent> =>
  command('slide.update', 'Edit slide', (d) => ({
    ...d,
    slides: d.slides.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  }));
function baseSlideObject(type: SlideObjectType, index: number, mint: IdMint = newId): SlideObject {
  return {
    id: mint('object'),
    type,
    bounds: {
      x: 80 + (index % 4) * 50,
      y: 180 + (index % 3) * 30,
      width: type === 'chart' ? 500 : type === 'text' ? 500 : 240,
      height: type === 'text' ? 80 : type === 'chart' ? 240 : 160,
    },
    text: type === 'text' ? 'Tell a clear story' : '',
    fill: type === 'text' ? '#304a39' : '#d8e4d1',
    ...(type === 'chart'
      ? {
          chart: {
            label: 'Data snapshot',
            labels: ['Alpha', 'Beta', 'Gamma'],
            values: [40, 70, 55],
            capturedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}
export function makeSlideObject(
  type: SlideInsertType,
  index: number,
  mint: IdMint = newId,
): SlideObject {
  if (!['text', 'shape', 'image', 'chart', 'group', 'table'].includes(type))
    throw Error('Animation の配置には保存版と placeSlideAnimation が必要です。');
  return baseSlideObject(type, index, mint);
}
function assertGenericObjectPatch(patch: object): void {
  if ('type' in patch || 'animation' in patch)
    throw Error('オブジェクトの種類と Animation の保存版は専用コマンドで変更してください。');
}
function assertAnimationPatchTarget(object: SlideObject, patch: Partial<SlideObject>): void {
  if (
    object.type === 'animation' &&
    (patch.src !== undefined ||
      patch.crop !== undefined ||
      patch.reference !== undefined ||
      (patch.imageFit !== undefined && patch.imageFit !== 'fit'))
  )
    throw Error('Animation オブジェクトに画像専用のプロパティは設定できません。');
}
export const insertObject = (
  slideId: string,
  type: SlideInsertType,
  patch: Partial<Omit<SlideObject, 'type' | 'animation'>> = {},
): EditorCommand<SlideContent> => {
  const ids = stableIds();
  return command('slide.insert-object', `Add ${type}`, (d) => {
    assertGenericObjectPatch(patch);
    const mint = ids(slideIds(d));
    return {
      ...d,
      slides: d.slides.map((s) =>
        s.id === slideId
          ? {
              ...s,
              objects: [
                ...s.objects,
                { ...makeSlideObject(type, s.objects.length, mint), ...patch },
              ],
            }
          : s,
      ),
    };
  });
};
export const updateObject = (
  slideId: string,
  id: string,
  patch: Partial<Omit<SlideObject, 'id' | 'type' | 'animation'>>,
): EditorCommand<SlideContent> =>
  command('slide.update-object', 'Edit slide object', (d) => {
    assertGenericObjectPatch(patch);
    return {
      ...d,
      slides: d.slides.map((s) =>
        s.id === slideId
          ? {
              ...s,
              objects: s.objects.map((o) => {
                if (o.id !== id) return o;
                assertAnimationPatchTarget(o, patch);
                return { ...o, ...patch };
              }),
            }
          : s,
      ),
    };
  });
function expanded(slide: Slide, ids: string[]): Set<string> {
  const all = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const o of slide.objects)
      if (o.groupId && all.has(o.groupId) && !all.has(o.id)) {
        all.add(o.id);
        changed = true;
      }
  }
  return all;
}
export const transformObjects = (
  slideId: string,
  ids: string[],
  delta: TransformDelta,
): EditorCommand<SlideContent> =>
  withCommandReads<SlideContent>(
    immutableCommand('slide.transform', 'Transform slide objects', (d) => ({
      ...d,
      slides: d.slides.map((s) => {
        if (s.id !== slideId) return s;
        const mapped = transformGeometry(geometry(s), ids, delta);
        return {
          ...s,
          objects: s.objects.map((o) => (mapped.has(o.id) ? { ...o, ...mapped.get(o.id)! } : o)),
        };
      }),
    })),
    { geometry: ids },
  );
export const deleteObjects = (slideId: string, ids: string[]): EditorCommand<SlideContent> =>
  command('slide.delete-object', 'Delete slide objects', (d) => ({
    ...d,
    slides: d.slides.map((s) =>
      s.id === slideId
        ? { ...s, objects: s.objects.filter((o) => !expanded(s, ids).has(o.id)) }
        : s,
    ),
  }));
export const groupObjects = (slideId: string, ids: string[]): EditorCommand<SlideContent> => {
  const groupIds = stableIds();
  return withCommandReads<SlideContent>(
    command('slide.group', 'Group slide objects', (d) => ({
      ...d,
      slides: d.slides.map((s) => {
        if (s.id !== slideId) return s;
        const objects = s.objects.filter((o) => ids.includes(o.id));
        if (objects.length < 2) throw new Error('Select at least two objects');
        const group = {
          ...makeSlideObject('group', 0, groupIds(slideIds(d))),
          bounds: unionBounds(objects.map((o) => o.bounds)),
        };
        return {
          ...s,
          objects: [
            group,
            ...s.objects.map((o) => (ids.includes(o.id) ? { ...o, groupId: group.id } : o)),
          ],
        };
      }),
    })),
    { geometry: ids },
  );
};
export const alignObjects = (
  slideId: string,
  ids: string[],
  mode: Alignment,
  reference?: Bounds,
): EditorCommand<SlideContent> =>
  withCommandReads<SlideContent>(
    command('slide.align', `Align ${mode}`, (d) => ({
      ...d,
      slides: d.slides.map((s) => {
        if (s.id !== slideId) return s;
        const mapped = alignGeometry(geometry(s), ids, mode, reference);
        return {
          ...s,
          objects: s.objects.map((o) =>
            mapped.has(o.id) ? { ...o, bounds: mapped.get(o.id)! } : o,
          ),
        };
      }),
    })),
    { geometry: ids },
  );
/** Clipboard commands must enforce the same retained-Animation contract as placement. */
function admitAnimationCopy(next: SlideContent): SlideContent {
  if (
    next.slides.some((s) =>
      s.objects.some((o) => o.type === 'animation' || o.animation !== undefined),
    ) &&
    !isDeck(next)
  )
    throw new Error('Animation の複製が Slide の保持契約または上限を満たしません。');
  return next;
}
export const duplicateSlide = (
  id: string,
  copyId = newId('slide'),
): EditorCommand<SlideContent> => {
  const mapping = new Map<string, string>();
  return withCommandReads<SlideContent>(
    command('slide.duplicate', 'Duplicate slide', (d) => {
      const slide = d.slides.find((s) => s.id === id);
      if (!slide) return d;
      if (d.slides.some((s) => s.id === copyId)) throw new Error('Slide ID already exists');
      for (const object of slide.objects)
        if (!mapping.has(object.id)) mapping.set(object.id, newId('object'));
      const index = d.slides.indexOf(slide);
      return admitAnimationCopy({
        ...d,
        slides: [
          ...d.slides.slice(0, index + 1),
          {
            ...clone(slide),
            id: copyId,
            title: `${slide.title} copy`,
            objects: slide.objects.map((o) => ({
              ...clone(o),
              id: mapping.get(o.id)!,
              groupId: o.groupId ? mapping.get(o.groupId) : undefined,
            })),
          },
          ...d.slides.slice(index + 1),
        ],
      });
    }),
    { content: [id] },
  );
};
function describeSlideAnimation(object: SlideObject): string {
  const animation = object.type === 'animation' ? object.animation : undefined;
  if (!animation) return '';
  const { source } = animation;
  return [
    '',
    `Animation: ${animation.label}`,
    `Source artifact: ${source.artifactId}`,
    `Source version: ${source.versionId}`,
    `Source content hash: ${source.contentHash}`,
    `Composition: ${source.compositionId}`,
    `Poster tick: ${animation.posterTick} · Fit: ${animation.fit}`,
    `Playback trigger: ${animation.trigger} · Loop: ${animation.loop}`,
    ...(animation.format === 'animation-embed-2'
      ? [`Inputs: ${canonicalJson(animation.inputs)}`]
      : []),
    `Format: ${animation.format}`,
    `Evaluator: ${animation.evaluatorVersion} · Player: ${animation.playerVersion}`,
  ].join('\n');
}
export function slideDiff(a: SlideContent, b: SlideContent): CompareResult {
  const header = (s: Slide) => ({ ...s, objects: undefined });
  const changes = describeChanges(
    a.slides.map(header),
    b.slides.map(header),
    (s) => `Page: ${s.title}`,
    (s) =>
      `${s.title}\nBackground: ${s.background}\n${s.hidden ? 'Hidden in presentation' : 'Visible in presentation'}\nNotes: ${s.notes ?? ''}`,
  );
  for (const id of new Set([...a.slides, ...b.slides].map((s) => s.id))) {
    const old = a.slides.find((s) => s.id === id),
      next = b.slides.find((s) => s.id === id);
    changes.push(
      ...describeChanges(
        old?.objects ?? [],
        next?.objects ?? [],
        (o) => `${next?.title ?? old!.title} / ${o.type}: ${o.text.slice(0, 40) || 'object'}`,
        (o) => describeDrawing(slideDrawing(o)) + describeReference(o) + describeSlideAnimation(o),
      ),
    );
  }
  if (a.width !== b.width || a.height !== b.height)
    changes.push({
      elementId: 'page-size',
      kind: 'changed',
      path: 'Page dimensions',
      before: `${a.width} × ${a.height} px`,
      after: `${b.width} × ${b.height} px`,
    });
  return { changes };
}
/** Sibling order applies to complete Group subtrees in every renderer. */
export function slidePaintOrder(s: Slide) {
  return hierarchyPaintOrder(s.objects, (o) => o.groupId);
}
export function slideDrawing(o: SlideObject): Drawing {
  const animation =
    o.type === 'animation' && o.animation ? inspectPlayableAnimationEmbed(o.animation) : undefined;
  const poster = animation && slideAnimationPoster(animation.embed);
  return {
    ...o,
    ...(animation && poster
      ? {
          src: poster.src,
          alt:
            poster.status === 'ready'
              ? animation.embed.label
              : `${animation.embed.label}: ${poster.message}`,
        }
      : {}),
    imageFit: animation
      ? 'fit'
      : o.reference
        ? o.reference.fit === 'cover'
          ? 'fill'
          : 'fit'
        : o.imageFit,
    // Vector geometry is owned by Design, not by undeclared imported fields.
    vector: undefined,
    kind: o.type === 'animation' ? 'image' : o.type,
    shape: o.shape ?? 'rectangle',
    typography: o.typography ?? { fontSize: 32 },
    chart: o.chart,
  };
}
export function exportSlideSvg(deck: SlideContent, slide: Slide): string {
  if (slidePaintOrder(slide).some((o) => o.type === 'animation' && !o.hidden))
    throw Error(
      'アニメーションを含むページの静止出力は未対応です。native JSON で保存してください。',
    );
  return drawingSvg(
    slidePaintOrder(slide).map(slideDrawing),
    { x: 0, y: 0, width: deck.width, height: deck.height },
    slide.background,
  );
}
const checkedObjectLists = new WeakSet<SlideObject[]>();
const checkedObjects = new WeakSet<SlideObject>();
function validAnimationObject(o: SlideObject): boolean {
  if (o.type !== 'animation') return o.animation === undefined;
  if (
    o.src !== undefined ||
    o.crop !== undefined ||
    (o.imageFit !== undefined && o.imageFit !== 'fit')
  )
    return false;
  try {
    inspectPlayableAnimationEmbed(o.animation);
    return true;
  } catch {
    return false;
  }
}
function validAnimationDeck(slides: Slide[]): boolean {
  let count = 0,
    bytes = 0;
  const identities = new Map<string, string>();
  try {
    for (const page of slides)
      for (const object of page.objects)
        if (object.type === 'animation') {
          const { embed } = inspectPlayableAnimationEmbed(object.animation, identities);
          const size = new TextEncoder().encode(canonicalJson(embed)).byteLength;
          if (++count > 16 || (bytes += size) > 8 * 1024 * 1024) return false;
        }
    return true;
  } catch {
    return false;
  }
}
const slideObjectTypes = ['text', 'shape', 'image', 'chart', 'group', 'table', 'animation'];
const validChart = (chart: SlideObject['chart']) =>
  chart === undefined ||
  (Array.isArray(chart.values) &&
    chart.values.every(Number.isFinite) &&
    Array.isArray(chart.labels) &&
    chart.labels.every((l) => typeof l === 'string'));
function validObject(o: SlideObject): boolean {
  if (checkedObjects.has(o)) return true;
  const valid =
    !!o &&
    typeof o.id === 'string' &&
    typeof o.text === 'string' &&
    typeof o.fill === 'string' &&
    validVisualStyle(o) &&
    (o.reference === undefined || (o.type === 'image' && validEmbeddedReference(o.reference))) &&
    slideObjectTypes.includes(o.type) &&
    validAnimationObject(o) &&
    validBounds(o.bounds) &&
    validChart(o.chart);
  if (valid && isDeepFrozen(o)) checkedObjects.add(o);
  return valid;
}
function validObjects(objects: SlideObject[]): boolean {
  if (checkedObjectLists.has(objects)) return true;
  const valid =
    objects.every(validObject) &&
    validHierarchy(objects.map((o) => ({ id: o.id, parentId: o.groupId })));
  // A new/mutable/shallow-frozen list still checks every object and relationship.
  // Reused immutable lists cannot acquire different geometry, IDs or parents.
  if (valid && isDeepFrozen(objects)) checkedObjectLists.add(objects);
  return valid;
}
const validSlide = (s: Slide) =>
  s &&
  typeof s.id === 'string' &&
  typeof s.title === 'string' &&
  typeof s.background === 'string' &&
  Array.isArray(s.objects) &&
  validObjects(s.objects);
const validPageSize = (d: SlideContent) =>
  Number.isFinite(d.width) && d.width > 0 && Number.isFinite(d.height) && d.height > 0;
export function isDeck(value: unknown): value is SlideContent {
  if (!value || typeof value !== 'object') return false;
  const d = value as SlideContent;
  return (
    (d.schemaVersion === 1 || d.schemaVersion === 2) &&
    Array.isArray(d.slides) &&
    validNativeReuse(d.reuse, 'slide') &&
    validPageSize(d) &&
    new Set(d.slides.map((s) => s?.id)).size === d.slides.length &&
    d.slides.every(validSlide) &&
    validReferenceItems(d.slides.flatMap((s) => s.objects)) &&
    validAnimationDeck(d.slides) &&
    (!hasSlideAnimations(d) || !hasSlideReuse(d))
  );
}

function geometry(s: Slide): GeometryItem[] {
  return s.objects.map((o) => ({ ...o, parentId: o.groupId }));
}
export function migrateDeck(d: SlideContent): SlideContent {
  return d.schemaVersion === 2 ? d : { ...clone(d), schemaVersion: 2 };
}
export type SlideLayout =
  | 'blank'
  | 'title'
  | 'title-body'
  | 'two-column'
  | 'image-caption'
  | 'comparison'
  | 'chart';
export function slideWithLayout(
  index: number,
  layout: SlideLayout,
  width = 960,
  height = 540,
  mint: IdMint = newId,
): Slide {
  const slide = makeSlide(index, mint);
  slide.objects = [];
  const insert = (
    type: SlideInsertType,
    text: string,
    bounds: Bounds,
    patch: Partial<SlideObject> = {},
  ) => slide.objects.push({ ...makeSlideObject(type, 0, mint), text, bounds, ...patch });
  if (layout !== 'blank')
    insert(
      'text',
      'Title',
      { x: 60, y: 40, width: width - 120, height: 80 },
      { typography: { fontSize: 40, bold: true } },
    );
  if (layout === 'title')
    insert('text', 'Subtitle', { x: 60, y: 150, width: width - 120, height: 100 });
  if (layout === 'title-body')
    insert('text', 'Add your story here', {
      x: 60,
      y: 150,
      width: width - 120,
      height: height - 210,
    });
  if (layout === 'two-column') {
    insert('text', 'First perspective', {
      x: 60,
      y: 150,
      width: width / 2 - 90,
      height: height - 210,
    });
    insert('text', 'Second perspective', {
      x: width / 2 + 30,
      y: 150,
      width: width / 2 - 90,
      height: height - 210,
    });
  }
  if (layout === 'image-caption') {
    insert(
      'shape',
      'Insert an image here',
      { x: 60, y: 140, width: width - 120, height: height - 240 },
      { fill: '#e7edf5' },
    );
    insert(
      'text',
      'Image caption',
      { x: 60, y: height - 80, width: width - 120, height: 50 },
      { typography: { fontSize: 20 } },
    );
  }
  if (layout === 'comparison')
    insert(
      'table',
      '',
      { x: 60, y: 150, width: width - 120, height: height - 210 },
      {
        table: {
          rows: [
            ['Criteria', 'Option A', 'Option B'],
            ['Quality', '', ''],
            ['Time', '', ''],
            ['Cost', '', ''],
          ],
          header: true,
        },
        fill: '#253044',
      },
    );
  if (layout === 'chart')
    insert('chart', '', { x: 100, y: 150, width: width - 200, height: height - 210 });
  return slide;
}
export const insertSlideLayout = (layout: SlideLayout): EditorCommand<SlideContent> => {
  const ids = stableIds();
  return command('slide.layout', 'Add slide layout', (d) => ({
    ...d,
    slides: [
      ...d.slides,
      slideWithLayout(d.slides.length, layout, d.width, d.height, ids(slideIds(d))),
    ],
  }));
};
/**
 * Copies objects (with their group descendants) under new IDs, moved by `offset`.
 * Copy uses the default offset once; cut passes 0 so a later paste restores position.
 */
export function copiedObjects(
  s: Slide,
  ids: string[],
  offset = 20,
  mint: IdMint = newId,
): SlideObject[] {
  const all = expanded(s, ids),
    copied = s.objects.filter((o) => all.has(o.id)),
    mapping = new Map(copied.map((o) => [o.id, mint('object')]));
  return copied.map((o) => ({
    ...clone(o),
    id: mapping.get(o.id)!,
    groupId: o.groupId ? mapping.get(o.groupId) : undefined,
    bounds: { ...o.bounds, x: o.bounds.x + offset, y: o.bounds.y + offset },
  }));
}
/** Pastes clipboard objects as prepared by copiedObjects, at their stored positions. */
export const pasteObjects = (
  slideId: string,
  objects: SlideObject[],
): EditorCommand<SlideContent> => {
  const ids = stableIds();
  return command('slide.paste', 'Paste objects', (d) => {
    const mint = ids(slideIds(d));
    return admitAnimationCopy({
      ...d,
      slides: d.slides.map((s) =>
        s.id === slideId
          ? {
              ...s,
              objects: [
                ...s.objects,
                ...copiedObjects(
                  { ...s, objects },
                  objects.map((o) => o.id),
                  0,
                  mint,
                ),
              ],
            }
          : s,
      ),
    });
  });
};
export const patchObjects = (
  slideId: string,
  ids: string[],
  patch: Partial<Omit<SlideObject, 'type' | 'animation'>>,
): EditorCommand<SlideContent> =>
  command('slide.properties', 'Edit object properties', (d) => {
    assertGenericObjectPatch(patch);
    return {
      ...d,
      slides: d.slides.map((s) => {
        if (s.id !== slideId) return s;
        if (!('locked' in patch || 'hidden' in patch)) assertEditable(geometry(s), ids);
        return {
          ...s,
          objects: s.objects.map((o) => {
            if (!ids.includes(o.id)) return o;
            assertAnimationPatchTarget(o, patch);
            const next = patchVisualStyle<SlideObject>(o, patch);
            if (next.reference && patch.imageFit !== undefined)
              next.reference = {
                ...next.reference,
                fit: patch.imageFit === 'fill' ? 'cover' : 'contain',
              };
            return next;
          }),
        };
      }),
    };
  });
/** Applies changed geometry/transform patches to the objects they name. */
const patchedObjects = (s: Slide, patches: Map<string, Partial<SlideObject>>): Slide => ({
  ...s,
  objects: s.objects.map((o) => (patches.has(o.id) ? { ...o, ...patches.get(o.id)! } : o)),
});
function groupSelection(s: Slide, roots: GeometryItem[], mint: IdMint): Slide {
  if (roots.length < 2) throw new Error('Select at least two elements');
  const g = {
    ...makeSlideObject('group', 0, mint),
    bounds: unionBounds(roots.map((o) => o.bounds)),
    groupId: roots[0].parentId,
  };
  return {
    ...s,
    objects: [
      g,
      ...s.objects.map((o) => (roots.some((r) => r.id === o.id) ? { ...o, groupId: g.id } : o)),
    ],
  };
}
function ungroupObjects(s: Slide, ids: string[]): Slide {
  const groups = s.objects.filter((o) => ids.includes(o.id) && o.type === 'group');
  return {
    ...s,
    objects: s.objects
      .filter((o) => !groups.some((g) => g.id === o.id))
      .map((o) => {
        const parent = groups.find((g) => g.id === o.groupId);
        return parent ? { ...o, groupId: parent.groupId } : o;
      }),
  };
}
function distributePatches(
  items: GeometryItem[],
  ids: string[],
  action: string,
  value: number | undefined,
) {
  const axis = action.endsWith('x') ? 'x' : 'y',
    gap = action.startsWith('gap') ? value : undefined;
  const bounds = distributeGeometry(items, ids, axis, gap);
  return new Map([...bounds].map(([id, b]) => [id, { bounds: b }]));
}
/** Resizes each selected root (with its descendants) to the bounds `same-*` asks for. */
function sameSizePatches(items: GeometryItem[], ids: string[], action: string) {
  const mapped = new Map<string, { bounds: Bounds; rotation: number }>();
  for (const [id, bounds] of matchingSizeBounds(items, ids, action)) {
    const old = items.find((item) => item.id === id)!.bounds;
    for (const [childId, patch] of transformGeometry(items, [id], {
      dx: 0,
      dy: 0,
      dw: bounds.width - old.width,
      dh: bounds.height - old.height,
    }))
      mapped.set(childId, patch);
  }
  return mapped;
}
function reorderSiblings(
  s: Slide,
  items: GeometryItem[],
  roots: GeometryItem[],
  ids: string[],
  action: string,
): Slide {
  const order = reorderedSiblingIds(items, ids, action);
  const byId = new Map(s.objects.map((o) => [o.id, o]));
  let index = 0;
  return {
    ...s,
    objects: s.objects.map((o) =>
      o.groupId === roots[0]?.parentId ? byId.get(order[index++])! : o,
    ),
  };
}
/** lock/unlock/hide/show on the selection and its descendants; other actions change nothing. */
function setObjectFlags(s: Slide, all: Set<string>, action: string): Slide {
  return {
    ...s,
    objects: s.objects.map((o) => {
      if (!all.has(o.id)) return o;
      if (action === 'lock' || action === 'unlock') return { ...o, locked: action === 'lock' };
      if (action === 'hide' || action === 'show') return { ...o, hidden: action === 'hide' };
      return o;
    }),
  };
}
const flagActions = ['unlock', 'show', 'lock', 'hide'];
const orderActions = ['front', 'back', 'forward', 'backward'];
/** One `slide.arrange` action on one slide. */
function arrangeSlide(
  d: SlideContent,
  s: Slide,
  ids: string[],
  action: string,
  value: number | undefined,
  mint: IdMint,
): Slide {
  const items = geometry(s),
    roots = selectedRoots(items, ids),
    all = descendantIds(
      items,
      roots.map((o) => o.id),
    );
  if (!flagActions.includes(action)) assertEditable(items, ids, true);
  if (action === 'duplicate') {
    const copied = { ...s, objects: [...s.objects, ...copiedObjects(s, ids, 20, mint)] };
    admitAnimationCopy({ ...d, slides: d.slides.map((page) => (page === s ? copied : page)) });
    return copied;
  }
  if (action === 'delete') return { ...s, objects: s.objects.filter((o) => !all.has(o.id)) };
  if (action === 'group') return groupSelection(s, roots, mint);
  if (action === 'ungroup') return ungroupObjects(s, ids);
  if (action.startsWith('distribute-') || action.startsWith('gap-'))
    return patchedObjects(s, distributePatches(items, ids, action, value));
  if (action === 'rotate')
    return patchedObjects(
      s,
      transformGeometry(items, ids, { dx: 0, dy: 0, dw: 0, dh: 0, rotation: 90 }),
    );
  if (action.startsWith('same-')) return patchedObjects(s, sameSizePatches(items, ids, action));
  if (action === 'flip-x' || action === 'flip-y')
    return patchedObjects(s, reflectGeometry(items, ids, action === 'flip-x' ? 'x' : 'y'));
  if (orderActions.includes(action)) return reorderSiblings(s, items, roots, ids, action);
  return setObjectFlags(s, all, action);
}
export const arrangeObjects = (
  slideId: string,
  ids: string[],
  action: string,
  value?: number,
): EditorCommand<SlideContent> => {
  const minted = stableIds();
  return withCommandReads<SlideContent>(
    command('slide.arrange', action, (d) => {
      const mint = minted(slideIds(d));
      return {
        ...d,
        slides: d.slides.map((s) =>
          s.id === slideId ? arrangeSlide(d, s, ids, action, value, mint) : s,
        ),
      };
    }),
    action === 'duplicate' ? { content: ids } : { geometry: ids },
  );
};
