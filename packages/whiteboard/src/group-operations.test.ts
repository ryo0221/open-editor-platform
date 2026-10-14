import { expect, it } from 'vitest';
import { groupOperationContract } from '../../../tests/unit/group-contract';
import {
  arrangeBoard,
  createWhiteboard,
  makeWhiteboardNode,
  type WhiteboardContent,
} from './model';
import { exportBoardSvg } from './export';
import { transformBoardCommand } from './sections';
groupOperationContract<WhiteboardContent>('Whiteboard', {
  create: (items) => ({
    ...createWhiteboard(),
    nodes: items.map(({ parentId, fill, ...item }) => ({
      ...item,
      groupId: parentId,
      color: fill,
      text: '',
    })),
    connectors: [
      {
        id: 'edge',
        from: items.filter((i) => i.kind !== 'group')[0].id,
        to: items.filter((i) => i.kind !== 'group')[1].id,
        label: 'Preserve references',
      },
    ],
  }),
  items: (d) =>
    d.nodes.map((n) => ({
      ...n,
      kind: n.kind as 'shape' | 'group' | 'text' | 'image',
      parentId: n.groupId,
      fill: n.color,
      rotation: n.rotation ?? 0,
      flipX: !!n.flipX,
      flipY: !!n.flipY,
    })),
  arrange: arrangeBoard,
  svg: exportBoardSvg,
  invariant: (before, after) => {
    expect(after.connectors).toEqual(before.connectors);
    expect(after.sections).toEqual(before.sections);
  },
});
it('R2-01 leaves Section resize independent from Group size matching', () => {
  const section = {
    id: 'S',
    title: 'Region',
    background: '#ffffff',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  };
  const group = {
    ...makeWhiteboardNode('group'),
    id: 'G',
    sectionId: 'S',
    bounds: { ...section.bounds },
  };
  const child = {
    ...makeWhiteboardNode('shape'),
    id: 'A',
    groupId: 'G',
    bounds: { x: 10, y: 10, width: 20, height: 20 },
  };
  const reference = {
    ...makeWhiteboardNode('shape'),
    id: 'R',
    bounds: { x: 300, y: 0, width: 200, height: 200 },
  };
  const before = { ...createWhiteboard(), sections: [section], nodes: [group, child, reference] };
  const resized = transformBoardCommand(['S'], { dx: 0, dy: 0, dw: 200, dh: 100 }).apply(before);
  expect(resized.nodes).toEqual(before.nodes);
  const matched = arrangeBoard(['R', 'G'], 'same-both').apply(before);
  expect(matched.sections).toEqual(before.sections);
  expect(matched.nodes[0].sectionId).toBe('S');
  expect(matched.nodes[1].bounds).toEqual({ x: 20, y: 20, width: 40, height: 40 });
});
