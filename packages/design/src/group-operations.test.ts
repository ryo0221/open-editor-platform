import { groupOperationContract } from '../../../tests/unit/group-contract';
import { expect, it } from 'vitest';
import {
  arrangeDesign,
  createDesign,
  exportDesignSvg,
  makeDesignElement,
  layoutDesign,
  type DesignContent,
} from './model';
groupOperationContract<DesignContent>('Design', {
  create: (items) => ({
    ...createDesign(),
    elements: items.map(({ kind, ...item }) => ({ ...item, type: kind, name: item.id, text: '' })),
  }),
  items: (d) =>
    d.elements.map((e) => ({
      ...e,
      kind: e.type as 'shape' | 'group' | 'text' | 'image',
      rotation: e.rotation ?? 0,
      flipX: !!e.flipX,
      flipY: !!e.flipY,
    })),
  arrange: arrangeDesign,
  svg: exportDesignSvg,
});
for (const dimension of ['width', 'height', 'both'])
  it(`R2-01 Design Frame match ${dimension} preserves fixed child sizes and applies constraints`, () => {
    const frame = {
      ...makeDesignElement('frame'),
      id: 'F',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    };
    const fixed = {
      ...makeDesignElement('rectangle'),
      id: 'A',
      parentId: 'F',
      bounds: { x: 10, y: 10, width: 20, height: 20 },
    };
    const pinned = {
      ...makeDesignElement('rectangle'),
      id: 'B',
      parentId: 'F',
      bounds: { x: 60, y: 60, width: 30, height: 30 },
      constraints: { horizontal: 'right' as const, vertical: 'bottom' as const },
    };
    const reference = {
      ...makeDesignElement('rectangle'),
      id: 'R',
      bounds: { x: 300, y: 0, width: 200, height: 300 },
    };
    const before = { ...createDesign(), elements: [frame, fixed, pinned, reference] };
    const after = arrangeDesign(['R', 'F'], `same-${dimension}`).apply(before);
    expect(after.elements[1]).toEqual(fixed);
    expect(after.elements[2].bounds).toEqual({
      ...pinned.bounds,
      x: dimension === 'height' ? 60 : 160,
      y: dimension === 'width' ? 60 : 260,
    });
    expect(after.elements[3]).toEqual(reference);
  });
it('R2-01 Design Frame matching runs auto-layout rather than scaling fixed children', () => {
  const frame = {
    ...makeDesignElement('frame'),
    id: 'F',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    layout: {
      direction: 'row' as const,
      gap: 10,
      padding: 10,
      align: 'start' as const,
      sizing: 'fixed' as const,
    },
  };
  const child = {
    ...makeDesignElement('rectangle'),
    id: 'A',
    parentId: 'F',
    bounds: { x: 10, y: 10, width: 80, height: 20 },
    sizing: 'fill' as const,
  };
  const reference = {
    ...makeDesignElement('rectangle'),
    id: 'R',
    bounds: { x: 300, y: 0, width: 200, height: 300 },
  };
  const before = layoutDesign({ ...createDesign(), elements: [frame, child, reference] });
  const after = arrangeDesign(['R', 'F'], 'same-both').apply(before);
  expect(after.elements[1].bounds).toEqual({ x: 10, y: 10, width: 180, height: 20 });
  expect(after.elements[2]).toEqual(reference);
});
