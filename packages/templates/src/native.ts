import { clone, newId } from '@editor-platform/artifact-core';
import { isDeck, migrateDeck, hasSlideAnimations } from '@editor-platform/slide/model';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { migrateWhiteboard } from '@editor-platform/whiteboard/sections';
import { isDesign, remapDesignInteractionTargets } from '@editor-platform/design/model';
import { isDocument, migrateDocument } from '@editor-platform/document/model';
import {
  isStructuredData,
  validateData,
  cellValue,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { isFile, isReview } from '@editor-platform/review-surfaces/model';
import { type Domain, type NativeContent, type Path, problem } from './types';
import { type ReuseState } from '@editor-platform/reuse-core';
import { dataNativeIds, remapDataNative } from './native-data';
export function at(value: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (v, key) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined),
    value,
  );
}
export function setAt(value: unknown, path: Path, next: unknown) {
  if (
    !path.length ||
    path.some((k) => ['__proto__', 'constructor', 'prototype'].includes(String(k)))
  )
    problem('invalid-binding', 'Unsafe or empty binding path');
  const owner = at(value, path.slice(0, -1));
  if (!owner || typeof owner !== 'object' || !(path.at(-1)! in owner))
    problem('invalid-binding', `Missing native field ${path.join('.')}`);
  (owner as Record<string, unknown>)[path.at(-1)!] = next;
}
const refs = new Set([
  'id',
  'parentId',
  'groupId',
  'sectionId',
  'componentId',
  'styleId',
  'from',
  'to',
  'paragraphId',
  'childrenId',
  'columnId',
  'x',
  'y',
  'series',
  'groupBy',
  'start',
  'end',
  'group',
  'hidden',
  'cardFields',
  'cellParagraphIds',
]);
/** Resolve names with the source schema before any rename, reuse or ID remapping. */
export function bindDataFormulas(source: StructuredData): StructuredData {
  const content = clone(source);
  for (const column of content.columns)
    if (column.type === 'formula' && column.formula)
      column.formula = column.formula.replace(/\[[^\]]+\]|[A-Za-z_][A-Za-z_0-9]*/g, (token) => {
        const name = token.replace(/^\[|\]$/g, '');
        const ref = source.columns.find((c) => c.name === name || c.id === name);
        // A prepared fragment can reference an explicitly reused target field.
        return ref ? `[${ref.id}]` : token;
      });
  return content;
}
export function remapNative<T>(
  source: T,
  supplied?: Map<string, string>,
  seed?: string,
): { content: T; ids: Map<string, string> } {
  const ids = supplied ?? new Map<string, string>();
  const gather = (value: unknown, key = '') => {
    if (key === 'reuse') {
      (value as ReuseState | undefined)?.instances.forEach((i) => gather(i.id, 'id'));
      return;
    }
    if (
      typeof value === 'string' &&
      ['id', 'paragraphId', 'childrenId', 'cellParagraphIds'].includes(key) &&
      value &&
      !ids.has(value)
    )
      ids.set(value, seed ? `${seed}_${ids.size}` : newId('tpl'));
    else if (Array.isArray(value)) value.forEach((v) => gather(v, key));
    else if (value && typeof value === 'object')
      Object.entries(value).forEach(([k, v]) => gather(v, k));
  };
  const data = isStructuredData(source);
  if (data) {
    dataNativeIds(source).forEach((id) => gather(id, 'id'));
    gather(source.reuse, 'reuse');
  } else gather(source);
  const walk = (value: unknown, key = ''): unknown => {
    if (key === 'reuse' && value) {
      const reuse = clone(value) as ReuseState;
      for (const instance of reuse.instances) {
        instance.id = ids.get(instance.id) ?? instance.id;
        instance.parts = Object.fromEntries(
          Object.entries(instance.parts).map(([part, address]) => [
            part,
            ids.get(address) ??
              address
                .split('/')
                .map((id) => ids.get(id) ?? id)
                .join('/'),
          ]),
        );
        instance.slots = Object.fromEntries(
          Object.entries(instance.slots).map(([slot, values]) => [
            slot,
            values.map(
              (address) =>
                ids.get(address) ??
                address
                  .split('/')
                  .map((id) => ids.get(id) ?? id)
                  .join('/'),
            ),
          ]),
        );
        if (instance.nativeIds)
          instance.nativeIds = Object.fromEntries(
            Object.entries(instance.nativeIds).map(([source, target]) => [
              source,
              ids.get(target) ?? target,
            ]),
          );
      }
      return reuse;
    }
    if (typeof value === 'string') {
      if (key === 'formula')
        return value.replace(/\[([^\]]+)\]/g, (all, id: string) =>
          ids.has(id) ? `[${ids.get(id)}]` : all,
        );
      return refs.has(key) ? (ids.get(value) ?? value) : value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          (['values', 'widths', 'overrides'].includes(key) ? ids.get(k) : undefined) ?? k,
          walk(v, k),
        ]),
      );
    return value;
  };
  const content = (data ? remapDataNative(bindDataFormulas(source), ids) : walk(source)) as T;
  // Only Design's native prototype references are IDs. Host props with the same
  // field names remain literal data, as do fields in other native domains.
  if (isDesign(source) && isDesign(content)) {
    content.elements = content.elements.map((e) => remapDesignInteractionTargets(e, ids));
    content.components = content.components.map((c) => ({
      ...c,
      template: remapDesignInteractionTargets(c.template, ids),
      ...(c.elements
        ? { elements: c.elements.map((e) => remapDesignInteractionTargets(e, ids)) }
        : {}),
    }));
    if (content.prototyping) {
      const p = content.prototyping;
      content.prototyping = {
        ...p,
        ...(p.startFrameId ? { startFrameId: ids.get(p.startFrameId) ?? p.startFrameId } : {}),
        flows: p.flows.map((f) => ({ ...f, frameIds: f.frameIds.map((id) => ids.get(id) ?? id) })),
      };
    }
  }
  if (data && source.reuse)
    (content as StructuredData).reuse = walk(source.reuse, 'reuse') as ReuseState;
  return { content, ids };
}
export function nativeValid(domain: Domain, value: unknown): value is NativeContent {
  return domain === 'slide'
    ? isDeck(value) && !hasSlideAnimations(value)
    : domain === 'whiteboard'
      ? isWhiteboard(value)
      : domain === 'design'
        ? isDesign(value)
        : domain === 'document'
          ? isDocument(value)
          : domain === 'data'
            ? isStructuredData(value)
            : domain === 'review'
              ? isReview(value)
              : isFile(value);
}
export function assertNative(domain: Domain, value: unknown): asserts value is NativeContent {
  if (!nativeValid(domain, value)) problem('domain-schema', `Invalid ${domain} native content`);
  let all: string[] = [];
  const gather = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if ('id' in v && typeof v.id === 'string') all.push(v.id);
    Object.entries(v).forEach(([key, value]) => {
      if (key !== 'reuse') gather(value);
    });
  };
  // Component parts have their own ID scope. createComponent intentionally keeps
  // the first part's ID on the canvas instance; that is not a duplicate entity.
  const scopes = isDesign(value)
    ? [
        { ...value, components: value.components.map((c) => ({ ...c, elements: undefined })) },
        ...value.components.map((c) => c.elements ?? []),
      ]
    : [value];
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (domain === 'data' && isStructuredData(scope)) all = dataNativeIds(scope);
    else {
      all = [];
      gather(scope);
    }
    if (new Set(all).size !== all.length) problem('internal-reference', 'Duplicate native IDs');
    all.forEach((id) => ids.add(id));
  }
  const check = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'reuse') continue;
      if (
        ['parentId', 'groupId', 'sectionId', 'componentId', 'styleId', 'from', 'to'].includes(k) &&
        typeof x === 'string' &&
        x &&
        !ids.has(x)
      )
        problem('internal-reference', `Missing ${k}: ${x}`);
      check(x);
    }
  };
  if (domain !== 'data') check(value);
  if (domain === 'data' && isStructuredData(value)) {
    const errors = validateData(value);
    if (errors.length) problem('data-validation', errors[0].message, errors[0].columnId);
    const probe = {
      id: 'validation',
      values: Object.fromEntries(
        value.columns
          .filter((c) => c.type !== 'formula')
          .map((c) => [c.id, c.defaultValue ?? (c.type === 'number' ? 1 : null)]),
      ),
    };
    for (const c of value.columns.filter((c) => c.type === 'formula')) {
      try {
        cellValue(value, value.rows[0] ?? probe, c);
      } catch (e) {
        problem('formula-reference', String(e), c.id);
      }
    }
    const columns = new Set(value.columns.map((c) => c.id));
    for (const view of value.views ?? []) {
      const fields = [
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
        ...Object.keys(view.widths),
        ...view.widgets.flatMap((w) => [w.columnId, w.chart?.x, w.chart?.y, w.chart?.series]),
      ];
      if (fields.some((id) => id && !columns.has(id)))
        problem('internal-reference', 'View references a missing field');
    }
    for (const row of value.rows)
      if (Object.keys(row.values).some((id) => !columns.has(id)))
        problem('internal-reference', 'Record references a missing field');
  }
}
export function migrateNative(domain: Domain, value: NativeContent): NativeContent {
  if (domain === 'whiteboard' && isWhiteboard(value)) return migrateWhiteboard(clone(value));
  if (domain === 'slide' && isDeck(value)) return migrateDeck(clone(value));
  if (domain === 'document' && isDocument(value)) return migrateDocument(clone(value));
  return clone(value);
}
export function nativeIds(value: unknown): string[] {
  if (isStructuredData(value)) return dataNativeIds(value);
  const ids: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if ('id' in v && typeof v.id === 'string') ids.push(v.id);
    Object.entries(v).forEach(([key, value]) => {
      if (key !== 'reuse') walk(value);
    });
  };
  walk(value);
  return ids;
}
