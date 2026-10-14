import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  connectNodes,
  createWhiteboard,
  deleteNodes,
  exportWhiteboardSvg,
  groupNodes,
  insertNode,
  isWhiteboard,
  transformNodes,
  whiteboardDiff,
} from './model';
it('moves and resizes nodes through undoable commands with minimum geometry', () => {
  const s = new EditorSession(createWhiteboard());
  s.execute(insertNode('sticky'));
  const n = s.content.nodes[0];
  s.execute(transformNodes([n.id], { dx: 30, dy: -10, dw: -1000, dh: 20 }));
  expect(s.content.nodes[0].bounds).toEqual({
    x: n.bounds.x + 30,
    y: n.bounds.y - 10,
    width: 20,
    height: 140,
  });
  expect(s.undo().nodes[0]).toEqual(n);
  expect(s.redo().nodes[0].bounds.width).toBe(20);
});
it('maintains connector endpoints and deletes incident edges', () => {
  let d = insertNode('ellipse').apply(insertNode('rectangle').apply(createWhiteboard()));
  d = connectNodes(d.nodes[0].id, d.nodes[1].id).apply(d);
  expect(d.connectors).toHaveLength(1);
  expect(isWhiteboard(d)).toBe(true);
  expect(deleteNodes([d.nodes[0].id]).apply(d).connectors).toEqual([]);
  expect(() => connectNodes('missing', 'other').apply(d)).toThrow();
});
it('groups nodes and moves the group while preserving stable IDs', () => {
  let d = insertNode('ellipse').apply(insertNode('rectangle').apply(createWhiteboard()));
  const ids = d.nodes.map((n) => n.id);
  d = groupNodes(ids).apply(d);
  const frame = d.nodes.find((n) => n.kind === 'group')!;
  expect(d.nodes.filter((n) => n.groupId === frame.id)).toHaveLength(2);
  const moved = transformNodes([frame.id], { dx: 50, dy: 20, dw: 0, dh: 0 }).apply(d);
  expect(moved.nodes.find((n) => n.id === ids[0])!.bounds.x).toBe(
    d.nodes.find((n) => n.id === ids[0])!.bounds.x + 50,
  );
  expect(whiteboardDiff(d, moved).changes.length).toBeGreaterThan(0);
});
it('exports ordinary SVG with no domain identifiers', () => {
  const d = insertNode('sticky').apply(createWhiteboard()),
    svg = exportWhiteboardSvg(d);
  expect(svg).toContain('<svg');
  expect(svg).toContain('A new idea');
  expect(svg).not.toContain(d.nodes[0].id);
});

it('preserves internal connector IDs on copy and detaches external endpoints explicitly', async () => {
  const { copyBoard, connectorGeometry, updateConnector, arrangeBoard } = await import('./model');
  let d = insertNode('ellipse').apply(insertNode('rectangle').apply(createWhiteboard()));
  d = connectNodes(d.nodes[0].id, d.nodes[1].id).apply(d);
  d = updateConnector(d.connectors[0].id, {
    label: 'Branch',
    fromPort: 'right',
    toPort: 'left',
  }).apply(d);
  const p = connectorGeometry(d, d.connectors[0])!;
  expect(p.x1).toBe(d.nodes[0].bounds.x + d.nodes[0].bounds.width);
  const both = copyBoard(
    d,
    d.nodes.map((n) => n.id),
  );
  expect(both.connectors[0].from).toBe(both.nodes[0].id);
  expect(both.connectors[0].to).toBe(both.nodes[1].id);
  const one = copyBoard(d, [d.nodes[0].id]);
  expect(one.connectors[0].to).toBe('');
  expect(one.connectors[0].toPoint).toEqual({ x: p.x2 + 20, y: p.y2 + 20 });
  const grouped = arrangeBoard(
      d.nodes.map((n) => n.id),
      'group',
    ).apply(d),
    group = grouped.nodes.find((n) => n.kind === 'group')!;
  const transformed = transformNodes([group.id], { dx: 10, dy: 20, dw: 100, dh: 50 }).apply(
    grouped,
  );
  const moved = connectorGeometry(transformed, transformed.connectors[0])!;
  expect(moved.x1).not.toBe(p.x1);
  expect(transformed.connectors[0].from).toBe(d.nodes[0].id);
});
