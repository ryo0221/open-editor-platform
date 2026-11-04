import {
  changedKeys,
  sameValue,
  textRange,
  type ProposalDiffAdapter,
  type DomainDiff,
} from '@editor-platform/editor-core';
import type { DesignContent } from './model';
/** Page semantic display. Unknown properties stay visible as fallback and must not be adopted. */
export const designMangaProposalDiff: ProposalDiffAdapter<DesignContent> = {
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
        result.changes.push({
          domain: 'design',
          kind: 'property',
          elementId: id,
          property: !x ? 'panel.added' : 'panel.removed',
          before: x,
          after: y,
        });
      else
        for (const property of changedKeys(x, y)) {
          const old = x[property as keyof typeof x],
            next = y[property as keyof typeof y];
          // Native bounds transforms materialize the default 0 rotation on leaves.
          // This is not a rotation proposal; actual angle changes remain unsupported.
          if (property === 'rotation' && (old ?? 0) === (next ?? 0)) continue;
          if (
            [
              'bounds',
              'text',
              'src',
              'shape',
              'flipX',
              'flipY',
              'clipContent',
              'panelGeometry',
              'radius',
              'parentId',
            ].includes(property)
          )
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
    const oldPages = before.pagination?.pages,
      newPages = after.pagination?.pages;
    if (
      oldPages &&
      newPages &&
      oldPages.length === newPages.length &&
      oldPages.every((p) => newPages.some((n) => n.frameId === p.frameId))
    ) {
      const old = oldPages.map((p) => p.frameId),
        next = newPages.map((p) => p.frameId);
      if (!sameValue(old, next))
        result.changes.push({
          domain: 'design',
          kind: 'order',
          elementId: '',
          property: 'pagination.pageOrder',
          before: old,
          after: next,
        });
      for (const page of oldPages) {
        const division = newPages.find((p) => p.frameId === page.frameId)!.division;
        if (!sameValue(page.division, division))
          result.changes.push({
            domain: 'design',
            kind: 'property',
            elementId: page.frameId,
            property: 'pagination.division',
            before: page.division,
            after: division,
          });
        const next = newPages.find((p) => p.frameId === page.frameId)!.panelIds;
        if (!sameValue(page.panelIds, next))
          result.changes.push({
            domain: 'design',
            kind: 'order',
            elementId: page.frameId,
            property: 'pagination.panelOrder',
            before: page.panelIds,
            after: next,
          });
      }
    } else if (!sameValue(oldPages, newPages))
      result.changes.push({
        domain: 'design',
        kind: 'order',
        elementId: '',
        property: 'pagination.pages',
        before: oldPages,
        after: newPages,
      });
    for (const property of ['direction', 'images'] as const) {
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
    for (const key of changedKeys(before, after, ['elements', 'pagination', 'schemaVersion']))
      result.fallback.push({
        path: key,
        before: before[key as keyof DesignContent],
        after: after[key as keyof DesignContent],
        reason: 'unsupported-m0-property',
      });
    if (before.schemaVersion !== after.schemaVersion)
      result.changes.push({
        domain: 'design',
        kind: 'property',
        elementId: '',
        property: 'schemaVersion',
        before: before.schemaVersion,
        after: after.schemaVersion,
      });
    return result;
  },
};
