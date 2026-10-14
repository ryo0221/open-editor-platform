import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import {
  canonical,
  copy,
  fail,
  operation,
  prepareOperation,
  type Action,
  type DomainCodec,
  type Effect,
  type Identity,
  type Operation,
  type PreparedOperation,
  type Origin,
  type Snapshot,
} from '@editor-platform/collaboration-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import { isDeck, type SlideContent } from '@editor-platform/slide/model';
import { isDesign, type DesignContent } from '@editor-platform/design/model';
import { isWhiteboard, type WhiteboardContent } from '@editor-platform/whiteboard/model';
import {
  isStructuredData,
  validateData,
  cellValue,
  type StructuredData,
  type DataGraphView,
} from '@editor-platform/structured-data/model';
import { slideCodec, designCodec, whiteboardCodec } from './canvas';
import { editorAssetCodec } from './editor-assets';
import { withNativeReuse } from './reuse';
import { reactUiPatchAction } from './react-ui';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import { dataCodec } from './data';
import {
  applyCanvasSteps,
  canvasEngineDocument,
  canvasTextItem,
  mapCanvasTextAnchor,
} from './canvas-text';
import { canvasTextReplacement } from '@editor-platform/canvas-ui/text-engine';
import { EditorState } from 'prosemirror-state';
import type { TextRun } from '@editor-platform/editor-core';

// Temporary accessors into each existing schema. This is never a stored content model.
type RecordValue = Record<string, unknown> & { id: string };
type Root = Record<string, unknown>;
interface Collection {
  key: string;
  fields: readonly string[];
  items: RecordValue[];
  set(items: RecordValue[]): void;
  nested?: string;
  present: boolean;
  clear(): void;
}
interface Schema<T> {
  base: DomainCodec<T>;
  root: readonly string[];
  collections(content: T): Collection[];
}
export type EditorChange =
  | { kind: 'insert'; collection: string; id: string; value: RecordValue }
  | { kind: 'remove'; collection: string; id: string }
  | { kind: 'field'; collection: string; id: string; field: string; value: unknown }
  | { kind: 'order'; collection: string; ids: string[] }
  | { kind: 'empty'; collection: string; present: boolean }
  | { kind: 'root'; field: string; value: unknown }
  | { kind: 'graph-settings'; value: Omit<DataGraphView, 'positions'> | null }
  | { kind: 'graph-position'; rowId: string; value: { x: number; y: number } | null }
  | { kind: 'cell'; rowId: string; columnId: string; value: unknown };
const visual =
  'shape stroke strokeWidth dash opacity radius rotation flipX flipY locked hidden typography runs imageFit crop alt arrowhead'.split(
    ' ',
  );
