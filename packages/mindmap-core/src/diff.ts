// What changed between two saved versions of one map, matched by stable node ids.
import type { Change, CompareResult } from '@editor-platform/artifact-core';
import { MINDMAP_MARK_NAMES, mindmapParent, type MindmapContent, type MindmapNode } from './model';

const title = (n: MindmapNode | undefined) => (n ? n.text || '（無題）' : 'なし');
const details = (n: MindmapNode) =>
  [
    n.side ? `左右: ${n.side === 'left' ? '左' : '右'}` : '',
    n.color ? `色: ${n.color}` : '',
    n.marks?.length ? `印: ${n.marks.map((m) => MINDMAP_MARK_NAMES[m]).join('、')}` : '',
    n.note ? `メモ: ${n.note}` : '',
    n.link ? `つながり: ${n.link.namespace}/${n.link.id}` : '',
  ]
    .filter(Boolean)
    .join('\n');

/**
 * Added, removed, renamed, moved and reordered nodes, then other field changes. A node renamed and moved
 * gets both. Changes are in the order of the newer version's tree, removed nodes last.
 */
export function mindmapDiff(before: MindmapContent, after: MindmapContent): CompareResult {
  const changes: Change[] = [];
  const order = (c: MindmapContent) => {
    const ids: string[] = [];
    (function walk(id: string) {
      ids.push(id);
      c.nodes[id]?.children.forEach(walk);
    })(c.rootId);
    return ids;
  };
  for (const id of order(after)) {
    const b = before.nodes[id],
      a = after.nodes[id];
    if (!b) {
      changes.push({
        elementId: id,
        path: `nodes.${id}`,
        kind: 'added',
        after: `${title(a)}\n親: ${title(mindmapParent(after, id))}`,
      });
      continue;
    }
    if (b.text !== a.text)
      changes.push({
        elementId: id,
        path: `nodes.${id}.text`,
        kind: 'changed',
        before: title(b),
        after: title(a),
      });
    const pb = mindmapParent(before, id),
      pa = mindmapParent(after, id);
    if (pb?.id !== pa?.id)
      changes.push({
        elementId: id,
        path: `nodes.${id}.parent`,
        kind: 'moved',
        before: `${title(a)}\n親: ${title(pb)}`,
        after: `${title(a)}\n親: ${title(pa)}`,
      });
    else if (pa && pb) {
      // Same parent: a reorder moves the node among the siblings present in both versions.
      const kept = (list: string[], other: string[]) => list.filter((k) => other.includes(k));
      const was = kept(pb.children, pa.children),
        now = kept(pa.children, pb.children);
      if (was.indexOf(id) !== now.indexOf(id))
        changes.push({
          elementId: id,
          path: `nodes.${id}.order`,
          kind: 'moved',
          before: `${title(a)}\n${title(pa)} の ${was.indexOf(id) + 1} 番目`,
          after: `${title(a)}\n${title(pa)} の ${now.indexOf(id) + 1} 番目`,
        });
    }
    if (details(b) !== details(a))
      changes.push({
        elementId: id,
        path: `nodes.${id}`,
        kind: 'changed',
        before: details(b) || 'なし',
        after: details(a) || 'なし',
      });
  }
  for (const id of order(before))
    if (!after.nodes[id])
      changes.push({
        elementId: id,
        path: `nodes.${id}`,
        kind: 'removed',
        before: `${title(before.nodes[id])}\n親: ${title(mindmapParent(before, id))}`,
      });
  if (before.layout !== after.layout)
    changes.push({
      elementId: after.id,
      path: 'layout',
      kind: 'changed',
      before: before.layout,
      after: after.layout,
    });
  return { changes };
}
