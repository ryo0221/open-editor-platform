import { clone, newId } from '@editor-platform/artifact-core';
import {
  command,
  immutableCommand,
  withCommandReads,
  descendantIds,
  selectedRoots,
  unionBounds,
  validBounds,
  assertEditable,
  type Bounds,
  type TransformDelta,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  transformNodes,
  connectorGeometry,
  connectorProjector,
  type WhiteboardContent,
  type WhiteboardNode,
  type WhiteboardSection,
} from './model';
export function migrateWhiteboard(source: WhiteboardContent): WhiteboardContent {
  if (source.schemaVersion === 3) return source;
  const d = clone(source),
    frames = d.nodes.filter((n) => n.kind === 'frame'),
    sections = [
      ...(d.sections ?? []),
      ...frames.map((n) => ({
        id: n.id,
        title: n.name || n.text || 'Section',
        bounds: clone(n.bounds),
        background: n.color,
        locked: n.locked,
      })),
    ];
  const nearest = (node: WhiteboardNode) => {
    let id = node.groupId;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const parent = d.nodes.find((n) => n.id === id);
      if (!parent) return undefined;
      if (parent.kind === 'frame') return parent.id;
      id = parent.groupId;
    }
    return undefined;
  };
  return {
    ...d,
    schemaVersion: 3,
    sections,
    nodes: d.nodes
      .filter((n) => n.kind !== 'frame')
      .map((n) => ({
        ...n,
        groupId: frames.some((f) => f.id === n.groupId) ? undefined : n.groupId,
        sectionId:
          n.groupId && !frames.some((f) => f.id === n.groupId)
            ? undefined
            : (nearest(n) ?? n.sectionId),
      })),
    connectors: d.connectors.map((c) => {
      const p = connectorGeometry(d, c);
      return {
        ...c,
        ...(frames.some((f) => f.id === c.from)
          ? { from: '', fromPoint: { x: p?.x1 ?? 0, y: p?.y1 ?? 0 } }
          : {}),
        ...(frames.some((f) => f.id === c.to)
          ? { to: '', toPoint: { x: p?.x2 ?? 0, y: p?.y2 ?? 0 } }
          : {}),
      };
    }),
  };
}
export function nodeSection(d: WhiteboardContent, node: WhiteboardNode): string | undefined {
  return sectionForNode(node, (id) => d.nodes.find((n) => n.id === id));
}
function sectionForNode(
  node: WhiteboardNode,
  lookup: (id: string) => WhiteboardNode | undefined,
): string | undefined {
  let root = node;
  const seen = new Set<string>();
  while (root.groupId && !seen.has(root.groupId)) {
    seen.add(root.groupId);
    const parent = lookup(root.groupId);
    if (!parent) break;
    root = parent;
  }
  return root.sectionId;
}
export function sectionMembers(d: WhiteboardContent, id: string): WhiteboardNode[] {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const lookup = (id: string) => byId.get(id);
  return d.nodes.filter((n) => sectionForNode(n, lookup) === id);
}
export function sectionAt(d: WhiteboardContent, bounds: Bounds): WhiteboardSection | undefined {
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  return [...(d.sections ?? [])]
    .reverse()
    .find(
      (s) =>
        x >= s.bounds.x &&
        x <= s.bounds.x + s.bounds.width &&
        y >= s.bounds.y &&
        y <= s.bounds.y + s.bounds.height,
    );
}
export function boardSelection(d: WhiteboardContent, ids: string[]): Set<string> {
  const roots = [
    ...ids,
    ...ids.flatMap((id) =>
      (d.sections ?? []).some((s) => s.id === id) ? sectionMembers(d, id).map((n) => n.id) : [],
    ),
  ];
  return descendantIds(
    d.nodes.map((n) => ({ ...n, parentId: n.groupId })),
    roots,
  );
}
export function createSection(
  bounds: Bounds,
  title = 'Section',
  members: string[] = [],
): EditorCommand<WhiteboardContent> {
  const section = { id: newId('section'), title, bounds: clone(bounds), background: '#eaf0ff' };
  return command('whiteboard.section.create', 'Create Section', (source) => {
    const d = migrateWhiteboard(source);
    if (!validBounds(bounds)) throw new Error('Section needs valid bounds');
    if (members.some((id) => (d.sections ?? []).some((s) => s.id === id)))
      throw new Error('Sections cannot be nested');
    const roots = selectedRoots(
      d.nodes.map((n) => ({ ...n, parentId: n.groupId })),
      members,
    );
    if (roots.some((r) => r.parentId))
      throw new Error('Select root objects or Groups to assign a Section');
    assertEditable(
      d.nodes.map((n) => ({ ...n, parentId: n.groupId })),
      members,
    );
    return {
      ...d,
      sections: [...(d.sections ?? []), clone(section)],
      nodes: d.nodes.map((n) =>
        roots.some((r) => r.id === n.id) ? { ...n, sectionId: section.id } : n,
      ),
    };
  });
}
export function encloseInSection(d: WhiteboardContent, ids: string[], title = 'Section') {
  const all = boardSelection(d, ids),
    box = unionBounds(d.nodes.filter((n) => all.has(n.id)).map((n) => n.bounds));
  if (!all.size) throw new Error('Select objects to enclose');
  return createSection(
    { x: box.x - 32, y: box.y - 52, width: box.width + 64, height: box.height + 84 },
    title,
    ids,
  );
}
export function updateSection(
  id: string,
  patch: Partial<Pick<WhiteboardSection, 'title' | 'background' | 'locked'>>,
) {
  const fixed = clone(patch);
  return command<WhiteboardContent>('whiteboard.section.update', 'Edit Section', (source) => {
    const d = migrateWhiteboard(source),
      s = d.sections?.find((s) => s.id === id);
    if (!s) throw new Error('Section is missing');
    if (s.locked && fixed.locked !== false) throw new Error('Unlock the Section first');
    const next = { ...s, ...fixed, id };
    if (!validBounds(next.bounds)) throw new Error('Section needs valid bounds');
    return { ...d, sections: d.sections!.map((s) => (s.id === id ? next : s)) };
  });
}
export function dissolveSection(id: string, deleteContents = false) {
  return command<WhiteboardContent>(
    'whiteboard.section.remove',
    deleteContents ? 'Delete Section and contents' : 'Dissolve Section',
    (source) => {
      const d = migrateWhiteboard(source),
        s = d.sections?.find((s) => s.id === id);
      if (!s) throw new Error('Section is missing');
      if (s.locked) throw new Error('Unlock the Section first');
      const removed = new Set(deleteContents ? sectionMembers(d, id).map((n) => n.id) : []);
      return {
        ...d,
        sections: d.sections!.filter((s) => s.id !== id),
        nodes: d.nodes
          .filter((n) => !removed.has(n.id))
          .map((n) => (n.sectionId === id ? { ...n, sectionId: undefined } : n)),
        connectors: d.connectors.filter((c) => !removed.has(c.from) && !removed.has(c.to)),
      };
    },
  );
}
export function assignSection(ids: string[], sectionId?: string) {
  return command<WhiteboardContent>('whiteboard.section.assign', 'Assign Section', (source) => {
    const d = migrateWhiteboard(source);
    if (sectionId && !d.sections?.some((s) => s.id === sectionId))
      throw new Error('Section is missing');
    const roots = selectedRoots(
      d.nodes.map((n) => ({ ...n, parentId: n.groupId })),
      ids,
    );
    if (roots.some((r) => r.parentId))
      throw new Error('Ungroup before assigning this object to another Section');
    return {
      ...d,
      nodes: d.nodes.map((n) => (roots.some((r) => r.id === n.id) ? { ...n, sectionId } : n)),
    };
  });
}
export function transformBoard(
  source: WhiteboardContent,
  ids: string[],
  delta: TransformDelta,
): WhiteboardContent {
  const d = migrateWhiteboard(source),
    sections = (d.sections ?? []).filter((s) => ids.includes(s.id)),
    scoped = new Set(sections.flatMap((s) => sectionMembers(d, s.id).map((n) => n.id))),
    nodeIds = ids.filter((id) => d.nodes.some((n) => n.id === id) && !scoped.has(id));
  if (sections.some((s) => s.locked)) throw new Error('Unlock the Section first');
  if (sections.length && (delta.rotation ?? 0) !== 0) throw new Error('Sections do not rotate');
  if (sections.length > 1 && (delta.dw || delta.dh))
    throw new Error('Resize one Section at a time');
  if (sections.length && nodeIds.length && (delta.dw || delta.dh))
    throw new Error('Resize Sections separately from objects');
  const next = nodeIds.length ? transformNodes(nodeIds, delta).apply(d) : clone(d);
  next.sections = (d.sections ?? []).map((s) =>
    !sections.some((v) => v.id === s.id)
      ? s
      : {
          ...s,
          bounds: {
            x: s.bounds.x + delta.dx,
            y: s.bounds.y + delta.dy,
            width: Math.max(40, s.bounds.width + delta.dw),
            height: Math.max(40, s.bounds.height + delta.dh),
          },
        },
  );
  // A resize handle may change region x/y, but members remain fixed. Only a move translates them.
  const moveMembers = sections.length && !delta.dw && !delta.dh;
  if (moveMembers) {
    assertEditable(
      d.nodes.map((n) => ({ ...n, parentId: n.groupId })),
      [...scoped],
    );
    next.nodes = next.nodes.map((n) =>
      scoped.has(n.id)
        ? { ...n, bounds: { ...n.bounds, x: n.bounds.x + delta.dx, y: n.bounds.y + delta.dy } }
        : n,
    );
  }
  if (nodeIds.length && (delta.dx || delta.dy) && !delta.dw && !delta.dh && !delta.rotation) {
    const roots = selectedRoots(
      d.nodes.map((n) => ({ ...n, parentId: n.groupId })),
      nodeIds,
    );
    next.nodes = next.nodes.map((n) =>
      roots.some((r) => r.id === n.id) && !n.groupId
        ? { ...n, sectionId: sectionAt(next, n.bounds)?.id }
        : n,
    );
  }
  return next;
}
export const transformBoardCommand = (ids: string[], delta: TransformDelta) =>
  withCommandReads<WhiteboardContent>(
    immutableCommand<WhiteboardContent>('whiteboard.transform', 'Transform board selection', (d) =>
      transformBoard(d, ids, delta),
    ),
    { geometry: ids },
  );
