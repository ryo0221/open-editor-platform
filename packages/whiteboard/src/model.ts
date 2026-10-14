import { exportBoardSvg } from './export';
import { validNativeReuse, type ReuseState } from '@editor-platform/reuse-core';
import {
  clone,
  describeChanges,
  isDeepFrozen,
  newId,
  type CompareResult,
} from '@editor-platform/artifact-core';
import {
  command,
  withCommandReads,
  alignGeometry,
  distributeGeometry,
  transformGeometry,
  descendantIds,
  selectedRoots,
  assertEditable,
  type Drawing,
  type VisualStyle,
  type Alignment,
  type TransformDelta,
  type Point,
  unionBounds,
  validBounds,
  validVisualStyle,
  describeDrawing,
  patchVisualStyle,
  matchingSizeBounds,
  reflectGeometry,
  reorderedSiblingIds,
  hierarchyPaintOrder,
  type Bounds,
  type EditorCommand,
} from '@editor-platform/editor-core';
export type WhiteboardNodeKind =
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'sticky'
  | 'frame'
  | 'shape'
  | 'image'
  | 'group'
  | 'freehand';
export interface WhiteboardNode extends VisualStyle {
  id: string;
  kind: WhiteboardNodeKind;
  bounds: Bounds;
  text: string;
  color: string;
  groupId?: string;
  sectionId?: string;
  src?: string;
  points?: Point[];
  name?: string;
  ports?: WhiteboardPort[];
}
export interface WhiteboardPort {
  /** Stable within its node; it is not a globally remapped element ID. */
  key: string;
  label: string;
  side: 'top' | 'right' | 'bottom' | 'left';
  offset: number;
}
export interface WhiteboardConnector {
  id: string;
  from: string;
  to: string;
  label: string;
  fromPoint?: Point;
  toPoint?: Point;
  fromPort?: string;
  toPort?: string;
  routing?: 'straight' | 'elbow' | 'curve';
  stroke?: string;
  strokeWidth?: number;
  arrowhead?: 'none' | 'end' | 'both';
}
export interface WhiteboardSection {
  id: string;
  title: string;
  bounds: Bounds;
  background: string;
  locked?: boolean;
}
export interface WhiteboardContent {
  schemaVersion: 1 | 2 | 3;
  reuse?: ReuseState;
  sections?: WhiteboardSection[];
  nodes: WhiteboardNode[];
  connectors: WhiteboardConnector[];
}
export const createWhiteboard = (): WhiteboardContent => ({
  schemaVersion: 3,
  sections: [],
  nodes: [],
  connectors: [],
});
export function makeWhiteboardNode(kind: WhiteboardNodeKind, index = 0): WhiteboardNode {
  return {
    id: newId('node'),
    kind,
    bounds: {
      x: 70 + (index % 4) * 205,
      y: 90 + Math.floor(index / 4) * 160,
      width: kind === 'frame' ? 400 : 170,
      height: kind === 'text' ? 70 : kind === 'frame' ? 280 : 120,
    },
    text:
      kind === 'sticky'
        ? 'A new idea'
        : kind === 'frame'
          ? 'Frame'
          : kind === 'text'
            ? 'A note'
            : kind === 'ellipse'
              ? 'Explore'
              : 'Make something',
    color: kind === 'sticky' ? '#f2e3a8' : kind === 'frame' ? '#eef0e8' : '#dce8d8',
  };
}
export const insertNode = (kind: WhiteboardNodeKind): EditorCommand<WhiteboardContent> => {
  const node = makeWhiteboardNode(kind);
  return command('whiteboard.insert', `Add ${kind}`, (d) => ({ ...d, nodes: [...d.nodes, node] }));
};
export const updateNode = (
  id: string,
  patch: Partial<Omit<WhiteboardNode, 'id'>>,
): EditorCommand<WhiteboardContent> =>
  command('whiteboard.update', 'Edit whiteboard node', (d) => ({
    ...d,
    nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  }));
