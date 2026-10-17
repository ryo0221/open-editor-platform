import { containsEmbeddedReference } from '@editor-platform/artifact-references';
import {
  copy,
  fail,
  type Action,
  type Domain,
  type DomainCodec,
  type Effect,
} from '@editor-platform/collaboration-core';
import { isDeck, type SlideContent } from '@editor-platform/slide/model';
import { isDesign, type DesignContent } from '@editor-platform/design/model';
import { isWhiteboard, type WhiteboardContent } from '@editor-platform/whiteboard/model';
// These are transient accessors over existing, distinct schemas, not a stored node model.
type Entity = {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
};
interface Access<T> {
  entities(content: T): Entity[];
  replace(content: T, entities: Entity[]): void;
  parent: string;
  ids(content: T): string[];
}
const fields = new Set([
  'bounds',
  'fill',
  'color',
  'opacity',
  'rotation',
  'hidden',
  'locked',
  'name',
]);
function canvas<T>(
  domain: Domain,
  validateNative: (v: unknown) => v is T,
  access: Access<T>,
): DomainCodec<T> {
  const validate = (value: unknown): value is T =>
    validateNative(value) && !containsEmbeddedReference(value);
  const resource = (content: T, key: string): unknown => {
    const [id, field] = key.split('/');
    return field
      ? access.entities(content).find((e) => e.id === id)?.[field]
      : access.entities(content).find((e) => e.id === id);
  };
  return {
    domain,
    validate,
    resource,
    validateAnchor: (content, anchor) =>
      anchor.type === 'element' && access.ids(content).includes(anchor.elementId),
    mapAnchor: (anchor, before, action) => {
      if (anchor.type !== 'element' || action.type !== 'canvas.delete') return anchor;
      const ids = new Set([action.target]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const e of access.entities(before))
          if (
            typeof e[access.parent] === 'string' &&
            ids.has(e[access.parent] as string) &&
            !ids.has(e.id)
          ) {
            ids.add(e.id);
            changed = true;
          }
      }
      if (domain === 'whiteboard')
        for (const c of (before as WhiteboardContent).connectors)
          if (ids.has(c.from) || ids.has(c.to)) ids.add(c.id);
      return ids.has(anchor.elementId) ? { ...anchor, orphan: true } : anchor;
    },
    apply(content, action): Effect<T> {
      if (containsEmbeddedReference(content) || containsEmbeddedReference(action.payload))
        fail(
          'invalid-operation',
          '参照埋め込みの共有編集は未対応です。ローカルで編集してください。',
        );
      if (action.type === 'domain.restore') {
        if (!validate(action.payload.content)) fail('invalid-operation', 'Invalid restore content');
        return {
          content: copy(action.payload.content),
          required: ['*'],
          touched: ['*'],
          targets: ['*'],
          inverse: [{ type: 'domain.restore', target: '*', payload: { content } }],
        };
      }
      const before = copy(content),
        entities = access.entities(content),
        item = entities.find((e) => e.id === action.target),
        p = action.payload;
      const structural = (targets: string[]): Effect<T> => ({
        content,
        required: ['*'],
        touched: ['*'],
        targets,
        inverse: [{ type: 'domain.restore', target: '*', payload: { content: before } }],
      });
      if (action.type === 'canvas.order') {
        if (
          !Array.isArray(p.ids) ||
          p.ids.length !== entities.length ||
          new Set(p.ids).size !== entities.length ||
          !p.ids.every((id) => typeof id === 'string' && entities.some((e) => e.id === id))
        )
          fail('invalid-operation', 'Order must be an exact ID permutation');
        access.replace(
          content,
          p.ids.map((id) => entities.find((e) => e.id === id)!),
        );
        return structural(entities.map((e) => e.id));
      }
      if (action.type === 'slide.order' && domain === 'slide') {
        const deck = content as SlideContent;
        if (
          !Array.isArray(p.ids) ||
          p.ids.length !== deck.slides.length ||
          new Set(p.ids).size !== deck.slides.length ||
          !p.ids.every((id) => deck.slides.some((s) => s.id === id))
        )
          fail('invalid-operation', 'Invalid page order');
        deck.slides = p.ids.map((id) => deck.slides.find((s) => s.id === id)!);
        return structural(deck.slides.map((s) => s.id));
      }
      if (action.type === 'component.fill' && domain === 'design') {
        const design = content as DesignContent,
          component = design.components.find((c) => c.id === action.target);
        if (!component) fail('target-deleted', 'Component definition missing');
        if (typeof p.value !== 'string') fail('invalid-operation', 'Invalid component fill');
        if (component.elements) {
          const part = component.elements.find((e) => e.id === p.elementId);
          if (!part) fail('target-deleted', 'Component part missing; use its stable ID');
          part.fill = p.value;
        } else {
          if (p.elementId !== undefined)
            fail('target-deleted', 'Single-template component has no tree part');
          component.template.fill = p.value;
        }
        return structural([component.id]);
      }
      if (!item) fail('target-deleted', 'Canvas target is missing', [action.target]);
      if (item.locked && !(action.type === 'canvas.set' && p.field === 'locked'))
        fail('unauthorized', 'Canvas target is locked');
      if (action.type === 'canvas.set') {
        if (typeof p.field !== 'string' || !fields.has(p.field))
          fail(
            'unsupported-operation',
            'Shared field is not supported (rich text requires an engine)',
          );
        if (
          (domain === 'whiteboard' && p.field === 'fill') ||
          (domain !== 'whiteboard' && p.field === 'color') ||
          (domain === 'slide' && p.field === 'name')
        )
          fail('unsupported-operation', 'Field does not belong to this domain schema');
        if (
          p.value !== null &&
          ((['fill', 'color', 'name'].includes(p.field) && typeof p.value !== 'string') ||
            (['hidden', 'locked'].includes(p.field) && typeof p.value !== 'boolean') ||
            (['opacity', 'rotation'].includes(p.field) && typeof p.value !== 'number'))
        )
          fail('schema-mismatch', 'Invalid canvas property value');
        if (p.field === 'bounds' && entities.some((e) => e[access.parent] === item.id))
          fail('unsupported-operation', 'Resize of a group requires a domain layout transaction');
        const key = `${item.id}/${p.field}`,
          previous = copy(item[p.field] ?? null);
        if (p.value === null) delete item[p.field];
        else item[p.field] = copy(p.value);
        return {
          content,
          required: [key],
          touched: [key],
          targets: [item.id],
          inverse: [
            { type: action.type, target: item.id, payload: { field: p.field, value: previous } },
          ],
        };
      }
      if (action.type === 'geometry.move') {
        if (
          typeof p.dx !== 'number' ||
          typeof p.dy !== 'number' ||
          !Number.isFinite(p.dx) ||
          !Number.isFinite(p.dy)
        )
          fail('invalid-operation', 'Finite deltas required');
        const ids = new Set([item.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const e of entities)
            if (
              typeof e[access.parent] === 'string' &&
              ids.has(e[access.parent] as string) &&
              !ids.has(e.id)
            ) {
              ids.add(e.id);
              changed = true;
            }
        }
        const moving = entities.filter((e) => ids.has(e.id)),
          keys = moving.map((e) => `${e.id}/bounds`);
        for (const e of moving)
          e.bounds = { ...e.bounds, x: e.bounds.x + p.dx, y: e.bounds.y + p.dy };
        // Deltas commute for a leaf; groups additionally pin topology to prevent a missed child.
        return {
          content,
          required: ids.size > 1 ? ['*'] : [],
          touched: keys,
          targets: [...ids],
          inverse: [{ type: 'geometry.move', target: item.id, payload: { dx: -p.dx, dy: -p.dy } }],
        };
      }
      if (action.type === 'canvas.reparent') {
        if (p.parentId !== null && typeof p.parentId !== 'string')
          fail('invalid-operation', 'Invalid parent ID');
        if (p.parentId === null) delete item[access.parent];
        else item[access.parent] = p.parentId;
        return structural([item.id, ...(typeof p.parentId === 'string' ? [p.parentId] : [])]);
      }
      if (action.type === 'canvas.delete') {
        const ids = new Set([item.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const e of entities)
            if (
              typeof e[access.parent] === 'string' &&
              ids.has(e[access.parent] as string) &&
              !ids.has(e.id)
            ) {
              ids.add(e.id);
              changed = true;
            }
        }
        access.replace(
          content,
          entities.filter((e) => !ids.has(e.id)),
        );
        if (domain === 'whiteboard') {
          const board = content as WhiteboardContent;
          const removed = board.connectors.filter((c) => ids.has(c.from) || ids.has(c.to));
          board.connectors = board.connectors.filter((c) => !ids.has(c.from) && !ids.has(c.to));
          removed.forEach((c) => ids.add(c.id));
        }
        return structural([...ids]);
      }
      if (action.type === 'instance.override-fill' && domain === 'design') {
        const design = content as DesignContent,
          instance = design.elements.find((e) => e.id === item.id)!;
        const component = design.components.find((c) => c.id === instance.componentId);
        if (
          instance.type !== 'instance' ||
          !component ||
          typeof p.elementId !== 'string' ||
          !component.elements?.some((e) => e.id === p.elementId) ||
          typeof p.value !== 'string'
        )
          fail('invalid-operation', 'Invalid component override scope');
        instance.overrides = {
          ...instance.overrides,
          [p.elementId]: { ...instance.overrides?.[p.elementId], fill: p.value },
        };
        return structural([instance.id]);
      }
      fail('unsupported-operation', `Unsupported shared ${domain} operation: ${action.type}`);
    },
  };
}
export const slideCodec = canvas<SlideContent>(
  'slide',
  (v): v is SlideContent =>
    isDeck(v) &&
    new Set(v.slides.flatMap((s) => s.objects.map((o) => o.id))).size ===
      v.slides.reduce((n, s) => n + s.objects.length, 0) &&
    v.slides.every((s) => {
      const groups = new Set(s.objects.filter((o) => o.type === 'group').map((o) => o.id));
      return s.objects.every((o) => !o.groupId || groups.has(o.groupId));
    }),
  {
    entities: (d) => d.slides.flatMap((s) => s.objects) as unknown as Entity[],
    replace: (d, entities) => {
      for (const s of d.slides) {
        const ids = new Set(s.objects.map((o) => o.id));
        s.objects = entities.filter((e) => ids.has(e.id)) as unknown as typeof s.objects;
      }
    },
    parent: 'groupId',
    ids: (d) => [
      ...d.slides.map((s) => s.id),
      ...d.slides.flatMap((s) => s.objects.map((o) => o.id)),
    ],
  },
);
export const designCodec = canvas<DesignContent>(
  'design',
  (v): v is DesignContent => {
    if (!isDesign(v)) return false;
    const components = new Set(v.components.map((c) => c.id));
    if (components.size !== v.components.length) return false;
    const parents = new Set(
      v.elements.filter((e) => e.type === 'group' || e.type === 'frame').map((e) => e.id),
    );
    return v.elements.every(
      (e) =>
        (!e.parentId || parents.has(e.parentId)) &&
        (!e.componentId || components.has(e.componentId)),
    );
  },
  {
    entities: (d) => d.elements as unknown as Entity[],
    replace: (d, e) => {
      d.elements = e as unknown as typeof d.elements;
    },
    parent: 'parentId',
    ids: (d) => d.elements.map((e) => e.id),
  },
);
export const whiteboardCodec = canvas<WhiteboardContent>('whiteboard', isWhiteboard, {
  entities: (d) => d.nodes as unknown as Entity[],
  replace: (d, e) => {
    d.nodes = e as unknown as typeof d.nodes;
  },
  parent: 'groupId',
  ids: (d) => [...d.nodes.map((e) => e.id), ...d.connectors.map((e) => e.id)],
});
export function setField(target: string, field: string, value: unknown): Action {
  return { type: 'canvas.set', target, payload: { field, value } };
}
export function move(target: string, dx: number, dy: number): Action {
  return { type: 'geometry.move', target, payload: { dx, dy } };
}
