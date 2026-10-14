import { describe, it, expect } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { contentHash, deepFreeze } from '@editor-platform/artifact-core';
import {
  createWhiteboard,
  makeWhiteboardNode,
  connectNodes,
  connectorGeometry,
  connectorProjector,
  groupNodes,
  type WhiteboardContent,
} from './model';
import {
  createSection,
  sectionMembers,
  migrateWhiteboard,
  transformBoardCommand,
  dissolveSection,
  assignSection,
  boardBounds,
} from './sections';
function fixture() {
  const a = {
      ...makeWhiteboardNode('sticky'),
      bounds: { x: -50000, y: -50000, width: 170, height: 120 },
    },
    b = {
      ...makeWhiteboardNode('sticky'),
      bounds: { x: 50000, y: 50000, width: 170, height: 120 },
    };
  let d = { ...createWhiteboard(), nodes: [a, b] };
  d = createSection({ x: -50040, y: -50060, width: 300, height: 250 }, '調査', [a.id]).apply(d);
  d = createSection({ x: 49960, y: 49940, width: 300, height: 250 }, '次の行動', [b.id]).apply(d);
  return connectNodes(a.id, b.id).apply(d);
}
describe('Whiteboard Section semantics', () => {
  it('indexed connector projection matches scalar endpoints and keeps its own immutable basis', () => {
    const before = deepFreeze(fixture());
    const first = connectorProjector(before);
    const moved = transformBoardCommand([before.nodes[0].id], {
      dx: 30,
      dy: -20,
      dw: 0,
      dh: 0,
    }).apply(before);
    const next = connectorProjector(moved);
    const connector = before.connectors[0];
    for (const port of ['auto', 'left', 'right', 'top', 'bottom'] as const) {
      const value = { ...connector, fromPort: port };
      expect(first(value)).toEqual(connectorGeometry(before, value));
      expect(next(value)).toEqual(connectorGeometry(moved, value));
    }
    const detached = { ...connector, from: '', fromPoint: { x: 5, y: 7 } };
    expect(first(detached)).toEqual(connectorGeometry(before, detached));
    expect(next({ ...connector, from: 'missing' })).toBeUndefined();
    expect(first(connector)).not.toEqual(next(connector));
  });
  it('moves members/connector endpoints once but resizes only the region, including north/west handles', () => {
    const d = fixture(),
      s = new EditorSession(d),
      section = d.sections![0],
      node = d.nodes[0],
      before = connectorGeometry(d, d.connectors[0])!;
    s.execute(transformBoardCommand([section.id, node.id], { dx: 120, dy: -50, dw: 0, dh: 0 }));
    expect(s.content.nodes[0].bounds).toEqual({
      ...node.bounds,
      x: node.bounds.x + 120,
      y: node.bounds.y - 50,
    });
    expect(connectorGeometry(s.content, s.content.connectors[0])!.x1).not.toBe(before.x1);
    const members = structuredClone(s.content.nodes);
    s.execute(transformBoardCommand([section.id], { dx: -80, dy: -40, dw: 160, dh: 70 }));
    expect(s.content.nodes).toEqual(members);
    expect(s.content.sections![0].bounds.width).toBe(460);
    expect(s.content.nodes[0].sectionId).toBe(section.id);
    s.undo();
    s.undo();
    expect(s.content).toEqual(d);
  });
  it('changes root membership only on committed movement, retains it across resize, and supports undo/dissolve', () => {
    const d = fixture(),
      s = new EditorSession(d),
      node = d.nodes[0],
      other = d.sections![1];
    s.execute(transformBoardCommand([node.id], { dx: 100000, dy: 100000, dw: 0, dh: 0 }));
    expect(s.content.nodes[0].sectionId).toBe(other.id);
    expect(sectionMembers(s.content, other.id)).toHaveLength(2);
    s.undo();
    expect(s.content.nodes[0].sectionId).toBe(d.sections![0].id);
    s.execute(dissolveSection(d.sections![0].id));
    expect(s.content.nodes).toHaveLength(2);
    expect(s.content.nodes[0].sectionId).toBeUndefined();
    expect(s.content.connectors).toHaveLength(1);
    s.undo();
    expect(s.content).toEqual(d);
  });
  it('distinguishes proportional Group scale from Section resize and preserves nested membership', () => {
    const d = fixture(),
      extra = {
        ...makeWhiteboardNode('sticky'),
        bounds: { ...d.nodes[0].bounds, x: -49700 },
        sectionId: d.sections![0].id,
      },
      initial = { ...d, nodes: [...d.nodes, extra] },
      grouped = groupNodes([d.nodes[0].id, extra.id]).apply(initial),
      group = grouped.nodes.find((n) => n.kind === 'group')!,
      before = grouped.nodes.find((n) => n.id === extra.id)!;
    const scaled = transformBoardCommand([group.id], {
      dx: 0,
      dy: 0,
      dw: group.bounds.width,
      dh: group.bounds.height,
    }).apply(grouped);
    expect(scaled.nodes.find((n) => n.id === extra.id)!.bounds.width).toBe(before.bounds.width * 2);
    expect(sectionMembers(scaled, d.sections![0].id)).toHaveLength(3);
    expect(() => assignSection([extra.id], d.sections![1].id).apply(scaled)).toThrow('Ungroup');
  });
  it('retains immutable legacy versions while migrating frame IDs, world positions and connector anchors', async () => {
    const frame = { ...makeWhiteboardNode('frame'), id: 'legacy-frame', text: '調査' },
      node = { ...makeWhiteboardNode('sticky'), id: 'legacy-sticky', groupId: frame.id };
    const legacy: WhiteboardContent = {
      schemaVersion: 1,
      nodes: [frame, node],
      connectors: [{ id: 'edge', from: frame.id, to: node.id, label: 'legacy' }],
    };
    deepFreeze(legacy);
    const hash = await contentHash(legacy),
      next = migrateWhiteboard(legacy);
    expect(next.schemaVersion).toBe(3);
    expect(next.sections![0].id).toBe(frame.id);
    expect(next.nodes[0].bounds).toEqual(node.bounds);
    expect(next.nodes[0].sectionId).toBe(frame.id);
    expect(next.connectors[0].from).toBe('');
    expect(next.connectors[0].fromPoint).toBeDefined();
    expect(await contentHash(legacy)).toBe(hash);
    expect(migrateWhiteboard(next)).toBe(next);
  });
  it('includes overflow members and free connector endpoints in export bounds', () => {
    const d = fixture(),
      s = d.sections![0],
      small = transformBoardCommand([s.id], { dx: 0, dy: 0, dw: -240, dh: -190 }).apply(d),
      bounds = boardBounds(small, [s.id]);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(d.nodes[0].bounds.x + 170);
    expect(bounds.height).toBeGreaterThan(small.sections![0].bounds.height);
    const removed = dissolveSection(s.id, true).apply(d);
    expect(removed.nodes).toHaveLength(1);
    expect(removed.connectors).toHaveLength(0);
  });
});