function geometry(d: WhiteboardContent) {
  return d.nodes.map((n) => ({ ...n, parentId: n.groupId }));
}
function expanded(d: WhiteboardContent, ids: string[]): string[] {
  return [...descendantIds(geometry(d), ids)];
}
export const transformNodes = (
  ids: string[],
  delta: TransformDelta,
): EditorCommand<WhiteboardContent> =>
  withCommandReads<WhiteboardContent>(
    command('whiteboard.transform', 'Transform nodes', (d) => {
      const roots = selectedRoots(geometry(d), ids),
        box = unionBounds(roots.map((n) => n.bounds));
      const m = transformGeometry(geometry(d), ids, {
        ...delta,
        dw: Math.max(20, box.width + delta.dw) - box.width,
        dh: Math.max(20, box.height + delta.dh) - box.height,
      });
      return { ...d, nodes: d.nodes.map((n) => (m.has(n.id) ? { ...n, ...m.get(n.id)! } : n)) };
    }),
    { geometry: ids },
  );
export const deleteNodes = (ids: string[]): EditorCommand<WhiteboardContent> =>
  command('whiteboard.delete', 'Delete nodes', (d) => {
    const all = expanded(d, ids);
    return {
      ...d,
      nodes: d.nodes.filter((n) => !all.includes(n.id)),
      connectors: d.connectors.filter((c) => !all.includes(c.from) && !all.includes(c.to)),
    };
  });
export const connectNodes = (from: string, to: string): EditorCommand<WhiteboardContent> => {
  const id = newId('connector');
  return command('whiteboard.connect', 'Connect nodes', (d) => {
    if (from === to || ![from, to].every((id) => d.nodes.some((n) => n.id === id)))
      throw new Error('Select two distinct nodes');
    return { ...d, connectors: [...d.connectors, { id, from, to, label: '' }] };
  });
};
export const groupNodes = (ids: string[]): EditorCommand<WhiteboardContent> =>
  arrangeBoard(ids, 'group');
