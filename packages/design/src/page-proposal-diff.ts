import {
  changedKeys,
  sameValue,
  textRange,
  type ProposalDiffAdapter,
  type DomainDiff,
} from '@editor-platform/editor-core';
import type { DesignContent } from './model';
/** M0 semantic display. Unknown properties stay visible as fallback and must not be accepted by an M0 Host. */
export const designPageProposalDiff: ProposalDiffAdapter<DesignContent> = {
  domain: 'design',
  has: (d, id) => d.elements.some((e) => e.id === id),
  diff(before, after) {
    const result: DomainDiff = { changes: [], view: [], fallback: [] };
    const a = new Map(before.elements.map((e) => [e.id, e]));
    const b = new Map(after.elements.map((e) => [e.id, e]));
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(id),
        y = b.get(id);
      if (!x || !y)
        result.fallback.push({
          path: `elements/${id}`,
          before: x,
          after: y,
          reason: 'unsupported-m0-structure',
        });
      else
        for (const property of changedKeys(x, y)) {
          const old = x[property as keyof typeof x],
            next = y[property as keyof typeof y];
          if (['bounds', 'text', 'src'].includes(property))
            result.changes.push({
              domain: 'design',
              kind: property === 'text' ? 'text' : property === 'bounds' ? 'move' : 'property',
              elementId: id,
              elementLabel: x.name,
              property,
              before: old,
              after: next,
              ...(property === 'text'
                ? { units: 'utf16', range: textRange(x.text, y.text) }
                : property === 'bounds'
                  ? { units: 'design-px' }
                  : {}),
            });
          else
            result.fallback.push({
              path: `elements/${id}/${property}`,
              before: old,
              after: next,
              reason: 'unsupported-m0-property',
            });
        }
    }
    if (
      !sameValue(
        before.elements.map((e) => e.id),
        after.elements.map((e) => e.id),
      )
    )
      result.changes.push({
        domain: 'design',
        kind: 'order',
        elementId: '',
        property: 'z-order',
        before: before.elements.map((e) => e.id),
        after: after.elements.map((e) => e.id),
      });
    for (const property of ['pages', 'direction', 'images'] as const) {
      const old = before.pagination?.[property],
        next = after.pagination?.[property];
      if (!sameValue(old, next))
        result.changes.push({
          domain: 'design',
          kind: property === 'images' ? 'property' : 'order',
          elementId: '',
          property: `pagination.${property}`,
          before: old,
          after: next,
        });
    }
    for (const key of changedKeys(before, after, ['elements', 'pagination']))
      result.fallback.push({
        path: key,
        before: before[key as keyof DesignContent],
        after: after[key as keyof DesignContent],
        reason: 'unsupported-m0-property',
      });
    return result;
  },
};
