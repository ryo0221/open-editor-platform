import { describe, expect, it } from 'vitest';
import { EditorSession, type Bounds, type EditorCommand } from '@editor-platform/editor-core';

/** Test-only projection; production content remains owned by each domain. */
export interface GroupFixtureItem {
  id: string;
  parentId?: string;
  kind: 'group' | 'shape' | 'image' | 'text';
  bounds: Bounds;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  fill: string;
}
export const groupItem = (
  id: string,
  kind: GroupFixtureItem['kind'],
  bounds: Bounds,
  parentId?: string,
): GroupFixtureItem => ({
  id,
  kind,
  bounds,
  parentId,
  rotation: 0,
  flipX: false,
  flipY: false,
  fill: '#ff0000',
});
export const minimalGroup = () => [
  groupItem('G', 'group', { x: 0, y: 0, width: 100, height: 100 }),
  groupItem('A', 'shape', { x: 10, y: 10, width: 20, height: 20 }, 'G'),
  groupItem('B', 'shape', { x: 60, y: 60, width: 30, height: 30 }, 'G'),
  { ...groupItem('R', 'shape', { x: 0, y: 0, width: 200, height: 100 }), fill: '#0000ff' },
];

export function groupOperationContract<T>(
  domain: string,
  adapter: {
    create(items: GroupFixtureItem[]): T;
    items(content: T): GroupFixtureItem[];
    arrange(ids: string[], action: string): EditorCommand<T>;
    svg(content: T): string;
    invariant?(before: T, after: T): void;
  },
) {
  const item = (content: T, id: string) => adapter.items(content).find((i) => i.id === id)!;
  const execute = (source: T, ids: string[], action: string) => {
    const session = new EditorSession(source);
    session.execute(adapter.arrange(ids, action));
    const after = session.content;
    expect(
      adapter
        .items(after)
        .map((i) => [i.id, i.parentId])
        .sort(),
    ).toEqual(
      adapter
        .items(source)
        .map((i) => [i.id, i.parentId])
        .sort(),
    );
    adapter.invariant?.(source, after);
    session.undo();
    expect(session.content).toEqual(source);
    session.redo();
    expect(session.content).toEqual(after);
    return after;
  };
  describe(`${domain} group review regressions`, () => {
    it('R2-01 preserves the reference Group and children when matching width', () => {
      const before = adapter.create(minimalGroup());
      const after = execute(before, ['G', 'R'], 'same-width');
      for (const id of ['G', 'A', 'B']) expect(item(after, id)).toEqual(item(before, id));
      expect(item(after, 'R').bounds.width).toBe(100);
    });
    it('R2-02 reflects child positions around the selected Group center', () => {
      const before = adapter.create(minimalGroup());
      const after = execute(before, ['G'], 'flip-x');
      expect(item(after, 'A').bounds.x).toBe(70);
      expect(item(after, 'B').bounds.x).toBe(10);
      expect(item(after, 'A').flipX).toBe(true);
      expect(item(after, 'R')).toEqual(item(before, 'R'));
    });
    it('R2-03 paints a promoted Group subtree above another Group in SVG', () => {
      const items = minimalGroup();
      items[3].parentId = 'H';
      items.splice(3, 0, groupItem('H', 'group', { x: 0, y: 0, width: 200, height: 100 }));
      const before = adapter.create(items);
      const after = execute(before, ['G'], 'front');
      const svg = adapter.svg(after);
      expect(svg.indexOf('fill="#ff0000"')).toBeGreaterThan(svg.indexOf('fill="#0000ff"'));
      for (const id of ['G', 'A', 'B', 'H', 'R']) expect(item(after, id)).toEqual(item(before, id));
    });
    for (const dimension of ['width', 'height', 'both']) {
      it(`R2-01 matches ${dimension} per root, preserves the first-selected subtree and scales nested targets`, () => {
        const items = minimalGroup();
        items[3].bounds.height = 300;
        items[1].parentId = 'N';
        items.splice(1, 0, groupItem('N', 'group', { x: 0, y: 0, width: 50, height: 50 }, 'G'));
        const before = adapter.create(items);
        const unchanged = execute(before, ['G', 'R'], `same-${dimension}`);
        for (const id of ['G', 'N', 'A', 'B'])
          expect(item(unchanged, id)).toEqual(item(before, id));
        // Selection order differs from storage order; selecting a descendant as well must not double-scale it.
        const after = execute(before, ['R', 'G', 'A'], `same-${dimension}`);
        expect(item(after, 'R')).toEqual(item(before, 'R'));
        const sx = dimension === 'height' ? 1 : 2,
          sy = dimension === 'width' ? 1 : 3;
        for (const id of ['G', 'N', 'A', 'B']) {
          const old = item(before, id).bounds;
          expect(item(after, id).bounds).toEqual({
            x: old.x * sx,
            y: old.y * sy,
            width: old.width * sx,
            height: old.height * sy,
          });
        }
      });
    }
    for (const axis of ['x', 'y'] as const) {
      it(`R2-02 reflects nested rotated image/text vertices once along ${axis}, twice restores geometry`, () => {
        const items = minimalGroup();
        items[0].rotation = 30;
        items[1] = { ...items[1], parentId: 'N', kind: 'image', rotation: 17, flipY: true };
        items[2] = { ...items[2], kind: 'text', rotation: 121, flipX: true };
        items.splice(1, 0, {
          ...groupItem('N', 'group', { x: 5, y: 5, width: 30, height: 30 }, 'G'),
          rotation: 70,
        });
        const before = adapter.create(items);
        const after = execute(before, ['G', 'N', 'A'], `flip-${axis}`);
        const vertex = (i: GroupFixtureItem, x: number, y: number) => {
          const radians = (i.rotation * Math.PI) / 180;
          const dx = ((x * i.bounds.width) / 2) * (i.flipX ? -1 : 1),
            dy = ((y * i.bounds.height) / 2) * (i.flipY ? -1 : 1);
          return {
            x: i.bounds.x + i.bounds.width / 2 + dx * Math.cos(radians) - dy * Math.sin(radians),
            y: i.bounds.y + i.bounds.height / 2 + dx * Math.sin(radians) + dy * Math.cos(radians),
          };
        };
        // Independent reflection matrix about the root's rotated local axis.
        const cos = Math.cos(Math.PI / 3),
          sin = Math.sin(Math.PI / 3),
          sign = axis === 'x' ? -1 : 1;
        for (const id of ['G', 'N', 'A', 'B'])
          for (const [x, y] of [
            [-1, -1],
            [-1, 1],
            [1, -1],
            [1, 1],
          ]) {
            const old = vertex(item(before, id), x, y),
              next = vertex(item(after, id), x, y);
            expect(next.x).toBeCloseTo(50 + sign * ((old.x - 50) * cos + (old.y - 50) * sin), 8);
            expect(next.y).toBeCloseTo(50 + sign * ((old.x - 50) * sin - (old.y - 50) * cos), 8);
          }
        const twice = execute(after, ['G'], `flip-${axis}`);
        for (const old of adapter.items(before)) {
          const next = item(twice, old.id);
          for (const key of ['x', 'y', 'width', 'height'] as const)
            expect(next.bounds[key]).toBeCloseTo(old.bounds[key], 8);
          expect({ ...next, bounds: old.bounds }).toEqual(old);
        }
      });
    }
    for (const [action, ids, order] of [
      ['front', ['G0', 'G2'], [1, 3, 4, 0, 2]],
      ['back', ['G1', 'G3'], [1, 3, 0, 2, 4]],
      ['forward', ['G0', 'G2'], [1, 0, 3, 2, 4]],
      ['backward', ['G1', 'G3'], [1, 0, 3, 2, 4]],
    ] as const) {
      it(`R2-03 ${action} preserves multiple selected subtrees and nested sibling order`, () => {
        const items = Array.from({ length: 5 }, (_, i) => [
          groupItem(`G${i}`, 'group', { x: 0, y: 0, width: 100, height: 100 }),
          {
            ...groupItem(`C${i}`, 'shape', { x: 10, y: 10, width: 30, height: 30 }, `G${i}`),
            fill: `#10000${i}`,
          },
        ]).flat();
        items[1].parentId = 'nested';
        items.splice(
          1,
          0,
          groupItem('nested', 'group', { x: 0, y: 0, width: 50, height: 50 }, 'G0'),
        );
        const before = adapter.create(items),
          after = execute(before, [...ids], action),
          svg = adapter.svg(after);
        const positions = order.map((i) => svg.indexOf(`fill="#10000${i}"`));
        expect(positions.every((p) => p >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        for (const old of adapter.items(before)) expect(item(after, old.id)).toEqual(old);
      });
    }
  });
}