const objectFields = [
  'type',
  'bounds',
  'text',
  'fill',
  'src',
  'chart',
  'table',
  'groupId',
  ...visual,
];
const elementFields = [
  'vector',
  'interactions',
  'react',
  'web',
  'webProps',
  'webSlots',
  'type',
  'name',
  'bounds',
  'text',
  'fill',
  'src',
  'parentId',
  'componentId',
  'overrides',
  'styleId',
  'clipContent',
  'layout',
  'sizing',
  'constraints',
  ...visual,
];
const nodeFields = [
  'ports',
  'kind',
  'bounds',
  'text',
  'color',
  'groupId',
  'sectionId',
  'src',
  'points',
  'name',
  ...visual,
];
const layoutFields = new Set([
  'bounds',
  'rotation',
  'flipX',
  'flipY',
  'groupId',
  'parentId',
  'sectionId',
  'layout',
  'sizing',
  'constraints',
  'componentId',
  'elements',
  'template',
  'width',
  'height',
]);
const entityKey = (collection: string, id: string) => `entity:${collection}:${id}`;
const orderKey = (collection: string) => `order:${collection}`;
function collection(
  owner: object,
  field: string,
  fields: readonly string[],
  key = field,
  nested?: string,
): Collection {
  const root = owner as Root;
  return {
    key,
    fields,
    get items() {
      return (root[field] ?? []) as RecordValue[];
    },
    nested,
    get present() {
      return root[field] !== undefined;
    },
    clear: () => {
      delete root[field];
    },
    set: (items) => {
      root[field] = items;
    },
  };
}
const slideSchema: Schema<SlideContent> = {
  base: slideCodec,
  root: ['schemaVersion', 'width', 'height', 'theme'],
  collections: (d) => [
    collection(
      d,
      'slides',
      ['title', 'background', 'notes', 'hidden', 'backgroundImage'],
      'pages',
      'objects',
    ),
    ...d.slides.map((s) => collection(s, 'objects', objectFields, `objects@${s.id}`)),
  ],
};
const designSchema: Schema<DesignContent> = {
  base: designCodec,
  root: ['schemaVersion', 'web', 'prototyping'],
  collections: (d) => [
    collection(d, 'elements', elementFields),
    collection(d, 'components', ['name', 'elements', 'template', 'width', 'height', 'web']),
    collection(d, 'styles', ['name', 'appearance']),
  ],
};
const boardSchema: Schema<WhiteboardContent> = {
  base: whiteboardCodec,
  root: ['schemaVersion'],
  collections: (d) => [
    collection(d, 'nodes', nodeFields),
    collection(d, 'connectors', [
      'from',
      'to',
      'label',
      'fromPoint',
      'toPoint',
      'fromPort',
      'toPort',
      'routing',
      'stroke',
      'strokeWidth',
      'arrowhead',
    ]),
    collection(d, 'sections', ['title', 'bounds', 'background', 'locked']),
  ],
};
const dataSchema: Schema<StructuredData> = {
  base: dataCodec,
  root: ['schemaVersion'],
  collections: (d) => [
    collection(d, 'rows', [], 'rows', 'values'),
    collection(d, 'columns', [
      'name',
      'type',
      'required',
      'defaultValue',
      'options',
      'formula',
      'readOnly',
      'format',
      'decimals',
      'currency',
    ]),
    collection(d, 'views', [
      'accent',
      'name',
      'projection',
      'search',
      'filterMode',
      'filters',
      'sorts',
      'groupBy',
      'hidden',
      'widths',
      'frozen',
      'cardFields',
      'chart',
      'timeline',
      'widgets',
      'summary',
    ]),
  ],
};
function schemaFor<T>(codec: DomainCodec<T>): Schema<T> {
  const schema = {
    slide: slideSchema,
    design: designSchema,
    whiteboard: boardSchema,
    data: dataSchema,
  }[codec.domain as 'slide'];
  if (!schema) fail('unsupported-operation', 'This editor uses its text or annotation engine');
  return schema as unknown as Schema<T>;
}
function equal(a: unknown, b: unknown) {
  return a === b || canonical(a) === canonical(b);
}
function safeId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id || /[/:@]/.test(id) || id.length > 200)
    fail('schema-mismatch', 'Invalid stable identifier');
}
function projection<T>(schema: Schema<T>, d: T) {
  return {
    root: Object.fromEntries(
      schema.root.filter((k) => layoutFields.has(k)).map((k) => [k, (d as Root)[k]]),
    ),
    collections: schema.collections(d).map((c) => ({
      collection: c.key,
      items: c.items.map((item) =>
        Object.fromEntries(
          Object.entries(item).filter(([key]) => key === 'id' || layoutFields.has(key)),
        ),
      ),
    })),
  };
}
function geometryIndex<T>(schema: Schema<T>, content: T) {
  const entries = schema
    .collections(content)
    .flatMap((c) =>
      c.items.map((item) => ({ item, collection: c.key, key: entityKey(c.key, item.id) })),
    );
  const byId = new Map(entries.map((entry) => [entry.item.id, entry]));
  const children = new Map<string, string[]>();
  for (const { item } of entries)
    for (const field of ['parentId', 'groupId', 'sectionId']) {
      const parent = byId.get(item[field] as string);
      if (parent) {
        const siblings = children.get(parent.key);
        if (siblings) siblings.push(item.id);
        else children.set(parent.key, [item.id]);
      }
    }
  return { entries, byId, children };
}
/** Read the selected geometry, its descendants and required ancestors/layout containers. */
function geometryReads<T>(
  schema: Schema<T>,
  content: T,
  ids: string[],
  index?: ReturnType<typeof geometryIndex<T>>,
) {
  if (!ids.length) return [];
  const { byId, children } = index ?? geometryIndex(schema, content),
    selected = new Set(ids),
    expand = [...ids],
    reads = new Set<string>();
  for (let i = 0; i < expand.length; i++) {
    const entry = byId.get(expand[i]);
    if (!entry) continue;
    for (const child of children.get(entry.key) ?? [])
      if (!selected.has(child)) {
        selected.add(child);
        expand.push(child);
      }
  }
  const pending = [...selected];
  for (let i = 0; i < pending.length; i++) {
    const entry = byId.get(pending[i]);
    if (!entry) continue;
    const { item, key, collection } = entry;
    for (const field of [...layoutFields, 'id', 'type', 'kind', 'hidden', 'locked'])
      reads.add(`${key}/${field}`);
    if (item.sizing === 'hug')
      for (const field of ['text', 'typography']) reads.add(`${key}/${field}`);
    reads.add(`children:${key}`);
    if (collection.startsWith('objects@'))
      reads.add(`${entityKey('pages', collection.slice(8))}/id`);
    const related = ['parentId', 'groupId', 'sectionId'].flatMap((field) =>
      typeof item[field] === 'string' ? [item[field] as string] : [],
    );
    // Auto-layout reads all ordered siblings and their subtree geometry.
    if (
      schema.base.domain === 'design' &&
      item.layout &&
      (item.layout as Root).direction !== 'absolute'
    ) {
      const descendants = [...(children.get(key) ?? [])],
        seen = new Set(descendants);
      for (let j = 0; j < descendants.length; j++) {
        related.push(descendants[j]);
        const child = byId.get(descendants[j]);
        if (child)
          for (const id of children.get(child.key) ?? [])
            if (!seen.has(id)) {
              seen.add(id);
              descendants.push(id);
            }
      }
    }
    for (const id of related)
      if (!selected.has(id)) {
        selected.add(id);
        pending.push(id);
      }
  }
  if (schema.base.domain === 'slide' && ids.length) {
    reads.add('root/width');
    reads.add('root/height');
  }
  return [...reads];
}
function contentReads<T>(schema: Schema<T>, content: T, ids: readonly string[]) {
  if (!ids.length) return [];
  if (ids.includes('*'))
    return [
      'reuse',
      ...[
        ...new Set([
          ...schema.root,
          ...Object.keys(content as Root).filter(
            (key) => key !== 'reuse' && !schema.collections(content).some((c) => c.key === key),
          ),
        ]),
      ].map((key) => `root/${key}`),
      ...schema
        .collections(content)
        .flatMap((c) => [
          orderKey(c.key),
          ...c.items.flatMap((item) => [
            entityKey(c.key, item.id),
            ...c.fields.map((field) => `${entityKey(c.key, item.id)}/${field}`),
          ]),
        ]),
    ];
  const { byId, children } = geometryIndex(schema, content),
    selected = new Set(ids),
    pending = [...ids];
  for (let i = 0; i < pending.length; i++) {
    const entry = byId.get(pending[i]);
    if (entry)
      for (const child of children.get(entry.key) ?? [])
        if (!selected.has(child)) {
          selected.add(child);
          pending.push(child);
        }
  }
  return pending.flatMap((id) => (byId.has(id) ? [byId.get(id)!.key] : []));
}
function differences<T>(schema: Schema<T>, before: T, after: T): EditorChange[] {
  const changes: EditorChange[] = [];
  const roots = {
    slide: ['slides'],
    design: ['elements', 'components', 'styles'],
    whiteboard: ['nodes', 'connectors', 'sections'],
    data: ['rows', 'columns', 'views', 'graphView'],
  }[schema.base.domain as 'slide'];
  for (const field of new Set([...Object.keys(before as Root), ...Object.keys(after as Root)]))
    if (
      !schema.root.includes(field) &&
      !roots.includes(field) &&
      !equal((before as Root)[field], (after as Root)[field])
    )
      fail('unsupported-operation', `Unknown domain property: ${field}`);
  for (const field of schema.root)
    if (!equal((before as Root)[field], (after as Root)[field]))
      changes.push({ kind: 'root', field, value: (after as Root)[field] ?? null });
  if (schema.base.domain === 'data') {
    const old = (before as StructuredData).graphView,
      next = (after as StructuredData).graphView;
    const settings = (view: DataGraphView | undefined) =>
      view ? { schemaVersion: view.schemaVersion, labelColumnId: view.labelColumnId } : null;
    if (!equal(settings(old), settings(next)))
      changes.push({ kind: 'graph-settings', value: settings(next) });
    const a = old?.positions ?? {},
      b = next?.positions ?? {};
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (
        !equal(Object.hasOwn(a, id) ? a[id] : undefined, Object.hasOwn(b, id) ? b[id] : undefined)
      )
        changes.push({
          kind: 'graph-position',
          rowId: id,
          value: Object.hasOwn(b, id) ? b[id] : null,
        });
  }
  const oldCollections = schema.collections(before),
    nextCollections = schema.collections(after);
  for (const next of nextCollections) {
    const previous = oldCollections.find((c) => c.key === next.key);
    if (previous?.items === next.items && previous.present === next.present) continue;
    // A new page contains its initial objects in its own insertion, once.
    if (!previous && next.key.startsWith('objects@')) continue;
    const old = previous?.items ?? [],
      now = next.items,
      oldById = new Map(old.map((item) => [item.id, item])),
      nextIds = new Set(now.map((item) => item.id));
    for (const item of old)
      if (!nextIds.has(item.id))
        changes.push({ kind: 'remove', collection: next.key, id: item.id });
    for (const item of now) {
      const prev = oldById.get(item.id);
      if (prev === item) continue;
      if (!prev)
        changes.push({ kind: 'insert', collection: next.key, id: item.id, value: copy(item) });
      else {
        for (const field of new Set([...Object.keys(prev), ...Object.keys(item)]))
          if (
            field !== 'id' &&
            field !== next.nested &&
            !next.fields.includes(field) &&
            !equal(prev[field], item[field])
          )
            fail('unsupported-operation', `Unknown element property: ${field}`);
        for (const field of next.fields)
          if (!equal(prev[field], item[field]))
            changes.push({
              kind: 'field',
              collection: next.key,
              id: item.id,
              field,
              value: item[field] ?? null,
            });
        if (next.key === 'rows') {
          const a = prev.values as Root,
            b = item.values as Root;
          for (const columnId of new Set([...Object.keys(a), ...Object.keys(b)]))
            if (!equal(a[columnId], b[columnId]) || columnId in a !== columnId in b)
              changes.push({
                kind: 'cell',
                rowId: item.id,
                columnId,
                value: columnId in b ? b[columnId] : { deleted: true },
              });
        }
      }
    }
    const interim = [
      ...old.filter((e) => nextIds.has(e.id)),
      ...now.filter((e) => !oldById.has(e.id)),
    ].map((e) => e.id);
    if (
      !equal(
        interim,
        now.map((e) => e.id),
      )
    )
      changes.push({ kind: 'order', collection: next.key, ids: now.map((e) => e.id) });
    if (!now.length && next.present !== previous?.present)
      changes.push({ kind: 'empty', collection: next.key, present: next.present });
  }
  return changes;
}
function transactionAction<T>(
  schema: Schema<T>,
  before: T,
  after: T,
  reads: string[] = [],
): Action {
  return {
    type: `${schema.base.domain}.edit`,
    target: '*',
    payload: { changes: JSON.parse(canonical(differences(schema, before, after))), reads },
  };
}
/** Evaluate the compatibility function once; never put functions or regenerated IDs on the wire. */
export function prepareEditorCommand<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  identity: Identity,
  command: EditorCommand<T>,
): Operation | undefined {
  const value = editorCommandActions(codec, state, command);
  if (!value) return;
  const op = operation(codec, state, identity, value.actions, value.origin);
  if (value.transactionId) op.transactionId = value.transactionId;
  return op;
}
/** Immutable preparation for a client that can reuse its first optimistic edit. */
export function prepareEditorProjection<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  identity: Identity,
  command: EditorCommand<T>,
): PreparedOperation<T> | undefined {
  const value = editorCommandActions(codec, state, command);
  if (!value) return;
  return prepareOperation(codec, state, identity, value.actions, value.origin, value.transactionId);
}
function editorCommandActions<T>(
  codec: DomainCodec<T>,
  state: Snapshot<T>,
  command: EditorCommand<T>,
): { actions: Action[]; origin: Origin; transactionId?: string } | undefined {
  if (codec.domain === 'react-ui') {
    const after = command.apply(command.readonlyInput ? state.content : copy(state.content));
    const action = reactUiPatchAction(
      state.content as ReactUiDocument,
      after as ReactUiDocument,
      command.reads?.content,
    );
    return action
      ? {
          actions: [action],
          origin: command.context?.origin === 'proposal' ? 'proposal' : 'human',
          transactionId: command.context?.transactionId,
        }
      : undefined;
  }
  if (codec.domain === 'document') {
    const before = state.content as Root,
      after = command.apply(command.readonlyInput ? state.content : copy(state.content)) as Root;
    if (!equal({ ...before, page: null }, { ...after, page: null }))
      fail('unsupported-operation', 'Document content edits require the text engine');
    if (equal(before.page, after.page)) return;
    return {
      actions: [{ type: 'document.page', target: '*', payload: { value: after.page ?? null } }],
      origin: 'human',
    };
  }
  const schema = schemaFor(codec),
    after = command.apply(command.readonlyInput ? state.content : copy(state.content));
  if (!codec.validate(after)) fail('invalid-operation', 'Command produced invalid domain content');
  const action = transactionAction(schema, state.content, after);
  if (!(action.payload.changes as EditorChange[]).length) return undefined;
  const changes = action.payload.changes as EditorChange[],
    textIds = new Set(
      changes.flatMap((c) =>
        c.kind === 'field' && ['text', 'runs'].includes(c.field) ? [c.id] : [],
      ),
    );
  const textActions: Action[] = [...textIds]
    .map((id) => {
      const item = schema
        .collections(after)
        .flatMap((c) => c.items)
        .find((e) => e.id === id)!;
      const tr = canvasTextReplacement(
        EditorState.create({ doc: canvasEngineDocument(codec, state.content, id) }),
        item.text as string,
        item.runs as TextRun[] | undefined,
        canvasTextItem(codec, after, id).style,
      );
      return {
        type: 'canvas.text-steps',
        target: id,
        payload: { version: state.textVersions?.[id] ?? 0, steps: tr.steps.map((s) => s.toJSON()) },
      };
    })
    .filter((a) => (a.payload.steps as unknown[]).length);
  action.payload.changes = changes.filter(
    (c) => c.kind !== 'field' || !['text', 'runs'].includes(c.field),
  );
  // Explicit command reads include unchanged alignment references and duplication sources.
  // Required write/parent dependencies are also derived independently at the authority.
  const geometryIds = [...(command.reads?.geometry ?? [])];
  action.payload.reads = [
    ...geometryReads(schema, state.content, geometryIds),
    ...contentReads(schema, state.content, command.reads?.content ?? []),
    ...(codec.domain === 'slide' && command.type === 'slide.layout'
      ? ['root/width', 'root/height']
      : []),
    ...(codec.domain === 'whiteboard' && command.type === 'whiteboard.transform'
      ? [
          'order:sections',
          ...((state.content as WhiteboardContent).sections ?? []).flatMap((s) =>
            ['id', 'bounds'].map((field) => `${entityKey('sections', s.id)}/${field}`),
          ),
        ]
      : []),
  ];
  return {
    actions: [
      ...textActions,
      ...((action.payload.changes as EditorChange[]).length ? [action] : []),
    ],
    origin: command.context?.origin === 'proposal' ? 'proposal' : 'human',
    transactionId: command.context?.transactionId,
  };
}
/** Fork only the containers written by a native edit. Nested assigned values and
 * insertions are copied at the write below; every other branch remains read-only. */