export function whiteboardDiff(a: WhiteboardContent, b: WhiteboardContent): CompareResult {
  return {
    changes: [
      ...describeChanges(
        a.nodes,
        b.nodes,
        (n) => `${n.kind}: ${n.text.slice(0, 40)}`,
        (n) =>
          `${describeDrawing(whiteboardDrawing(n))}\nSection: ${[...(b.sections ?? []), ...(a.sections ?? [])].find((s) => s.id === n.sectionId)?.title ?? 'none'}\nGroup: ${n.groupId ?? 'none'}`,
      ),
      ...describeChanges(
        a.connectors,
        b.connectors,
        (c) => `Connector: ${c.label || 'unlabelled'}`,
        (c) => {
          const name = (id: string) =>
            [...b.nodes, ...a.nodes].find((n) => n.id === id)?.text || 'free endpoint';
          return `${name(c.from)} → ${name(c.to)}\nLabel: ${c.label}\nRouting: ${c.routing ?? 'straight'}\nPorts: ${c.fromPort ?? 'auto'} → ${c.toPort ?? 'auto'}`;
        },
      ),
      ...describeChanges(
        a.sections ?? [],
        b.sections ?? [],
        (s) => `Section: ${s.title}`,
        (s) =>
          `${s.title}\nPosition: ${s.bounds.x}, ${s.bounds.y} px\nSize: ${s.bounds.width} × ${s.bounds.height} px\nBackground: ${s.background}`,
      ),
    ],
  };
}
export function connectorGeometry(
  d: WhiteboardContent,
  c: WhiteboardConnector,
): { x1: number; y1: number; x2: number; y2: number } | undefined {
  const a = d.nodes.find((n) => n.id === c.from),
    b = d.nodes.find((n) => n.id === c.to);
  return connectorEndpoints(c, a, b);
}
/** Snapshot-scoped endpoint lookup for drawing many connectors. */
export function connectorProjector(d: WhiteboardContent) {
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  return (c: WhiteboardConnector) => connectorEndpoints(c, nodes.get(c.from), nodes.get(c.to));
}
function connectorEndpoints(
  c: WhiteboardConnector,
  a: WhiteboardNode | undefined,
  b: WhiteboardNode | undefined,
): { x1: number; y1: number; x2: number; y2: number } | undefined {
  if ((!a && !c.fromPoint) || (!b && !c.toPoint)) return;
  const center = (n: WhiteboardNode | undefined, fallback: Point | undefined): Point =>
    n ? { x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 } : fallback!;
  const ac = center(a, c.fromPoint),
    bc = center(b, c.toPoint);
  const endpoint = (
    n: WhiteboardNode | undefined,
    other: Point,
    fallback: Point | undefined,
    port: WhiteboardConnector['fromPort'],
  ): Point => {
    if (!n) return fallback!;
    const box = n.bounds,
      cx = box.x + box.width / 2,
      cy = box.y + box.height / 2;
    const angle = ((n.rotation ?? 0) * Math.PI) / 180,
      cos = Math.cos(angle),
      sin = Math.sin(angle);
    const world = (point: Point): Point => {
      const x = (point.x - cx) * (n.flipX ? -1 : 1),
        y = (point.y - cy) * (n.flipY ? -1 : 1);
      return { x: cx + x * cos - y * sin, y: cy + x * sin + y * cos };
    };
    if (port && port !== 'auto') {
      const declared = n.ports?.find((p) => p.key === port),
        side = declared?.side ?? port,
        offset = declared?.offset ?? 0.5;
      return world(
        side === 'left'
          ? { x: box.x, y: box.y + box.height * offset }
          : side === 'right'
            ? { x: box.x + box.width, y: box.y + box.height * offset }
            : side === 'top'
              ? { x: box.x + box.width * offset, y: box.y }
              : { x: box.x + box.width * offset, y: box.y + box.height },
      );
    }
    const wx = other.x - cx,
      wy = other.y - cy,
      dx = (wx * cos + wy * sin) * (n.flipX ? -1 : 1),
      dy = (-wx * sin + wy * cos) * (n.flipY ? -1 : 1);
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const f =
      n.kind === 'ellipse' || n.shape === 'ellipse'
        ? 1 / Math.sqrt((dx / (box.width / 2)) ** 2 + (dy / (box.height / 2)) ** 2)
        : Math.min(
            dx ? Math.abs(box.width / 2 / dx) : Infinity,
            dy ? Math.abs(box.height / 2 / dy) : Infinity,
          );
    return world({ x: cx + dx * f, y: cy + dy * f });
  };
  const from = endpoint(a, bc, c.fromPoint, c.fromPort),
    to = endpoint(b, ac, c.toPoint, c.toPort);
  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
}
export function connectorPath(
  c: WhiteboardConnector,
  p: { x1: number; y1: number; x2: number; y2: number },
): string {
  const mid = (p.x1 + p.x2) / 2;
  return c.routing === 'elbow'
    ? `M${p.x1} ${p.y1}H${mid}V${p.y2}H${p.x2}`
    : c.routing === 'curve'
      ? `M${p.x1} ${p.y1}C${mid} ${p.y1} ${mid} ${p.y2} ${p.x2} ${p.y2}`
      : `M${p.x1} ${p.y1}L${p.x2} ${p.y2}`;
}
/** Sibling order applies to complete Group subtrees in every renderer. */
export function whiteboardPaintOrder(d: WhiteboardContent) {
  return hierarchyPaintOrder(d.nodes, (n) => n.groupId);
}
export function whiteboardDrawing(n: WhiteboardNode): Drawing {
  return {
    ...n,
    // Vector geometry is owned by Design, not by undeclared imported fields.
    vector: undefined,
    kind:
      n.kind === 'text'
        ? 'text'
        : n.kind === 'image'
          ? 'image'
          : n.kind === 'group'
            ? 'group'
            : n.kind === 'freehand'
              ? 'freehand'
              : 'shape',
    shape: n.shape ?? (n.kind === 'ellipse' ? 'ellipse' : 'rectangle'),
    fill: n.kind === 'text' ? '#253044' : n.color,
    text: n.kind === 'frame' ? '' : n.text,
    typography: { fontSize: n.kind === 'sticky' ? 22 : 18, padding: 12, ...n.typography },
    opacity: n.opacity ?? (n.kind === 'frame' ? 0.35 : 1),
  };
}
export function exportWhiteboardSvg(d: WhiteboardContent, ids?: string[]): string {
  return exportBoardSvg(d, ids);
}
const checkedNodes = new WeakSet<WhiteboardNode>();
const fixedData = new WeakSet<object>();
function fixedNodeData(value: unknown, visiting = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return typeof value !== 'function';
  if (!isDeepFrozen(value)) return false;
  if (fixedData.has(value)) return true;
  if (visiting.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    return false;
  visiting.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !fixedNodeData(descriptor.value, visiting)) return false;
  }
  visiting.delete(value);
  fixedData.add(value);
  return true;
}
function validNode(node: WhiteboardNode): boolean {
  if (!node) return false;
  if (checkedNodes.has(node)) return true;
  const valid =
    typeof node.id === 'string' &&
    typeof node.text === 'string' &&
    typeof node.color === 'string' &&
    validVisualStyle(node) &&
    validBoardPorts(node.ports) &&
    [
      'rectangle',
      'ellipse',
      'text',
      'sticky',
      'frame',
      'shape',
      'image',
      'group',
      'freehand',
    ].includes(node.kind) &&
    validBounds(node.bounds);
  // Object.freeze alone does not make a stateful getter (including bounds/style)
  // immutable. Such Host values keep the complete validation path on every call.
  if (valid && fixedNodeData(node)) checkedNodes.add(node);
  return valid;
}
export function isWhiteboard(value: unknown): value is WhiteboardContent {
  if (!value || typeof value !== 'object') return false;
  const d = value as WhiteboardContent;
  if (!Array.isArray(d.nodes)) return false;
  const nodes = new Set(d.nodes.map((n) => n?.id));
  return (
    (d.schemaVersion === 1 || d.schemaVersion === 2 || d.schemaVersion === 3) &&
    validNativeReuse(d.reuse, 'whiteboard') &&
    (d.sections === undefined ||
      (Array.isArray(d.sections) &&
        d.sections.every(
          (s) =>
            s &&
            typeof s.id === 'string' &&
            typeof s.title === 'string' &&
            typeof s.background === 'string' &&
            validBounds(s.bounds),
        ))) &&
    Array.isArray(d.connectors) &&
    nodes.size === d.nodes.length &&
    d.nodes.every((n) => validNode(n) && (d.schemaVersion !== 3 || n.kind !== 'frame')) &&
    d.connectors.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.label === 'string' &&
        (nodes.has(c.from!) || validPoint(c.fromPoint)) &&
        (nodes.has(c.to!) || validPoint(c.toPoint)),
    ) &&
    validBoardReferences(d)
  );
}
function validPoint(point: Point | undefined) {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}
function validBoardReferences(d: WhiteboardContent) {
  const all = [...d.nodes, ...d.connectors, ...(d.sections ?? [])];
  if (new Set(all.map((e) => e.id)).size !== all.length) return false;
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  const sections = new Set((d.sections ?? []).map((s) => s.id));
  for (const node of d.nodes) {
    if (node.sectionId !== undefined && (!sections.has(node.sectionId) || !!node.groupId))
      return false;
    const seen = new Set([node.id]);
    let parent = node.groupId;
    while (parent) {
      if (seen.has(parent)) return false;
      seen.add(parent);
      const group = nodes.get(parent);
      if (!group || !['group', 'frame'].includes(group.kind)) return false;
      parent = group.groupId;
    }
  }
  for (const connector of d.connectors)
    for (const side of ['from', 'to'] as const) {
      const port = connector[`${side}Port`];
      if (
        port !== undefined &&
        (typeof port !== 'string' ||
          (!['auto', 'top', 'right', 'bottom', 'left'].includes(port) &&
            !nodes.get(connector[side])?.ports?.some((p) => p.key === port)))
      )
        return false;
    }
  return true;
}
export function validBoardPorts(value: unknown): value is WhiteboardPort[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 64) return false;
  return (
    new Set(value.map((p) => p?.key)).size === value.length &&
    value.every(
      (p) =>
        p &&
        typeof p.key === 'string' &&
        /^[A-Za-z0-9_-]{1,100}$/.test(p.key) &&
        !['auto', 'top', 'right', 'bottom', 'left'].includes(p.key) &&
        typeof p.label === 'string' &&
        p.label.length <= 200 &&
        ['top', 'right', 'bottom', 'left'].includes(p.side) &&
        Number.isFinite(p.offset) &&
        p.offset >= 0 &&
        p.offset <= 1,
    )
  );
}

