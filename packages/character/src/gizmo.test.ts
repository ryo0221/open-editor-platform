import { describe, expect, it } from 'vitest';
import { boxMesh, editInput, mirrorVertices } from '@editor-platform/geometry-mesh';
import { dragDistance, gizmoHandles } from './gizmo';
import { previewMove, runMeshOperation, selectionCenter, type Projected } from './mesh-edit';

describe('move gizmo (C3g, TS-1230)', () => {
  // Centre at (100, 100); x is 2 px/mm to the right, y 1 px/mm up, z along the view.
  const screen: Projected[] = [
    [100, 100, 0.5],
    [110, 100, 0.5],
    [100, 95, 0.5],
    [100, 100.001, 0.4],
  ];
  it('draws a handle per axis that is not along the view', () => {
    const h = gizmoHandles(screen, 5, 80);
    expect(h.map((x) => x.axis)).toEqual([0, 1]);
    expect(h[0]).toEqual({ axis: 0, from: [100, 100], to: [180, 100], perMm: [2, 0] });
    expect(h[1]!.to).toEqual([100, 20]);
    expect(h[1]!.perMm).toEqual([0, -1]);
  });
  it('has no handles when the centre is behind the camera', () => {
    expect(gizmoHandles([[100, 100, 2], ...screen.slice(1)], 5)).toEqual([]);
  });
  it('measures a drag along the axis on screen, to 0.1 mm', () => {
    const [x, y] = gizmoHandles(screen, 5);
    // 25 px right and 40 px off the axis: 12.5 mm along x.
    expect(dragDistance(x!, [150, 100], [175, 140])).toBe(12.5);
    expect(dragDistance(y!, [100, 60], [130, 83.33])).toBe(-23.3);
    expect(dragDistance(x!, [150, 100], [150.04, 100])).toBe(0);
  });
  it('previews the move it makes, with symmetry', () => {
    const input = editInput(boxMesh([200, 200, 200]));
    const sel = { mode: 'vertex' as const, items: [0] };
    const p = input.mesh.positions;
    const right = [...Array(p.length / 3).keys()].find((v) => p[3 * v]! > 0)!;
    const one = { mode: 'vertex' as const, items: [right] };
    for (const [s, symmetric] of [
      [sel, false],
      [one, true],
    ] as const) {
      const mirror = symmetric ? mirrorVertices(input, 0).mirror : undefined;
      const delta: [number, number, number] = [30, -10, 5];
      const preview = previewMove(input, s, delta, mirror);
      const made = runMeshOperation(input, s, { kind: 'move', delta }, symmetric).mesh;
      expect([...preview]).toEqual([...made.positions]);
    }
    expect(selectionCenter(input, { mode: 'face', items: [0] })).toHaveLength(3);
    expect(selectionCenter(input, { mode: 'vertex', items: [] })).toBeUndefined();
  });
});