export function boardPreview(d: WhiteboardContent, ids: string[], delta: TransformDelta) {
  const next = transformBoard(d, ids, delta);
  return new Map([
    ...next.nodes.map((n) => [n.id, { bounds: n.bounds, rotation: n.rotation ?? 0 }] as const),
    ...(next.sections ?? []).map((s) => [s.id, { bounds: s.bounds, rotation: 0 }] as const),
  ]);
}
export function boardBounds(d: WhiteboardContent, ids?: string[]): Bounds {
  const projectConnector = connectorProjector(d);
  const all = ids?.length
      ? boardSelection(d, ids)
      : new Set([...d.nodes.map((n) => n.id), ...(d.sections ?? []).map((s) => s.id)]),
    boxes = [
      ...d.nodes.filter((n) => all.has(n.id) && !n.hidden).map((n) => n.bounds),
      ...(d.sections ?? []).filter((s) => all.has(s.id)).map((s) => s.bounds),
    ];
  for (const c of d.connectors)
    if ((all.has(c.from) || !c.from) && (all.has(c.to) || !c.to)) {
      const p = projectConnector(c);
      if (p)
        boxes.push({
          x: Math.min(p.x1, p.x2) - 10,
          y: Math.min(p.y1, p.y2) - 20,
          width: Math.abs(p.x2 - p.x1) + 20,
          height: Math.abs(p.y2 - p.y1) + 40,
        });
    }
  return unionBounds(boxes);
}
