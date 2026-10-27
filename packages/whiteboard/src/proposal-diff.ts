import {
  changedKeys,
  orderChanged,
  sameValue,
  textRange,
  type Bounds,
  type FallbackChange,
  type ProposalDiffAdapter,
  type SemanticChange,
} from '@editor-platform/editor-core';
import type { WhiteboardContent, WhiteboardNode } from './model';

const finite = (b: Bounds | undefined) =>
  !!b && [b.x, b.y, b.width, b.height].every((v) => typeof v === 'number' && Number.isFinite(v));
const nodeLabel = (n: WhiteboardNode) => n.name || n.text || n.kind;
const boardUnits = (...bounds: (Bounds | undefined)[]) =>
  bounds.every(finite)
    ? { units: 'board-px' }
    : { unknownUnits: 'Bounds are not finite board pixels' };

function boundsChange(old: WhiteboardNode, next: WhiteboardNode): SemanticChange | undefined {
  const a = old.bounds,
    b = next.bounds;
  if (sameValue(a, b)) return;
  const resized = a.width !== b.width || a.height !== b.height;
  return {
    domain: 'whiteboard',
    kind: resized ? 'resize' : 'move',
    elementId: next.id,
    elementLabel: nodeLabel(next),
    property: 'bounds',
    before: a,
    after: b,
    // Board coordinates: absolute CSS pixels at zoom 1, independent of the camera.
    ...boardUnits(a, b),
  };
}

/** Node moves, sizes, text and connectors keyed by stable node/connector IDs. */
export const whiteboardProposalDiff: ProposalDiffAdapter<WhiteboardContent> = {
  domain: 'whiteboard',
  has: (d, id) =>
    d.nodes.some((n) => n.id === id) ||
    d.connectors.some((c) => c.id === id) ||
    !!d.sections?.some((s) => s.id === id),
  diff(before, after) {
    const changes: SemanticChange[] = [],
      fallback: FallbackChange[] = [];
    const am = new Map(before.nodes.map((n) => [n.id, n]));
    for (const node of before.nodes)
      if (!after.nodes.some((n) => n.id === node.id))
        changes.push({
          domain: 'whiteboard',
          kind: 'removed',
          elementId: node.id,
          elementLabel: nodeLabel(node),
          property: node.kind,
          // The native node (text, image source, embedded reference), bounds in board px.
          before: node,
          ...boardUnits(node.bounds),
        });
    for (const node of after.nodes) {
      const old = am.get(node.id);
      if (!old) {
        changes.push({
          domain: 'whiteboard',
          kind: 'added',
          elementId: node.id,
          elementLabel: nodeLabel(node),
          property: node.kind,
          after: node,
          ...boardUnits(node.bounds),
        });
        continue;
      }
      const moved = boundsChange(old, node);
      if (moved) changes.push(moved);
      if (old.text !== node.text)
        changes.push({
          domain: 'whiteboard',
          kind: 'text',
          elementId: node.id,
          elementLabel: nodeLabel(old),
          property: 'text',
          before: old.text,
          after: node.text,
          units: 'utf16',
          range: textRange(old.text, node.text),
        });
      // Native transforms write rotation 0 where it was absent; both mean unrotated.
      if ((old.rotation ?? 0) !== (node.rotation ?? 0))
        changes.push({
          domain: 'whiteboard',
          kind: 'property',
          elementId: node.id,
          elementLabel: nodeLabel(node),
          property: 'rotation',
          before: old.rotation ?? 0,
          after: node.rotation ?? 0,
          units: 'deg',
        });
      for (const key of changedKeys(old, node, ['bounds', 'text', 'rotation']))
        changes.push({
          domain: 'whiteboard',
          kind: 'property',
          elementId: node.id,
          elementLabel: nodeLabel(node),
          property: key,
          before: (old as unknown as Record<string, unknown>)[key],
          after: (node as unknown as Record<string, unknown>)[key],
        });
    }
    const ids = (d: WhiteboardContent) => d.nodes.map((n) => n.id);
    if (orderChanged(ids(before), ids(after)))
      changes.push({
        domain: 'whiteboard',
        kind: 'order',
        elementId: '',
        property: 'nodes',
        before: ids(before),
        after: ids(after),
      });
    const cm = new Map(before.connectors.map((c) => [c.id, c]));
    for (const c of after.connectors) {
      const old = cm.get(c.id);
      if (!old || !sameValue(old, c))
        changes.push({
          domain: 'whiteboard',
          kind: old ? 'property' : 'added',
          elementId: c.id,
          elementLabel: c.label || 'Connector',
          property: 'connector',
          ...(old ? { before: old } : {}),
          after: c,
        });
    }
    for (const c of before.connectors)
      if (!after.connectors.some((n) => n.id === c.id))
        changes.push({
          domain: 'whiteboard',
          kind: 'removed',
          elementId: c.id,
          elementLabel: c.label || 'Connector',
          property: 'connector',
          before: c,
        });
    const sm = new Map((before.sections ?? []).map((s) => [s.id, s]));
    for (const s of after.sections ?? []) {
      const old = sm.get(s.id);
      if (old && !sameValue(old.bounds, s.bounds))
        changes.push({
          domain: 'whiteboard',
          kind:
            old.bounds.width !== s.bounds.width || old.bounds.height !== s.bounds.height
              ? 'resize'
              : 'move',
          elementId: s.id,
          elementLabel: s.title,
          property: 'bounds',
          before: old.bounds,
          after: s.bounds,
          ...boardUnits(old.bounds, s.bounds),
        });
      for (const key of old ? changedKeys(old, s, ['bounds']) : ['section'])
        changes.push({
          domain: 'whiteboard',
          kind: old ? 'property' : 'added',
          elementId: s.id,
          elementLabel: s.title,
          property: key,
          ...(old ? { before: (old as unknown as Record<string, unknown>)[key] } : {}),
          after: old ? (s as unknown as Record<string, unknown>)[key] : s,
        });
    }
    for (const s of before.sections ?? [])
      if (!after.sections?.some((n) => n.id === s.id))
        changes.push({
          domain: 'whiteboard',
          kind: 'removed',
          elementId: s.id,
          elementLabel: s.title,
          property: 'section',
          before: s,
        });
    // Connectors paint (and take clicks) in array order too.
    const connectorIds = (d: WhiteboardContent) => d.connectors.map((c) => c.id);
    if (orderChanged(connectorIds(before), connectorIds(after)))
      changes.push({
        domain: 'whiteboard',
        kind: 'order',
        elementId: '',
        property: 'connectors',
        before: connectorIds(before),
        after: connectorIds(after),
      });
    // Sections paint in array order and the last one under a node receives it.
    const sectionIds = (d: WhiteboardContent) => (d.sections ?? []).map((x) => x.id);
    if (orderChanged(sectionIds(before), sectionIds(after)))
      changes.push({
        domain: 'whiteboard',
        kind: 'order',
        elementId: '',
        property: 'sections',
        before: sectionIds(before),
        after: sectionIds(after),
      });
    for (const key of changedKeys(before, after, ['nodes', 'connectors', 'sections']))
      fallback.push({
        path: key,
        before: (before as unknown as Record<string, unknown>)[key],
        after: (after as unknown as Record<string, unknown>)[key],
        reason: 'no-semantic-diff',
      });
    return { changes, view: [], fallback };
  },
};
