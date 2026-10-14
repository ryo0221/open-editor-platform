import {
  clone,
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
export type SlideObjectType = 'text' | 'shape' | 'image' | 'chart' | 'group' | 'table';
export interface ChartSnapshot {
  label: string;
  labels: string[];
  values: number[];
  capturedAt: string;
  type?: 'bar' | 'line' | 'pie';
  legend?: boolean;
}
export interface SlideObject extends VisualStyle {
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
export function makeSlide(index = 0): Slide {
  return {
    id: newId('slide'),
    title: `Slide ${index + 1}`,
    background: '#ffffff',
    objects: [
      {
        id: newId('object'),
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
export const addSlide = (): EditorCommand<SlideContent> =>
  command('slide.insert', 'Add slide', (d) => ({
    ...d,
    slides: [...d.slides, makeSlide(d.slides.length)],
  }));
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
export function makeSlideObject(type: SlideObjectType, index: number): SlideObject {
  return {
    id: newId('object'),
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
export const insertObject = (
  slideId: string,
  type: SlideObjectType,
  patch: Partial<SlideObject> = {},
): EditorCommand<SlideContent> =>
  command('slide.insert-object', `Add ${type}`, (d) => ({
    ...d,
    slides: d.slides.map((s) =>
      s.id === slideId
        ? {
            ...s,
            objects: [...s.objects, { ...makeSlideObject(type, s.objects.length), ...patch }],
          }
        : s,
    ),
  }));
export const updateObject = (
  slideId: string,
  id: string,
  patch: Partial<Omit<SlideObject, 'id'>>,
): EditorCommand<SlideContent> =>
  command('slide.update-object', 'Edit slide object', (d) => ({
    ...d,
    slides: d.slides.map((s) =>
      s.id === slideId
        ? { ...s, objects: s.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) }
        : s,
    ),
  }));
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
export const groupObjects = (slideId: string, ids: string[]): EditorCommand<SlideContent> =>
  withCommandReads<SlideContent>(
    command('slide.group', 'Group slide objects', (d) => ({
      ...d,
      slides: d.slides.map((s) => {
        if (s.id !== slideId) return s;
        const objects = s.objects.filter((o) => ids.includes(o.id));
        if (objects.length < 2) throw new Error('Select at least two objects');
        const group = {
          ...makeSlideObject('group', 0),
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
      return {
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
      };
    }),
    { content: [id] },
  );
};
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
        (o) => describeDrawing(slideDrawing(o)),
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
  return {
    ...o,
    // Vector geometry is owned by Design, not by undeclared imported fields.
    vector: undefined,
    kind: o.type,
    shape: o.shape ?? 'rectangle',
    typography: o.typography ?? { fontSize: 32 },
    chart: o.chart,
  };
}
export function exportSlideSvg(deck: SlideContent, slide: Slide): string {
  return drawingSvg(
    slidePaintOrder(slide).map(slideDrawing),
    { x: 0, y: 0, width: deck.width, height: deck.height },
    slide.background,
  );
}
const checkedObjectLists = new WeakSet<SlideObject[]>();
const checkedObjects = new WeakSet<SlideObject>();
function validObject(o: SlideObject): boolean {
  if (checkedObjects.has(o)) return true;
  const valid =
    !!o &&
    typeof o.id === 'string' &&
    typeof o.text === 'string' &&
    typeof o.fill === 'string' &&
    validVisualStyle(o) &&
    ['text', 'shape', 'image', 'chart', 'group', 'table'].includes(o.type) &&
    validBounds(o.bounds) &&
    (o.chart === undefined ||
      (Array.isArray(o.chart.values) &&
        o.chart.values.every(Number.isFinite) &&
        Array.isArray(o.chart.labels) &&
        o.chart.labels.every((l) => typeof l === 'string')));
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
export function isDeck(value: unknown): value is SlideContent {
  if (!value || typeof value !== 'object') return false;
  const d = value as SlideContent;
  return (
    (d.schemaVersion === 1 || d.schemaVersion === 2) &&
    Array.isArray(d.slides) &&
    validNativeReuse(d.reuse, 'slide') &&
    Number.isFinite(d.width) &&
    d.width > 0 &&
    Number.isFinite(d.height) &&
    d.height > 0 &&
    new Set(d.slides.map((s) => s?.id)).size === d.slides.length &&
    d.slides.every(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.title === 'string' &&
        typeof s.background === 'string' &&
        Array.isArray(s.objects) &&
        validObjects(s.objects),
    )
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
): Slide {
  const slide = makeSlide(index);
  slide.objects = [];
  const insert = (
    type: SlideObjectType,
    text: string,
    bounds: Bounds,
    patch: Partial<SlideObject> = {},
  ) => slide.objects.push({ ...makeSlideObject(type, 0), text, bounds, ...patch });
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
export const insertSlideLayout = (layout: SlideLayout): EditorCommand<SlideContent> =>
  command('slide.layout', 'Add slide layout', (d) => ({
    ...d,
    slides: [...d.slides, slideWithLayout(d.slides.length, layout, d.width, d.height)],
  }));
export function copiedObjects(s: Slide, ids: string[]): SlideObject[] {
  const all = expanded(s, ids),
    copied = s.objects.filter((o) => all.has(o.id)),
    mapping = new Map(copied.map((o) => [o.id, newId('object')]));
  return copied.map((o) => ({
    ...clone(o),
    id: mapping.get(o.id)!,
    groupId: o.groupId ? mapping.get(o.groupId) : undefined,
    bounds: { ...o.bounds, x: o.bounds.x + 20, y: o.bounds.y + 20 },
  }));
}
export const pasteObjects = (
  slideId: string,
  objects: SlideObject[],
): EditorCommand<SlideContent> =>
  command('slide.paste', 'Paste objects', (d) => ({
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
              ),
            ],
          }
        : s,
    ),
  }));
export const patchObjects = (
  slideId: string,
  ids: string[],
  patch: Partial<SlideObject>,
): EditorCommand<SlideContent> =>
  command('slide.properties', 'Edit object properties', (d) => ({
    ...d,
    slides: d.slides.map((s) => {
      if (s.id !== slideId) return s;
      if (!('locked' in patch || 'hidden' in patch)) assertEditable(geometry(s), ids);
      return {
        ...s,
        objects: s.objects.map((o) => (ids.includes(o.id) ? patchVisualStyle(o, patch) : o)),
      };
    }),
  }));
export const arrangeObjects = (
  slideId: string,
  ids: string[],
  action: string,
  value?: number,
): EditorCommand<SlideContent> =>
  withCommandReads<SlideContent>(
    command('slide.arrange', action, (d) => ({
      ...d,
      slides: d.slides.map((s) => {
        if (s.id !== slideId) return s;
        const items = geometry(s),
          roots = selectedRoots(items, ids),
          all = descendantIds(
            items,
            roots.map((o) => o.id),
          );
        if (!['unlock', 'show', 'lock', 'hide'].includes(action)) assertEditable(items, ids, true);
        if (action === 'duplicate')
          return { ...s, objects: [...s.objects, ...copiedObjects(s, ids)] };
        if (action === 'delete') return { ...s, objects: s.objects.filter((o) => !all.has(o.id)) };
        if (action === 'group') {
          if (roots.length < 2) throw new Error('Select at least two elements');
          const g = {
            ...makeSlideObject('group', 0),
            bounds: unionBounds(roots.map((o) => o.bounds)),
            groupId: roots[0].parentId,
          };
          return {
            ...s,
            objects: [
              g,
              ...s.objects.map((o) =>
                roots.some((r) => r.id === o.id) ? { ...o, groupId: g.id } : o,
              ),
            ],
          };
        }
        if (action === 'ungroup') {
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
        if (action.startsWith('distribute-') || action.startsWith('gap-')) {
          const m = distributeGeometry(
            items,
            ids,
            action.endsWith('x') ? 'x' : 'y',
            action.startsWith('gap') ? value : undefined,
          );
          return {
            ...s,
            objects: s.objects.map((o) => (m.has(o.id) ? { ...o, bounds: m.get(o.id)! } : o)),
          };
        }
        if (action === 'rotate') {
          const m = transformGeometry(items, ids, { dx: 0, dy: 0, dw: 0, dh: 0, rotation: 90 });
          return {
            ...s,
            objects: s.objects.map((o) => (m.has(o.id) ? { ...o, ...m.get(o.id)! } : o)),
          };
        }
        if (action.startsWith('same-')) {
          const targets = matchingSizeBounds(items, ids, action);
          const mapped = new Map<string, { bounds: Bounds; rotation: number }>();
          for (const [id, bounds] of targets) {
            const old = items.find((item) => item.id === id)!.bounds;
            for (const [childId, patch] of transformGeometry(items, [id], {
              dx: 0,
              dy: 0,
              dw: bounds.width - old.width,
              dh: bounds.height - old.height,
            }))
              mapped.set(childId, patch);
          }
          return {
            ...s,
            objects: s.objects.map((o) => (mapped.has(o.id) ? { ...o, ...mapped.get(o.id)! } : o)),
          };
        }
        if (action === 'flip-x' || action === 'flip-y') {
          const mapped = reflectGeometry(items, ids, action === 'flip-x' ? 'x' : 'y');
          return {
            ...s,
            objects: s.objects.map((o) => (mapped.has(o.id) ? { ...o, ...mapped.get(o.id)! } : o)),
          };
        }
        if (['front', 'back', 'forward', 'backward'].includes(action)) {
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
        return {
          ...s,
          objects: s.objects.map((o) => {
            if (!all.has(o.id)) return o;
            if (action === 'lock' || action === 'unlock')
              return { ...o, locked: action === 'lock' };
            if (action === 'hide' || action === 'show') return { ...o, hidden: action === 'hide' };
            return o;
          }),
        };
      }),
    })),
    action === 'duplicate' ? { content: ids } : { geometry: ids },
  );