export const updateConnector = (
  id: string,
  patch: Partial<WhiteboardConnector>,
): EditorCommand<WhiteboardContent> =>
  command('whiteboard.connector', 'Edit connector', (d) => ({
    ...d,
    connectors: d.connectors.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }));
export const patchNodes = (
  ids: string[],
  patch: Partial<WhiteboardNode>,
): EditorCommand<WhiteboardContent> =>
  command('whiteboard.properties', 'Edit nodes', (d) => {
    if (!('locked' in patch || 'hidden' in patch)) assertEditable(geometry(d), ids);
    return {
      ...d,
      nodes: d.nodes.map((n) => (ids.includes(n.id) ? patchVisualStyle(n, patch) : n)),
    };
  });
export const alignNodes = (
  ids: string[],
  mode: Alignment,
  reference?: Bounds,
): EditorCommand<WhiteboardContent> =>
  withCommandReads<WhiteboardContent>(
    command('whiteboard.align', `Align ${mode}`, (d) => {
      const m = alignGeometry(geometry(d), ids, mode, reference);
      return {
        ...d,
        nodes: d.nodes.map((n) => (m.has(n.id) ? { ...n, bounds: m.get(n.id)! } : n)),
      };
    }),
    { geometry: ids },
  );
export function copyBoard(d: WhiteboardContent, ids: string[]): WhiteboardContent {
  const all = new Set(expanded(d, ids)),
    nodes = d.nodes.filter((n) => all.has(n.id)),
    mapping = new Map(nodes.map((n) => [n.id, newId('node')]));
  return {
    schemaVersion: 2,
    nodes: nodes.map((n) => ({
      ...clone(n),
      id: mapping.get(n.id)!,
      groupId: n.groupId ? mapping.get(n.groupId) : undefined,
      sectionId: undefined,
      bounds: { ...n.bounds, x: n.bounds.x + 20, y: n.bounds.y + 20 },
    })),
    connectors: d.connectors
      .filter((c) => all.has(c.from) || all.has(c.to))
      .map((c) => {
        const p = connectorGeometry(d, c)!;
        return {
          ...clone(c),
          id: newId('connector'),
          from: mapping.get(c.from) ?? '',
          to: mapping.get(c.to) ?? '',
          fromPoint: { x: p.x1 + 20, y: p.y1 + 20 },
          toPoint: { x: p.x2 + 20, y: p.y2 + 20 },
        };
      }),
  };
}
export const pasteBoard = (copied: WhiteboardContent): EditorCommand<WhiteboardContent> => {
  const next = copyBoard(
    copied,
    copied.nodes.map((n) => n.id),
  );
  return command('whiteboard.paste', 'Paste board content', (d) => ({
    ...d,
    nodes: [...d.nodes, ...clone(next.nodes)],
    connectors: [...d.connectors, ...clone(next.connectors)],
  }));
};
export const arrangeBoard = (
  ids: string[],
  action: string,
  value?: number,
): EditorCommand<WhiteboardContent> => {
  const groupTemplate = makeWhiteboardNode('group');
  return withCommandReads<WhiteboardContent>(
    command('whiteboard.arrange', action, (d) => {
      const items = geometry(d),
        roots = selectedRoots(items, ids),
        all = descendantIds(items, ids);
      if (!['unlock', 'show', 'lock', 'hide'].includes(action)) assertEditable(items, ids, true);
      if (action === 'duplicate') return pasteBoard(copyBoard(d, ids)).apply(d);
      if (action === 'delete') return deleteNodes(ids).apply(d);
      if (action === 'frame') return groupNodes(ids).apply(d);
      if (action === 'group') {
        if (roots.length < 2) throw new Error('Select two or more nodes');
        if (new Set(roots.map((r) => d.nodes.find((n) => n.id === r.id)?.sectionId ?? '')).size > 1)
          throw new Error('Select objects in the same Section before grouping');
        const group = {
          ...groupTemplate,
          sectionId: d.nodes.find((n) => n.id === roots[0].id)?.sectionId,
          bounds: unionBounds(roots.map((n) => n.bounds)),
          groupId: roots[0].parentId,
        };
        return {
          ...d,
          nodes: [
            group,
            ...d.nodes.map((n) =>
              roots.some((r) => r.id === n.id)
                ? { ...n, groupId: group.id, sectionId: undefined }
                : n,
            ),
          ],
        };
      }
      if (action === 'ungroup') {
        const groups = d.nodes.filter(
          (n) => ids.includes(n.id) && ['group', 'frame'].includes(n.kind),
        );
        return {
          ...d,
          nodes: d.nodes
            .filter((n) => !groups.some((g) => g.id === n.id))
            .map((n) => {
              const g = groups.find((g) => g.id === n.groupId);
              return g
                ? { ...n, groupId: g.groupId, sectionId: g.groupId ? undefined : g.sectionId }
                : n;
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
          ...d,
          nodes: d.nodes.map((n) => (m.has(n.id) ? { ...n, bounds: m.get(n.id)! } : n)),
        };
      }
      if (action === 'rotate')
        return transformNodes(ids, { dx: 0, dy: 0, dw: 0, dh: 0, rotation: 90 }).apply(d);
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
          ...d,
          nodes: d.nodes.map((n) => (mapped.has(n.id) ? { ...n, ...mapped.get(n.id)! } : n)),
        };
      }
      if (action === 'flip-x' || action === 'flip-y') {
        const mapped = reflectGeometry(items, ids, action === 'flip-x' ? 'x' : 'y');
        return {
          ...d,
          nodes: d.nodes.map((n) => (mapped.has(n.id) ? { ...n, ...mapped.get(n.id)! } : n)),
        };
      }
      if (['front', 'back', 'forward', 'backward'].includes(action)) {
        const order = reorderedSiblingIds(items, ids, action);
        const byId = new Map(d.nodes.map((n) => [n.id, n]));
        let index = 0;
        return {
          ...d,
          nodes: d.nodes.map((n) =>
            n.groupId === roots[0]?.parentId ? byId.get(order[index++])! : n,
          ),
        };
      }
      return {
        ...d,
        nodes: d.nodes.map((n) => {
          if (!all.has(n.id)) return n;
          if (action === 'lock' || action === 'unlock') return { ...n, locked: action === 'lock' };
          if (action === 'hide' || action === 'show') return { ...n, hidden: action === 'hide' };
          return n;
        }),
      };
    }),
    action === 'duplicate' ? { content: ids } : { geometry: ids },
  );
};