function forkEditedContent<T>(schema: Schema<T>, source: T, changes: EditorChange[]): T {
  const next = { ...source };
  if (
    schema.base.domain === 'data' &&
    changes.some((c) => c.kind === 'graph-settings' || c.kind === 'graph-position')
  ) {
    const data = next as StructuredData;
    if (data.graphView)
      data.graphView = { ...data.graphView, positions: { ...data.graphView.positions } };
  }
  const fields = new Map<string, Set<string>>();
  for (const change of changes) {
    const collection =
      change.kind === 'cell' ? 'rows' : change.kind === 'field' ? change.collection : undefined;
    if (collection) {
      const ids = fields.get(collection) ?? new Set<string>();
      ids.add(change.kind === 'cell' ? change.rowId : (change as { id: string }).id);
      fields.set(collection, ids);
    }
  }
  if (schema.base.domain === 'slide') {
    const pages = new Set(fields.get('pages'));
    for (const change of changes)
      if ('collection' in change && change.collection.startsWith('objects@'))
        pages.add(change.collection.slice(8));
    const deck = next as SlideContent;
    if (pages.size)
      deck.slides = deck.slides.map((page) => (pages.has(page.id) ? { ...page } : page));
    // Page containers were already forked; object collection setters must retain them.
    fields.delete('pages');
  }
  for (const collection of schema.collections(next)) {
    const ids = fields.get(collection.key);
    if (!ids) continue;
    collection.set(
      collection.items.map((item) =>
        !ids.has(item.id)
          ? item
          : {
              ...item,
              ...(collection.key === 'rows' ? { values: { ...(item.values as Root) } } : {}),
            },
      ),
    );
  }
  return next;
}
function editorCodec<T>(schema: Schema<T>): DomainCodec<T> {
  const base = schema.base;
  // Only domain content is cached. Snapshot metadata, permissions, operation
  // preconditions and asset checks keep their independent validation boundaries.
  const validContents = new WeakSet<object>();
  const valid = (value: unknown): value is T => {
    if (value && typeof value === 'object' && validContents.has(value)) return true;
    if (!base.validate(value)) return false;
    const collections = schema.collections(value),
      ids = collections.flatMap((c) => c.items.map((e) => e.id));
    if (new Set(ids).size !== ids.length || ids.some((id) => !id || /[/:@]/.test(id))) return false;
    if (base.domain === 'design') {
      const d = value as DesignContent;
      if (
        d.elements.some((e) => {
          const component = d.components.find((c) => c.id === e.componentId);
          return (
            (e.type === 'instance' && !component) ||
            (e.styleId !== undefined && !d.styles?.some((s) => s.id === e.styleId)) ||
            (e.overrides &&
              Object.keys(e.overrides).some((id) =>
                component?.elements ? !component.elements.some((p) => p.id === id) : id !== 'root',
              )) ||
            (e.layout &&
              (!['row', 'column', 'absolute'].includes(e.layout.direction) ||
                !Number.isFinite(e.layout.gap) ||
                !Number.isFinite(e.layout.padding) ||
                e.layout.gap < 0 ||
                e.layout.padding < 0))
          );
        })
      )
        return false;
    }
    if (base.domain === 'whiteboard') {
      const d = value as WhiteboardContent,
        nodes = new Set(d.nodes.map((n) => n.id));
      if (d.connectors.some((c) => (c.from && !nodes.has(c.from)) || (c.to && !nodes.has(c.to))))
        return false;
    }
    if (base.domain === 'data') {
      const d = value as StructuredData,
        columns = new Set(d.columns.map((c) => c.id));
      if (d.rows.some((r) => Object.keys(r.values).some((id) => !columns.has(id)))) return false;
      if (new Set(d.columns.map((c) => c.name.toLowerCase())).size !== d.columns.length)
        return false;
      try {
        for (const column of d.columns.filter((c) => c.type === 'formula'))
          cellValue(
            d,
            d.rows[0] ?? {
              id: 'schema-check',
              values: Object.fromEntries(
                d.columns
                  .filter((c) => c.type !== 'formula')
                  .map((c) => [c.id, c.type === 'number' ? 1 : null]),
              ),
            },
            column,
          );
      } catch {
        return false;
      }
      for (const view of d.views ?? []) {
        const refs = [
          ...view.hidden,
          ...view.cardFields,
          ...view.sorts.map((s) => s.columnId),
          ...view.filters.map((f) => f.columnId),
          view.groupBy,
          view.chart.x,
          view.chart.y,
          view.chart.series,
          view.timeline.start,
          view.timeline.end,
          view.timeline.group,
          view.summary.columnId,
          ...view.widgets.flatMap((w) => [w.columnId, w.chart?.x, w.chart?.y, w.chart?.series]),
        ];
        if (refs.some((id) => id && !columns.has(id))) return false;
      }
    }
    if (value && typeof value === 'object' && isDeepFrozen(value)) validContents.add(value);
    return true;
  };
  type ResourceIndex = {
    collections: Map<string, Collection>;
    items: Map<string, Map<string, RecordValue>>;
    children?: Map<string, string[]>;
  };
  const read = (d: T, key: string, index?: ResourceIndex): unknown => {
    if (base.domain === 'data' && key.startsWith('data-graph/')) {
      const view = (d as StructuredData).graphView;
      if (key === 'data-graph/settings')
        return view
          ? { schemaVersion: view.schemaVersion, labelColumnId: view.labelColumnId }
          : null;
      if (key === 'data-graph/present') return !!view;
      if (key === 'data-graph/positions') return view?.positions;
      if (key.startsWith('data-graph/position/')) {
        const id = key.slice(20);
        return view && Object.hasOwn(view.positions, id) ? view.positions[id] : undefined;
      }
    }
    if (key === 'geometry') return projection(schema, d);
    if (key.startsWith('children:'))
      return (
        (index
          ? (index.children ??= geometryIndex(schema, d).children)
          : geometryIndex(schema, d).children
        ).get(key.slice(9)) ?? []
      );
    if (key === 'schema') return base.domain === 'data' ? (d as StructuredData).columns : undefined;
    if (key.startsWith('root/')) return (d as Root)[key.slice(5)];
    if (key.startsWith('order:')) {
      const c = index
        ? index.collections.get(key.slice(6))
        : schema.collections(d).find((c) => c.key === key.slice(6));
      return c?.present ? c.items.map((e) => e.id) : null;
    }
    if (key.startsWith('entity:')) {
      const [collection, part] = key.slice(7).split(':'),
        [id, field, columnId] = part.split('/');
      const item = index
        ? index.items.get(collection)?.get(id)
        : schema
            .collections(d)
            .find((c) => c.key === collection)
            ?.items.find((e) => e.id === id);
      return field === 'values' && columnId
        ? (item?.values as Root | undefined)?.[columnId]
        : field
          ? item?.[field]
          : item;
    }
    return base.resource(d, key);
  };
  const codec: DomainCodec<T> = {
    ...base,
    validate: valid,
    resource: (d, key) => read(d, key),
    resources(d, keys) {
      const collections = schema.collections(d);
      const index: ResourceIndex = {
        collections: new Map(collections.map((c) => [c.key, c])),
        items: new Map(
          collections.map((c) => [c.key, new Map(c.items.map((item) => [item.id, item]))]),
        ),
      };
      return keys.map((key) => read(d, key, index));
    },
    validateAnchor(d, anchor) {
      if (anchor.orphan) return true;
      if (anchor.type === 'canvas-text') {
        try {
          return (
            Number.isSafeInteger(anchor.from) &&
            Number.isSafeInteger(anchor.to) &&
            anchor.from >= 0 &&
            anchor.to >= anchor.from &&
            anchor.to <= canvasEngineDocument(base, d, anchor.elementId).content.size
          );
        } catch {
          return false;
        }
      }
      if (base.domain === 'data' && anchor.type === 'element' && anchor.region?.type === 'cell') {
        const data = d as StructuredData,
          region = anchor.region;
        return (
          data.rows.some((r) => r.id === anchor.elementId) &&
          data.columns.some((c) => c.id === region.columnId) &&
          (!region.endRowId || data.rows.some((r) => r.id === region.endRowId)) &&
          (!region.endColumnId || data.columns.some((c) => c.id === region.endColumnId))
        );
      }
      return (
        base.validateAnchor(d, anchor) ||
        (anchor.type === 'element' &&
          schema.collections(d).some((c) => c.items.some((e) => e.id === anchor.elementId)))
      );
    },
    mapAnchor(anchor, before, action) {
      if (action.type === 'canvas.text-steps')
        return mapCanvasTextAnchor(base, anchor, before, action);
      if (action.type !== `${base.domain}.edit`)
        return base.mapAnchor?.(anchor, before, action) ?? anchor;
      if (anchor.type === 'element' || anchor.type === 'canvas-text') {
        const after = codec.applyReadonly!(before, action, 0).content;
        if (!codec.validateAnchor(after, { ...anchor, orphan: false }))
          return { ...anchor, orphan: true };
      }
      return anchor;
    },
    apply(content, action, version, textVersions): Effect<T> {
      if (action.type === 'canvas.text-steps')
        return applyCanvasSteps(codec, content, action, textVersions);
      if (action.type === 'domain.restore') return base.apply(content, action, version);
      if (action.type !== `${base.domain}.edit`)
        fail('unsupported-operation', 'Use the normal editor transaction or text engine API');
      const before = content,
        changes = action.payload.changes as EditorChange[];
      if (!Array.isArray(changes) || !changes.length || changes.length > 2000)
        fail('schema-mismatch', 'Invalid editor transaction');
      content = forkEditedContent(schema, before, changes);
      const required = new Set<string>(),
        touched = new Set<string>(),
        invalidates = new Set<string>(),
        targets = new Set<string>();
      const reads = action.payload.reads;
      if (!Array.isArray(reads) || !reads.every((r) => typeof r === 'string'))
        fail('schema-mismatch', 'Invalid read dependencies');
      reads.forEach((r) => required.add(r));
      // Collection accessors follow their current native arrays. Keep item indexes
      // only for this private evaluation and update them after each structural edit.
      let collections = new Map(schema.collections(content).map((c) => [c.key, c]));
      const items = new Map<string, Map<string, RecordValue>>();
      for (const change of changes) {
        if (change.kind === 'graph-settings' || change.kind === 'graph-position') {
          if (base.domain !== 'data')
            fail('unsupported-operation', 'Graph view settings belong to Data');
          const d = content as StructuredData;
          invalidates.add('root/graphView');
          if (change.kind === 'graph-settings') {
            const key = 'data-graph/settings';
            required.add(key);
            touched.add(key);
            targets.add('*');
            if (!!d.graphView !== (change.value !== null)) {
              touched.add('data-graph/present');
              touched.add('data-graph/positions');
            }
            if (change.value === null) {
              required.add('data-graph/positions');
              delete d.graphView;
            } else {
              if (
                change.value.schemaVersion !== 1 ||
                Object.keys(change.value).some(
                  (k) => !['schemaVersion', 'labelColumnId'].includes(k),
                )
              )
                fail('schema-mismatch', 'Invalid graph view settings');
              d.graphView = { ...copy(change.value), positions: d.graphView?.positions ?? {} };
            }
          } else {
            safeId(change.rowId);
            const key = `data-graph/position/${change.rowId}`;
            required.add(key);
            touched.add(key);
            invalidates.add('data-graph/positions');
            targets.add(change.rowId);
            required.add(`${entityKey('rows', change.rowId)}/id`);
            if (change.value === null) {
              if (d.graphView) delete d.graphView.positions[change.rowId];
            } else {
              required.add('data-graph/present');
              if (!d.graphView) fail('target-deleted', 'Graph view settings are missing');
              d.graphView.positions = {
                ...d.graphView.positions,
                [change.rowId]: copy(change.value),
              };
            }
          }
          continue;
        }
        if (change.kind === 'root') {
          if (!schema.root.includes(change.field))
            fail('unsupported-operation', 'Unknown domain property');
          const key = `root/${change.field}`;
          required.add(key);
          touched.add(key);
          targets.add('*');
          (content as Root)[change.field] = copy(change.value);
          invalidates.add('geometry');
          continue;
        }
        if (change.kind === 'cell') {
          if (base.domain !== 'data') fail('unsupported-operation', 'Cells belong to Data');
          const d = content as StructuredData,
            row = d.rows.find((r) => r.id === change.rowId),
            col = d.columns.find((c) => c.id === change.columnId),
            original = (before as StructuredData).columns.find((c) => c.id === change.columnId);
          const deleted = equal(change.value, { deleted: true });
          if (!row) fail('target-deleted', 'Row is missing');
          // Deleting a column removes its cells in the same atomic transaction.
          if (
            !col &&
            !deleted &&
            !changes.some(
              (c) => c.kind === 'insert' && c.collection === 'columns' && c.id === change.columnId,
            )
          )
            fail('target-deleted', 'Column is missing');
          const finalTypeChange = changes.find(
            (c) =>
              c.kind === 'field' &&
              c.collection === 'columns' &&
              c.id === change.columnId &&
              c.field === 'type',
          );
          const finalType = finalTypeChange?.kind === 'field' ? finalTypeChange.value : col?.type;
          if (
            original?.readOnly &&
            !(
              deleted &&
              changes.some(
                (c) => c.kind === 'remove' && c.collection === 'columns' && c.id === original.id,
              )
            )
          )
            fail(
              'unauthorized',
              'read-only values cannot be changed in the same operation as unlocking their field',
            );
          if (
            col &&
            (col.readOnly || col.type === 'formula') &&
            // An atomic, validated schema migration may materialize a computed field.
            // Ordinary cell writes still cannot edit computed/read-only values.
            !(finalTypeChange && finalType !== col.type && (finalType !== 'formula' || deleted)) &&
            !changes.some(
              (c) =>
                c.kind === 'field' &&
                c.collection === 'columns' &&
                c.id === change.columnId &&
                c.field === 'readOnly' &&
                c.value === false &&
                finalType !== 'formula',
            ) &&
            !changes.some(
              (c) => c.kind === 'remove' && c.collection === 'columns' && c.id === col.id,
            )
          )
            fail('unauthorized', 'Computed/read-only cell');
          const key = `${entityKey('rows', change.rowId)}/values/${change.columnId}`;
          required.add(key);
          required.add('schema');
          touched.add(key);
          targets.add(change.rowId);
          targets.add(change.columnId);
          if (deleted) delete row.values[change.columnId];
          else row.values[change.columnId] = copy(change.value) as never;
          continue;
        }
        const c = collections.get(change.collection);
        if (!c) fail('target-deleted', 'Domain collection is missing');
        let byId = items.get(c.key);
        if (!byId) items.set(c.key, (byId = new Map(c.items.map((item) => [item.id, item]))));
        if (c.key.startsWith('objects@'))
          invalidates.add(`${entityKey('pages', c.key.slice(8))}/objects`);
        if (change.kind === 'empty') {
          if (
            !['views', 'styles', 'sections'].includes(c.key) ||
            c.items.length ||
            typeof change.present !== 'boolean'
          )
            fail('invalid-operation', 'Only an empty optional collection may be omitted');
          required.add(orderKey(c.key));
          touched.add(orderKey(c.key));
          targets.add('*');
          if (change.present) c.set([]);
          else c.clear();
          continue;
        }
        if (change.kind === 'order') {
          if (
            !Array.isArray(change.ids) ||
            new Set(change.ids).size !== c.items.length ||
            change.ids.length !== c.items.length ||
            !change.ids.every((id) => byId.has(id))
          )
            fail('invalid-operation', 'Order must be an exact permutation');
          required.add(orderKey(c.key));
          touched.add(orderKey(c.key));
          invalidates.add('geometry');
          change.ids.forEach((id) => targets.add(id));
          c.set(change.ids.map((id) => byId.get(id)!));
          continue;
        }
        safeId(change.id);
        const item = byId.get(change.id),
          key = entityKey(c.key, change.id);
        targets.add(change.id);
        if (c.key.startsWith('objects@')) {
          const parent = c.key.slice(8);
          targets.add(parent);
          required.add(`${entityKey('pages', parent)}/id`);
        }
        if (change.kind === 'insert') {
          if (item) fail('stale-precondition', 'Inserted ID already exists');
          if (
            !change.value ||
            change.value.id !== change.id ||
            Object.keys(change.value).some(
              (k) => k !== 'id' && k !== c.nested && !c.fields.includes(k),
            )
          )
            fail('schema-mismatch', 'Invalid inserted domain fields');
          required.add(key);
          required.add(orderKey(c.key));
          touched.add(key);
          touched.add(orderKey(c.key));
          invalidates.add('geometry');
          const inserted = copy(change.value);
          c.set([...c.items, inserted]);
          byId.set(change.id, inserted);
        } else if (change.kind === 'remove') {
          if (!item) fail('target-deleted', 'Deleted element is missing');
          if (item.locked) fail('unauthorized', 'Element is locked');
          required.add(key);
          required.add(orderKey(c.key));
          touched.add(key);
          touched.add(orderKey(c.key));
          invalidates.add('geometry');
          c.set(c.items.filter((e) => e.id !== change.id));
          byId.delete(change.id);
        } else if (change.kind === 'field') {
          if (!item) fail('target-deleted', 'Edited element is missing');
          if (!c.fields.includes(change.field))
            fail('unsupported-operation', 'Unknown domain field');
          if (item.locked && change.field !== 'locked') fail('unauthorized', 'Element is locked');
          if (['text', 'runs'].includes(change.field))
            fail('unsupported-operation', 'Shared text requires text engine steps');
          const fieldKey = `${key}/${change.field}`;
          required.add(fieldKey);
          touched.add(fieldKey);
          if (layoutFields.has(change.field)) {
            invalidates.add('geometry');
          }
          if (change.value === null) delete item[change.field];
          else item[change.field] = copy(change.value);
        } else fail('schema-mismatch', 'Unknown domain change');
        if (c.key === 'pages' && (change.kind === 'insert' || change.kind === 'remove')) {
          // Page edits change which object collections exist, including a remove
          // followed by a new page with the same ID in this atomic transaction.
          collections = new Map(schema.collections(content).map((c) => [c.key, c]));
          items.clear();
        }
        if (base.domain === 'data' && c.key === 'columns') {
          required.add('schema');
          invalidates.add('schema');
        }
      }
      const geometryIds = changes.flatMap((change) =>
        change.kind === 'field' && layoutFields.has(change.field) ? [change.id] : [],
      );
      const beforeGeometry = base.domain === 'data' ? undefined : geometryIndex(schema, before),
        afterGeometry = base.domain === 'data' ? undefined : geometryIndex(schema, content);
      for (const key of [
        ...geometryReads(schema, before, geometryIds, beforeGeometry),
        ...geometryReads(schema, content, geometryIds, afterGeometry),
      ])
        required.add(key);
      const oldChildren = beforeGeometry?.children ?? new Map<string, string[]>(),
        nextChildren = afterGeometry?.children ?? new Map<string, string[]>();
      for (const key of new Set([...oldChildren.keys(), ...nextChildren.keys()]))
        if (!equal(oldChildren.get(key) ?? [], nextChildren.get(key) ?? []))
          invalidates.add(`children:${key}`);
      if (!base.validate(content))
        fail('invalid-operation', 'Transaction violates domain invariants');
      if (base.domain === 'data' && validateData(content as StructuredData).length)
        fail('invalid-operation', 'Transaction violates cell types, constraints or formulas');
      return {
        content,
        required: [...required],
        touched: [...touched],
        invalidates: [...invalidates],
        targets: [...targets],
        inverse: [transactionAction(schema, content, before)],
      };
    },
  };
  codec.applyReadonly = (content, action, version, textVersions) => {
    const result = codec.apply(
      action.type === `${base.domain}.edit` ? content : copy(content),
      action,
      version,
      textVersions,
    );
    // Every write owns its assigned values. Certify the private result only when
    // no borrowed source branch could belong to a mutable Host caller.
    if (Object.values(content as object).every(isDeepFrozen)) deepFreeze(result.content);
    return result;
  };
  return codec;
}
export const slideEditorCodec = editorAssetCodec(withNativeReuse(editorCodec(slideSchema)));
export const designEditorCodec = editorAssetCodec(withNativeReuse(editorCodec(designSchema)));
export const whiteboardEditorCodec = editorAssetCodec(withNativeReuse(editorCodec(boardSchema)));
export const dataEditorCodec = withNativeReuse(editorCodec(dataSchema));
// Keep schema imports in the public type graph; these validators also document ownership.
export const editorValidators = {
  slide: isDeck,
  design: isDesign,
  whiteboard: isWhiteboard,
  data: isStructuredData,
};
